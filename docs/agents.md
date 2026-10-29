# Using Tapsmith with AI coding agents

Tapsmith is designed so a coding agent (Claude Code, Codex, Cursor, ...) can set up
and run mobile tests without a human at the keyboard. Every setup command has a
non-interactive mode with machine-readable output.

## The setup loop

Tapsmith needs Node.js 22 or newer: check `node --version` before installing. On older Node, npm can install an old, incompatible release. Under `--json`, the CLI reports an unsupported Node as the `UNSUPPORTED_NODE` error. With Yarn or pnpm, run the CLI as `yarn tapsmith …` or `pnpm exec tapsmith …`; a Yarn Plug'n'Play project needs `nodeLinker: node-modules` first (`verify --json` reports `YARN_PNP_UNSUPPORTED`, `doctor --json` a failing `yarn-pnp` check). [Package manager notes](getting-started.md#pnpm-err_pnpm_ignored_builds) cover the pnpm `allowBuilds` snippet.

```bash
npm install -D tapsmith    # or: yarn add -D tapsmith / pnpm add -D tapsmith

# 1. Diagnose the environment. Every failing check includes a `fix`.
npx tapsmith doctor --json

# 2. Configure non-interactively. Auto-detects APK/.app, package name, devices.
npx tapsmith init --yes --json
#    Undecidable cases exit 1 with JSON listing candidates and the flag to pass,
#    e.g. {"error":{"code":"AMBIGUOUS_APK","candidates":[...],"fix":"Pass --apk <path>"}}

# 3. Prove the loop works end-to-end before writing tests.
npx tapsmith verify --json
```

`init` also scaffolds an `AGENTS.md` section (fenced with `<!-- tapsmith:begin/end -->`)
so the project's agent has durable instructions. Skip with `--no-agents-md`.

All `--json` surfaces (`init`, `verify`, `doctor`, `list-devices`, `telemetry`,
`ios setup-device`) follow the same conventions: one JSON document on stdout, on success
and on failure (`{"error":{"code","message","fix?","candidates?"}}`), exit code 0/1, no
ANSI codes. `init --json` needs `--yes` (or a setup flag): the wizard has no JSON output.
The exceptions — a config file that itself prints to stdout, and interrupted runs (which
may print nothing, and for `verify` may even finish normally) — and every schema and
error code are in the [API reference](api-reference.md#json-output---json).

## init flags

Run `npx tapsmith init --help` for the full list: `--platform`, `--apk`, `--package`,
`--app`, `--bundle-id`, `--avd`, `--simulator`, `--device-type`, `--network-capture`,
`--no-network-capture`, `--no-example-test`, `--no-agents-md`, `--force`, `--json`, `--yes`.

iOS *physical* devices require the interactive wizard (code-signing preflight);
everything else works unattended.

## Running tests with structured output

```bash
npx tapsmith test --reporter json     # writes tapsmith-results/results.json
```

## MCP server (recommended)

For richer agent workflows — inspecting the live accessibility tree, validating
locators before committing them, running tests, reading traces — register the
MCP server. It comes in two forms, registered under two names so an agent can
have both:

- **`tapsmith-ui`**, preferred whenever `npx tapsmith test --ui` is running: the
  agent works in the UI session you can see, sharing its device, test tree,
  results and traces. Register the MCP URL the UI shows (`http://localhost:9274/mcp`
  by default):

  ```bash
  claude mcp add tapsmith-ui --transport http http://localhost:9274/mcp   # Claude Code
  codex mcp add tapsmith-ui --url http://localhost:9274/mcp               # Codex
  ```

- **`tapsmith-headless`**, for when no UI session is running or the agent needs a
  session of its own. The agent's MCP client starts it as a subprocess:

  ```bash
  claude mcp add tapsmith-headless -- npx tapsmith mcp-server   # Claude Code
  codex mcp add tapsmith-headless -- npx tapsmith mcp-server    # Codex
  ```

The `AGENTS.md` section `tapsmith init` writes tells your agent the same.

Key tools: `tapsmith_snapshot` (accessibility tree with suggested locators),
`tapsmith_test_locator`, `tapsmith_run_tests`, `tapsmith_read_trace`,
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
