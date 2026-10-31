package dev.tapsmith.agent

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentAuthTest {
    private val token = "ab".repeat(32)
    private val challenge = "0123456789abcdef".repeat(4)
    private val daemonNonce = "d".repeat(64)

    private fun authLine(
        proof: String,
        nonce: String = daemonNonce,
    ) = """{"id":"auth","method":"auth","params":{"nonce":"$nonce","proof":"$proof"}}"""

    private fun daemonProof(token: String = this.token) = AgentAuth.proof(token, "daemon", challenge)

    @Test
    fun `proofs match the test vector shared with the daemon and the iOS agent`() {
        assertEquals(
            "9a11a9da9d0f2172d5801943fbf6124fa424af0de00767c54b12a04791e64f3a",
            AgentAuth.proof(token, "daemon", challenge),
        )
        assertEquals(
            "9e9de4b1c2ee0bdfa527a9a8194aab687a211461a9461da1fd5fc353b2a91493",
            AgentAuth.proof(token, "agent", challenge),
        )
    }

    @Test
    fun `accepts a daemon that proves it holds the token, and proves it back`() {
        val verdict = AgentAuth(token).judge(authLine(daemonProof()), challenge)
        assertTrue(verdict is AgentAuth.Verdict.Accepted)
        val ack = JSONObject((verdict as AgentAuth.Verdict.Accepted).ack)
        assertEquals("auth", ack.getString("id"))
        val result = ack.getJSONObject("result")
        assertEquals(true, result.getBoolean("authenticated"))
        assertEquals(AgentAuth.proof(token, "agent", daemonNonce), result.getString("proof"))
        assertFalse("the token never goes out", verdict.ack.contains(token))
    }

    private fun refusal(
        line: String,
        auth: AgentAuth = AgentAuth(token),
    ): String? = (auth.judge(line, challenge) as? AgentAuth.Verdict.Refused)?.reason

    @Test
    fun `refuses a wrong or missing proof`() {
        assertEquals("wrong token", refusal(authLine(daemonProof("cd".repeat(32)))))
        assertEquals("wrong token", refusal(authLine(AgentAuth.proof(token, "agent", challenge))))
        assertEquals("wrong token", refusal(authLine(daemonProof().dropLast(1))))
        assertEquals("wrong token", refusal(authLine("")))
        assertEquals("wrong token", refusal("""{"id":"auth","method":"auth","params":{}}"""))
        // The raw token is not a proof.
        assertEquals("wrong token", refusal("""{"id":"auth","method":"auth","params":{"token":"$token"}}"""))
    }

    @Test
    fun `refuses a malformed daemon nonce`() {
        assertNotEquals(null, refusal(authLine(daemonProof(), nonce = "")))
        assertNotEquals(null, refusal(authLine(daemonProof(), nonce = "xyz")))
    }

    @Test
    fun `refuses a command sent before authenticating`() {
        assertNotEquals(null, refusal("""{"id":"1","method":"getClipboard","params":{"proof":"${daemonProof()}"}}"""))
        assertNotEquals(null, refusal("not json"))
    }

    @Test
    fun `an agent started without a token refuses everything`() {
        for (missing in listOf(null, "")) {
            assertNotEquals(null, refusal(authLine(daemonProof()), AgentAuth(missing)))
            assertNotEquals(null, refusal(authLine(""), AgentAuth(missing)))
        }
    }

    @Test
    fun `nonces are fresh 64-hex strings`() {
        val a = AgentAuth.newNonce()
        assertTrue(AgentAuth.isNonce(a))
        assertNotEquals(a, AgentAuth.newNonce())
        assertEquals(challenge, JSONObject(AgentAuth.challengeLine(challenge)).getString("challenge"))
    }

    @Test
    fun `the refusal is what the daemon reads`() {
        val refusal = JSONObject(AgentAuth.refusalLine("wrong token"))
        assertEquals("auth", refusal.getString("id"))
        assertEquals("UNAUTHORIZED", refusal.getJSONObject("error").getString("type"))
        assertEquals("wrong token", refusal.getJSONObject("error").getString("message"))
    }
}
