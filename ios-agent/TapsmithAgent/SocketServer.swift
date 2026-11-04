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
/// The listener is bound to loopback only, and every connection opens with
/// `AgentAuth`'s challenge-response (PILOT-969): the first line must answer
/// the challenge; it is answered on the socket queue, never logged and never
/// reaches the command handler.
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
        let gate = ConnectionGate(auth: auth)
        connection.start(queue: queue)
        if case .send(let challenge) = gate.start() {
            send(challenge, on: connection, thenClose: false)
        }
        queue.asyncAfter(deadline: .now() + AgentAuth.deadline) {
            if !gate.authenticated {
                NSLog("[TapsmithSocket] Client did not authenticate in time; closing")
                connection.cancel()
            }
        }
        receiveLines(connection: connection, gate: gate)
    }

    private func send(_ line: String, on connection: NWConnection, thenClose: Bool) {
        let data = (line + "\n").data(using: .utf8)!
        connection.send(content: data, completion: .contentProcessed { error in
            if let error = error {
                NSLog("[TapsmithSocket] Write error: \(error)")
            }
            if thenClose || error != nil {
                connection.cancel()
            }
        })
    }

    /// Recursively receive data and enqueue complete commands for main-thread
    /// processing. The gate answers the auth line on this queue; only lines
    /// after it become commands.
    private func receiveLines(connection: NWConnection, gate: ConnectionGate) {
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

            for action in gate.receive(data ?? Data()) {
                switch action {
                case .send(let line):
                    self.send(line, on: connection, thenClose: false)
                case .sendAndClose(let line):
                    NSLog("[TapsmithSocket] Refused a connection: \(line)")
                    self.send(line, on: connection, thenClose: true)
                    return
                case .command(let line):
                    NSLog("[TapsmithSocket] Received: \(line.prefix(200))")
                    // Enqueue for main-thread processing
                    self.commandLock.lock()
                    self.pendingCommands.append((line, connection))
                    self.commandLock.unlock()
                }
            }

            if isComplete {
                NSLog("[TapsmithSocket] Client disconnected")
                connection.cancel()
                return
            }

            // Continue reading
            self.receiveLines(connection: connection, gate: gate)
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
