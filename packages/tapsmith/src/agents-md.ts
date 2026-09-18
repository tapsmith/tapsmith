/**
 * AGENTS.md scaffolding — gives the user's coding agent durable instructions
 * for running and debugging tapsmith tests. The section is fenced with
 * markers so re-running `tapsmith init` updates it idempotently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const AGENTS_BEGIN = '<!-- tapsmith:begin -->';
export const AGENTS_END = '<!-- tapsmith:end -->';

export function renderAgentsSection(): string {
  return `${AGENTS_BEGIN}
## Mobile testing with Tapsmith

This project uses [Tapsmith](https://github.com/tapsmith/tapsmith) for mobile E2E tests (Playwright-style API).

### Running and debugging

- Run all tests: \`npx tapsmith test\`
- Run one file: \`npx tapsmith test tests/example.test.ts\`
- Filter by name: \`npx tapsmith test --grep "login"\`
- Machine-readable results: \`npx tapsmith test --reporter json\` (writes \`tapsmith-results/results.json\`)
- Interactive UI mode: \`npx tapsmith test --ui\` (preferred for local debugging and agent-assisted work)
- Config lives in \`tapsmith.config.ts\`.
- Environment problems: \`npx tapsmith doctor --json\` (each failing check includes a \`fix\`).
- Verify the whole setup end-to-end: \`npx tapsmith verify --json\`.
- Failed runs record traces; open with \`npx tapsmith show-trace <trace.zip>\`.

### MCP workflow

Prefer the UI-backed MCP server over the standalone headless server. If the user already has \`npx tapsmith test --ui\` running, ask them for the MCP URL shown in the UI and register it as \`tapsmith-ui\`:

- Claude Code: \`claude mcp add tapsmith-ui --transport http http://localhost:<port>/mcp\`
- Codex: \`codex mcp add tapsmith-ui http://localhost:<port>/mcp\`

The UI MCP session shares the browser test runner, device, test tree, results, traces, and mutual exclusion. Use the headless stdio server only when no UI session is available or you specifically need an isolated agent-owned session:

- Claude Code: \`claude mcp add tapsmith-headless -- npx tapsmith mcp-server\`
- Codex: \`codex mcp add tapsmith-headless -- npx tapsmith mcp-server\`

Do not start a long-lived UI session yourself unless the user asks you to. Prefer asking the user to start \`npx tapsmith test --ui\` in their terminal so they can see and control the shared session.

When using MCP, inspect before editing: \`tapsmith_snapshot\` for the accessibility tree and suggested locators, \`tapsmith_test_locator\` to prove a locator is unique, \`tapsmith_screenshot\` when the tree is not enough, \`tapsmith_list_tests\` before \`tapsmith_run_tests\`, and \`tapsmith_read_trace\` for failures.

### Writing tests

- Prefer a custom fixture module once the suite has shared screen objects, setup, or helpers (for example \`tests/fixtures.ts\` or \`e2e/fixtures.ts\`). Export \`test\`, \`expect\`, and shared fixtures from that module, and import from it consistently instead of importing directly from \`tapsmith\` in each spec.
- Group related behavior with \`describe()\`. Keep each test focused on one user-visible behavior, and use hooks only to put the app into a known starting state.
- Prefer screen objects for reused screens. A screen object should take \`Device\`, expose locators as getters, and provide composite multi-step actions such as \`login()\` or \`openSettings()\`. Avoid one-line wrappers around \`.tap()\`; tests can tap exposed locators directly.
- Keep assertions in tests, not screen objects. Screen objects provide locators and intentful actions; specs decide what must be true.
- Tests should be independent and parallel-safe. Tapsmith resets the app for you between files — or before every test, automatically, when the app mounts \`@tapsmith/react-native\` (a warm, acknowledged in-app reset; recommend adding it to React Native apps). Declare a policy with \`test.use({ appReset: 'clear' | 'restart' | 'warm' | 'none', appResetScope: 'file' | 'test' })\` instead of writing \`restartApp()\` / \`launchApp({ clearData: true })\` in a \`beforeEach\`; \`device.resetApp({ target })\` runs the same reset mid-test. Prefer deep links, API setup, setup projects, or saved app state over clicking through unrelated setup UI. Generate unique names/emails/IDs for data created during tests.
- Clean up per-test network routes or mocks, for example with \`device.unrouteAll()\`, when a test installs routes that could affect later tests.

### Projects and authenticated state

- For authenticated areas, prefer a setup project over logging in inside every spec. Create an \`auth.setup.ts\` test that logs in once and calls \`device.saveAppState(packageName, './tapsmith-results/auth-state-<name>.tar.gz')\`.
- Add a setup project in \`tapsmith.config.ts\` with \`testMatch: ['**/auth.setup.ts']\`. Add a logged-in project with \`dependencies: ['auth-setup']\` and \`use: { appState: './tapsmith-results/auth-state-auth-setup.tar.gz' }\`, then point that project at the authenticated specs.
- Keep unauthenticated and authenticated specs in separate projects or use \`testIgnore\` so the setup test does not run as a normal test and logged-out tests do not accidentally inherit app state.
- For multi-platform suites, create one auth setup project per platform and one logged-in project per platform. Save each platform's state to a distinct file and make each logged-in project depend on its matching setup project.

### Locators and assertions

- Prefer accessibility-first locators: \`device.getByRole('button', { name: 'Login' })\`, \`device.getByText('Welcome', { exact: true })\`, \`device.getByDescription('Close')\`, \`device.getByLabel('Email')\`, and \`device.getByPlaceholder('Search')\`.
- Use \`getByTestId()\` or \`locator({ id })\` only when no user-visible or accessibility locator can uniquely identify the element. Treat \`locator({ xpath })\` as a last resort; it is Android-only and should have an explanatory comment.
- Assertions auto-wait: prefer \`await expect(locator).toBeVisible()\`, \`toHaveText()\`, \`toBeEnabled()\`, etc. Avoid fixed sleeps and broad timeouts; wait on the UI state, route, response, or traceable app signal that matters.
- Remember strict mode: if a locator can match multiple elements, disambiguate with role/name, \`{ exact: true }\`, a test id, or \`.first()/.nth()\` only when that ordering is intentional.

### Anti-patterns

- Do not add \`waitForTimeout\`, \`sleep\`, or arbitrary polling when an assertion or explicit app/network signal can wait.
- Do not duplicate complex locator construction across specs; add it to the relevant screen object or fixture.
- Do not run the full suite while iterating on one behavior; use a file path, \`--grep\`, or the UI/MCP test tree for targeted runs.
- Do not depend on a previous test's app state. Reset, deep-link, or restore saved state explicitly.
${AGENTS_END}
`;
}

export function mergeAgentsMd(existing: string | undefined, section: string): string {
  if (existing === undefined || existing.trim() === '') {
    return section;
  }
  const beginIdx = existing.indexOf(AGENTS_BEGIN);
  const endIdx = existing.indexOf(AGENTS_END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = existing.slice(0, beginIdx);
    const after = existing.slice(endIdx + AGENTS_END.length).replace(/^\n/, '');
    return `${before}${section}${after}`;
  }
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${section}`;
}

/** Writes/updates the tapsmith section in <cwd>/AGENTS.md. Returns the file path. */
export function writeAgentsMd(cwd: string): string {
  const filePath = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  fs.writeFileSync(filePath, mergeAgentsMd(existing, renderAgentsSection()));
  return filePath;
}
