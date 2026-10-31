package dev.tapsmith.agent

import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.io.PrintWriter
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future

/**
 * Serves one daemon connection: newline-delimited JSON requests in, one
 * response line per request out, one command at a time and in order.
 *
 * Each command runs on a thread of its own from [executor] while this
 * connection's thread goes on reading (PILOT-605). The daemon sends the next
 * request only after the answer to the last one, so what that read sees
 * while a command runs is the daemon dropping the connection — it has given
 * up on the command — and the command's [CommandCancellation] is cancelled,
 * so its long-running loops stop at their next checkpoint instead of running
 * on (and touching the screen) after nobody waits for them. A request that
 * does arrive early waits for the one before it.
 *
 * The first non-blank line must authenticate the connection ([AgentAuth],
 * PILOT-969): it is answered with the ack and never reaches [handle] or the
 * log; anything else is answered with the refusal and the connection ends.
 * [onAuthenticated] runs once it has (the server lifts its handshake read
 * deadline there).
 *
 * [serve] returns as soon as the connection closes, without waiting for a
 * cancelled command to reach a checkpoint: it may be stuck in a native call
 * that cannot be stopped, and the caller frees the connection's resources.
 * Plain JVM code with an injected logger, for the unit tests.
 */
internal class CommandConnection(
    input: InputStream,
    output: OutputStream,
    private val executor: ExecutorService,
    private val auth: AgentAuth,
    private val handle: (String) -> String,
    private val onAuthenticated: () -> Unit = {},
    private val isRunning: () -> Boolean = { true },
    private val log: (String) -> Unit,
) {
    private val reader = BufferedReader(InputStreamReader(input, Charsets.UTF_8))
    private val writer = PrintWriter(OutputStreamWriter(output, Charsets.UTF_8), true)

    fun serve() {
        var inFlight: Future<*>? = null
        var token: CommandCancellation? = null
        if (!authenticate()) return
        try {
            while (isRunning()) {
                val line =
                    try {
                        reader.readLine()
                    } catch (e: IOException) {
                        log("Client read error: ${e.message}")
                        null
                    }
                if (line == null) {
                    log("Client disconnected")
                    break
                }
                if (line.isBlank()) continue

                // One command at a time per connection, as before.
                inFlight?.let(::awaitQuietly)
                val command = CommandCancellation()
                token = command
                inFlight = executor.submit { run(line, command) }
            }
        } finally {
            // Nobody will read the answer now. A command that has already
            // answered is not affected.
            token?.cancel("the daemon closed the connection before the command finished")
        }
    }

    /** Read the first line and judge it: true when the connection may go on. */
    private fun authenticate(): Boolean {
        var line: String?
        do {
            line =
                try {
                    reader.readLine()
                } catch (e: IOException) {
                    // Includes the handshake deadline running out.
                    log("Client did not authenticate: ${e.message}")
                    return false
                }
        } while (line != null && line.isBlank())
        if (line == null) {
            log("Client disconnected before authenticating")
            return false
        }
        val refusal = auth.refusal(line)
        if (refusal != null) {
            log("Refused a connection: $refusal")
            send(AgentAuth.refusalLine(refusal))
            return false
        }
        onAuthenticated()
        send(AgentAuth.ackLine())
        return true
    }

    private fun send(line: String) {
        synchronized(writer) {
            writer.println(line)
            writer.flush()
        }
    }

    private fun run(
        line: String,
        command: CommandCancellation,
    ) {
        val response =
            try {
                CommandCancellation.runWith(command) { handle(line) }
            } catch (e: Throwable) {
                // Errors too (a stack overflow in a deep hierarchy walk, an
                // OOM on a huge dump): unanswered, the daemon would wait out
                // its whole read deadline on a connection still open.
                log("Unhandled error processing command: $e")
                JSONObject()
                    .put("id", JSONObject.NULL)
                    .put(
                        "error",
                        JSONObject()
                            .put("type", "INTERNAL_ERROR")
                            .put("message", e.message ?: e.javaClass.name),
                    ).toString()
            }
        if (command.isCancelled) {
            log("Dropped the answer to an abandoned command (the daemon closed the connection)")
            return
        }
        synchronized(writer) {
            writer.println(response)
            writer.flush()
            // PrintWriter swallows I/O errors: the connection went away just
            // as the command finished, and its reader sees that as EOF.
            if (writer.checkError()) log("Client write error: the connection closed before the answer was sent")
        }
    }

    private fun awaitQuietly(future: Future<*>) {
        try {
            future.get()
        } catch (_: ExecutionException) {
            // run() answers every failure itself.
        }
    }
}

/**
 * The pool connections and their commands run on: unbounded, so a new
 * connection never queues behind one whose command the daemon gave up on
 * (PILOT-605). The daemon drops a connection when it stops waiting and opens
 * another for the next command — and its liveness ping opens one too. A
 * fixed pool of 2 let two abandoned commands still running hold both threads,
 * so every later command, ping included, waited for one of them to finish,
 * and the daemon declared a working agent dead. A cancelled command stops at
 * its next checkpoint, but a native call (a hierarchy dump) cannot be
 * stopped, so it must not hold up the next connection. Idle threads exit
 * after 60 s.
 */
internal fun newConnectionExecutor(): ExecutorService = Executors.newCachedThreadPool()
