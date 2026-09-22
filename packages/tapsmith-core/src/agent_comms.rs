use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

use crate::adb;

/// Port the on-device agent listens on (device side).
const AGENT_DEVICE_PORT: u16 = 18700;

/// Default local port we forward to.
const DEFAULT_AGENT_HOST_PORT: u16 = 18700;

/// Default timeout for agent commands.
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Default headroom added to the read-side timeout so the daemon always
/// outlasts the agent's own work clock. Without this, an agent command that
/// uses up its full client-supplied timeout (e.g. FindElement(timeout_ms=100))
/// races the daemon's read timeout — the daemon may give up before the agent's
/// "not found" response arrives, falsely marking the connection as dead and
/// triggering an unnecessary reconnect on the next command.
///
/// This headroom matters most for `findElements`, which the on-device agent
/// runs to completion *ignoring* the client timeout (a UIAutomator hierarchy
/// dump is a single uninterruptible native call). So in practice this value is
/// the ceiling on how long one hierarchy dump may take before the daemon
/// declares the command timed out. On CPU-starved CI emulators a dump can
/// exceed the 5s default; raise it via `TAPSMITH_AGENT_READ_HEADROOM_MS`
/// (milliseconds) rather than lowering it — trimming this converts a slow-but-
/// completing dump into a hard "Agent command timed out".
const DEFAULT_READ_TIMEOUT_HEADROOM: Duration = Duration::from_secs(5);

/// Env var overriding [`DEFAULT_READ_TIMEOUT_HEADROOM`], in milliseconds.
const READ_TIMEOUT_HEADROOM_ENV: &str = "TAPSMITH_AGENT_READ_HEADROOM_MS";

/// Parse the read-timeout headroom from an env-var value. A missing, empty, or
/// unparseable value falls back to [`DEFAULT_READ_TIMEOUT_HEADROOM`] so a
/// typo can never silently produce a zero (or absurd) timeout.
fn parse_read_timeout_headroom(raw: Option<&str>) -> Duration {
    raw.and_then(|s| s.trim().parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_READ_TIMEOUT_HEADROOM)
}

/// Read-side timeout headroom, honoring `TAPSMITH_AGENT_READ_HEADROOM_MS`.
/// Cached: the env var is read once per process.
fn read_timeout_headroom() -> Duration {
    static HEADROOM: OnceLock<Duration> = OnceLock::new();
    *HEADROOM.get_or_init(|| {
        parse_read_timeout_headroom(std::env::var(READ_TIMEOUT_HEADROOM_ENV).ok().as_deref())
    })
}

/// Upper bound for a computed read timeout. `tokio::time::timeout` adds the
/// duration to `Instant::now()`, so `Duration::MAX` (or anything close) would
/// overflow the timer and panic. One year is practically infinite for a single
/// agent command yet leaves ample headroom before the `Instant` overflows.
const MAX_READ_TIMEOUT: Duration = Duration::from_secs(60 * 60 * 24 * 365);

/// Pure `timeout + headroom` saturated to [`MAX_READ_TIMEOUT`]. Saturating
/// (rather than `+`) avoids a panic both from the addition itself overflowing
/// and, downstream, from `tokio::time::timeout` overflowing `Instant::now() +
/// duration` — the latter is why we cap well below `Duration::MAX`. Split out
/// from [`read_timeout_for`] so it's testable without the ambient env var.
fn saturating_read_timeout(timeout: Duration, headroom: Duration) -> Duration {
    timeout
        .checked_add(headroom)
        .unwrap_or(MAX_READ_TIMEOUT)
        .min(MAX_READ_TIMEOUT)
}

/// Compute the read-side timeout for an agent command: the caller's timeout
/// plus the configured headroom (`TAPSMITH_AGENT_READ_HEADROOM_MS`), saturated
/// to [`MAX_READ_TIMEOUT`].
fn read_timeout_for(timeout: Duration) -> Duration {
    saturating_read_timeout(timeout, read_timeout_headroom())
}

/// Timeout for each half (connect, then read) of a liveness probe after an
/// empty-response EOF. The probe is a real ping round-trip, so it has to
/// leave a busy agent time to answer, but it sits on the command hot path
/// so it stays tight.
const AGENT_LIVENESS_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Timeout for each half (connect, then read) of a handshake ping.
const AGENT_PING_TIMEOUT: Duration = Duration::from_secs(3);

/// How long `connect_ios` keeps pinging an agent that should already be up
/// before declaring it unreachable.
const DEFAULT_CONNECT_READINESS: Duration = Duration::from_secs(8);

/// Pause between handshake pings while waiting for an agent to answer.
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_secs(1);

/// Sentinel string used by `try_send_command` to mark an empty-response
/// failure. `anyhow::Error` does not preserve original error types across
/// contexts, so we match on the root message. Kept in sync with the
/// `bail!` site above.
const EMPTY_RESPONSE_MARKER: &str = "Agent returned empty response";

/// Returns true when the given error chain indicates an "empty response
/// from agent" EOF. Matches the string used in the `bail!` above.
fn is_empty_response(err: &anyhow::Error) -> bool {
    err.chain()
        .any(|cause| cause.to_string().contains(EMPTY_RESPONSE_MARKER))
}

/// Probe whether the agent is alive by round-tripping a real ping on a
/// fresh connection. Returns true only if the agent ANSWERS.
///
/// A bare TCP connect is not evidence of life. On Android the host port is
/// an `adb forward`: the adb server accepts every connect itself and only
/// then tries the device side, closing the socket when nothing listens
/// there. A connect-only probe therefore reported a crashed or
/// not-yet-listening agent as alive, which turned every EOF into
/// "reconnecting" and let StartAgent reuse an agent that was gone.
async fn probe_agent_alive(host_port: u16) -> bool {
    ping_agent_port_with_timeout(host_port, AGENT_LIVENESS_PROBE_TIMEOUT)
        .await
        .is_ok()
}

pub(crate) async fn ping_agent_port(host_port: u16) -> Result<()> {
    ping_agent_port_with_timeout(host_port, AGENT_PING_TIMEOUT).await
}

/// Connect, send a `ping`, and require a non-empty reply. `timeout` bounds
/// the connect and the read separately.
///
/// EOF is a failure, not a pong. Through `adb forward` the connect and the
/// write both succeed with no agent on the device — adb closes the socket
/// and `read_line` returns an empty line. Counting that as success declared
/// a still-starting or dead Android agent "connected" and made the reuse
/// check in StartAgent keep a dead agent forever.
pub(crate) async fn ping_agent_port_with_timeout(host_port: u16, timeout: Duration) -> Result<()> {
    let addr = format!("127.0.0.1:{host_port}");
    let mut stream = tokio::time::timeout(timeout, TcpStream::connect(&addr))
        .await
        .map_err(|_| anyhow!("Timed out connecting to agent"))?
        .context("Agent socket not reachable")?;

    let ping = r#"{"id":"ping","method":"ping","params":{}}"#;
    stream.write_all(ping.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;

    let mut reader = BufReader::new(&mut stream);
    let mut line = String::new();

    tokio::time::timeout(timeout, reader.read_line(&mut line))
        .await
        .map_err(|_| anyhow!("Agent did not respond to ping"))??;

    if line.trim().is_empty() {
        bail!(
            "Agent closed the connection without answering the ping \
             (not listening yet, or its process is gone)"
        );
    }

    debug!(response = %line.trim(), "Agent ping successful");
    Ok(())
}

/// Categorizes a `try_send_command` failure so the caller can decide whether
/// retrying is safe. See the long comment on `send_command_with_timeout` for
/// the reasoning.
enum SendError {
    /// Failed before writing any byte to the agent. Safe to retry.
    Connect(anyhow::Error),
    /// TCP connection succeeded; the agent may have observed the command
    /// (or part of it). Not safe to retry side-effectful commands.
    PostSend(anyhow::Error),
}

impl From<SendError> for anyhow::Error {
    fn from(value: SendError) -> Self {
        match value {
            SendError::Connect(e) | SendError::PostSend(e) => e,
        }
    }
}

/// A reusable TCP connection to the on-device agent. Split into owned
/// halves so the `BufReader` retains any buffered data across calls.
pub(crate) struct PersistentStream {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    host_port: u16,
}

pub(crate) type AgentStreamCache = Arc<tokio::sync::Mutex<Option<PersistentStream>>>;

pub(crate) fn new_agent_stream_cache() -> AgentStreamCache {
    Arc::new(tokio::sync::Mutex::new(None))
}

pub(crate) async fn clear_stream_cache(cache: &AgentStreamCache) {
    *cache.lock().await = None;
}

async fn connect_persistent(host_port: u16) -> Result<PersistentStream, SendError> {
    let addr = format!("127.0.0.1:{}", host_port);
    let stream = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(&addr))
        .await
        .map_err(|_| SendError::Connect(anyhow!("Timed out connecting to agent socket")))?
        .map_err(|e| SendError::Connect(anyhow!(e).context("Failed to connect to agent socket")))?;
    stream.set_nodelay(true).ok();
    let (read_half, write_half) = stream.into_split();
    Ok(PersistentStream {
        reader: BufReader::new(read_half),
        writer: write_half,
        host_port,
    })
}

async fn try_send_persistent(
    stream: &mut PersistentStream,
    command: &AgentCommand,
    timeout: Duration,
) -> std::result::Result<AgentResponse, SendError> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let json_msg = command.to_json(&request_id);
    let mut payload = serde_json::to_string(&json_msg)
        .map_err(|e| SendError::PostSend(anyhow!(e).context("Failed to serialize command")))?;
    debug!(payload = %payload, "Sending command to agent (persistent)");
    payload.push('\n');

    // Write phase. Single write avoids two TCP packets with NODELAY.
    // Write failure means the connection is dead — safe to retry
    // (Connect). Flush pushes the full message to the kernel send
    // buffer where it may reach the agent — classify as PostSend.
    if let Err(e) = stream.writer.write_all(payload.as_bytes()).await {
        return Err(SendError::Connect(
            anyhow!(e).context("Failed to write to agent socket"),
        ));
    }
    if let Err(e) = stream.writer.flush().await {
        return Err(SendError::PostSend(
            anyhow!(e).context("Failed to flush agent socket"),
        ));
    }

    // Read — once flushed, the agent may have the command
    let read_timeout = read_timeout_for(timeout);
    let mut line = String::new();
    let read_result = tokio::time::timeout(read_timeout, stream.reader.read_line(&mut line)).await;

    match read_result {
        Err(_) => Err(SendError::PostSend(anyhow!(
            "Agent command timed out after {read_timeout:?}"
        ))),
        Ok(Err(e)) => {
            // Connection-reset/broken-pipe on read: the TCP connection
            // died after we flushed the command. Probe whether the
            // agent is still listening — if so, the old connection was
            // stale and it's safe to retry on a fresh one. If the
            // agent is gone, it may have processed the command before
            // crashing, so treat as PostSend (no retry).
            use std::io::ErrorKind::*;
            let kind = e.kind();
            if matches!(kind, ConnectionReset | ConnectionAborted | BrokenPipe) {
                if probe_agent_alive(stream.host_port).await {
                    Err(SendError::Connect(
                        anyhow!(e).context("Agent connection lost during read"),
                    ))
                } else {
                    Err(SendError::PostSend(
                        anyhow!(e).context("Agent connection lost and agent is unreachable"),
                    ))
                }
            } else {
                Err(SendError::PostSend(
                    anyhow!(e).context("Failed to read from agent socket"),
                ))
            }
        }
        Ok(Ok(_)) => {
            let line = line.trim();
            if line.is_empty() {
                return if probe_agent_alive(stream.host_port).await {
                    Err(SendError::Connect(
                        anyhow!("{}", EMPTY_RESPONSE_MARKER)
                            .context("Agent connection dropped (empty response); reconnecting"),
                    ))
                } else {
                    Err(SendError::PostSend(
                        anyhow!("{}", EMPTY_RESPONSE_MARKER).context(
                            "Agent connection dropped (empty response) and agent is unreachable",
                        ),
                    ))
                };
            }
            debug!(response = %line, "Received response from agent (persistent)");
            let raw: Value = serde_json::from_str(line).map_err(|e| {
                SendError::PostSend(anyhow!(e).context("Failed to parse agent response as JSON"))
            })?;
            // Verify response ID matches to detect desync from a
            // late response on a reused connection.
            match raw.get("id").and_then(|v| v.as_str()) {
                Some(resp_id) if resp_id != request_id => {
                    return Err(SendError::PostSend(anyhow!(
                        "Response ID mismatch: expected '{request_id}', got '{resp_id}'"
                    )));
                }
                _ => {}
            }
            Ok(AgentResponse::from_json(&raw))
        }
    }
}

pub(crate) async fn send_with_persistent_cache(
    cache: &AgentStreamCache,
    params: &ConnectionParams,
    command: &AgentCommand,
    timeout: Duration,
) -> Result<AgentResponse> {
    let mut guard = cache.lock().await;

    // Discard stale stream if port changed
    if guard
        .as_ref()
        .is_some_and(|s| s.host_port != params.host_port)
    {
        debug!("Agent port changed, dropping cached stream");
        *guard = None;
    }

    // Retry loop: allow one retry for any Connect-class error, whether
    // from the initial connect or from a broken cached stream. This
    // matches the old per-command code's single-retry behaviour, which
    // is important right after restartApp when the agent's socket is
    // briefly down.
    let mut retried = false;
    loop {
        // Establish connection if needed
        if guard.is_none() {
            match connect_persistent(params.host_port).await {
                Ok(s) => *guard = Some(s),
                Err(e) => {
                    let err: anyhow::Error = e.into();
                    if !retried {
                        retried = true;
                        warn!("Agent connect failed, retrying: {err}");
                        continue;
                    }
                    return Err(err);
                }
            }
        }

        // Take the stream out during I/O so that if this future is
        // cancelled mid-await, the stream is dropped rather than left
        // in a half-read state that would desync the next command.
        let mut stream = guard.take().unwrap();
        match try_send_persistent(&mut stream, command, timeout).await {
            Ok(resp) => {
                *guard = Some(stream);
                return Ok(resp);
            }
            Err(SendError::PostSend(e)) => {
                return Err(e);
            }
            Err(SendError::Connect(e)) => {
                if !retried {
                    retried = true;
                    warn!("Persistent stream failed, reconnecting: {e}");
                    continue;
                }
                return Err(e);
            }
        }
    }
}

// ─── Agent Command Protocol ───
//
// Commands are serialized as: {"id": "uuid", "method": "methodName", "params": {...}}
// to match what the on-device Android agent expects.

#[derive(Debug, Clone)]
pub enum AgentCommand {
    FindElement {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    FindElements {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    Tap {
        selector: Value,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    /// iOS: resolve the screen point an element-addressed touch can land on
    /// without hitting something drawn over the element (PILOT-223), waiting
    /// up to `timeout_ms` for a cover to go away. The HID-injected gestures
    /// use it instead of `FindElement` so they never press a cover.
    // Only the macOS-only HID gesture paths construct it.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ResolveActionPoint {
        selector: Value,
        timeout_ms: Option<u64>,
    },
    LongPress {
        selector: Value,
        duration_ms: Option<u64>,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    TypeText {
        selector: Value,
        text: String,
        timeout_ms: Option<u64>,
        typing_delay_ms: Option<u32>,
        element_id: Option<String>,
    },
    ClearText {
        selector: Value,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    Swipe {
        direction: String,
        start_element: Option<Value>,
        speed: Option<f32>,
        distance: Option<f32>,
        timeout_ms: Option<u64>,
    },
    TapCoordinates {
        x: f32,
        y: f32,
    },
    LongPressCoordinates {
        x: f32,
        y: f32,
        duration_ms: u64,
    },
    DragCoordinates {
        from_x: f32,
        from_y: f32,
        to_x: f32,
        to_y: f32,
        duration_ms: u64,
    },
    InputText {
        text: String,
        typing_delay_ms: Option<u32>,
    },
    TouchDown {
        x: f32,
        y: f32,
        t_ms: u64,
    },
    TouchMove {
        x: f32,
        y: f32,
        t_ms: u64,
    },
    TouchUp {
        x: f32,
        y: f32,
        t_ms: u64,
    },
    TouchCancel {},
    Scroll {
        container: Option<Value>,
        direction: String,
        scroll_until_visible: Option<Value>,
        distance: Option<f32>,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    PressKey {
        key: String,
    },
    GetUiHierarchy {},
    WaitForIdle {
        timeout_ms: Option<u64>,
    },
    #[allow(dead_code)]
    Screenshot {},
    DoubleTap {
        selector: Value,
        timeout_ms: Option<u64>,
        interval_ms: Option<u64>,
        element_id: Option<String>,
    },
    DragAndDrop {
        source_selector: Value,
        target_selector: Value,
        timeout_ms: Option<u64>,
        source_element_id: Option<String>,
        target_element_id: Option<String>,
    },
    SelectOption {
        selector: Value,
        option: Option<String>,
        index: Option<i32>,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    PinchZoom {
        selector: Value,
        scale: f32,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    Focus {
        selector: Value,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    Blur {
        selector: Value,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    Highlight {
        selector: Value,
        duration_ms: Option<u64>,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    TakeElementScreenshot {
        selector: Value,
        timeout_ms: Option<u64>,
        element_id: Option<String>,
    },
    SetClipboard {
        text: String,
    },
    GetClipboard {},
    LaunchApp {
        package: String,
    },
    TerminateApp {
        package: String,
    },
    OpenDeepLink {
        url: String,
        package: String,
        deliver_in_process: bool,
        /// Require the UI hierarchy to change from its pre-delivery state
        /// before reporting success. Used for warm in-process delivery to an
        /// already-running app, where "app has rendered content" is trivially
        /// true and would mask a dropped Linking event.
        require_ui_change: bool,
        /// Acknowledge the delivery only once the `@tapsmith/react-native`
        /// marker's epoch is strictly greater than this value (the in-app
        /// reset completed). Replaces the hierarchy-change heuristic for
        /// declared app resets; the agent reports `epochAfter` in its data.
        ack_epoch_gt: Option<u64>,
        /// Per-process `boot` token read alongside `ack_epoch_gt`; lets the
        /// agent recognise the ack after a cold relaunch (see
        /// `app_reset::hooks_acknowledged`).
        ack_boot_before: Option<String>,
        /// Acknowledge a plain navigation link by the marker's `nav` counter
        /// advancing past this value (same-screen links verify instantly).
        ack_nav_gt: Option<u64>,
    },
    AcceptOpenInAppDialog {
        timeout_ms: Option<u64>,
    },
    HideKeyboard {},
    IsKeyboardShown {},
    SetOrientation {
        orientation: String,
    },
    GetOrientation {},
    GetColorScheme {},
    GetAppState {
        package: String,
    },
    CaptureTraceState {
        screenshot: bool,
        hierarchy: bool,
        selector: Option<Value>,
    },
    #[allow(dead_code)]
    DismissSystemDialog,
}

/// Add an `elementId` to an action's params when set. The agent honors
/// `elementId` ahead of any selector, acting on the exact previously-found
/// element — how positional/filtered handles target the element they resolved.
fn add_element_id(params: &mut Value, element_id: &Option<String>) {
    if let Some(id) = element_id {
        params["elementId"] = json!(id);
    }
}

impl AgentCommand {
    /// The wire method name for this command. Mirrors the `method` value in
    /// [`Self::to_json`] but returns a static string with no serialization or
    /// allocation, so it's cheap to call on hot paths (e.g. timing labels).
    pub(crate) fn method_name(&self) -> &'static str {
        match self {
            AgentCommand::FindElement { .. } => "findElement",
            AgentCommand::FindElements { .. } => "findElements",
            AgentCommand::Tap { .. } => "tap",
            AgentCommand::ResolveActionPoint { .. } => "resolveActionPoint",
            AgentCommand::LongPress { .. } => "longPress",
            AgentCommand::TypeText { .. } => "typeText",
            AgentCommand::ClearText { .. } => "clearText",
            AgentCommand::Swipe { .. } => "swipe",
            AgentCommand::TapCoordinates { .. } => "tap",
            AgentCommand::LongPressCoordinates { .. } => "longPress",
            AgentCommand::DragCoordinates { .. } => "swipe",
            AgentCommand::InputText { .. } => "typeText",
            AgentCommand::TouchDown { .. } => "touchDown",
            AgentCommand::TouchMove { .. } => "touchMove",
            AgentCommand::TouchUp { .. } => "touchUp",
            AgentCommand::TouchCancel {} => "touchCancel",
            AgentCommand::Scroll { .. } => "scroll",
            AgentCommand::PressKey { .. } => "pressKey",
            AgentCommand::GetUiHierarchy {} => "getUiHierarchy",
            AgentCommand::WaitForIdle { .. } => "waitForIdle",
            AgentCommand::Screenshot {} => "screenshot",
            AgentCommand::DoubleTap { .. } => "doubleTap",
            AgentCommand::DragAndDrop { .. } => "dragAndDrop",
            AgentCommand::SelectOption { .. } => "selectOption",
            AgentCommand::PinchZoom { .. } => "pinchZoom",
            AgentCommand::Focus { .. } => "focus",
            AgentCommand::Blur { .. } => "blur",
            AgentCommand::Highlight { .. } => "highlight",
            AgentCommand::TakeElementScreenshot { .. } => "elementScreenshot",
            AgentCommand::SetClipboard { .. } => "setClipboard",
            AgentCommand::GetClipboard {} => "getClipboard",
            AgentCommand::LaunchApp { .. } => "launchApp",
            AgentCommand::TerminateApp { .. } => "terminateApp",
            AgentCommand::OpenDeepLink { .. } => "openDeepLink",
            AgentCommand::AcceptOpenInAppDialog { .. } => "acceptOpenInAppDialog",
            AgentCommand::HideKeyboard {} => "hideKeyboard",
            AgentCommand::IsKeyboardShown {} => "isKeyboardShown",
            AgentCommand::SetOrientation { .. } => "setOrientation",
            AgentCommand::GetOrientation {} => "getOrientation",
            AgentCommand::GetColorScheme {} => "getColorScheme",
            AgentCommand::GetAppState { .. } => "getAppState",
            AgentCommand::CaptureTraceState { .. } => "captureTraceState",
            AgentCommand::DismissSystemDialog => "dismissSystemDialogs",
        }
    }

    /// Serialize into the JSON protocol format: {"id": "...", "method": "...", "params": {...}}
    pub(crate) fn to_json(&self, id: &str) -> Value {
        let (method, params) = match self {
            AgentCommand::FindElement {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("findElement", p)
            }
            AgentCommand::FindElements {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("findElements", p)
            }
            AgentCommand::Tap {
                selector,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("tap", p)
            }
            AgentCommand::ResolveActionPoint {
                selector,
                timeout_ms,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("resolveActionPoint", p)
            }
            AgentCommand::LongPress {
                selector,
                duration_ms,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(d) = duration_ms {
                    p["duration"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("longPress", p)
            }
            AgentCommand::TypeText {
                selector,
                text,
                timeout_ms,
                typing_delay_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                p["text"] = json!(text);
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                if let Some(d) = typing_delay_ms {
                    p["typingDelayMs"] = json!(d);
                }
                add_element_id(&mut p, element_id);
                ("typeText", p)
            }
            AgentCommand::ClearText {
                selector,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("clearText", p)
            }
            AgentCommand::Swipe {
                direction,
                start_element,
                speed,
                distance,
                timeout_ms,
            } => {
                let mut p = json!({"direction": direction});
                if let Some(se) = start_element {
                    p["startElement"] = se.clone();
                }
                if let Some(s) = speed {
                    p["speed"] = json!(s);
                }
                if let Some(d) = distance {
                    p["distance"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("swipe", p)
            }
            AgentCommand::TapCoordinates { x, y } => ("tap", json!({"x": x, "y": y})),
            AgentCommand::LongPressCoordinates { x, y, duration_ms } => (
                "longPress",
                json!({"x": x, "y": y, "duration": duration_ms}),
            ),
            AgentCommand::DragCoordinates {
                from_x,
                from_y,
                to_x,
                to_y,
                duration_ms,
            } => (
                "swipe",
                json!({
                    "fromX": from_x,
                    "fromY": from_y,
                    "toX": to_x,
                    "toY": to_y,
                    "durationMs": duration_ms
                }),
            ),
            AgentCommand::InputText {
                text,
                typing_delay_ms,
            } => {
                let mut p = json!({"text": text, "focused": true});
                if let Some(d) = typing_delay_ms {
                    p["typingDelayMs"] = json!(d);
                }
                ("typeText", p)
            }
            AgentCommand::TouchDown { x, y, t_ms } => {
                ("touchDown", json!({"x": x, "y": y, "t": t_ms}))
            }
            AgentCommand::TouchMove { x, y, t_ms } => {
                ("touchMove", json!({"x": x, "y": y, "t": t_ms}))
            }
            AgentCommand::TouchUp { x, y, t_ms } => ("touchUp", json!({"x": x, "y": y, "t": t_ms})),
            AgentCommand::TouchCancel {} => ("touchCancel", json!({})),
            AgentCommand::Scroll {
                container,
                direction,
                scroll_until_visible,
                distance,
                timeout_ms,
                element_id,
            } => {
                let mut p = json!({"direction": direction});
                if let Some(c) = container {
                    p["container"] = c.clone();
                }
                add_element_id(&mut p, element_id);
                if let Some(sv) = scroll_until_visible {
                    p["scrollTo"] = sv.clone();
                }
                if let Some(d) = distance {
                    p["distance"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("scroll", p)
            }
            AgentCommand::PressKey { key } => ("pressKey", json!({"key": key})),
            AgentCommand::GetUiHierarchy {} => ("getUiHierarchy", json!({})),
            AgentCommand::WaitForIdle { timeout_ms } => {
                let mut p = json!({});
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("waitForIdle", p)
            }
            AgentCommand::Screenshot {} => ("screenshot", json!({})),
            AgentCommand::DoubleTap {
                selector,
                timeout_ms,
                interval_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                if let Some(i) = interval_ms {
                    p["intervalMs"] = json!(i);
                }
                add_element_id(&mut p, element_id);
                ("doubleTap", p)
            }
            AgentCommand::DragAndDrop {
                source_selector,
                target_selector,
                timeout_ms,
                source_element_id,
                target_element_id,
            } => {
                // Each end is addressed by its cached id (positional/filtered
                // handle) or by selector. The agent honors `elementId` in the
                // source/target params ahead of any selector.
                let source = match source_element_id {
                    Some(id) => json!({ "elementId": id }),
                    None => source_selector.clone(),
                };
                let target = match target_element_id {
                    Some(id) => json!({ "elementId": id }),
                    None => target_selector.clone(),
                };
                let mut p = json!({ "source": source, "target": target });
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("dragAndDrop", p)
            }
            AgentCommand::SelectOption {
                selector,
                option,
                index,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(ref opt) = option {
                    p["option"] = json!(opt);
                }
                if let Some(idx) = index {
                    p["index"] = json!(idx);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("selectOption", p)
            }
            AgentCommand::PinchZoom {
                selector,
                scale,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                p["scale"] = json!(scale);
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("pinchZoom", p)
            }
            AgentCommand::Focus {
                selector,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("focus", p)
            }
            AgentCommand::Blur {
                selector,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("blur", p)
            }
            AgentCommand::Highlight {
                selector,
                duration_ms,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(d) = duration_ms {
                    p["duration"] = json!(d);
                }
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("highlight", p)
            }
            AgentCommand::TakeElementScreenshot {
                selector,
                timeout_ms,
                element_id,
            } => {
                let mut p = selector.clone();
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                add_element_id(&mut p, element_id);
                ("elementScreenshot", p)
            }
            AgentCommand::SetClipboard { text } => ("setClipboard", json!({"text": text})),
            AgentCommand::GetClipboard {} => ("getClipboard", json!({})),
            AgentCommand::LaunchApp { package } => ("launchApp", json!({ "bundleId": package })),
            AgentCommand::TerminateApp { package } => {
                ("terminateApp", json!({ "bundleId": package }))
            }
            AgentCommand::OpenDeepLink {
                url,
                package,
                deliver_in_process,
                require_ui_change,
                ack_epoch_gt,
                ack_boot_before,
                ack_nav_gt,
            } => {
                let mut p = json!({
                    "url": url,
                    "bundleId": package,
                    "deliverInProcess": deliver_in_process,
                    "requireUiChange": require_ui_change,
                });
                if let Some(epoch) = ack_epoch_gt {
                    p["ackEpochGreaterThan"] = json!(epoch);
                }
                if let Some(boot) = ack_boot_before {
                    p["ackBootBefore"] = json!(boot);
                }
                if let Some(nav) = ack_nav_gt {
                    p["ackNavGreaterThan"] = json!(nav);
                }
                ("openDeepLink", p)
            }
            AgentCommand::AcceptOpenInAppDialog { timeout_ms } => {
                let mut p = json!({});
                if let Some(t) = timeout_ms {
                    p["timeout"] = json!(t);
                }
                ("acceptOpenInAppDialog", p)
            }
            AgentCommand::HideKeyboard {} => ("hideKeyboard", json!({})),
            AgentCommand::IsKeyboardShown {} => ("isKeyboardShown", json!({})),
            AgentCommand::SetOrientation { orientation } => {
                ("setOrientation", json!({ "orientation": orientation }))
            }
            AgentCommand::GetOrientation {} => ("getOrientation", json!({})),
            AgentCommand::GetColorScheme {} => ("getColorScheme", json!({})),
            AgentCommand::GetAppState { package } => {
                ("getAppState", json!({ "bundleId": package }))
            }
            AgentCommand::CaptureTraceState {
                screenshot,
                hierarchy,
                selector,
            } => {
                let mut p = match selector.clone() {
                    Some(Value::Object(map)) => Value::Object(map),
                    _ => json!({}),
                };
                p["screenshot"] = json!(screenshot);
                p["hierarchy"] = json!(hierarchy);
                ("captureTraceState", p)
            }
            AgentCommand::DismissSystemDialog => ("dismissSystemDialogs", json!({})),
        };

        json!({
            "id": id,
            "method": method,
            "params": params
        })
    }
}

/// Response from the on-device agent.
/// Format: {"id": "...", "result": {...}} or {"id": "...", "error": {"type": "...", "message": "..."}}
#[derive(Debug, Clone)]
pub struct AgentResponse {
    pub success: bool,
    pub error: Option<String>,
    pub error_type: Option<String>,
    pub data: Value,
}

impl AgentResponse {
    pub(crate) fn from_json(value: &Value) -> Self {
        if let Some(error) = value.get("error") {
            AgentResponse {
                success: false,
                error: error
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                error_type: error.get("type").and_then(|v| v.as_str()).map(String::from),
                data: Value::Null,
            }
        } else {
            AgentResponse {
                success: true,
                error: None,
                error_type: None,
                data: value.get("result").cloned().unwrap_or(Value::Null),
            }
        }
    }
}

// ─── Connection Management ───

/// Snapshot of the fields needed to send a command over TCP, extracted under
/// a brief read lock so the actual I/O happens without holding the lock.
#[derive(Debug, Clone)]
pub struct ConnectionParams {
    pub host_port: u16,
}

/// Manages the TCP connection to the on-device Tapsmith agent.
#[derive(Debug)]
pub struct AgentConnection {
    connected: bool,
    device_serial: Option<String>,
    host_port: u16,
    is_ios: bool,
}

impl AgentConnection {
    pub fn new() -> Self {
        Self::with_port(DEFAULT_AGENT_HOST_PORT)
    }

    pub fn with_port(host_port: u16) -> Self {
        Self {
            connected: false,
            device_serial: None,
            host_port,
            is_ios: false,
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    pub fn port(&self) -> u16 {
        self.host_port
    }

    pub fn connected_host_port_for(&self, serial: &str, is_ios: bool) -> Option<u16> {
        if self.connected && self.is_ios == is_ios && self.device_serial.as_deref() == Some(serial)
        {
            Some(self.host_port)
        } else {
            None
        }
    }

    /// Snapshot the connection params needed for TCP I/O. Returns an error if
    /// the agent is not connected. Designed to be called under a brief read
    /// lock so the caller can release the lock before doing the actual I/O.
    pub fn connection_params(&self) -> Result<ConnectionParams> {
        if !self.connected {
            bail!("Not connected to agent. Call StartAgent or connect first.");
        }
        Ok(ConnectionParams {
            host_port: self.host_port,
        })
    }

    /// Establish port forwarding and verify the agent is reachable.
    /// For Android, sets up ADB port forwarding.
    /// For iOS simulators, no forwarding is needed (shared localhost).
    /// Connect to an Android agent whose instrumentation was launched
    /// moments ago, giving it `readiness` to bind its socket and answer.
    /// UIAutomator's accessibility bootstrap on a cold software-GPU CI
    /// emulator takes tens of seconds; the loop returns as soon as the
    /// first real pong arrives, so a fast agent pays nothing for the
    /// headroom.
    pub async fn connect_android_with_readiness(
        &mut self,
        serial: &str,
        readiness: Duration,
    ) -> Result<()> {
        self.connect_for_platform(serial, false, readiness).await
    }

    /// Connect to an iOS agent (skip ADB port forwarding).
    pub async fn connect_ios(&mut self, serial: &str) -> Result<()> {
        self.connect_for_platform(serial, true, DEFAULT_CONNECT_READINESS)
            .await
    }

    async fn connect_for_platform(
        &mut self,
        serial: &str,
        ios: bool,
        readiness: Duration,
    ) -> Result<()> {
        self.is_ios = ios;

        if !ios {
            // Android: Set up ADB port forwarding
            adb::forward_port(serial, self.host_port, AGENT_DEVICE_PORT)
                .await
                .context("Failed to set up ADB port forwarding to agent")?;
        }
        // iOS simulator: agent listens on localhost directly, no forwarding needed

        // Ping until the agent answers or `readiness` runs out. A freshly
        // launched agent can accept the launch-time socket probe yet miss
        // the very next ping while the runner finishes initializing
        // (observed on loaded CI runners), and through `adb forward` an
        // agent that has not bound its port yet answers with an immediate
        // EOF — `ping_agent` rejects that, so this loop is what actually
        // waits for the agent to come up.
        let deadline = tokio::time::Instant::now() + readiness;
        let mut attempt = 0u32;
        let last_err = loop {
            match self.ping_agent().await {
                Ok(_) => {
                    self.connected = true;
                    self.device_serial = Some(serial.to_string());
                    info!(
                        serial,
                        platform = if ios { "ios" } else { "android" },
                        attempt,
                        "Connected to on-device agent"
                    );
                    return Ok(());
                }
                Err(e) => {
                    debug!(serial, attempt, error = %e, "agent handshake ping failed");
                    if tokio::time::Instant::now() >= deadline {
                        break e;
                    }
                    attempt += 1;
                    tokio::time::sleep(CONNECT_RETRY_INTERVAL).await;
                }
            }
        };
        if !ios {
            // Clean up the forwarding on failure
            let _ = adb::remove_forward(serial, self.host_port).await;
        }
        bail!(
            "Agent is not responding on device {serial} after {}s: {last_err}. Is the agent app running?",
            readiness.as_secs()
        );
    }

    /// Disconnect and clean up port forwarding.
    #[allow(dead_code)]
    pub async fn disconnect(&mut self) {
        if !self.is_ios {
            if let Some(ref serial) = self.device_serial {
                let _ = adb::remove_forward(serial, self.host_port).await;
            }
        }
        self.connected = false;
        self.device_serial = None;
        debug!("Agent disconnected");
    }

    /// Send a command to the agent and wait for a response.
    /// Retained for tests that exercise the retry/classification logic.
    #[allow(dead_code)]
    pub async fn send_command(&mut self, command: &AgentCommand) -> Result<AgentResponse> {
        self.send_command_with_timeout(command, DEFAULT_COMMAND_TIMEOUT)
            .await
    }

    /// Send a command with a specific timeout.
    #[allow(dead_code)]
    pub async fn send_command_with_timeout(
        &mut self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> Result<AgentResponse> {
        if !self.connected {
            bail!("Not connected to agent. Call StartAgent or connect first.");
        }

        // We split failures into two classes:
        //
        // 1. Connect-time failures (we never wrote a single byte to the agent)
        //    — safe to retry. The command was never observed by the agent, so
        //    even side-effectful commands like tap/openDeepLink can be tried
        //    again without double-executing. This matters in practice right
        //    after `restartApp`: force-stopping the target app briefly tears
        //    down the agent's listening socket on Android while the agent
        //    process re-binds, so the very next command can hit a transient
        //    "Failed to connect to agent socket".
        //
        // 2. Post-send failures (we already wrote the command to the socket)
        //    — NOT safe to retry. The agent may have processed the command
        //    even if the response was dropped, so retrying would double up
        //    side-effectful commands. The trace collector swallows transient
        //    hierarchy/screen capture errors, so a single dropped response is
        //    still non-fatal for non-essential commands.
        //
        // In neither case do we flip `self.connected = false`: a transient
        // socket blip does not mean the agent process is dead, and poisoning
        // the cached connection flag would trigger expensive recovery on the
        // next test's session preflight.
        match self.try_send_command(command, timeout).await {
            Ok(resp) => Ok(resp),
            Err(SendError::Connect(e)) => {
                warn!("Agent connect failed, retrying once: {e}");
                self.try_send_command(command, timeout)
                    .await
                    .map_err(Into::into)
            }
            Err(SendError::PostSend(e)) => Err(e),
        }
    }

    #[allow(dead_code)]
    async fn try_send_command(
        &self,
        command: &AgentCommand,
        timeout: Duration,
    ) -> std::result::Result<AgentResponse, SendError> {
        let addr = format!("127.0.0.1:{}", self.host_port);
        let mut stream = tokio::time::timeout(Duration::from_secs(5), async {
            TcpStream::connect(&addr).await
        })
        .await
        .map_err(|_| SendError::Connect(anyhow!("Timed out connecting to agent socket")))?
        .map_err(|e| SendError::Connect(anyhow!(e).context("Failed to connect to agent socket")))?;

        // Everything past the successful TCP connect normally counts as a
        // "post-send" failure: even if the write hasn't happened yet, we
        // treat it as unsafe to retry once we've claimed a socket, because
        // in practice the write is what fails most of the time and we can't
        // tell from the outside whether the agent observed it.
        //
        // The exception is EOF ("empty response"): see below.
        let io_result: Result<AgentResponse> = async {
            let request_id = uuid::Uuid::new_v4().to_string();
            let json_msg = command.to_json(&request_id);
            let payload =
                serde_json::to_string(&json_msg).context("Failed to serialize command")?;
            debug!(payload = %payload, "Sending command to agent");

            // Write the command as a newline-delimited JSON message
            stream
                .write_all(payload.as_bytes())
                .await
                .context("Failed to write to agent socket")?;
            stream
                .write_all(b"\n")
                .await
                .context("Failed to write newline to agent socket")?;
            stream.flush().await?;

            // Read the response (newline-delimited JSON). Use the caller-
            // supplied timeout plus headroom so the agent's own work clock
            // always finishes first — see DEFAULT_READ_TIMEOUT_HEADROOM for the
            // rationale.
            let read_timeout = read_timeout_for(timeout);
            let reader = BufReader::new(&mut stream);
            let mut line = String::new();

            tokio::time::timeout(read_timeout, async {
                let mut reader = reader;
                reader
                    .read_line(&mut line)
                    .await
                    .context("Failed to read from agent socket")
            })
            .await
            .map_err(|_| anyhow!("Agent command timed out after {read_timeout:?}"))??;

            let line = line.trim();
            if line.is_empty() {
                bail!("{}", EMPTY_RESPONSE_MARKER);
            }

            debug!(response = %line, "Received response from agent");

            let raw: Value =
                serde_json::from_str(line).context("Failed to parse agent response as JSON")?;

            Ok(AgentResponse::from_json(&raw))
        }
        .await;

        match io_result {
            Ok(resp) => Ok(resp),
            Err(e) => {
                // Empty-response EOF is ambiguous: it could mean "agent died
                // after processing the command" (not safe to retry) or "the
                // socket was already half-dead when we wrote, the write was
                // buffered locally, and the agent never saw it" (safe to
                // retry). The second case is common under host load and is
                // what we want to recover from.
                //
                // Probe with a fresh TCP connect. If the agent is reachable
                // again, the OLD connection was stale — the agent almost
                // certainly did not observe the command, so we reclassify as
                // a Connect error and let the caller retry once on a new
                // socket. If the probe also fails, the agent is truly gone
                // and session recovery upstream will restart it.
                //
                // Narrow double-tap risk for non-idempotent commands:
                //   1. Agent reads the command, executes it (e.g. tap).
                //   2. Agent crashes after writing the response but before
                //      our read completes (or the response is lost to a TCP
                //      RST mid-flight).
                //   3. The supervisor restarts the agent on the same port
                //      before our probe fires.
                //   4. Our probe succeeds → we retry → the tap runs twice.
                //
                // This window is narrow (agent restart is far slower than
                // our 2 s probe) and vastly outweighed by the reliability
                // win under host load, but it IS a real correctness risk
                // for mutating commands. A future improvement would gate
                // the reclassification on command idempotency (query ops
                // like findElement / dumpHierarchy → retry safely; mutating
                // ops like tap / type / swipe → no retry) or require the
                // probe to observe the same agent PID / session token
                // rather than just "something is listening on the port".
                if is_empty_response(&e) && probe_agent_alive(self.host_port).await {
                    warn!("Agent returned empty response but is still reachable — treating as stale connection and retrying");
                    return Err(SendError::Connect(e.context(
                        "Agent connection dropped (empty response); reconnecting",
                    )));
                }
                Err(SendError::PostSend(e))
            }
        }
    }

    async fn ping_agent(&self) -> Result<()> {
        ping_agent_port(self.host_port).await
    }

    #[allow(dead_code)]
    async fn reconnect(&mut self, serial: &str) -> Result<()> {
        info!(serial, "Attempting to reconnect to agent");
        self.connected = false;

        // Re-establish ADB port forwarding (Android only; iOS uses localhost directly)
        if !self.is_ios {
            let _ = adb::remove_forward(serial, self.host_port).await;
            adb::forward_port(serial, self.host_port, AGENT_DEVICE_PORT).await?;
        }

        match self.ping_agent().await {
            Ok(_) => {
                self.connected = true;
                info!("Reconnected to agent");
                Ok(())
            }
            Err(e) => {
                bail!("Failed to reconnect to agent: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ─── Read-timeout headroom ───

    #[test]
    fn read_headroom_parses_valid_millis() {
        assert_eq!(
            parse_read_timeout_headroom(Some("10000")),
            Duration::from_millis(10_000)
        );
        // Surrounding whitespace is tolerated.
        assert_eq!(
            parse_read_timeout_headroom(Some("  2500 ")),
            Duration::from_millis(2_500)
        );
        // Zero is a legitimate explicit override (no headroom).
        assert_eq!(parse_read_timeout_headroom(Some("0")), Duration::ZERO);
    }

    #[test]
    fn saturating_read_timeout_adds_and_caps() {
        // Tests the pure helper so the result doesn't depend on whether
        // TAPSMITH_AGENT_READ_HEADROOM_MS is set in the ambient environment.
        // A normal timeout just adds the headroom.
        assert_eq!(
            saturating_read_timeout(Duration::from_secs(30), DEFAULT_READ_TIMEOUT_HEADROOM),
            Duration::from_secs(35)
        );
        // A pathological timeout saturates to the timer-safe cap instead of
        // overflowing (which would later panic inside tokio::time::timeout) —
        // whether the overflow comes from the timeout or an absurd headroom.
        assert_eq!(
            saturating_read_timeout(Duration::MAX, DEFAULT_READ_TIMEOUT_HEADROOM),
            MAX_READ_TIMEOUT
        );
        assert_eq!(
            saturating_read_timeout(Duration::from_secs(30), Duration::MAX),
            MAX_READ_TIMEOUT
        );
        assert!(MAX_READ_TIMEOUT < Duration::MAX);
    }

    #[test]
    fn read_headroom_falls_back_to_default() {
        // Unset, empty, and unparseable all fall back to the 5s default rather
        // than silently producing a zero timeout.
        assert_eq!(
            parse_read_timeout_headroom(None),
            DEFAULT_READ_TIMEOUT_HEADROOM
        );
        assert_eq!(
            parse_read_timeout_headroom(Some("")),
            DEFAULT_READ_TIMEOUT_HEADROOM
        );
        assert_eq!(
            parse_read_timeout_headroom(Some("not-a-number")),
            DEFAULT_READ_TIMEOUT_HEADROOM
        );
        assert_eq!(
            parse_read_timeout_headroom(Some("-1")),
            DEFAULT_READ_TIMEOUT_HEADROOM
        );
    }

    // ─── AgentCommand::to_json ───

    #[test]
    fn to_json_find_element() {
        let cmd = AgentCommand::FindElement {
            selector: json!({"text": "Login"}),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("req-1");
        assert_eq!(j["id"], "req-1");
        assert_eq!(j["method"], "findElement");
        assert_eq!(j["params"]["text"], "Login");
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_find_element_no_timeout() {
        let cmd = AgentCommand::FindElement {
            selector: json!({"text": "OK"}),
            timeout_ms: None,
        };
        let j = cmd.to_json("r2");
        assert_eq!(j["method"], "findElement");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn method_name_matches_to_json_method() {
        // method_name() is a cheap static mirror of to_json's `method`; assert
        // they agree across a representative spread of variants — struct
        // variants with fields, empty-brace variants, and the unit variant —
        // so the two can't silently drift.
        let cases = vec![
            AgentCommand::FindElements {
                selector: json!({}),
                timeout_ms: None,
            },
            AgentCommand::Tap {
                selector: json!({}),
                timeout_ms: None,
                element_id: None,
            },
            AgentCommand::TypeText {
                selector: json!({}),
                text: "x".into(),
                timeout_ms: None,
                typing_delay_ms: None,
                element_id: None,
            },
            AgentCommand::TapCoordinates { x: 1.0, y: 2.0 },
            AgentCommand::LongPressCoordinates {
                x: 1.0,
                y: 2.0,
                duration_ms: 500,
            },
            AgentCommand::DragCoordinates {
                from_x: 1.0,
                from_y: 2.0,
                to_x: 3.0,
                to_y: 4.0,
                duration_ms: 300,
            },
            AgentCommand::InputText {
                text: "x".into(),
                typing_delay_ms: None,
            },
            AgentCommand::TouchDown {
                x: 1.0,
                y: 2.0,
                t_ms: 0,
            },
            AgentCommand::TouchMove {
                x: 2.0,
                y: 3.0,
                t_ms: 16,
            },
            AgentCommand::TouchUp {
                x: 3.0,
                y: 4.0,
                t_ms: 32,
            },
            AgentCommand::TouchCancel {},
            AgentCommand::TakeElementScreenshot {
                selector: json!({}),
                timeout_ms: None,
                element_id: None,
            },
            AgentCommand::GetUiHierarchy {},
            AgentCommand::Screenshot {},
            AgentCommand::WaitForIdle { timeout_ms: None },
            AgentCommand::LaunchApp {
                package: "p".into(),
            },
            AgentCommand::AcceptOpenInAppDialog { timeout_ms: None },
            AgentCommand::GetClipboard {},
            AgentCommand::GetOrientation {},
            AgentCommand::CaptureTraceState {
                screenshot: true,
                hierarchy: true,
                selector: Some(json!({"text": "Login"})),
            },
            AgentCommand::DismissSystemDialog,
        ];
        for cmd in cases {
            assert_eq!(
                json!(cmd.method_name()),
                cmd.to_json("t")["method"],
                "method_name() disagrees with to_json for {cmd:?}"
            );
        }
    }

    #[test]
    fn to_json_find_elements() {
        let cmd = AgentCommand::FindElements {
            selector: json!({"className": "Button"}),
            timeout_ms: Some(1000),
        };
        let j = cmd.to_json("r3");
        assert_eq!(j["method"], "findElements");
        assert_eq!(j["params"]["className"], "Button");
        assert_eq!(j["params"]["timeout"], 1000);
    }

    #[test]
    fn to_json_resolve_action_point() {
        // The HID gestures ask the agent where a touch can land without
        // hitting a cover (PILOT-223); the budget rides along so the agent
        // can wait a transient cover out.
        let cmd = AgentCommand::ResolveActionPoint {
            selector: json!({"text": "Item"}),
            timeout_ms: Some(4000),
        };
        let j = cmd.to_json("rap");
        assert_eq!(j["method"], "resolveActionPoint");
        assert_eq!(cmd.method_name(), "resolveActionPoint");
        assert_eq!(j["params"]["text"], "Item");
        assert_eq!(j["params"]["timeout"], 4000);
    }

    #[test]
    fn to_json_tap() {
        let cmd = AgentCommand::Tap {
            selector: json!({"testId": "submit"}),
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("t1");
        assert_eq!(j["method"], "tap");
        assert_eq!(j["params"]["testId"], "submit");
    }

    #[test]
    fn to_json_tap_by_element_id() {
        // When element_id is set the agent acts on that exact cached element;
        // it is serialized alongside (here, instead of) any selector.
        let cmd = AgentCommand::Tap {
            selector: json!({}),
            timeout_ms: None,
            element_id: Some("el-abc".into()),
        };
        let j = cmd.to_json("t2");
        assert_eq!(j["method"], "tap");
        assert_eq!(j["params"]["elementId"], "el-abc");
    }

    #[test]
    fn to_json_long_press() {
        let cmd = AgentCommand::LongPress {
            selector: json!({"text": "Item"}),
            duration_ms: Some(2000),
            timeout_ms: Some(10000),
            element_id: None,
        };
        let j = cmd.to_json("lp1");
        assert_eq!(j["method"], "longPress");
        assert_eq!(j["params"]["text"], "Item");
        assert_eq!(j["params"]["duration"], 2000);
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_long_press_no_optionals() {
        let cmd = AgentCommand::LongPress {
            selector: json!({"text": "X"}),
            duration_ms: None,
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("lp2");
        assert!(j["params"].get("duration").is_none());
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_type_text() {
        let cmd = AgentCommand::TypeText {
            selector: json!({"hint": "Email"}),
            text: "user@example.com".into(),
            timeout_ms: Some(3000),
            typing_delay_ms: Some(10),
            element_id: None,
        };
        let j = cmd.to_json("tt1");
        assert_eq!(j["method"], "typeText");
        assert_eq!(j["params"]["text"], "user@example.com");
        assert_eq!(j["params"]["hint"], "Email");
        assert_eq!(j["params"]["timeout"], 3000);
        assert_eq!(j["params"]["typingDelayMs"], 10);
    }

    #[test]
    fn to_json_clear_text() {
        let cmd = AgentCommand::ClearText {
            selector: json!({"resourceId": "input"}),
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("ct1");
        assert_eq!(j["method"], "clearText");
        assert_eq!(j["params"]["resourceId"], "input");
    }

    #[test]
    fn to_json_swipe() {
        let cmd = AgentCommand::Swipe {
            direction: "up".into(),
            start_element: Some(json!({"text": "list"})),
            speed: Some(1.5),
            distance: Some(0.8),
            timeout_ms: Some(5000),
        };
        let j = cmd.to_json("sw1");
        assert_eq!(j["method"], "swipe");
        assert_eq!(j["params"]["direction"], "up");
        assert_eq!(j["params"]["startElement"]["text"], "list");
        assert_eq!(j["params"]["speed"], 1.5);
        assert_eq!(j["params"]["distance"], json!(0.800000011920929)); // f32 precision
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_swipe_minimal() {
        let cmd = AgentCommand::Swipe {
            direction: "down".into(),
            start_element: None,
            speed: None,
            distance: None,
            timeout_ms: None,
        };
        let j = cmd.to_json("sw2");
        assert_eq!(j["params"]["direction"], "down");
        assert!(j["params"].get("startElement").is_none());
        assert!(j["params"].get("speed").is_none());
    }

    #[test]
    fn to_json_scroll() {
        let cmd = AgentCommand::Scroll {
            container: Some(json!({"resourceId": "list"})),
            direction: "down".into(),
            scroll_until_visible: Some(json!({"text": "End"})),
            distance: Some(0.5),
            timeout_ms: Some(8000),
            element_id: None,
        };
        let j = cmd.to_json("sc1");
        assert_eq!(j["method"], "scroll");
        assert_eq!(j["params"]["direction"], "down");
        assert_eq!(j["params"]["container"]["resourceId"], "list");
        assert_eq!(j["params"]["scrollTo"]["text"], "End");
    }

    #[test]
    fn to_json_press_key() {
        let cmd = AgentCommand::PressKey {
            key: "KEYCODE_BACK".into(),
        };
        let j = cmd.to_json("pk1");
        assert_eq!(j["method"], "pressKey");
        assert_eq!(j["params"]["key"], "KEYCODE_BACK");
    }

    #[test]
    fn to_json_get_ui_hierarchy() {
        let cmd = AgentCommand::GetUiHierarchy {};
        let j = cmd.to_json("ui1");
        assert_eq!(j["method"], "getUiHierarchy");
        assert_eq!(j["params"], json!({}));
    }

    #[test]
    fn to_json_wait_for_idle() {
        let cmd = AgentCommand::WaitForIdle {
            timeout_ms: Some(10000),
        };
        let j = cmd.to_json("wi1");
        assert_eq!(j["method"], "waitForIdle");
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_wait_for_idle_no_timeout() {
        let cmd = AgentCommand::WaitForIdle { timeout_ms: None };
        let j = cmd.to_json("wi2");
        assert_eq!(j["method"], "waitForIdle");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_screenshot() {
        let cmd = AgentCommand::Screenshot {};
        let j = cmd.to_json("ss1");
        assert_eq!(j["method"], "screenshot");
        assert_eq!(j["params"], json!({}));
    }

    // ─── New Element Actions (PILOT-2) ───

    #[test]
    fn to_json_double_tap() {
        let cmd = AgentCommand::DoubleTap {
            selector: json!({"text": "Button"}),
            timeout_ms: Some(5000),
            interval_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("dt1");
        assert_eq!(j["method"], "doubleTap");
        assert_eq!(j["params"]["text"], "Button");
        assert_eq!(j["params"]["timeout"], 5000);
        assert!(j["params"]["intervalMs"].is_null());
    }

    #[test]
    fn to_json_double_tap_with_interval() {
        let cmd = AgentCommand::DoubleTap {
            selector: json!({"text": "Button"}),
            timeout_ms: Some(5000),
            interval_ms: Some(100),
            element_id: None,
        };
        let j = cmd.to_json("dt2");
        assert_eq!(j["method"], "doubleTap");
        assert_eq!(j["params"]["text"], "Button");
        assert_eq!(j["params"]["timeout"], 5000);
        assert_eq!(j["params"]["intervalMs"], 100);
    }

    #[test]
    fn to_json_drag_and_drop() {
        let cmd = AgentCommand::DragAndDrop {
            source_selector: json!({"text": "Item 1"}),
            target_selector: json!({"text": "Drop Zone"}),
            timeout_ms: Some(10000),
            source_element_id: None,
            target_element_id: None,
        };
        let j = cmd.to_json("dd1");
        assert_eq!(j["method"], "dragAndDrop");
        assert_eq!(j["params"]["source"]["text"], "Item 1");
        assert_eq!(j["params"]["target"]["text"], "Drop Zone");
        assert_eq!(j["params"]["timeout"], 10000);
    }

    #[test]
    fn to_json_drag_and_drop_by_element_id() {
        let cmd = AgentCommand::DragAndDrop {
            source_selector: json!({}),
            target_selector: json!({}),
            timeout_ms: None,
            source_element_id: Some("src-1".into()),
            target_element_id: Some("tgt-1".into()),
        };
        let j = cmd.to_json("dd2");
        assert_eq!(j["params"]["source"]["elementId"], "src-1");
        assert_eq!(j["params"]["target"]["elementId"], "tgt-1");
    }

    #[test]
    fn to_json_select_option_by_text() {
        let cmd = AgentCommand::SelectOption {
            selector: json!({"role": {"role": "combobox", "name": ""}}),
            option: Some("Option 2".into()),
            index: None,
            timeout_ms: Some(5000),
            element_id: None,
        };
        let j = cmd.to_json("so1");
        assert_eq!(j["method"], "selectOption");
        assert_eq!(j["params"]["option"], "Option 2");
        assert!(j["params"].get("index").is_none());
    }

    #[test]
    fn to_json_select_option_by_index() {
        let cmd = AgentCommand::SelectOption {
            selector: json!({"text": "Dropdown"}),
            option: None,
            index: Some(2),
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("so2");
        assert_eq!(j["method"], "selectOption");
        assert_eq!(j["params"]["index"], 2);
        assert!(j["params"].get("option").is_none());
    }

    #[test]
    fn to_json_pinch_zoom() {
        let cmd = AgentCommand::PinchZoom {
            selector: json!({"text": "Map"}),
            scale: 2.0,
            timeout_ms: Some(5000),
            element_id: None,
        };
        let j = cmd.to_json("pz1");
        assert_eq!(j["method"], "pinchZoom");
        assert_eq!(j["params"]["scale"], 2.0);
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_focus() {
        let cmd = AgentCommand::Focus {
            selector: json!({"hint": "Email"}),
            timeout_ms: Some(3000),
            element_id: None,
        };
        let j = cmd.to_json("f1");
        assert_eq!(j["method"], "focus");
        assert_eq!(j["params"]["hint"], "Email");
        assert_eq!(j["params"]["timeout"], 3000);
    }

    #[test]
    fn to_json_blur() {
        let cmd = AgentCommand::Blur {
            selector: json!({"hint": "Email"}),
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("b1");
        assert_eq!(j["method"], "blur");
        assert_eq!(j["params"]["hint"], "Email");
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_highlight() {
        let cmd = AgentCommand::Highlight {
            selector: json!({"text": "Submit"}),
            duration_ms: Some(2000),
            timeout_ms: Some(5000),
            element_id: None,
        };
        let j = cmd.to_json("h1");
        assert_eq!(j["method"], "highlight");
        assert_eq!(j["params"]["duration"], 2000);
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_highlight_no_optionals() {
        let cmd = AgentCommand::Highlight {
            selector: json!({"text": "X"}),
            duration_ms: None,
            timeout_ms: None,
            element_id: None,
        };
        let j = cmd.to_json("h2");
        assert!(j["params"].get("duration").is_none());
        assert!(j["params"].get("timeout").is_none());
    }

    #[test]
    fn to_json_take_element_screenshot() {
        let cmd = AgentCommand::TakeElementScreenshot {
            selector: json!({"resourceId": "profile_image"}),
            timeout_ms: Some(5000),
            element_id: None,
        };
        let j = cmd.to_json("es1");
        assert_eq!(j["method"], "elementScreenshot");
        assert_eq!(j["params"]["resourceId"], "profile_image");
        assert_eq!(j["params"]["timeout"], 5000);
    }

    #[test]
    fn to_json_open_deep_link() {
        let cmd = AgentCommand::OpenDeepLink {
            url: "tapsmithtest:///login".into(),
            package: "dev.tapsmith.testapp".into(),
            deliver_in_process: false,
            require_ui_change: false,
            ack_epoch_gt: None,
            ack_boot_before: None,
            ack_nav_gt: None,
        };
        let j = cmd.to_json("dl1");
        assert_eq!(j["method"], "openDeepLink");
        assert_eq!(j["params"]["url"], "tapsmithtest:///login");
        assert_eq!(j["params"]["bundleId"], "dev.tapsmith.testapp");
        assert_eq!(j["params"]["deliverInProcess"], false);
        assert_eq!(j["params"]["requireUiChange"], false);
    }

    #[test]
    fn to_json_open_deep_link_warm() {
        let cmd = AgentCommand::OpenDeepLink {
            url: "tapsmithtest:///__reset".into(),
            package: "dev.tapsmith.testapp".into(),
            deliver_in_process: true,
            require_ui_change: true,
            ack_epoch_gt: None,
            ack_boot_before: None,
            ack_nav_gt: None,
        };
        let j = cmd.to_json("dl2");
        assert_eq!(j["method"], "openDeepLink");
        assert_eq!(j["params"]["deliverInProcess"], true);
        assert_eq!(j["params"]["requireUiChange"], true);
        assert!(j["params"].get("ackEpochGreaterThan").is_none());
    }

    #[test]
    fn to_json_open_deep_link_with_ack_epoch() {
        let cmd = AgentCommand::OpenDeepLink {
            url: "myapp:///?__tapsmith_reset=1&nonce=abc".into(),
            package: "dev.tapsmith.testapp".into(),
            deliver_in_process: true,
            require_ui_change: false,
            ack_epoch_gt: Some(4),
            ack_boot_before: None,
            ack_nav_gt: None,
        };
        let j = cmd.to_json("dl3");
        assert_eq!(j["params"]["ackEpochGreaterThan"], 4);
        let with_boot = AgentCommand::OpenDeepLink {
            url: "tapsmithtest:///?__tapsmith_reset=1".into(),
            package: "dev.tapsmith.testapp".into(),
            deliver_in_process: false,
            require_ui_change: false,
            ack_epoch_gt: Some(4),
            ack_boot_before: Some("c0ffee42".into()),
            ack_nav_gt: None,
        };
        let j = with_boot.to_json("dl3");
        assert_eq!(j["params"]["ackEpochGreaterThan"], 4);
        assert_eq!(j["params"]["ackBootBefore"], "c0ffee42");
    }

    #[test]
    fn open_deep_link_serialises_nav_ack() {
        let cmd = AgentCommand::OpenDeepLink {
            url: "app:///gestures".into(),
            package: "com.example".into(),
            deliver_in_process: true,
            require_ui_change: false,
            ack_epoch_gt: None,
            ack_boot_before: Some("c0ffee42".into()),
            ack_nav_gt: Some(7),
        };
        let j = cmd.to_json("id-1");
        assert_eq!(j["params"]["ackNavGreaterThan"], 7);
        assert!(j["params"].get("ackEpochGreaterThan").is_none());
        assert_eq!(j["params"]["requireUiChange"], false);
    }

    #[test]
    fn to_json_accept_open_in_app_dialog() {
        let cmd = AgentCommand::AcceptOpenInAppDialog {
            timeout_ms: Some(750),
        };
        let j = cmd.to_json("open-dialog");
        assert_eq!(j["method"], "acceptOpenInAppDialog");
        assert_eq!(j["params"]["timeout"], 750);
    }

    #[test]
    fn to_json_id_is_passed_through() {
        let cmd = AgentCommand::PressKey {
            key: "ENTER".into(),
        };
        let j = cmd.to_json("my-custom-id-123");
        assert_eq!(j["id"], "my-custom-id-123");
    }

    // ─── Coordinate Gesture Commands ───

    #[test]
    fn serializes_tap_coordinates() {
        let cmd = AgentCommand::TapCoordinates { x: 100.0, y: 200.0 };
        let j = cmd.to_json("tc1");
        assert_eq!(j["method"], "tap");
        assert_eq!(j["params"]["x"], 100.0);
        assert_eq!(j["params"]["y"], 200.0);
    }

    #[test]
    fn serializes_long_press_coordinates() {
        let cmd = AgentCommand::LongPressCoordinates {
            x: 10.0,
            y: 20.0,
            duration_ms: 800,
        };
        let j = cmd.to_json("lpc1");
        assert_eq!(j["method"], "longPress");
        assert_eq!(j["params"]["x"], 10.0);
        assert_eq!(j["params"]["y"], 20.0);
        assert_eq!(j["params"]["duration"], 800);
    }

    #[test]
    fn serializes_drag_coordinates() {
        let cmd = AgentCommand::DragCoordinates {
            from_x: 1.0,
            from_y: 2.0,
            to_x: 3.0,
            to_y: 4.0,
            duration_ms: 300,
        };
        let j = cmd.to_json("dc1");
        assert_eq!(j["method"], "swipe");
        assert_eq!(j["params"]["fromX"], 1.0);
        assert_eq!(j["params"]["fromY"], 2.0);
        assert_eq!(j["params"]["toX"], 3.0);
        assert_eq!(j["params"]["toY"], 4.0);
        assert_eq!(j["params"]["durationMs"], 300);
    }

    #[test]
    fn serializes_input_text() {
        let cmd = AgentCommand::InputText {
            text: "hello".to_string(),
            typing_delay_ms: Some(10),
        };
        let j = cmd.to_json("it1");
        assert_eq!(j["method"], "typeText");
        assert_eq!(j["params"]["text"], "hello");
        assert_eq!(j["params"]["focused"], true);
        assert_eq!(j["params"]["typingDelayMs"], 10);
    }

    #[test]
    fn serializes_touch_down() {
        let cmd = AgentCommand::TouchDown {
            x: 12.0,
            y: 34.0,
            t_ms: 0,
        };
        let j = cmd.to_json("id");
        assert_eq!(j["method"], "touchDown");
        assert_eq!(j["params"]["x"], 12.0);
        assert_eq!(j["params"]["y"], 34.0);
        assert_eq!(j["params"]["t"], 0);
    }

    #[test]
    fn serializes_touch_move() {
        let cmd = AgentCommand::TouchMove {
            x: 1.0,
            y: 2.0,
            t_ms: 50,
        };
        let j = cmd.to_json("id");
        assert_eq!(j["method"], "touchMove");
        assert_eq!(j["params"]["x"], 1.0);
        assert_eq!(j["params"]["y"], 2.0);
        assert_eq!(j["params"]["t"], 50);
    }

    #[test]
    fn serializes_touch_up() {
        let cmd = AgentCommand::TouchUp {
            x: 3.0,
            y: 4.0,
            t_ms: 120,
        };
        let j = cmd.to_json("id");
        assert_eq!(j["method"], "touchUp");
        assert_eq!(j["params"]["x"], 3.0);
        assert_eq!(j["params"]["y"], 4.0);
        assert_eq!(j["params"]["t"], 120);
    }

    #[test]
    fn serializes_touch_cancel() {
        let cmd = AgentCommand::TouchCancel {};
        let j = cmd.to_json("id");
        assert_eq!(j["method"], "touchCancel");
    }

    // ─── AgentResponse::from_json ───

    #[test]
    fn from_json_success() {
        let raw = json!({
            "id": "r1",
            "result": {"elementId": "e1", "text": "Hello"}
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert!(resp.error.is_none());
        assert!(resp.error_type.is_none());
        assert_eq!(resp.data["elementId"], "e1");
        assert_eq!(resp.data["text"], "Hello");
    }

    #[test]
    fn from_json_error() {
        let raw = json!({
            "id": "r2",
            "error": {
                "type": "ELEMENT_NOT_FOUND",
                "message": "Could not find element matching selector"
            }
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(!resp.success);
        assert_eq!(
            resp.error.as_deref(),
            Some("Could not find element matching selector")
        );
        assert_eq!(resp.error_type.as_deref(), Some("ELEMENT_NOT_FOUND"));
        assert_eq!(resp.data, Value::Null);
    }

    #[test]
    fn from_json_null_result() {
        let raw = json!({"id": "r3"});
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert_eq!(resp.data, Value::Null);
    }

    #[test]
    fn from_json_success_with_object_result() {
        let raw = json!({
            "id": "r4",
            "result": null
        });
        let resp = AgentResponse::from_json(&raw);
        assert!(resp.success);
        assert_eq!(resp.data, Value::Null);
    }

    // ─── SendError categorization ───
    //
    // These tests pin the Connect-vs-PostSend split that send_command_with_timeout
    // depends on. Misclassifying a Connect failure as PostSend would prevent the
    // safe single-retry path from running; misclassifying PostSend as Connect
    // would risk double-executing side-effectful commands like tap.

    #[tokio::test]
    async fn try_send_command_classifies_no_listener_as_connect_error() {
        // Bind a TCP listener to grab a guaranteed-free port, then drop it so
        // a connect attempt to that port fails immediately with ECONNREFUSED.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};

        let result = conn.try_send_command(&cmd, Duration::from_secs(1)).await;
        match result {
            Err(SendError::Connect(_)) => {} // expected — safe to retry
            Err(SendError::PostSend(e)) => {
                panic!("expected Connect, got PostSend: {e}")
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn try_send_command_reclassifies_empty_response_as_connect_when_agent_reachable() {
        // Listener accepts, reads the command, closes without writing a
        // response. From try_send_command's point of view that's "write
        // succeeded, read returned empty/EOF" — but the listener is still
        // accepting new connections, so the liveness probe that fires after
        // the empty-response detection will succeed and we reclassify as
        // Connect. This is the happy path for the new retry logic.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            while let Ok((mut stream, _)) = listener.accept().await {
                // Read the command bytes so the client's write_all
                // completes successfully, then close the half-open
                // stream without writing a response. The client's
                // read_line will observe EOF → empty response.
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while let Ok(n) = stream.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.contains(&b'\n') {
                        break;
                    }
                }
                // The liveness probe is a real ping: answer it so the
                // mock reads as "alive", and drop every other command
                // unanswered so it reads as an empty response.
                if String::from_utf8_lossy(&buf).contains("\"method\":\"ping\"") {
                    let _ = stream
                        .write_all(b"{\"id\":\"ping\",\"result\":{\"pong\":true}}\n")
                        .await;
                }
                drop(stream);
            }
        });

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};

        let result = conn.try_send_command(&cmd, Duration::from_secs(2)).await;
        match result {
            // Reclassification succeeded — outer send_command retry is safe.
            Err(SendError::Connect(e)) => {
                let msg = e.to_string();
                assert!(
                    msg.contains("empty response") || msg.contains("Agent connection dropped"),
                    "expected reclassified empty-response context, got: {msg}"
                );
            }
            Err(SendError::PostSend(e)) => {
                panic!("expected reclassified Connect, got PostSend: {e}")
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    #[tokio::test]
    async fn try_send_command_classifies_empty_response_as_post_send_when_agent_gone() {
        // Bind a listener, let the port be claimed briefly so try_send_command
        // gets past the initial connect, then tear down the listener before
        // the empty-response probe fires. The probe must fail → we fall back
        // to PostSend so session recovery upstream can restart the agent.
        //
        // Concretely: we accept exactly one connection, drop it, then drop
        // the listener so the port becomes un-bindable by subsequent probes.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                drop(stream); // close the client connection
            }
            drop(listener); // stop listening so the probe fails
            let _ = done_tx.send(());
        });

        let conn = AgentConnection::with_port(port);
        let cmd = AgentCommand::Screenshot {};
        let result = conn.try_send_command(&cmd, Duration::from_secs(2)).await;
        let _ = done_rx.await;

        match result {
            Err(SendError::PostSend(e)) => {
                let msg = e.to_string();
                // Either empty-response (if we got past the write before the
                // listener vanished) or a post-send write/read error.
                assert!(
                    msg.contains("empty response")
                        || msg.contains("Failed to")
                        || msg.contains("connection"),
                    "unexpected PostSend message: {msg}"
                );
            }
            Err(SendError::Connect(e)) => {
                // Accept this branch too: if the probe races and catches the
                // listener still alive, we land on Connect. The test's
                // primary purpose is to exercise the fallback path; the
                // PostSend branch is the one we're guarding against stale
                // after the dead-agent case.
                let msg = e.to_string();
                assert!(
                    msg.contains("empty response") || msg.contains("Agent connection dropped"),
                    "unexpected Connect message: {msg}"
                );
            }
            Ok(_) => panic!("expected error, got Ok"),
        }
    }

    /// Mock agent that answers every line with a pong, like the real
    /// agents' `ping` method.
    fn spawn_ping_answering_agent(listener: tokio::net::TcpListener) {
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                if reader.read_line(&mut line).await.is_ok() && !line.is_empty() {
                    let _ = write_half
                        .write_all(b"{\"id\":\"ping\",\"result\":{\"pong\":true}}\n")
                        .await;
                }
            }
        });
    }

    /// Mock of `adb forward` with no agent on the device side: the connect
    /// succeeds (the adb server accepts it), the request is consumed, then
    /// the socket closes without a byte in reply — the reader sees EOF.
    fn spawn_accept_then_close(listener: tokio::net::TcpListener) {
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (read_half, write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                let _ = reader.read_line(&mut line).await;
                drop(write_half);
            }
        });
    }

    #[tokio::test]
    async fn probe_agent_alive_returns_true_when_agent_answers_ping() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        spawn_ping_answering_agent(listener);

        assert!(probe_agent_alive(port).await);
    }

    #[tokio::test]
    async fn probe_agent_alive_returns_false_when_connect_succeeds_but_nothing_answers() {
        // The adb-forward shape: a connect to the host port succeeds even
        // when the device-side agent is dead, and the read then sees EOF.
        // That must NOT count as alive — it is exactly the case where the
        // agent needs restarting.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        spawn_accept_then_close(listener);

        assert!(!probe_agent_alive(port).await);
    }

    #[tokio::test]
    async fn probe_agent_alive_returns_false_when_nothing_listening() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        assert!(!probe_agent_alive(port).await);
    }

    #[tokio::test]
    async fn ping_agent_port_succeeds_on_a_real_pong() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        spawn_ping_answering_agent(listener);

        ping_agent_port(port)
            .await
            .expect("pong should satisfy the ping");
    }

    #[tokio::test]
    async fn ping_agent_port_rejects_eof_without_a_reply() {
        // Regression: this used to return Ok — `read_line` hitting EOF was
        // treated as a pong — so StartAgent declared a not-yet-listening
        // Android agent connected and later reused a dead one.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        spawn_accept_then_close(listener);

        let err = ping_agent_port(port)
            .await
            .expect_err("EOF must not count as a pong");
        assert!(
            err.to_string().contains("without answering the ping"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn is_empty_response_matches_the_bail_marker() {
        let err = anyhow!("{}", EMPTY_RESPONSE_MARKER).context("wrapper context");
        assert!(is_empty_response(&err));

        let other = anyhow!("some other failure");
        assert!(!is_empty_response(&other));
    }

    #[tokio::test]
    async fn send_command_requires_connected_flag() {
        // Sanity check on the public entry point: it must reject sends when the
        // connection has never been established, otherwise we'd waste a TCP
        // connect attempt and cloud the error message users see.
        let mut conn = AgentConnection::with_port(0);
        let cmd = AgentCommand::Screenshot {};
        let result = conn
            .send_command_with_timeout(&cmd, Duration::from_secs(1))
            .await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("Not connected"),
            "expected 'Not connected' in error, got: {msg}"
        );
    }

    #[test]
    fn connected_host_port_for_requires_matching_live_connection() {
        let mut conn = AgentConnection::with_port(12_345);

        assert_eq!(conn.connected_host_port_for("device-1", false), None);

        conn.connected = true;
        conn.device_serial = Some("device-1".to_string());
        conn.is_ios = false;

        assert_eq!(
            conn.connected_host_port_for("device-1", false),
            Some(12_345)
        );
        assert_eq!(conn.connected_host_port_for("device-2", false), None);
        assert_eq!(conn.connected_host_port_for("device-1", true), None);
    }

    #[test]
    fn send_error_into_anyhow_preserves_message() {
        let connect: anyhow::Error = SendError::Connect(anyhow!("connect-side failure")).into();
        assert!(connect.to_string().contains("connect-side failure"));

        let post: anyhow::Error = SendError::PostSend(anyhow!("post-send failure")).into();
        assert!(post.to_string().contains("post-send failure"));
    }

    #[test]
    fn to_json_capture_trace_state() {
        let cmd = AgentCommand::CaptureTraceState {
            screenshot: true,
            hierarchy: true,
            selector: Some(json!({"text": "Login"})),
        };
        let j = cmd.to_json("cts1");
        assert_eq!(j["method"], "captureTraceState");
        assert_eq!(j["params"]["screenshot"], true);
        assert_eq!(j["params"]["hierarchy"], true);
        assert_eq!(j["params"]["text"], "Login");
    }

    #[test]
    fn to_json_capture_trace_state_no_selector() {
        let cmd = AgentCommand::CaptureTraceState {
            screenshot: true,
            hierarchy: false,
            selector: None,
        };
        let j = cmd.to_json("cts2");
        assert_eq!(j["method"], "captureTraceState");
        assert_eq!(j["params"]["screenshot"], true);
        assert_eq!(j["params"]["hierarchy"], false);
    }

    // ─── Persistent stream cache ───

    #[tokio::test]
    async fn persistent_cache_reuses_connection() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept_count = Arc::new(AtomicUsize::new(0));
        let accept_count_clone = accept_count.clone();

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                accept_count_clone.fetch_add(1, Ordering::SeqCst);
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                tokio::spawn(async move {
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line).await {
                            Ok(0) => break,
                            Ok(_) => {
                                let parsed: Value = serde_json::from_str(line.trim()).unwrap();
                                let id = parsed["id"].as_str().unwrap_or("null");
                                let resp = format!(r#"{{"id":"{}","result":{{"ok":true}}}}"#, id);
                                let _ =
                                    write_half.write_all(format!("{}\n", resp).as_bytes()).await;
                                let _ = write_half.flush().await;
                            }
                            Err(_) => break,
                        }
                    }
                });
            }
        });

        let cache = new_agent_stream_cache();
        let params = ConnectionParams { host_port: port };
        let cmd = AgentCommand::Screenshot {};

        let r1 = send_with_persistent_cache(&cache, &params, &cmd, Duration::from_secs(2)).await;
        assert!(r1.is_ok(), "first send failed: {:?}", r1.err());

        let r2 = send_with_persistent_cache(&cache, &params, &cmd, Duration::from_secs(2)).await;
        assert!(r2.is_ok(), "second send failed: {:?}", r2.err());

        assert_eq!(
            accept_count.load(Ordering::SeqCst),
            1,
            "expected 1 connection, got more"
        );
    }

    #[tokio::test]
    async fn persistent_cache_reconnects_on_broken_stream() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accept_count = Arc::new(AtomicUsize::new(0));
        let accept_count_clone = accept_count.clone();

        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                accept_count_clone.fetch_add(1, Ordering::SeqCst);
                let (read_half, mut write_half) = stream.into_split();
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                if reader.read_line(&mut line).await.is_ok() && !line.is_empty() {
                    let parsed: Value = serde_json::from_str(line.trim()).unwrap();
                    let id = parsed["id"].as_str().unwrap_or("null");
                    let resp = format!(r#"{{"id":"{}","result":{{"ok":true}}}}"#, id);
                    let _ = write_half.write_all(format!("{}\n", resp).as_bytes()).await;
                    let _ = write_half.flush().await;
                }
                drop(write_half);
            }
        });

        let cache = new_agent_stream_cache();
        let params = ConnectionParams { host_port: port };
        let cmd = AgentCommand::Screenshot {};

        let r1 = send_with_persistent_cache(&cache, &params, &cmd, Duration::from_secs(2)).await;
        assert!(r1.is_ok(), "first send failed: {:?}", r1.err());

        let r2 = send_with_persistent_cache(&cache, &params, &cmd, Duration::from_secs(2)).await;
        assert!(
            r2.is_ok(),
            "second send failed (should have reconnected): {:?}",
            r2.err()
        );

        // 3 accepts: (1) initial command, (2) probe_agent_alive liveness
        // check after broken stream, (3) reconnected command
        assert_eq!(accept_count.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn persistent_cache_invalidates_on_port_change() {
        let listener1 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port1 = listener1.local_addr().unwrap().port();
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port2 = listener2.local_addr().unwrap().port();

        fn spawn_echo_agent(listener: tokio::net::TcpListener) {
            tokio::spawn(async move {
                while let Ok((stream, _)) = listener.accept().await {
                    let (read_half, mut write_half) = stream.into_split();
                    let mut reader = BufReader::new(read_half);
                    tokio::spawn(async move {
                        loop {
                            let mut line = String::new();
                            match reader.read_line(&mut line).await {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {
                                    let parsed: Value = serde_json::from_str(line.trim()).unwrap();
                                    let id = parsed["id"].as_str().unwrap_or("null");
                                    let resp =
                                        format!(r#"{{"id":"{}","result":{{"ok":true}}}}"#, id);
                                    let _ = write_half
                                        .write_all(format!("{}\n", resp).as_bytes())
                                        .await;
                                    let _ = write_half.flush().await;
                                }
                            }
                        }
                    });
                }
            });
        }

        spawn_echo_agent(listener1);
        spawn_echo_agent(listener2);

        let cache = new_agent_stream_cache();
        let cmd = AgentCommand::Screenshot {};

        let params1 = ConnectionParams { host_port: port1 };
        let r1 = send_with_persistent_cache(&cache, &params1, &cmd, Duration::from_secs(2)).await;
        assert!(r1.is_ok());

        let params2 = ConnectionParams { host_port: port2 };
        let r2 = send_with_persistent_cache(&cache, &params2, &cmd, Duration::from_secs(2)).await;
        assert!(r2.is_ok());
    }
}
