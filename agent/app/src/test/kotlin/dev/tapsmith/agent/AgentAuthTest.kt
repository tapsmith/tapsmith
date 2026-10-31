package dev.tapsmith.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AgentAuthTest {
    private val token = "ab".repeat(32)

    private fun authLine(token: String) = """{"id":"auth","method":"auth","params":{"token":"$token"}}"""

    @Test
    fun `accepts the auth line with the launch token`() {
        assertNull(AgentAuth(token).refusal(authLine(token)))
    }

    @Test
    fun `refuses a wrong, empty or missing token`() {
        val auth = AgentAuth(token)
        assertEquals("wrong token", auth.refusal(authLine("cd".repeat(32))))
        assertEquals("wrong token", auth.refusal(authLine(token.dropLast(1))))
        assertEquals("wrong token", auth.refusal(authLine("")))
        assertEquals("wrong token", auth.refusal("""{"id":"auth","method":"auth","params":{}}"""))
        assertEquals("wrong token", auth.refusal("""{"id":"auth","method":"auth"}"""))
    }

    @Test
    fun `refuses a command sent before authenticating`() {
        val auth = AgentAuth(token)
        assertNotNull(auth.refusal("""{"id":"1","method":"getClipboard","params":{"token":"$token"}}"""))
        assertNotNull(auth.refusal("not json"))
    }

    @Test
    fun `an agent started without a token refuses everything`() {
        for (missing in listOf(null, "")) {
            val reason = AgentAuth(missing).refusal(authLine(""))
            assertNotNull(reason)
            assertNotNull(AgentAuth(missing).refusal(authLine(token)))
        }
    }

    @Test
    fun `ack and refusal lines are what the daemon reads`() {
        val ack = JSONObject(AgentAuth.ackLine())
        assertEquals("auth", ack.getString("id"))
        assertEquals(true, ack.getJSONObject("result").getBoolean("authenticated"))
        val refusal = JSONObject(AgentAuth.refusalLine("wrong token"))
        assertEquals("auth", refusal.getString("id"))
        assertEquals("UNAUTHORIZED", refusal.getJSONObject("error").getString("type"))
        assertEquals("wrong token", refusal.getJSONObject("error").getString("message"))
    }
}
