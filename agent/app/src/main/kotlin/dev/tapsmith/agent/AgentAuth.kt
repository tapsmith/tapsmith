package dev.tapsmith.agent

import org.json.JSONException
import org.json.JSONObject
import java.security.MessageDigest

/**
 * The secret every daemon connection must present first (PILOT-969).
 *
 * The socket is bound to loopback, but any app on the device can reach
 * loopback, so the first line on a connection must be
 * `{"id":"auth","method":"auth","params":{"token":"…"}}` carrying the token
 * the daemon passed at launch (`am instrument -e token …`). Anything else is
 * refused and the connection closed. An agent started without a token
 * refuses everything.
 *
 * Plain JVM code, for the unit tests.
 */
internal class AgentAuth(
    token: String?,
) {
    private val expected: ByteArray? = token?.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)

    /** Why [line] does not authenticate the connection, or null when it does. */
    fun refusal(line: String): String? {
        val expected = expected ?: return "the agent was started without a token, so it accepts no connections"
        val request =
            try {
                JSONObject(line)
            } catch (_: JSONException) {
                return "the first line must authenticate the connection"
            }
        if (request.optString("method") != METHOD) return "the first line must authenticate the connection"
        val offered =
            request.optJSONObject("params")?.optString("token", "")?.toByteArray(Charsets.UTF_8)
                ?: ByteArray(0)
        // Constant time: the comparison does not reveal how much matched.
        return if (MessageDigest.isEqual(expected, offered)) null else "wrong token"
    }

    companion object {
        const val METHOD = "auth"

        /** How long a new connection has to authenticate. */
        const val DEADLINE_MS = 5_000

        fun ackLine(): String =
            JSONObject()
                .put("id", METHOD)
                .put("result", JSONObject().put("authenticated", true))
                .toString()

        fun refusalLine(reason: String): String =
            JSONObject()
                .put("id", METHOD)
                .put("error", JSONObject().put("type", "UNAUTHORIZED").put("message", reason))
                .toString()
    }
}
