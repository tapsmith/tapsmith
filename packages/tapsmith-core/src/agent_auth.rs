//! The secret every connection to an on-device agent must present first.
//!
//! Both agents listen on loopback only, but loopback is not private: any app
//! on an Android device can connect to the agent port, and a simulator's
//! agent listens on the Mac's own loopback. So each connection opens with an
//! auth line carrying a per-user token, and the agent closes any connection
//! that does not (PILOT-969):
//!
//! ```text
//! daemon → {"id":"auth","method":"auth","params":{"token":"<64 hex>"}}
//! agent  ← {"id":"auth","result":{"authenticated":true}}
//!       or {"id":"auth","error":{"type":"UNAUTHORIZED","message":"…"}} and close
//! ```
//!
//! The token is per user, not per daemon: a running iOS runner is adopted by
//! the next daemon on its port, which must be able to talk to it. It lives in
//! `~/.tapsmith/agent-token` (mode 0600) and reaches an agent at launch: the
//! Android instrumentation's `-e token` argument, the iOS runner's
//! `TAPSMITH_AGENT_TOKEN` environment variable.

use std::borrow::Cow;
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

/// What the logs show in place of the token.
const REDACTED: &str = "<agent-token>";

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

/// The auth line, newline included.
pub(crate) fn auth_request_line(token: &str) -> String {
    let mut line =
        json!({"id": AUTH_ID, "method": AUTH_ID, "params": {"token": token}}).to_string();
    line.push('\n');
    line
}

/// Judge the agent's answer to the auth line. `line` is what `read_line`
/// returned: empty at EOF.
pub(crate) fn check_auth_reply(line: &str) -> Result<()> {
    let line = line.trim();
    if line.is_empty() {
        bail!(
            "the agent closed the connection without answering \
             (not listening yet, or its process is gone)"
        );
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
        return Ok(());
    }
    let error_type = reply.pointer("/error/type").and_then(Value::as_str);
    let message = reply
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("no message");
    match error_type {
        Some("UNAUTHORIZED") => bail!(
            "the agent refused this daemon's token ({message}). It was started with a \
             different agent token than ~/.tapsmith/agent-token holds now, by another user \
             or before the file was replaced"
        ),
        Some(_) => bail!(
            "the agent does not support authentication ({message}), so it is from an older \
             Tapsmith build. Reinstall or rebuild the Tapsmith agent"
        ),
        None => bail!("unexpected answer to authentication: {line}"),
    }
}

/// Authenticate a fresh connection: send the auth line, read the agent's
/// answer. `timeout` bounds the exchange.
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
    tokio::time::timeout(timeout, async {
        writer
            .write_all(auth_request_line(token).as_bytes())
            .await?;
        writer.flush().await?;
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        Ok::<_, std::io::Error>(line)
    })
    .await
    .map_err(|_| anyhow!("the agent did not answer authentication within {timeout:?}"))?
    .map_err(|e| anyhow!(e).context("authentication failed"))
    .and_then(|line| check_auth_reply(&line))
}

/// `text` with this process's agent token replaced, for logs. Only redacts
/// once the token is loaded; nothing can carry it before that.
pub(crate) fn redact(text: &str) -> Cow<'_, str> {
    match TOKEN.get() {
        Some(Ok(token)) => redact_token(text, token),
        _ => Cow::Borrowed(text),
    }
}

fn redact_token<'a>(text: &'a str, token: &str) -> Cow<'a, str> {
    if text.contains(token) {
        Cow::Owned(text.replace(token, REDACTED))
    } else {
        Cow::Borrowed(text)
    }
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

    #[test]
    fn auth_line_is_one_json_line() {
        let line = auth_request_line("t0k");
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            v,
            json!({"id": "auth", "method": "auth", "params": {"token": "t0k"}})
        );
    }

    #[test]
    fn accepts_the_ack() {
        check_auth_reply("{\"id\":\"auth\",\"result\":{\"authenticated\":true}}\n").unwrap();
    }

    #[test]
    fn explains_each_refusal() {
        let eof = check_auth_reply("").unwrap_err().to_string();
        assert!(
            eof.contains("closed the connection without answering"),
            "{eof}"
        );

        let wrong = check_auth_reply(
            r#"{"id":"auth","error":{"type":"UNAUTHORIZED","message":"wrong token"}}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(wrong.contains("refused this daemon's token"), "{wrong}");
        assert!(wrong.contains("wrong token"), "{wrong}");

        // What an agent that predates authentication answers.
        let old = check_auth_reply(
            r#"{"id":"auth","error":{"type":"ACTION_FAILED","message":"Unknown method: auth"}}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(old.contains("older Tapsmith build"), "{old}");

        let turn = check_auth_reply(r#"{"id":"ping","result":{"pong":true}}"#)
            .unwrap_err()
            .to_string();
        assert!(turn.contains("out of turn"), "{turn}");

        let garbage = check_auth_reply("hello").unwrap_err().to_string();
        assert!(garbage.contains("not JSON"), "{garbage}");

        let not_ok = check_auth_reply(r#"{"id":"auth","result":{"authenticated":false}}"#)
            .unwrap_err()
            .to_string();
        assert!(not_ok.contains("unexpected answer"), "{not_ok}");
    }

    #[tokio::test]
    async fn authenticate_sends_the_line_and_reads_the_ack() {
        let (client, server) = tokio::io::duplex(1024);
        let agent = tokio::spawn(async move {
            let (r, mut w) = tokio::io::split(server);
            let mut r = BufReader::new(r);
            let mut line = String::new();
            r.read_line(&mut line).await.unwrap();
            w.write_all(b"{\"id\":\"auth\",\"result\":{\"authenticated\":true}}\n")
                .await
                .unwrap();
            line
        });
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        authenticate(&mut r, &mut w, "secret", Duration::from_secs(2))
            .await
            .unwrap();
        assert_eq!(agent.await.unwrap(), auth_request_line("secret"));
    }

    #[tokio::test]
    async fn authenticate_gives_up_on_a_silent_agent() {
        let (client, _server) = tokio::io::duplex(1024);
        let (r, mut w) = tokio::io::split(client);
        let mut r = BufReader::new(r);
        let err = authenticate(&mut r, &mut w, "secret", Duration::from_millis(50))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("did not answer authentication"), "{err}");
    }

    #[test]
    fn redacts_the_token() {
        let token = "ab".repeat(TOKEN_BYTES);
        let cmd = format!("am instrument -w -e token {token} dev.tapsmith.agent/.TapsmithAgent");
        let out = redact_token(&cmd, &token);
        assert!(!out.contains(&token));
        assert!(out.contains("-e token <agent-token> dev.tapsmith.agent"));
        assert!(matches!(
            redact_token("adb devices", &token),
            Cow::Borrowed(_)
        ));
    }
}
