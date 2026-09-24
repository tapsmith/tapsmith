# MCP Server

Tapsmith includes a built-in [MCP](https://modelcontextprotocol.io/) server that lets AI coding agents run tests, interact with devices, and inspect results through a standardized tool interface. Both modes expose the same **17 tools** for device interaction, test execution, result browsing, watch mode, and session info.

## Modes

The MCP server operates in two modes:

### HTTP mode (recommended)

When running `tapsmith test --ui`, a Streamable HTTP MCP endpoint is hosted alongside the UI. The agent shares the same daemon, device, and test session as the UI — test runs appear in the UI with full progress tracking, and both the agent and user share mutual exclusion (only one run at a time).

Multiple agents can connect to the same UI session at once: each gets its own MCP session but they all drive the same device and report into the same activity feed (the MCP panel shows how many clients are attached). If an agent's connection drops mid-call, it can simply reconnect — the session stays alive without restarting `tapsmith test --ui`.

To connect, copy the MCP URL from the MCP panel in the UI into any MCP client that supports Streamable HTTP transport. Replace the example URL below with the URL shown in the UI.

Claude Code:

```bash
claude mcp add tapsmith --transport http http://localhost:9274/mcp
```

Codex CLI:

```bash
codex mcp add tapsmith http://localhost:9274/mcp
```

Generic MCP config:

```json
{
  "mcpServers": {
    "tapsmith": {
      "url": "http://localhost:9274/mcp"
    }
  }
}
```

The MCP panel in the UI shows the connection status and a live activity feed of all tool calls.

### Stdio mode

Configure your MCP client to launch `tapsmith mcp-server` over stdio. You normally do not run this command directly; Codex, Claude Code, or another MCP client starts it as a subprocess when needed. The agent gets its own headless test session, daemon, and device, fully independent from any UI session — a headless server never attaches to the worker daemons of a running `tapsmith test --ui`, so what it drives does not change when that run starts, scales, or ends. It also stays off the **devices** that UI session is driving: they are skipped when a device is auto-picked, and a config that pins one of them fails with a message naming the UI session rather than starting a second agent on it. Test files and projects are discovered lazily on the first test-management tool call.

A multi-platform config gets one device and agent **per platform**, taken from
each project's own settings, and runs are routed to the device matching the
project's platform. `tapsmith_session_info` lists them. A platform that cannot
be provisioned — no emulator running, say — does not stop the session: it is
reported there, and a run targeting it fails with that reason while the other
platform keeps working.

Codex CLI:

```bash
codex mcp add tapsmith -- npx tapsmith mcp-server
```

Claude Code:

```bash
claude mcp add tapsmith -- npx tapsmith mcp-server
```

Generic MCP stdio config:

```json
{
  "mcpServers": {
    "tapsmith": {
      "command": "npx",
      "args": ["tapsmith", "mcp-server"]
    }
  }
}
```

To use a non-default Tapsmith config, include the config flag in the command your MCP client launches:

```bash
codex mcp add tapsmith-ios -- npx tapsmith mcp-server --config tapsmith.config.ios.mjs
claude mcp add tapsmith-ios -- npx tapsmith mcp-server --config tapsmith.config.ios.mjs
```

If a UI server is already running, stdio mode will detect it and suggest connecting via HTTP instead. Use HTTP mode when you want the agent and browser UI to share one visible session; use stdio when you want a standalone agent-owned session.

## Tool Reference

### Choosing a device

Every device tool takes an optional `device` and `project`. You rarely need
either:

- **One platform** — including a `workers: 2` UI session driving several
  simulator clones — the tool acts on the session's **primary device**: worker
  0 in UI mode, the first device prepared in a headless session. Pass `device`
  only to single out one worker of a parallel run.
- **More than one platform** (a multi-platform config) — there is no single
  default, so pass `project`. It selects that project's platform, and its
  primary device. `device` still works for a specific serial.

`tapsmith_session_info` lists the devices a session drives. A device the
session merely *sees* — another simulator, a peer session's device — cannot be
acted on: its daemon is pointed elsewhere.

For a project that drives several devices per test (`use.devices`, see
[Multi-device tests](./multi-device.md)), `device` also accepts a member's
**name** — `device: "bob"`. Such a project is discoverable without reading the
config: `tapsmith_list_tests` marks it `(drives 2 devices: alice, bob)`,
`tapsmith_session_info` lists the members beside the project and, once they
are provisioned, one `Device` line per member, and `tapsmith_list_devices`
labels each member with its `name` and `project`. `tapsmith_run_tests` runs
such a project against all of its devices, and every failure step it reports
(as does `tapsmith_list_results`) names the device it ran on.

The same rule governs `tapsmith_run_tests`, with one addition: if a requested
file runs under more than one project, the run is **refused** until you pass
`project`, rather than being sent to whichever project comes first. An unknown
project name is refused too, never ignored.

### Device interaction tools (both modes)

#### `tapsmith_snapshot`

Get the current screen's accessibility tree with copy-paste-ready Tapsmith locators for each interactive element. Use this first when writing tests to see what's on screen.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `device` | string | No | Device serial from `tapsmith_list_devices`. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

Returns a text representation of the accessibility tree with suggested locators like `device.getByRole("button", { name: "Login" })` for each interactive element.

#### `tapsmith_screenshot`

Capture a PNG screenshot of the device screen. Use when you need to visually verify what's on screen or when the accessibility tree is insufficient.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

Returns a base64-encoded PNG image.

#### `tapsmith_test_locator`

Test a Tapsmith locator against the current screen. Returns whether it matches, how many elements match, and details about each match. Use to validate locators before putting them in test code.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string | Yes | Tapsmith locator string, e.g. `device.getByRole("button", { name: "Login" })` |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

Returns a JSON object with `matched` (boolean), `count` (number), and `elements` (array of matched elements with role, text, and bounds).

#### `tapsmith_tap`

Tap a UI element matching the given Tapsmith locator.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string | Yes | Tapsmith locator, e.g. `device.getByRole("button", { name: "Login" })` |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

#### `tapsmith_type`

Type text into an element matching the locator.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `locator` | string | Yes | Tapsmith locator for the text field |
| `text` | string | Yes | Text to type |
| `clear` | boolean | No | Clear existing text before typing (default: false) |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

#### `tapsmith_swipe`

Swipe on the device screen in the given direction. Use to scroll or navigate between screens.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `direction` | string | Yes | One of: `up`, `down`, `left`, `right` |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

#### `tapsmith_press_key`

Press a device key.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | Yes | Key name: `back`, `home`, `enter`, `tab`, `delete`, etc. |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

#### `tapsmith_launch_app`

Launch an app on the device.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `package` | string | Yes | Android package name or iOS bundle ID |
| `clear_data` | boolean | No | Clear app data before launching (default: false) |
| `device` | string | No | Device serial. Defaults to the session's primary device — see [Choosing a device](#choosing-a-device). |

#### `tapsmith_list_devices`

List all connected mobile devices and emulators across all platforms. Returns serial numbers needed for the `device` parameter on other tools.

No parameters.

Returns a JSON array of device objects with `serial`, `model`, `platform` (android/ios), `os_version`, `is_emulator`, and `state`.

### Test execution tools (both modes)

#### `tapsmith_run_tests`

Run Tapsmith test files and return structured results. Only one test run can execute at a time. In HTTP mode, runs appear in the UI with full progress tracking. In stdio mode, runs execute in the headless MCP session and results are available through `tapsmith_list_results`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `files` | string[] | Yes | File paths — absolute, relative to the project root, or globs. Use `tapsmith_list_tests` to find available files. An argument that matches no discovered file is named in the error rather than reported as an empty run. |
| `test` | string | No | Run a specific test by its full name (e.g. `"Login screen > submits form"`). Only works with a single file. |
| `project` | string | No | Project name to target a specific platform/device (e.g. `"android"`, `"ios"`). Required when the same test file runs on multiple platforms. |
| `device` | string | No | Device serial, or a `use.devices` member name, the run must use. Prefer `project` to pick a platform. A session keeps its devices for its whole life, so `device` can confirm the device a run would use — or, on a headless session's first `tapsmith_run_tests`, choose it before anything auto-picks one. A device the session cannot use for the run is refused with the one it holds; it is never ignored. In HTTP (UI) mode it is accepted only when the session has a single worker, since each run goes to whichever worker is free. |

**On success:** returns a summary like "All tests passed: 5 passed, 0 skipped (12.3s)".

**On failure:** returns a detailed report including:
- Failed test names with error messages
- Steps leading to the failure (from the trace)
- Device logs around the failure time
- Trace file path for further debugging with `tapsmith_read_trace`
- A screenshot at the moment of failure

A file that dies before any test reports — a failed import, a crashed or
timed-out worker — is reported as a single failure named
`<file> — file failed to run`, carrying the underlying error. It appears in
`tapsmith_list_results` and `tapsmith_suite_status` like any other failure.

**Progress notifications:** when the MCP client supplies a `progressToken` with the request, the tool emits `notifications/progress` every 10 seconds while the run executes, reporting live pass/fail counts. This keeps long suites alive past client-side idle timeouts (for example, Claude Code aborts a tool call after 300 seconds without output or progress), so a full suite can run in a single `tapsmith_run_tests` call instead of being sharded into small batches.

#### `tapsmith_read_trace`

Read a Tapsmith trace archive (.zip) and return step-by-step test execution data. Use to debug why a test failed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Path to the trace `.zip` file |
| `include_screenshots` | boolean | No | Include base64 screenshots for each step (default: false) |
| `device_logs` | string | No | Include device logs: `errors` (default, error/warn only), `all`, or `none` |

Returns trace metadata (device, platform, test file, duration) followed by a step-by-step action list with status, locators, durations, and error details.

### Test session tools (both modes)

These tools operate on the current MCP test session. In HTTP mode that is the browser UI session; in stdio mode it is the standalone headless session created by the client-launched `tapsmith mcp-server` subprocess.

#### `tapsmith_list_tests`

List all test files, projects, and test names discovered by the current MCP test session. Call this before `tapsmith_run_tests` to get exact file paths, test names, and project names.

No parameters.

Returns a hierarchical tree showing:
- Available projects
- Test files with absolute paths
- Describe blocks (suites)
- Individual test names with their full names (for use with `tapsmith_run_tests`)

A file that fails to load (a missing import, a syntax error) has no tests to
list, so it is reported separately at the end of the tree as a warning with the
reason. Those files cannot be run until the error is fixed — the tree is only
complete when no warning is shown.

#### `tapsmith_list_results`

Browse test results from the current session. Shows pass/fail/skip status, duration, and error messages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status: `passed`, `failed`, or `skipped` |
| `file` | string | No | Filter by file path substring |
| `details` | boolean | No | Include trace steps for failed tests (default: false) |

Returns a summary with counts, then per-test results including status, full name, duration, project, file path, and (when `details: true`) the steps and device logs leading to the failure.

Only covers the most recent run — use `tapsmith_suite_status` for the whole-session board.

#### `tapsmith_suite_status`

Report the status of every test in the discovered test tree — `passed`, `failed`, `skipped`, or `not run` — accumulated across all test runs in the session. Unlike `tapsmith_list_results` (which only reflects the most recent run), results build up across batched `tapsmith_run_tests` calls and runs triggered from the UI, so this shows the complete suite board including tests that have not run yet.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` | string | No | Filter by file path substring |
| `details` | boolean | No | List every test with its status (default: false — per-file counts plus failed test names) |

Returns an overall summary (`Suite status: 27 passed, 2 failed, 1 skipped, 12 not run (30/42 tests run)`) followed by per-file counts, with failed test names and errors listed under each file.

#### `tapsmith_stop_tests`

Stop the currently running test execution and report the outcome. Works whether the run was started by the agent or by the user in the UI.

The stop takes effect immediately: the in-flight device command is cancelled and the current test is recorded as interrupted (`Stopped by user`) rather than riding out its timeout. A worker that fails to stop within a grace period is force-killed and respawned for the next run. The response reports the actual result (`Run stopped: X passed, Y failed, Z skipped, N interrupted`); partial results from the stopped run remain available via `tapsmith_list_results`.

No parameters.

#### `tapsmith_session_info`

Get configuration and environment info for the current test session. Useful for understanding the test environment before writing or running tests.

No parameters.

Returns session details: the config file backing the session, device serial, platform, app package, timeout, retries, and per-project settings (name, platform, package, test file count, dependencies).

Check the `Config:` line first — everything else is derived from it. A headless
session started outside a project directory may pick up a config you did not
intend, or find none at all and fall back to defaults; in the latter case it has
no app to launch, so a warning is returned here and on every failed run. A
UI-mode session reports the config `tapsmith test --ui` was launched with, which
is always a real one.

Paths inside a config are resolved relative to the config file's own directory,
so it does not matter which directory the MCP server was started in.

#### `tapsmith_watch`

Toggle watch mode on a test file. When enabled, the file automatically re-runs on save.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` | string | Yes | Absolute path to the test file |
| `test` | string | No | Specific test full name to watch (watches the whole file if omitted) |
| `project` | string | No | Project name to scope the watch to |

Returns a message indicating whether watch mode was enabled or disabled.

## Typical workflows

### UI-shared workflow

1. **Start the UI:** `tapsmith test --ui`
2. **Connect your agent** to the MCP endpoint shown in the MCP panel
3. **Understand the environment:** call `tapsmith_session_info` to see platform, device, package, and project configuration
4. **Discover tests:** call `tapsmith_list_tests` to see the full test tree with file paths and test names
5. **Explore the screen:** use `tapsmith_snapshot` to see the accessibility tree with suggested locators, then `tapsmith_test_locator` to validate a locator before using it
6. **Run tests:** call `tapsmith_run_tests` with file paths and optional test name / project filters. On failure, the response includes error details, trace steps, and a screenshot
7. **Review results:** use `tapsmith_list_results` to browse the latest run (pass `details: true` to see trace steps for failures), and `tapsmith_suite_status` to see the whole suite's accumulated status including tests that have not run yet
8. **Debug failures:** use `tapsmith_read_trace` with the trace file path from the failure report for step-by-step debugging
9. **Iterate:** toggle `tapsmith_watch` on files being actively developed for automatic re-runs on save

### Headless stdio workflow

1. **Add the MCP server config:** `codex mcp add tapsmith -- npx tapsmith mcp-server`
2. **Understand the environment:** call `tapsmith_session_info` to lazy-load config, connect a device, and show project settings
3. **Discover tests:** call `tapsmith_list_tests` to get file paths, test names, and project names from the headless session
4. **Explore the screen:** use `tapsmith_snapshot` and `tapsmith_test_locator` against the headless session's selected device
5. **Run tests:** call `tapsmith_run_tests`; results are stored in the headless session for `tapsmith_list_results`
6. **Iterate:** use `tapsmith_watch` to re-run watched files on save, or `tapsmith_stop_tests` to terminate a running headless test run

## Locator format

Device action tools (`tapsmith_tap`, `tapsmith_type`, `tapsmith_test_locator`) expect Tapsmith locator strings. These are the same expressions you'd write in test code:

```
device.getByRole("button", { name: "Login" })
device.getByText("Welcome")
device.getByText("Sign In", { exact: true })
device.getByDescription("Close menu")
device.getByTestId("submit-button")
device.getByPlaceholder("Email")
device.locator({ id: "com.myapp:id/input" })
```

Use `tapsmith_snapshot` to see suggested locators for every interactive element on screen.

## Multi-project support

When the config defines multiple projects (e.g. `android` and `ios`), all session-aware tools respect project scoping:

- `tapsmith_run_tests` accepts a `project` parameter to target a specific project
- `tapsmith_list_tests` shows the full tree grouped by project
- `tapsmith_list_results` includes the project name for each result
- `tapsmith_watch` accepts a `project` parameter to scope the watch

Use `tapsmith_session_info` to see available projects and their configuration.

## Resources

The MCP server exposes a `tapsmith://api-reference` resource containing the complete Tapsmith API documentation. Agents can read this resource to understand available methods and their signatures without needing external documentation.
