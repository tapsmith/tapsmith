import Foundation
import Network

/// TCP socket server that listens for JSON commands from the host daemon.
///
/// Protocol: newline-delimited JSON. Each line is a complete JSON object.
/// Request:  {"id": "uuid", "method": "methodName", "params": {...}}
/// Response: {"id": "uuid", "result": {...}} or {"id": "uuid", "error": {...}}
///
/// Commands are processed on the main thread via RunLoop to ensure XCUITest's
/// accessibility operations (which require main RunLoop XPC callbacks) work
/// correctly on Xcode 26.
///
/// The listener is bound to loopback only, and the first line on every
/// connection must authenticate it (`AgentAuth`, PILOT-969): it is answered
/// on the socket queue, never logged and never reaches the command handler.
/// A wrong first line is answered with the refusal and the connection
/// closed; so is a connection that sends nothing for `AgentAuth.deadline`.
class SocketServer {
    private let port: UInt16
    private let auth: AgentAuth
    private let commandHandler: CommandHandler
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "dev.tapsmith.agent.socket", qos: .userInitiated)

    /// Pending commands from the socket, to be processed on the main thread.
    private var pendingCommands: [(String, NWConnection)] = []
    private let commandLock = NSLock()

    @Volatile private var running = false

    /// Whether a connection has authenticated. Read and written only on `queue`.
    private final class ConnectionState {
        var authenticated = false
    }

    init(port: UInt16, auth: AgentAuth, commandHandler: CommandHandler) {
        self.port = port
        self.auth = auth
        self.commandHandler = commandHandler
    }

    /// Start the server. This blocks the calling thread (main/test thread)
    /// using RunLoop so XCUITest's XPC callbacks can be processed.
    func start() {
        running = true

        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true

        // Disable Nagle's algorithm for low latency
        if let tcpOptions = params.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            tcpOptions.noDelay = true
        }

        // Loopback only: the simulator shares the Mac's network stack, and
        // iproxy (usbmux) reaches a physical device's loopback, so nothing
        // that drives the agent needs another interface (PILOT-969).
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: .ipv4(.loopback),
            port: NWEndpoint.Port(rawValue: port)!
        )

        do {
            listener = try NWListener(using: params)
        } catch {
            NSLog("[TapsmithSocket] Failed to create listener: \(error)")
            return
        }

        listener?.newConnectionHandler = { [weak self] connection in
            guard let self = self, self.running else {
                connection.cancel()
                return
            }
            NSLog("[TapsmithSocket] Client connected")
            self.handleConnection(connection)
        }

        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                NSLog("[TapsmithSocket] Listening on 127.0.0.1:\(self.port)")
            case .failed(let error):
                NSLog("[TapsmithSocket] Listener failed: \(error)")
            case .cancelled:
                NSLog("[TapsmithSocket] Listener cancelled")
            default:
                break
            }
        }

        listener?.start(queue: queue)

        // Main loop: pump the RunLoop and process any pending commands.
        // XCUITest's accessibility operations require the main RunLoop to
        // process XPC callbacks. We process commands HERE on the main thread
        // rather than on the socket's background queue.
        while running {
            // Process one pending command if available
            commandLock.lock()
            let pending = pendingCommands.isEmpty ? nil : pendingCommands.removeFirst()
            commandLock.unlock()

            if let (line, connection) = pending {
                let response = commandHandler.handle(rawJson: line)
                let responseData = (response + "\n").data(using: .utf8)!
                connection.send(content: responseData, completion: .contentProcessed { error in
                    if let error = error {
                        NSLog("[TapsmithSocket] Write error: \(error)")
                        connection.cancel()
                    }
                })
            }

            // Run the RunLoop briefly to process XPC callbacks and GCD events.
            // Short interval when commands are pending, longer when idle.
            let interval = pending != nil ? 0.001 : 0.01
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: interval))
        }
    }

    /// Stop the server.
    func stop() {
        running = false
        listener?.cancel()
        listener = nil
    }

    private func handleConnection(_ connection: NWConnection) {
        let state = ConnectionState()
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + AgentAuth.deadline) {
            if !state.authenticated {
                NSLog("[TapsmithSocket] Client did not authenticate in time; closing")
                connection.cancel()
            }
        }
        receiveLines(connection: connection, buffer: Data(), state: state)
    }

    /// Judge a connection's first line. True when the connection may go on.
    private func authenticate(_ line: String, connection: NWConnection, state: ConnectionState) -> Bool {
        if let refusal = auth.refusal(line: line) {
            NSLog("[TapsmithSocket] Refused a connection: \(refusal)")
            let data = (AgentAuth.refusalLine(refusal) + "\n").data(using: .utf8)!
            connection.send(content: data, completion: .contentProcessed { _ in connection.cancel() })
            return false
        }
        state.authenticated = true
        let data = (AgentAuth.ackLine() + "\n").data(using: .utf8)!
        connection.send(content: data, completion: .contentProcessed { error in
            if let error = error {
                NSLog("[TapsmithSocket] Write error: \(error)")
                connection.cancel()
            }
        })
        return true
    }

    /// Recursively receive data and enqueue complete commands for main-thread processing.
    private func receiveLines(connection: NWConnection, buffer: Data, state: ConnectionState) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self, self.running else {
                connection.cancel()
                return
            }

            if let error = error {
                NSLog("[TapsmithSocket] Read error: \(error)")
                connection.cancel()
                return
            }

            var currentBuffer = buffer
            if let data = data {
                currentBuffer.append(data)
            }

            // Process all complete lines in the buffer
            while let newlineIndex = currentBuffer.firstIndex(of: UInt8(ascii: "\n")) {
                let lineData = currentBuffer[currentBuffer.startIndex..<newlineIndex]
                currentBuffer = Data(currentBuffer[currentBuffer.index(after: newlineIndex)...])

                guard let line = String(data: lineData, encoding: .utf8), !line.trimmingCharacters(in: .whitespaces).isEmpty else {
                    continue
                }

                if !state.authenticated {
                    // The first line authenticates the connection, or ends it.
                    if !self.authenticate(line, connection: connection, state: state) {
                        return
                    }
                    continue
                }

                NSLog("[TapsmithSocket] Received: \(line.prefix(200))")

                // Enqueue for main-thread processing
                self.commandLock.lock()
                self.pendingCommands.append((line, connection))
                self.commandLock.unlock()
            }

            if isComplete {
                NSLog("[TapsmithSocket] Client disconnected")
                connection.cancel()
                return
            }

            // Continue reading
            self.receiveLines(connection: connection, buffer: currentBuffer, state: state)
        }
    }
}

// MARK: - Volatile property wrapper (equivalent to Kotlin's @Volatile)

@propertyWrapper
struct Volatile<Value> {
    private var value: Value
    private let lock = NSLock()

    init(wrappedValue: Value) {
        self.value = wrappedValue
    }

    var wrappedValue: Value {
        get {
            lock.lock()
            defer { lock.unlock() }
            return value
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            value = newValue
        }
    }
}
