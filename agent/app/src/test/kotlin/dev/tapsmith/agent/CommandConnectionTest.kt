package dev.tapsmith.agent

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Host-side tests for how one daemon connection is served (PILOT-605): each
 * command runs off the connection's reader, so the daemon dropping the
 * connection while a command is still running cancels that command instead
 * of leaving it to run on.
 */
class CommandConnectionTest {
    private companion object {
        val TOKEN = "ab".repeat(32)
    }

    // The pool SocketServer serves connections on.
    private val executor = newConnectionExecutor()
    private val logs = CopyOnWriteArrayList<String>()

    @After
    fun tearDown() {
        executor.shutdownNow()
    }

    /** A connection under test: what the daemon writes, and what it reads back. */
    private inner class Wire(
        authenticate: Boolean = true,
        handle: (String) -> String,
    ) {
        private val toAgent = PipedOutputStream()
        private val agentIn = PipedInputStream(toAgent, 1 shl 16)
        private val agentOut = PipedOutputStream()
        private val fromAgent = BufferedReader(InputStreamReader(PipedInputStream(agentOut, 1 shl 16), Charsets.UTF_8))
        private val served = CountDownLatch(1)

        init {
            val connection =
                CommandConnection(agentIn, agentOut, executor, AgentAuth(TOKEN), handle, log = { logs.add(it) })
            executor.submit {
                try {
                    connection.serve()
                } finally {
                    served.countDown()
                }
            }
            if (authenticate) {
                send(authLine(TOKEN))
                assertEquals(AgentAuth.ackLine(), readLine())
            }
        }

        fun send(line: String) {
            toAgent.write((line + "\n").toByteArray(Charsets.UTF_8))
            toAgent.flush()
        }

        fun readLine(): String? = fromAgent.readLine()

        /** Whether the agent has written anything not yet read. */
        fun hasOutput(): Boolean = fromAgent.ready()

        /** The daemon giving up on the connection. */
        fun close() = toAgent.close()

        fun awaitServed(): Boolean = served.await(5, TimeUnit.SECONDS)
    }

    private fun authLine(token: String) = """{"id":"auth","method":"auth","params":{"token":"$token"}}"""

    // ─── Authentication (PILOT-969) ───

    @Test
    fun `a connection that authenticates is served, and the auth line never reaches the handler or the log`() {
        val handled = CopyOnWriteArrayList<String>()
        val wire =
            Wire { line ->
                handled.add(line)
                """{"id":"${JSONObject(line).getString("id")}","result":{}}"""
            }
        wire.send(request("1"))
        assertEquals("1", idOf(wire.readLine()))
        assertEquals(listOf(request("1")), handled)
        assertFalse(logs.any { it.contains(TOKEN) })
    }

    @Test
    fun `a wrong token is refused and the connection ends without running anything`() {
        val handled = AtomicInteger()
        val wire = Wire(authenticate = false) { handled.incrementAndGet().let { "{}" } }
        wire.send(authLine("cd".repeat(32)))
        wire.send(request("1"))
        val refusal = JSONObject(wire.readLine()!!)
        assertEquals("UNAUTHORIZED", refusal.getJSONObject("error").getString("type"))
        // serve() returning is the connection ending: SocketServer closes the socket.
        assertTrue(wire.awaitServed())
        assertEquals(0, handled.get())
    }

    @Test
    fun `a command sent before authenticating is refused, not run`() {
        val handled = AtomicInteger()
        val wire = Wire(authenticate = false) { handled.incrementAndGet().let { "{}" } }
        wire.send(request("1", method = "getClipboard"))
        val refusal = JSONObject(wire.readLine()!!)
        assertEquals("auth", refusal.getString("id"))
        assertEquals("UNAUTHORIZED", refusal.getJSONObject("error").getString("type"))
        assertTrue(wire.awaitServed())
        assertEquals(0, handled.get())
    }

    @Test
    fun `blank lines before the auth line are skipped`() {
        val wire = Wire(authenticate = false) { """{"id":"${JSONObject(it).getString("id")}","result":{}}""" }
        wire.send("")
        wire.send(authLine(TOKEN))
        assertEquals(AgentAuth.ackLine(), wire.readLine())
        wire.send(request("1"))
        assertEquals("1", idOf(wire.readLine()))
    }

    @Test
    fun `a connection closed before authenticating ends quietly`() {
        val wire = Wire(authenticate = false) { "{}" }
        wire.close()
        assertTrue(wire.awaitServed())
        assertFalse(wire.hasOutput())
    }

    private fun request(
        id: String,
        method: String = "ping",
    ) = """{"id":"$id","method":"$method","params":{}}"""

    private fun idOf(response: String?) = JSONObject(response!!).getString("id")

    @Test
    fun `answers each request on the connection`() {
        val wire = Wire { line -> """{"id":"${JSONObject(line).getString("id")}","result":{}}""" }
        wire.send(request("a"))
        assertEquals("a", idOf(wire.readLine()))
        wire.send(request("b"))
        assertEquals("b", idOf(wire.readLine()))
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `runs one command at a time, in order, even when requests arrive together`() {
        val running = AtomicInteger(0)
        val maxRunning = AtomicInteger(0)
        val wire =
            Wire { line ->
                maxRunning.accumulateAndGet(running.incrementAndGet(), ::maxOf)
                Thread.sleep(50)
                running.decrementAndGet()
                """{"id":"${JSONObject(line).getString("id")}","result":{}}"""
            }
        wire.send(request("1") + "\n" + request("2") + "\n" + request("3"))
        assertEquals(listOf("1", "2", "3"), List(3) { idOf(wire.readLine()) })
        assertEquals(1, maxRunning.get())
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `the daemon closing the connection cancels the running command`() {
        val started = CountDownLatch(1)
        val outcome = AtomicReference<Throwable?>()
        val finished = CountDownLatch(1)
        val wire =
            Wire { _ ->
                started.countDown()
                try {
                    CommandCancellation.sleep(30_000)
                    "{}"
                } catch (e: Throwable) {
                    outcome.set(e)
                    throw e
                } finally {
                    finished.countDown()
                }
            }
        wire.send(request("slow", "waitForElement"))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        wire.close()
        assertTrue("the abandoned command kept running", finished.await(5, TimeUnit.SECONDS))
        assertTrue(outcome.get() is CommandCancelledException)
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `the connection is released without waiting for a command that cannot be interrupted`() {
        val release = CountDownLatch(1)
        val started = CountDownLatch(1)
        val wire =
            Wire { _ ->
                started.countDown()
                // An uninterruptible native step (a hierarchy dump).
                release.await()
                "{}"
            }
        wire.send(request("dump", "getUiHierarchy"))
        assertTrue(started.await(5, TimeUnit.SECONDS))
        wire.close()
        assertTrue("serving the closed connection waited for the command", wire.awaitServed())
        release.countDown()
    }

    @Test
    fun `the answer to a command the daemon left is dropped`() {
        val release = CountDownLatch(1)
        val wire =
            Wire { _ ->
                release.await()
                """{"id":"late","result":{}}"""
            }
        wire.send(request("late"))
        wire.close()
        assertTrue(wire.awaitServed())
        release.countDown()
        val deadline = System.currentTimeMillis() + 5_000
        while (logs.none { it.startsWith("Dropped the answer") } && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("the late answer was not dropped: $logs", logs.any { it.startsWith("Dropped the answer") })
        assertFalse("a late answer was written", wire.hasOutput())
    }

    @Test(timeout = 10_000)
    fun `a new connection is served while abandoned commands are stuck in calls that cannot be stopped`() {
        // Two commands the daemon gave up on, each stuck in a native call
        // (a hierarchy dump on a busy app) that no checkpoint can stop.
        val release = CountDownLatch(1)
        val stuck = CountDownLatch(2)
        repeat(2) { i ->
            val wire =
                Wire { _ ->
                    stuck.countDown()
                    release.await()
                    "{}"
                }
            wire.send(request("dump$i", "getUiHierarchy"))
            wire.close()
        }
        try {
            assertTrue(stuck.await(5, TimeUnit.SECONDS))
            // The daemon's liveness ping, on a connection of its own.
            val ping = Wire { line -> """{"id":"${JSONObject(line).getString("id")}","result":{"pong":true}}""" }
            ping.send(request("ping"))
            assertEquals("ping", idOf(ping.readLine()))
            ping.close()
        } finally {
            release.countDown()
        }
    }

    @Test
    fun `a handler failure is answered as an internal error`() {
        val wire = Wire { _ -> throw IllegalStateException("boom \"quoted\"") }
        wire.send(request("x"))
        val response = JSONObject(wire.readLine()!!)
        assertEquals("INTERNAL_ERROR", response.getJSONObject("error").getString("type"))
        assertEquals("boom \"quoted\"", response.getJSONObject("error").getString("message"))
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test(timeout = 10_000)
    fun `an Error from a command is answered, not left hanging`() {
        // A stack overflow in a deep hierarchy walk, an OOM on a huge dump.
        val wire = Wire { _ -> throw StackOverflowError() }
        wire.send(request("deep", "getUiHierarchy"))
        val response = JSONObject(wire.readLine()!!)
        assertEquals("INTERNAL_ERROR", response.getJSONObject("error").getString("type"))
        assertEquals("java.lang.StackOverflowError", response.getJSONObject("error").getString("message"))
        wire.close()
        assertTrue(wire.awaitServed())
    }

    @Test
    fun `blank lines are ignored`() {
        val wire = Wire { line -> """{"id":"${JSONObject(line).getString("id")}","result":{}}""" }
        wire.send("")
        wire.send("   ")
        wire.send(request("a"))
        assertEquals("a", idOf(wire.readLine()))
        wire.close()
        assertTrue(wire.awaitServed())
    }
}
