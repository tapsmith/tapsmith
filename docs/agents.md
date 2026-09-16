# Using Tapsmith with AI coding agents

Tapsmith is designed so a coding agent (Claude Code, Codex, Cursor, ...) can set up
and run mobile tests without a human at the keyboard. Every setup command has a
non-interactive mode with machine-readable output.

## The setup loop

```bash
npm install -D tapsmith

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

All `--json` surfaces follow the same conventions: valid JSON on success and failure
(`{"error":{"code","message","fix?","candidates?"}}`), exit code 0/1, no ANSI codes.

## init flags

Run `npx tapsmith init --help` for the full list: `--platform`, `--apk`, `--package`,
`--app`, `--bundle-id`, `--avd`, `--simulator`, `--device-type`, `--network-capture`,
`--no-example-test`, `--no-agents-md`, `--force`, `--json`, `--yes`.

iOS *physical* devices require the interactive wizard (code-signing preflight);
everything else works unattended.

## Running tests with structured output

```bash
npx tapsmith test --reporter json     # writes tapsmith-results/results.json
```

## MCP server (recommended)

For richer agent workflows — inspecting the live accessibility tree, validating
locators before committing them, running tests, reading traces — register the
MCP server:

```bash
claude mcp add tapsmith -- npx tapsmith mcp-server   # Claude Code
codex mcp add tapsmith -- npx tapsmith mcp-server    # Codex
```

Key tools: `tapsmith_snapshot` (accessibility tree with suggested locators),
`tapsmith_test_locator`, `tapsmith_run_tests`, `tapsmith_read_trace`,
`tapsmith_screenshot`. The full API reference is exposed as the MCP resource
`tapsmith://api-reference`.

**Running a single test:** pass the `test` argument to `tapsmith_run_tests`. It's
a case-insensitive substring of the full test name (`"Describe > test name"`), so
a bare fragment like `"submits the form"` is enough. If it matches nothing the
tool returns an *error* listing the available tests — it never silently reports a
green run. Use `tapsmith_list_tests` to see exact names.

## Writing good tests (locator philosophy)

Prefer accessibility-first locators — they survive refactors and match how
users perceive the app:

```typescript
device.getByRole('button', { name: 'Login' })   // best
device.getByText('Welcome')                      // good
```

Avoid className/xpath locators. Assertions auto-wait — no manual sleeps.
