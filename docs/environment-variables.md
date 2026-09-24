# Environment Variables

Reference for all environment variables recognized by Tapsmith.

Most users will never need to set any of these. They are primarily useful for debugging, CI customization, and advanced setups where the defaults do not apply.

## Daemon and Binary

| Variable | Description |
|---|---|
| `TAPSMITH_DAEMON_BIN` | Override the path to the `tapsmith-core` daemon binary. Checked before auto-resolution from npm packages, monorepo builds, and PATH. |
| `TAPSMITH_DAEMON_LOG` | Path to a file for daemon stdout/stderr. When set, the CLI redirects the spawned daemon's output to this file. Useful for debugging daemon-side behavior (MITM proxy, agent startup, etc.). |
| `TAPSMITH_REUSE_DAEMON` | When set (any truthy value), the CLI connects to an existing daemon without killing it. Used internally by the MCP server's `tapsmith_run_tests` tool to avoid destroying a daemon owned by UI mode. |
| `TAPSMITH_AGENT_READ_HEADROOM_MS` | Milliseconds the daemon waits for an on-device agent to answer a command, *on top of* the caller's timeout (default `5000`). This is effectively the ceiling on a single UIAutomator hierarchy dump, which the agent runs uninterruptibly regardless of the caller timeout. Raise it on slow/CPU-starved CI emulators where a dump can exceed 5s and surface as `Agent command timed out`; do not lower it, as that turns a slow-but-completing dump into a hard timeout. |

## Debugging

| Variable | Description |
|---|---|
| `TAPSMITH_DEBUG` | Enable debug logging in the TypeScript SDK (assertion polling, element resolution, etc.). Set to `1` or `true`. |
| `RUST_LOG` | Control Rust daemon log verbosity. Examples: `RUST_LOG=info`, `RUST_LOG=tapsmith_core=debug`. Useful for diagnosing MITM proxy issues, agent startup failures, and device communication problems. |

## Telemetry

See [Telemetry](telemetry.md) for exactly what is (and is not) collected.

| Variable | Description |
|---|---|
| `TAPSMITH_TELEMETRY` | Set to `0` (or `false`, `no`, `off`) to disable anonymous usage telemetry for this process and every worker it forks. Equivalent to `telemetry: false` in the config, without editing a shared config. Cannot re-enable telemetry a config has switched off. |
| `DO_NOT_TRACK` | The cross-tool convention ([consoledonottrack.com](https://consoledonottrack.com)). Any value other than `0`, `false`, `no`, or `off` disables telemetry, as `TAPSMITH_TELEMETRY=0` does. |
| `TAPSMITH_TELEMETRY_ENDPOINT` | Send telemetry events to this URL instead of PostHog's EU capture endpoint — for organisations that want their own copy, must route through a proxy, or run a self-hosted PostHog. The payload is a standard PostHog capture envelope. Must be HTTPS (or plain HTTP only to a loopback host such as `localhost`); a cleartext remote endpoint is refused and telemetry is disabled for that process rather than sent in the clear, and redirects are never followed. |
| `TAPSMITH_TELEMETRY_DEBUG` | Dry run: set to `1` to print every event that would be sent to stderr, prefixed `[telemetry]`, and send nothing. The way to see exactly what leaves your machine. |

## iOS Network Capture

| Variable | Description |
|---|---|
| `TAPSMITH_REDIRECTOR_APP` | Override the path to the mitmproxy Redirector app binary. Default search order: (1) this env var, (2) `/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector`, (3) `~/.tapsmith/redirector/` (auto-extracted from brew cask). |
| `TAPSMITH_IOS_SYSTEM_PROXY_FALLBACK` | Whether an iOS simulator whose Network Extension redirector fails may fall back to the host-wide macOS system proxy, which records every app on the Mac. `1`/`true`/`on`/`yes` always allows it, `0`/`false`/`off`/`no` never does; unset, it is allowed only when `CI` is set. Read by the daemon, so set it in the environment the CLI or UI mode starts from. See [When the Network Extension is unavailable](ios-network-capture.md#when-the-network-extension-is-unavailable). |

## CI and Reporters

| Variable | Description |
|---|---|
| `CI` | When set (and not `"false"`), Tapsmith skips the Android device-health preflight and disables interactive progress output. It also lets the daemon use the host-wide iOS system-proxy capture fallback (for the daemon, `0` and any casing of `false` also count as unset; override with `TAPSMITH_IOS_SYSTEM_PROXY_FALLBACK`). Most CI providers set this automatically. Reporter selection is no longer affected — `list` is the default everywhere; set `reporter: 'dot'` explicitly for compact CI output. |
| `GITHUB_ACTIONS` | When set (GitHub Actions sets it automatically), Tapsmith auto-adds the `github` reporter for inline annotations on test failures. |
| `GITHUB_STEP_SUMMARY` | Path to the GitHub Actions step summary file. The GitHub reporter writes a Markdown summary table when this is set. |

## Android

| Variable | Description |
|---|---|
| `ANDROID_HOME` | Path to the Android SDK. Used to find `adb`, `emulator`, and `avdmanager` binaries. Falls back to `ANDROID_SDK_ROOT`. |
| `ANDROID_SDK_ROOT` | Alternate path to the Android SDK (deprecated by Google in favor of `ANDROID_HOME`, but still supported as a fallback). |

## Internal (Set by Tapsmith)

These are set by Tapsmith internally and generally should not be modified by users.

| Variable | Description |
|---|---|
| `TAPSMITH_WORKER_ID` | Set by the CLI in parallel and watch mode. Identifies the current worker process. |
| `TAPSMITH_TELEMETRY_SESSION` | Set once by the CLI or MCP server at startup and inherited by every forked worker, so all of one invocation's telemetry events share a `session_id`. Not intended to be set by hand. |
| `TAPSMITH_DAEMON_ADDRESS` | Comma-separated daemon addresses. Used internally by MCP server mode. |
| `TAPSMITH_UI_DEV_URL` | Development server URL for UI mode's frontend. Internal use only. |

## Examples

### Debugging a daemon issue

```bash
RUST_LOG=tapsmith_core=debug TAPSMITH_DAEMON_LOG=daemon.log npx tapsmith test
# Then inspect daemon.log for MITM proxy, agent startup, and device communication logs
```

### Running in CI with a custom daemon binary

```bash
TAPSMITH_DAEMON_BIN=/usr/local/bin/tapsmith-core npx tapsmith test
```

### Verbose SDK debug output

```bash
TAPSMITH_DEBUG=1 npx tapsmith test tests/flaky.test.ts
```

### Tolerating a slow CI emulator

```bash
# Give a hierarchy dump up to 10s before the daemon declares a command timed out
TAPSMITH_AGENT_READ_HEADROOM_MS=10000 npx tapsmith test
```
