//! How the daemon and an on-device agent prove to each other that they share
//! this user's agent token, before any command (PILOT-969).
//!
//! Both agents listen on loopback only, but loopback is not private: any app
//! on an Android device can connect to (or squat) the agent port, and a
//! simulator's agent listens on the Mac's own loopback. So every connection
//! opens with a mutual challenge-response, and the token itself never crosses
//! the wire: whoever answers on the port learns nothing it could reuse, and a
//! listener that cannot prove it holds the token never receives a command
//! (which can carry typed text).
//!
//! ```text
//! agent  → {"id":"auth","challenge":"<agent nonce>"}
//! daemon → {"id":"auth","method":"auth","params":{"nonce":"<daemon nonce>",
//!           "proof":HMAC(token, "daemon:" + agent nonce)}}
//! agent  → {"id":"auth","result":{"authenticated":true,
//!           "proof":HMAC(token, "agent:" + daemon nonce)}}
//!       or {"id":"auth","error":{"type":"UNAUTHORIZED","message":"…"}} and close
//! ```
//!
//! Nonces are 32 random bytes as 64 lowercase hex; HMAC is HMAC-SHA256 keyed
//! with the token's UTF-8 bytes, as lowercase hex. The `daemon:`/`agent:`
//! prefixes keep one side's proof from being replayed as the other's.
//!
//! The token is per user, not per daemon: a running iOS runner is adopted by
//! the next daemon on its port, which must be able to talk to it. It lives in
//! `~/.tapsmith/agent-token` (mode 0600) and reaches an agent at launch: the
//! Android instrumentation's `-e token` argument, the iOS runner's
//! `TAPSMITH_AGENT_TOKEN` environment variable.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};

/// The request id (and method) of the auth line.
pub(crate) const AUTH_ID: &str = "auth";

/// The instrumentation argument (Android) carrying the token.
pub(crate) const ANDROID_TOKEN_ARG: &str = "token";

/// The runner environment variable (iOS) carrying the token.
pub(crate) const IOS_TOKEN_ENV: &str = "TAPSMITH_AGENT_TOKEN";

const TOKEN_FILE: &str = "agent-token";
const TOKEN_BYTES: usize = 32;

static TOKEN: OnceLock<std::result::Result<String, String>> = OnceLock::new();

/// This user's agent token, read from (or first written to)
/// `~/.tapsmith/agent-token`. Loaded once per process.
pub(crate) fn agent_token() -> Result<&'static str> {
    TOKEN
        .get_or_init(|| {
            tapsmith_dir()
                .and_then(|dir| load_or_create_token_in(&dir))
                .map_err(|e| format!("{e:#}"))
        })
        .as_deref()
        .map_err(|e| anyhow!("Could not read or create the agent token: {e}"))
}

fn tapsmith_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not determine the home directory")?;
    Ok(home.join(".tapsmith"))
}

/// The token in `dir/agent-token`, creating it if the file is missing and
/// replacing it if it does not hold a token. Two daemons starting at once
/// agree on one token: each writes a private temp file and links it into
/// place, which only the first can do; the other reads the winner's.
pub(crate) fn load_or_create_token_in(dir: &Path) -> Result<String> {
    std::fs::create_dir_all(dir).with_context(|| format!("Failed to create {}", dir.display()))?;
    let path = dir.join(TOKEN_FILE);
    match std::fs::read_to_string(&path) {
        Ok(existing) if is_valid_token(existing.trim()) => {
            restrict_to_owner(&path)?;
            return Ok(existing.trim().to_string());
        }
        Ok(_) => {
            // Not a token (truncated, edited): replace it.
            let token = generate_token()?;
            let tmp = write_private_temp(dir, &token)?;
            tmp.persist(&path).map_err(|e| {
                anyhow!(e.error).context(format!("Failed to replace {}", path.display()))
            })?;
            return Ok(token);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(anyhow!(e).context(format!("Failed to read {}", path.display()))),
    }

    let token = generate_token()?;
    let tmp = write_private_temp(dir, &token)?;
    match std::fs::hard_link(tmp.path(), &path) {
        Ok(()) => Ok(token),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another daemon created it first; use theirs.
            let theirs = std::fs::read_to_string(&path)
                .with_context(|| format!("Failed to read {}", path.display()))?;
            let theirs = theirs.trim();
            if !is_valid_token(theirs) {
                bail!("{} does not hold an agent token", path.display());
            }
            Ok(theirs.to_string())
        }
        Err(e) => Err(anyhow!(e).context(format!("Failed to create {}", path.display()))),
    }
}

/// A temp file in `dir` holding `token`, readable by the owner only.
fn write_private_temp(dir: &Path, token: &str) -> Result<tempfile::NamedTempFile> {
    // `tempfile` creates the file with mode 0600 on unix.
    let mut tmp = tempfile::Builder::new()
        .prefix(".agent-token.")
        .tempfile_in(dir)
        .with_context(|| format!("Failed to create a temp file in {}", dir.display()))?;
    tmp.write_all(token.as_bytes())
        .and_then(|()| tmp.as_file().sync_all())
        .context("Failed to write the agent token")?;
    Ok(tmp)
}

/// Tighten a token file a user (or an older tool) left readable by others.
fn restrict_to_owner(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path)
            .with_context(|| format!("Failed to stat {}", path.display()))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .with_context(|| format!("Failed to restrict {}", path.display()))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn generate_token() -> Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("No secure random source: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn is_valid_token(s: &str) -> bool {
    s.len() == TOKEN_BYTES * 2 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A fresh nonce: 32 random bytes as lowercase hex.
fn new_nonce() -> Result<String> {
    generate_token()
}

/// HMAC-SHA256 of `"<role>:<nonce>"` keyed with `token`, as lowercase hex.
pub(crate) fn proof(token: &str, role: &str, nonce: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, token.as_bytes());
    let tag = ring::hmac::sign(&key, format!("{role}:{nonce}").as_bytes());
    tag.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Compare without revealing, through timing, how much matched.
fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// The agent's challenge, from the first line it sends. `line` is what
/// `read_line` returned: empty at EOF.
pub(crate) fn parse_challenge(line: &str) -> Result<String> {
    let line = line.trim();
    if line.is_empty() {
        bail!(
            "the agent closed the connection without answering \
             (not listening yet, or its process is gone)"
        );
    }
    let challenge = serde_json::from_str::<Value>(line)
        .ok()
        .filter(|v| v.get("id").and_then(Value::as_str) == Some(AUTH_ID))
        .and_then(|v| {
            v.get("challenge")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    match challenge {
        Some(nonce) if is_valid_token(&nonce) => Ok(nonce),
        _ => bail!("the listener on the agent port did not open with a Tapsmith agent challenge"),
    }
}

/// The daemon's answer to `challenge`, newline included.
pub(crate) fn auth_request_line(token: &str, challenge: &str, daemon_nonce: &str) -> String {
    let mut line = json!({
        "id": AUTH_ID,
        "method": AUTH_ID,
        "params": {"nonce": daemon_nonce, "proof": proof(token, "daemon", challenge)},
    })
    .to_string();
    line.push('\n');
    line
}

/// Judge the agent's answer to the auth line: it must accept the daemon and
/// prove it holds the token too. `line` is what `read_line` returned.
pub(crate) fn check_auth_reply(line: &str, token: &str, daemon_nonce: &str) -> Result<()> {
    let line = line.trim();
    if line.is_empty() {
        bail!("the agent closed the connection without answering authentication");
    }
    let reply: Value = serde_json::from_str(line).map_err(|_| {
        anyhow!("the agent answered authentication with something that is not JSON")
    })?;
    if reply.get("id").and_then(Value::as_str) != Some(AUTH_ID) {
        bail!("the agent answered authentication out of turn: {line}");
    }
    if reply
        .pointer("/result/authenticated")
        .and_then(Value::as_bool)
        == Some(true)
    {
        let offered = reply
            .pointer("/result/proof")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !constant_time_eq(offered, &proof(token, "agent", daemon_nonce)) {
            bail!(
                "the listener on the agent port did not prove it holds this user's agent \
                 token, so it is not a Tapsmith agent this user started"
            );
        }
        return Ok(());
    }
    let message = reply
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("no message");
    match reply.pointer("/error/type").and_then(Value::as_str) {
        Some("UNAUTHORIZED") => bail!(
            "the agent refused this daemon's token ({message}). It was started with a \
             different agent token than ~/.tapsmith/agent-token holds now, by another user \
             or before the file was replaced"
        ),
        _ => bail!("unexpected answer to authentication: {line}"),
    }
}

/// Authenticate a fresh connection both ways: read the agent's challenge,
/// answer it with this daemon's proof and nonce, check the agent's proof.
/// `timeout` bounds the exchange.
pub(crate) async fn authenticate<R, W>(
    reader: &mut R,
    writer: &mut W,
    token: &str,
    timeout: Duration,
) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let daemon_nonce = new_nonce()?;
    let deadline = tokio::time::Instant::now() + timeout;
    let mut line = String::new();
    tokio::time::timeout_at(deadline, reader.read_line(&mut line))
        .await
        .map_err(|_| {
            anyhow!(
                "the agent did not send its authentication challenge within {timeout:?} \
                 (it is from an older Tapsmith build that predates authentication, or it is \
                 not answering)"
            )
        })?
        .context("authentication failed")?;
    let challenge = parse_challenge(&line)?;

    let exchange = async {
        writer
            .write_all(auth_request_line(token, &challenge, &daemon_nonce).as_bytes())
            .await?;
        writer.flush().await?;
        line.clear();
        reader.read_line(&mut line).await?;
        Ok::<_, std::io::Error>(())
    };
    tokio::time::timeout_at(deadline, exchange)
        .await
        .map_err(|_| anyhow!("the agent did not answer authentication within {timeout:?}"))?
        .context("authentication failed")?;
    check_auth_reply(&line, token, &daemon_nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn creates_a_private_token_and_reuses_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_token_in(dir.path()).unwrap();
        assert!(is_valid_token(&first), "{first}");
        let second = load_or_create_token_in(dir.path()).unwrap();
        assert_eq!(first, second);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(TOKEN_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // No temp files left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from(TOKEN_FILE)]);
    }

    #[test]
    fn tokens_differ_between_users() {
        let a = load_or_create_token_in(tempfile::tempdir().unwrap().path()).unwrap();
        let b = load_or_create_token_in(tempfile::tempdir().unwrap().path()).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn creates_the_directory() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("home").join(".tapsmith");
        let token = load_or_create_token_in(&nested).unwrap();
        assert!(is_valid_token(&token));
    }

    #[test]
    fn replaces_a_file_that_does_not_hold_a_token() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(TOKEN_FILE), "not a token\n").unwrap();
        let token = load_or_create_token_in(dir.path()).unwrap();
        assert!(is_valid_token(&token));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(TOKEN_FILE)).unwrap(),
            token
        );
    }

    #[cfg(unix)]
    #[test]
    fn tightens_a_token_file_others_can_read() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(TOKEN_FILE);
        let token = "ab".repeat(TOKEN_BYTES);
        std::fs::write(&path, format!("{token}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_or_create_token_in(dir.path()).unwrap(), token);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn concurrent_creators_agree_on_one_token() {
        let dir = tempfile::tempdir().unwrap();
        let tokens: Vec<String> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..8)
                .map(|_| s.spawn(|| load_or_create_token_in(dir.path()).unwrap()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(tokens.windows(2).all(|w| w[0] == w[1]), "{tokens:?}");
    }

    const TOKEN: &str = "abababababababababababababababababababababababababababababababab";
    const NONCE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn proofs_match_the_shared_test_vector() {
        // The same vector is in the Android (AgentAuthTest.kt) and iOS
        // (AgentAuthTests/main.swift) agents' tests: all three must agree.
        assert_eq!(
            proof(TOKEN, "daemon", NONCE),
            "9a11a9da9d0f2172d5801943fbf6124fa424af0de00767c54b12a04791e64f3a"
        );
        assert_eq!(
            proof(TOKEN, "agent", NONCE),
            "9e9de4b1c2ee0bdfa527a9a8194aab687a211461a9461da1fd5fc353b2a91493"
        );
    }

    #[test]
    fn the_auth_line_carries_a_proof_never_the_token() {
        let line = auth_request_line(TOKEN, NONCE, "d".repeat(64).as_str());
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        assert!(!line.contains(TOKEN), "{line}");
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["method"], "auth");
        assert_eq!(v["params"]["nonce"], "d".repeat(64));
        assert_eq!(v["params"]["proof"], proof(TOKEN, "daemon", NONCE));
    }

    #[test]
    fn reads_the_agent_challenge() {
        let line = format!("{{\"id\":\"auth\",\"challenge\":\"{NONCE}\"}}\n");
        assert_eq!(parse_challenge(&line).unwrap(), NONCE);
        let eof = parse_challenge("").unwrap_err().to_string();
        assert!(
            eof.contains("closed the connection without answering"),
            "{eof}"
        );
        for bad in [
            "hello",
            r#"{"id":"ping","challenge":"0123"}"#,
            r#"{"id":"auth","challenge":"short"}"#,
            r#"{"id":"auth"}"#,
        ] {
            let err = parse_challenge(bad).unwrap_err().to_string();
            assert!(
                err.contains("did not open with a Tapsmith agent challenge"),
                "{bad}: {err}"
            );
        }
    }

    fn ack(proof: &str) -> String {
        json!({"id": "auth", "result": {"authenticated": true, "proof": proof}}).to_string()
    }

    #[test]
    fn accepts_an_ack_that_proves_the_agent_holds_the_token() {
        check_auth_reply(&ack(&proof(TOKEN, "agent", NONCE)), TOKEN, NONCE).unwrap();
    }

    #[test]
    fn refuses_an_ack_without_the_agents_proof() {
        // A squatter on the port cannot compute it, so it never gets a command.
        for bad in [
            ack(""),
            ack(&proof(TOKEN, "daemon", NONCE)), // our own proof reflected back
            ack(&proof(&"cd".repeat(32), "agent", NONCE)),
            r#"{"id":"auth","result":{"authenticated":true}}"#.to_string(),
        ] {
            let err = check_auth_reply(&bad, TOKEN, NONCE)
                .unwrap_err()
                .to_string();
            assert!(err.contains("did not prove it holds"), "{bad}: {err}");
        }
    }

    #[test]
    fn explains_each_refusal() {
        let wrong = check_auth_reply(
            r#"{"id":"auth","error":{"type":"UNAUTHORIZED","message":"wrong token"}}"#,
            TOKEN,
            NONCE,
        )
        .unwrap_err()
        .to_string();
        assert!(wrong.contains("refused this daemon's token"), "{wrong}");
        assert!(wrong.contains("wrong token"), "{wrong}");

        let eof = check_auth_reply("", TOKEN, NONCE).unwrap_err().to_string();
        assert!(eof.contains("closed the connection"), "{eof}");

        let turn = check_auth_reply(r#"{"id":"ping","result":{"pong":true}}"#, TOKEN, NONCE)
            .unwrap_err()
            .to_string();
        assert!(turn.contains("out of turn"), "{turn}");

        let garbage = check_auth_reply("hello", TOKEN, NONCE)
            .unwrap_err()
            .to_string();
        assert!(garbage.contains("not JSON"), "{garbage}");
    }

    /// A well-behaved agent's side of the exchange, over an in-memory pipe.
    async fn run_agent(server: tokio::io::DuplexStream, token: &'static str) -> String {
        let (r, mut w) = tokio::io::split(server);
        let mut r = BufReader::new(r);
        w.write_all(format!("{{\"id\":\"auth\",\"challenge\":\"{NONCE}\"}}\n").as_bytes())
            .await
            .unwrap();
        let mut line = String::new();
        r.read_line(&mut line).await.unwrap();
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["params"]["proof"], proof(token, "daemon", NONCE));
        let daemon_nonce = v["params"]["nonce"].as_str().unwrap().to_string();
        w.write_all(format!("{}\n", ack(&proof(token, "agent", &daemon_nonce))).as_bytes())
            .await
            .unwrap();
        line
    }

    #[tokio::test]
    async fn authenticate_completes_the_exchange_without_sending_the_token() {
        let (client, server) = tokio::io::duplex(4096);
        let agent = tokio::spawn(run_agent(server, TOKEN));
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        authenticate(&mut r, &mut w, TOKEN, Duration::from_secs(2))
            .await
            .unwrap();
        let sent = agent.await.unwrap();
        assert!(!sent.contains(TOKEN), "{sent}");
    }

    #[tokio::test]
    async fn authenticate_gives_up_on_a_silent_listener() {
        // An agent from before authentication waits for the client to speak.
        let (client, _server) = tokio::io::duplex(1024);
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        let err = authenticate(&mut r, &mut w, TOKEN, Duration::from_millis(50))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("did not send its authentication challenge"),
            "{err}"
        );
        assert!(err.contains("older Tapsmith build"), "{err}");
    }
}
