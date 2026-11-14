import CoreGraphics
import Foundation
import Network

/// TCP socket server that listens for JSON commands from the host daemon.
///
/// Protocol: newline-delimited JSON. Each line is a complete JSON object.
/// Request:  {"id": "uuid", "method": "methodName", "params": {...}}
/// Response: {"id": "uuid", "result": {...}} or {"id": "uuid", "error": {...}}
///
/// Between a request and its response the agent may ask the daemon to press
/// a tap, on the same connection, and the daemon answers (`HostTouch`):
/// Agent:    {"hostRequest": {"seq": 1, "method": "tap", ...}}
/// Daemon:   {"hostReply": {"seq": 1, "status": "delivered"}}
///
/// Commands are processed on the main thread via RunLoop to ensure XCUITest's
/// accessibility operations (which require main RunLoop XPC callbacks) work
/// correctly on Xcode 26.
class SocketServer {
    private let port: UInt16
    private let commandHandler: CommandHandler
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "dev.tapsmith.agent.socket", qos: .userInitiated)

    /// Pending commands from the socket, to be processed on the main thread.
    private var pendingCommands: [(String, NWConnection)] = []
    private let commandLock = NSLock()

    /// Where a command waits for the daemon's reply to a tap it asked the
    /// daemon to press (`HostTouch`).
    private let hostTouchMailbox = HostTouchMailbox()
    /// The connection of the command being handled, guarded by `commandLock`.
    private var commandConnection: NWConnection?

    @Volatile private var running = false

    init(port: UInt16, commandHandler: CommandHandler) {
        self.port = port
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

        do {
            listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
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
                NSLog("[TapsmithSocket] Listening on port \(self.port)")
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
                setCommandConnection(connection)
                commandHandler.hostTap = { [hostTouchMailbox] point, holdMs, wait in
                    Self.requestHostTap(on: connection, mailbox: hostTouchMailbox, point: point, holdMs: holdMs, wait: wait)
                }
                let response = commandHandler.handle(rawJson: line)
                commandHandler.hostTap = nil
                setCommandConnection(nil)
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

    private func setCommandConnection(_ connection: NWConnection?) {
        commandLock.lock()
        commandConnection = connection
        commandLock.unlock()
    }

    /// Ask the daemon, on the command's own connection, to press a tap
    /// (`HostTouch`), and wait on the command's thread for its reply, which
    /// the socket's queue leaves in `mailbox`.
    private static func requestHostTap(
        on connection: NWConnection,
        mailbox: HostTouchMailbox,
        point: CGPoint,
        holdMs: Int,
        wait: TimeInterval
    ) -> HostTouch.Outcome {
        let seq = mailbox.begin()
        let line = HostTouch.requestLine(seq: seq, point: point, holdMs: holdMs)
        guard !line.isEmpty else { return .notSent("the request could not be written") }
        connection.send(content: (line + "\n").data(using: .utf8)!, completion: .contentProcessed { error in
            // Never sent, so never pressed: the agent's own touch is safe.
            if let error = error {
                NSLog("[TapsmithSocket] Host touch request failed to send: \(error)")
                mailbox.deliver(seq: seq, outcome: .notSent("the request could not be sent"))
            }
        })
        return mailbox.wait(seq: seq, timeout: wait)
    }

    /// The connection ended: a command waiting on it for the daemon's reply
    /// to a host touch gets none.
    private func connectionEnded(_ connection: NWConnection) {
        commandLock.lock()
        let isCommands = commandConnection === connection
        commandLock.unlock()
        if isCommands { hostTouchMailbox.connectionLost() }
    }

    /// Stop the server.
    func stop() {
        running = false
        listener?.cancel()
        listener = nil
    }

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveLines(connection: connection, buffer: Data())
    }

    /// Recursively receive data and enqueue complete commands for main-thread processing.
    private func receiveLines(connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self = self, self.running else {
                connection.cancel()
                return
            }

            if let error = error {
                NSLog("[TapsmithSocket] Read error: \(error)")
                self.connectionEnded(connection)
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

                NSLog("[TapsmithSocket] Received: \(line.prefix(200))")

                // The daemon's reply to a tap the running command asked it
                // to press: for that command, which is waiting on the main
                // thread, not for the queue behind it.
                if let reply = HostTouch.reply(in: line) {
                    self.hostTouchMailbox.deliver(seq: reply.seq, outcome: reply.outcome)
                    continue
                }

                // Enqueue for main-thread processing
                self.commandLock.lock()
                self.pendingCommands.append((line, connection))
                self.commandLock.unlock()
            }

            if isComplete {
                NSLog("[TapsmithSocket] Client disconnected")
                self.connectionEnded(connection)
                connection.cancel()
                return
            }

            // Continue reading
            self.receiveLines(connection: connection, buffer: currentBuffer)
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
