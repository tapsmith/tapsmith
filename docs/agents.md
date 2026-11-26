# Using Tapsmith with AI coding agents

Tapsmith is designed so a coding agent (Claude Code, Codex, Cursor, ...) can set up
and run mobile tests without a human at the keyboard. Every setup command has a
non-interactive mode with machine-readable output.

## The setup loop

Tapsmith needs Node.js 22 or newer: check `node --version` before installing. On older Node, npm can install an old, incompatible release. Under `--json`, the CLI reports an unsupported Node as the `UNSUPPORTED_NODE` error. With Yarn or pnpm, run the CLI as `yarn tapsmith …` or `pnpm exec tapsmith …`; a Yarn Plug'n'Play project needs `nodeLinker: node-modules` first (`verify --json` reports `YARN_PNP_UNSUPPORTED`, `doctor --json` a failing `yarn-pnp` check). In a pnpm project, `init` sets `esbuild` and `protobufjs` to `false` under `allowBuilds` in `pnpm-workspace.yaml`, which pnpm 11 and later need for installs (CI's included) to exit 0: commit that file. Until those entries exist, run the CLI (`doctor` and `init` included) as `npx tapsmith …`, since pnpm 11's `pnpm exec` first re-runs the failed install and stops. [Package manager notes](getting-started.md#pnpm-err_pnpm_ignored_builds) cover the snippet.

```bash
npm install -D tapsmith    # or: yarn add -D tapsmith / pnpm add -D tapsmith

# 1. Have a build of the app for init to point at: it looks for an APK or a
#    simulator .app and stops if there is none. Use one that exists, else build
#    the app. See "Use an existing build, or make one" below.

# 2. Diagnose the environment. Every failing check includes a `fix`.
npx tapsmith doctor --json

# 3. Once the build exists, configure non-interactively. Auto-detects APK/.app,
#    package name, devices (a running emulator's AVD first). Say which with
#    --apk <path>, --app <path>, --device <serial> or --simulator <name or UDID>.
npx tapsmith init --yes --json
#    Undecidable cases exit 1 with JSON listing candidates and the flag to pass,
#    e.g. {"error":{"code":"AMBIGUOUS_APK","candidates":[...],"fix":"Pass --apk <path>"}}

# 4. Prove the loop works end-to-end before writing tests.
npx tapsmith verify --json
```

**Use an existing build, or make one.** `init` needs a build to point at, not a fresh one. If the app is
already built, use that build, and rebuild only if the app has changed since: `init` finds builds in the project, and Xcode's in
DerivedData when the project holds no simulator build; pass `--apk` or `--app` for one anywhere else. If there is
none, build it: [Build the app under test](getting-started.md#build-the-app-under-test) has the
commands, with [React Native and Expo](getting-started.md#react-native-and-expo) in a section of their
own. An Expo project with no `android/` or `ios/` yet needs `npx expo prebuild` before it can be built.

**`doctor` and `init` only list devices.** They never boot one, install on it or run anything on it, so
they are safe while the machine's devices are busy. `verify` and `test` use a device.

**Don't hand-write `tapsmith.config.ts`**, even while a long build runs: wait for the build, run
`npx tapsmith init --yes --json`, then edit the config it writes: changing it is fine. A project set
up without `init` gets no `AGENTS.md` section.

The `AGENTS.md` section (fenced with `<!-- tapsmith:begin/end -->`) tells every later agent session
how to find locators, run and debug tests, and which docs to read. Keep it: `--no-agents-md` leaves
it out, with a warning. For a project that already has a config but no section, add it without
touching the config:

```bash
npx tapsmith init --agents-md-only --json
```

Running it again after a Tapsmith upgrade brings the section up to date. `doctor` has an `agents-md`
warning while the section is missing.

`init`'s `nextSteps` include the [plugin](#the-plugin-recommended) install for the agent running it.
Give it to the user in the same turn: it changes their agent's settings, and the MCP tools
load when the agent's session restarts.

React Native Debug or Expo dev-client build only: it loads its JavaScript from Metro, so Metro must be
running (`npx expo start` or `npx react-native start`) before `verify` or `test`. JavaScript edits then need
no rebuild; changes to native code, config plugins or native dependencies do. See
[Debug and dev-client builds with Metro](getting-started.md#debug-and-dev-client-builds-with-metro).

All `--json` surfaces (`init`, `verify`, `doctor`, `list-devices`, `telemetry`,
`ios setup-device`) follow the same conventions: one JSON document on stdout, on success
and on failure (`{"error":{"code","message","fix?","candidates?"}}`), exit code 0/1, no
ANSI codes. `init --json` needs `--yes` (or a setup flag): the wizard has no JSON output.
The exceptions — a config file that itself prints to stdout, and interrupted runs (which
may print nothing, and for `verify` may even finish normally) — and every schema and
error code are in the [API reference](api-reference.md#json-output---json).

## init flags

Run `npx tapsmith init --help` for the full list: `--platform`, `--apk`, `--package`,
`--app`, `--bundle-id`, `--avd`, `--device`, `--simulator`, `--device-type`, `--network-capture`,
`--no-network-capture`, `--force`, `--agents-md-only`, `--no-example-test`, `--no-agents-md`, `--json`, `--yes`.

With an emulator already running, `init --yes` writes its AVD (one another Tapsmith
session is using is skipped); `--device <serial>` picks a connected device by its
`adb devices` serial. The `avd` init writes keeps working on CI, where the workflow boots its
own emulator ([CI Setup](ci-setup.md#the-avd-in-a-config-from-tapsmith-init)).
iOS *physical* devices require the interactive wizard (code-signing preflight);
everything else works unattended.

## Running tests with structured output

```bash
npx tapsmith test --reporter json     # writes tapsmith-results/results.json
```

## The docs in the package

Every docs page ships in the npm package, so an agent reads the docs of the
installed version without web access: `node_modules/tapsmith/docs/<page>.md`.
Start with `api-reference.md`, `writing-tests.md` and `locators.md`. Links
between pages are relative file links.

## The plugin (recommended)

Install the Tapsmith plugin for Claude Code, Codex or Cursor. Whenever UI mode
is running (`npx tapsmith test --ui`), the agent works in the UI session you have
open: you watch its test runs and device actions as they happen. With no UI
session running, it works headless on a device of its own, and moves to a UI
session you start later from its next tool call, with no restart.

```bash
claude plugin marketplace add tapsmith/tapsmith && claude plugin install tapsmith@tapsmith   # Claude Code
codex plugin marketplace add tapsmith/tapsmith && codex plugin add tapsmith@tapsmith         # Codex
```

The plugin registers one MCP server, run from the project's own Tapsmith
install, and adds a skill for writing and debugging tests that points the agent
at the bundled docs. [Install the plugin](mcp-server.md#install-the-plugin) covers
Cursor, which project folder the server runs in, and
[how the server follows UI mode](mcp-server.md#one-server-that-follows-ui-mode).

## MCP server

For richer agent workflows — inspecting the live accessibility tree, validating
locators before committing them, running tests, reading traces — the agent
needs the MCP server. The plugin registers it; without the plugin, register
`npx tapsmith mcp-server --prefer-ui`, the server the plugin uses. It works in
the project's UI session whenever one is running and headless otherwise, so
there is no URL to copy:

```bash
claude mcp add tapsmith -- npx tapsmith mcp-server --prefer-ui   # Claude Code
codex mcp add tapsmith -- npx tapsmith mcp-server --prefer-ui    # Codex
```

The two modes it chooses between can also be registered on their own, each
under a name of its own, for the cases it does not cover:

- **`tapsmith-ui`**, to connect to a UI session of another project or machine.
  Register the MCP URL that UI shows (`http://localhost:9274/mcp` by default):

  ```bash
  claude mcp add tapsmith-ui --transport http http://localhost:9274/mcp   # Claude Code
  codex mcp add tapsmith-ui --url http://localhost:9274/mcp               # Codex
  ```

- **`tapsmith-headless`**, to keep an agent on a session of its own whatever UI
  sessions are running. The agent's MCP client starts it as a subprocess:

  ```bash
  claude mcp add tapsmith-headless -- npx tapsmith mcp-server   # Claude Code
  codex mcp add tapsmith-headless -- npx tapsmith mcp-server    # Codex
  ```

The `AGENTS.md` section `tapsmith init` writes tells your agent the same, and
`init` lists the plugin install for the coding agent running it, or, run by a person, for each agent it finds in the project ([`tapsmith init`](api-reference.md#tapsmith-init-options) says how it looks).

Key tools: `tapsmith_snapshot` (accessibility tree with suggested locators),
`tapsmith_test_locator`, `tapsmith_run_code` (try assertions and other test statements on the device), `tapsmith_run_tests`, `tapsmith_read_trace`,
`tapsmith_screenshot`. [The locator loop](#the-locator-loop) says how they fit together. The full API reference is exposed as the MCP resource
`tapsmith://api-reference`.

**Running a single test:** pass the `test` argument to `tapsmith_run_tests`. It's
a case-insensitive substring of the full test name (`"Describe > test name"`), so
a bare fragment like `"submits the form"` is enough. If it matches nothing the
tool returns an *error* listing the available tests — it never silently reports a
green run. Use `tapsmith_list_tests` to see exact names.

## The locator loop

An agent that writes locators from one look at the screen, and finds out at run time, pays a full timeout for every wrong guess. Follow this loop instead, for every locator:

1. `tapsmith_snapshot` on the screen the test is about: the accessibility tree, with locators the device has checked for each element.
2. Take a suggested locator, or write one.
3. `tapsmith_test_locator` with it. Repeat until it counts exactly 1 match, or the one `.first()`/`.nth()` picks is the element you meant.
4. Only then put it in test code. **Never put a locator in a test that `tapsmith_test_locator` hasn't confirmed.**
5. `tapsmith_run_tests` on the file.
6. On a failure, `tapsmith_read_trace` on its trace. If a locator matched nothing, the error can list locators that match the same words (it lists none when nothing near matches, or for a locator the check doesn't cover), and the run's report ends with the next step. Go back to step 1 for that locator; don't edit and re-run blind.

`tapsmith_tap` and `tapsmith_type` act exactly as a test would, so they are for getting the app to the screen under test, not for checking a locator: their misses wait out a timeout first.

## Writing good tests (locator philosophy)

Prefer accessibility-first locators — they survive refactors and match how
users perceive the app:

```typescript
device.getByRole('button', { name: 'Login' })   // best
device.getByText('Welcome')                      // good
```

Avoid className/xpath locators. Assertions auto-wait — no manual sleeps.
