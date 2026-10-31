package dev.tapsmith.agent

import org.json.JSONException
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * How a daemon connection proves it holds the token the daemon passed at
 * launch (`am instrument -e token …`), and how the agent proves it back,
 * without the token ever crossing the wire (PILOT-969).
 *
 * The socket is bound to loopback, but any app on the device can reach (or
 * squat) loopback. So every connection opens with a mutual
 * challenge-response:
 * ```
 * agent  → {"id":"auth","challenge":"<agent nonce>"}
 * daemon → {"id":"auth","method":"auth","params":{"nonce":"<daemon nonce>",
 *           "proof":HMAC(token, "daemon:" + agent nonce)}}
 * agent  → {"id":"auth","result":{"authenticated":true,
 *           "proof":HMAC(token, "agent:" + daemon nonce)}}
 *       or {"id":"auth","error":{"type":"UNAUTHORIZED","message":"…"}} and close
 * ```
 * HMAC-SHA256 keyed with the token's UTF-8 bytes, as lowercase hex; nonces
 * are 32 random bytes as lowercase hex. The daemon side is
 * `packages/tapsmith-core/src/agent_auth.rs`. An agent started without a
 * token refuses everything.
 *
 * Plain JVM code, for the unit tests.
 */
internal class AgentAuth(
    token: String?,
) {
    private val key: ByteArray? = token?.takeIf { it.isNotEmpty() }?.toByteArray(Charsets.UTF_8)

    sealed interface Verdict {
        /** Send [ack] and serve the connection. */
        data class Accepted(
            val ack: String,
        ) : Verdict

        /** Send the refusal for [reason] and close. */
        data class Refused(
            val reason: String,
        ) : Verdict
    }

    /** Judge the daemon's answer [line] to the [challenge] this agent sent. */
    fun judge(
        line: String,
        challenge: String,
    ): Verdict {
        val key = key ?: return Verdict.Refused("the agent was started without a token, so it accepts no connections")
        val request =
            try {
                JSONObject(line)
            } catch (_: JSONException) {
                return Verdict.Refused(FIRST_LINE)
            }
        if (request.optString("method") != METHOD) return Verdict.Refused(FIRST_LINE)
        val params = request.optJSONObject("params") ?: JSONObject()
        val offered = params.optString("proof", "").toByteArray(Charsets.UTF_8)
        val expected = proof(key, "daemon", challenge).toByteArray(Charsets.UTF_8)
        // Constant time: the comparison does not reveal how much matched.
        if (!MessageDigest.isEqual(expected, offered)) return Verdict.Refused("wrong token")
        val daemonNonce = params.optString("nonce", "")
        if (!isNonce(daemonNonce)) return Verdict.Refused("the daemon's nonce is missing or malformed")
        return Verdict.Accepted(ackLine(proof(key, "agent", daemonNonce)))
    }

    companion object {
        const val METHOD = "auth"

        /** How long a new connection has to authenticate. */
        const val DEADLINE_MS = 5_000

        private const val FIRST_LINE = "the first line must authenticate the connection"
        private const val NONCE_BYTES = 32
        private val random = SecureRandom()

        fun newNonce(): String {
            val bytes = ByteArray(NONCE_BYTES)
            random.nextBytes(bytes)
            return hex(bytes)
        }

        fun isNonce(s: String): Boolean = s.length == NONCE_BYTES * 2 && s.all { it in '0'..'9' || it in 'a'..'f' }

        /** HMAC-SHA256 of `"<role>:<nonce>"` keyed with [token], as lowercase hex. */
        fun proof(
            token: String,
            role: String,
            nonce: String,
        ): String = proof(token.toByteArray(Charsets.UTF_8), role, nonce)

        private fun proof(
            key: ByteArray,
            role: String,
            nonce: String,
        ): String {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(key, "HmacSHA256"))
            return hex(mac.doFinal("$role:$nonce".toByteArray(Charsets.UTF_8)))
        }

        private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

        fun challengeLine(nonce: String): String = JSONObject().put("id", METHOD).put("challenge", nonce).toString()

        fun ackLine(proof: String): String =
            JSONObject()
                .put("id", METHOD)
                .put("result", JSONObject().put("authenticated", true).put("proof", proof))
                .toString()

        fun refusalLine(reason: String): String =
            JSONObject()
                .put("id", METHOD)
                .put("error", JSONObject().put("type", "UNAUTHORIZED").put("message", reason))
                .toString()
    }
}
