package dev.tapsmith.agent

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException

/**
 * TCP socket server that listens for JSON commands from the host daemon.
 *
 * Protocol: newline-delimited JSON. Each line is a complete JSON object.
 * Request:  {"id": "uuid", "method": "methodName", "params": {...}}
 * Response: {"id": "uuid", "result": {...}} or {"id": "uuid", "error": {...}}
 *
 * Commands are dispatched to the CommandHandler which runs UIAutomator2
 * operations. Each connection is served by [CommandConnection]: a thread
 * reading it, and a thread for each command, which is cancelled when the
 * daemon drops the connection (PILOT-605).
 */
internal class SocketServer(
    private val port: Int,
    private val auth: AgentAuth,
    private val commandHandler: CommandHandler,
) {
    companion object {
        private const val TAG = "TapsmithSocket"
        private const val BACKLOG = 50
    }

    /** One thread per connection and per command: see [newConnectionExecutor]. */
    private val executor = newConnectionExecutor()
    private var serverSocket: ServerSocket? = null

    @Volatile
    private var running = false

    suspend fun start() {
        running = true
        withContext(Dispatchers.IO) {
            try {
                // Loopback only: `adb forward` reaches it, the network does
                // not (PILOT-969). Apps on the device still can, which is
                // what the challenge-response is for. IPv4 127.0.0.1, not
                // getLoopbackAddress(): on Android that is ::1, which the
                // adbd of API 24–26 never tries (it connects to 127.0.0.1).
                val loopback = InetAddress.getByAddress("localhost", byteArrayOf(127, 0, 0, 1))
                serverSocket = ServerSocket(port, BACKLOG, loopback)
                Log.i(TAG, "Listening on 127.0.0.1:$port")

                while (running) {
                    val client =
                        try {
                            serverSocket?.accept()
                        } catch (e: SocketException) {
                            if (running) Log.e(TAG, "Accept failed", e)
                            break
                        } ?: break

                    Log.i(TAG, "Client connected: ${client.remoteSocketAddress}")
                    // Handle each client on a worker thread so UIAutomator
                    // operations run with the correct thread context
                    executor.submit { handleClient(client) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Server error", e)
            } finally {
                Log.i(TAG, "Server stopped")
            }
        }
    }

    fun stop() {
        running = false
        try {
            serverSocket?.close()
        } catch (_: Exception) {
        }
        executor.shutdownNow()
    }

    private fun handleClient(socket: Socket) {
        try {
            socket.use { s ->
                s.tcpNoDelay = true
                // A connection that never authenticates is dropped.
                s.soTimeout = AgentAuth.DEADLINE_MS
                CommandConnection(
                    input = s.getInputStream(),
                    output = s.getOutputStream(),
                    executor = executor,
                    auth = auth,
                    onAuthenticated = { s.soTimeout = 0 },
                    handle = { line ->
                        Log.d(TAG, "Received: $line")
                        commandHandler.handle(line).also { Log.d(TAG, "Responding: $it") }
                    },
                    isRunning = { running && !s.isClosed },
                    log = { Log.d(TAG, it) },
                ).serve()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Client handler error", e)
        }
    }
}
