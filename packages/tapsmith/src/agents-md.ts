/**
 * AGENTS.md scaffolding — gives the user's coding agent durable instructions
 * for running and debugging tapsmith tests. The section is fenced with
 * markers so re-running `tapsmith init` updates it idempotently.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const AGENTS_BEGIN = '<!-- tapsmith:begin -->';
export const AGENTS_END = '<!-- tapsmith:end -->';

/** Where the docs are when Tapsmith is installed in the project itself, as a path from it. */
export const DEFAULT_DOCS_DIR = 'node_modules/tapsmith/docs';

/**
 * The docs of the Tapsmith that `import "tapsmith"` finds from `cwd`, as a
 * path from `cwd` with forward slashes: the nearest `node_modules/tapsmith`
 * in `cwd` or a folder above it, as Node looks. A workspace that hoists the
 * install to its root (`npm i -D tapsmith -w e2e`) has none in the package
 * itself. The `node_modules` path is kept for a symlinked (pnpm) install.
 * With no install yet, {@link DEFAULT_DOCS_DIR}.
 */
export function installedDocsDir(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'node_modules', 'tapsmith');
    if (fs.existsSync(path.join(pkg, 'package.json'))) {
      return path.relative(path.resolve(cwd), path.join(pkg, 'docs')).split(path.sep).join('/');
    }
    if (path.dirname(dir) === dir) return DEFAULT_DOCS_DIR;
  }
}

/** The AGENTS.md section; `docsDir` is where the installed docs are, from the project ({@link installedDocsDir}). */
export function renderAgentsSection(docsDir: string = DEFAULT_DOCS_DIR): string {
  return `${AGENTS_BEGIN}
## Mobile testing with Tapsmith

This project uses [Tapsmith](https://github.com/tapsmith/tapsmith) for mobile E2E tests (Playwright-style API).

The docs for the installed Tapsmith version ship in the package: read \`${docsDir}/<page>.md\` (start with \`api-reference.md\`, \`writing-tests.md\` and \`locators.md\`) rather than guessing the API or relying on docs for another version.

### Running and debugging

- Run all tests: \`npx tapsmith test\`
- Run one file: \`npx tapsmith test tests/example.tapsmith.ts\`
- Test files end in \`.tapsmith.ts\` (the config's \`testMatch\`), so the project's Jest or Vitest run doesn't pick them up as unit tests. Keep them out of \`__tests__\` folders, where Jest runs every file.
- Filter by name: \`npx tapsmith test --grep "login"\`
- Machine-readable results: \`npx tapsmith test --reporter json\` (writes \`tapsmith-results/results.json\`)
- Interactive UI mode: \`npx tapsmith test --ui\` (preferred for local debugging and agent-assisted work)
- Config lives in \`tapsmith.config.ts\`.
- Environment problems: \`npx tapsmith doctor --json\` (each failing check includes a \`fix\`).
- Verify the whole setup end-to-end: \`npx tapsmith verify --json\`.
- Traces are recorded only when tracing is on (\`trace\` in the config, or \`--trace retain-on-failure\`); open one with \`npx tapsmith show-trace <trace.zip>\`. Network mocks (\`device.route()\`) need no trace: the network proxy starts on a test's first route or network wait. Register routes before the app sends the requests they mock.

### MCP workflow

The Tapsmith plugin for Claude Code, Codex and Cursor registers one MCP server, \`tapsmith\` (run from this project's Tapsmith install), and adds a skill for writing and debugging tests; \`${docsDir}/mcp-server.md\` says how to install it. That server works in the user's running \`npx tapsmith test --ui\` session when there is one, so they can watch, and headless otherwise; \`tapsmith_session_info\` says which. With the plugin installed, nothing below needs registering.

Without the plugin, register by hand the server the plugin uses, under the name \`tapsmith\`. It works in the user's UI session whenever one is running and headless otherwise, so no URL is needed:

- Claude Code: \`claude mcp add tapsmith -- npx tapsmith mcp-server --prefer-ui\`
- Codex: \`codex mcp add tapsmith -- npx tapsmith mcp-server --prefer-ui\`

Two single-mode registrations cover the cases it does not. To work in a UI session of another project or machine, ask the user for the MCP URL that UI shows and register it as \`tapsmith-ui\`:

- Claude Code: \`claude mcp add tapsmith-ui --transport http http://localhost:<port>/mcp\`
- Codex: \`codex mcp add tapsmith-ui --url http://localhost:<port>/mcp\`

To keep an agent headless, on an isolated agent-owned session whatever UI sessions are running, register the plain stdio server as \`tapsmith-headless\`:

- Claude Code: \`claude mcp add tapsmith-headless -- npx tapsmith mcp-server\`
- Codex: \`codex mcp add tapsmith-headless -- npx tapsmith mcp-server\`

Do not start a long-lived UI session yourself unless the user asks you to. Prefer asking the user to start \`npx tapsmith test --ui\` in their terminal so they can see and control the shared session.

When using MCP, inspect before editing: \`tapsmith_snapshot\` for the accessibility tree and suggested locators, \`tapsmith_test_locator\` to prove a locator is unique, \`tapsmith_screenshot\` when the tree is not enough, \`tapsmith_list_tests\` before \`tapsmith_run_tests\`, and \`tapsmith_read_trace\` for failures.

### The locator loop

Follow it for every locator you write:

1. \`tapsmith_snapshot\` on the screen under test.
2. Pick a suggested locator, or write one.
3. \`tapsmith_test_locator\` with it, until it counts exactly 1 match (or the element a deliberate \`.first()\`/\`.nth()\` picks).
4. Only then put it in test code. Never put a locator in a test that \`tapsmith_test_locator\` hasn't confirmed.
5. \`tapsmith_run_tests\`.
6. On failure, \`tapsmith_read_trace\`. A locator that matched nothing may list locators that match the same words; either way, go back to step 1 for it instead of guessing again.

When you walk a flow with \`tapsmith_tap\`, \`tapsmith_type\`, \`tapsmith_swipe\`, \`tapsmith_press_key\` or \`tapsmith_launch_app\`, each answers with a \`Test line:\` that repeats the step, its locator checked by the device to match exactly the element acted on. Write each line into the test file as you go. A \`(position-dependent)\` line keeps its \`.first()\`/\`.nth()\`; a result that says the line could not be verified gives none, so take that step's locator through the loop above.

Check every assertion with \`tapsmith_run_code\` before you write it into the test: it runs statements as a test writes them (\`await expect(device.getByText("Saved")).toBeVisible();\`, \`await device.getByText("Row 40").scrollIntoView();\`, \`await device.openDeepLink("…");\`) on the device, stops at the first failure with the error the test would get, and answers each passing one with its \`Test line:\`.

Without MCP, ask the user to pick the element in UI mode (\`npx tapsmith test --ui\`, pick button in the device mirror); its Locator tab lists locators the device has checked.

### Writing tests

- Prefer a custom fixture module once the suite has shared screen objects, setup, or helpers (for example \`tests/fixtures.ts\` or \`e2e/fixtures.ts\`). Export \`test\`, \`expect\`, and shared fixtures from that module, and import from it consistently instead of importing directly from \`tapsmith\` in each spec.
- Group related behavior with \`describe()\`. Keep each test focused on one user-visible behavior, and use hooks only to put the app into a known starting state.
- Prefer screen objects for reused screens. A screen object should take \`Device\`, expose locators as getters, and provide composite multi-step actions such as \`login()\` or \`openSettings()\`. Avoid one-line wrappers around \`.tap()\`; tests can tap exposed locators directly.
- Keep assertions in tests, not screen objects. Screen objects provide locators and intentful actions; specs decide what must be true.
- Tests should be independent and parallel-safe. Tapsmith resets the app for you once per test file by default; a scope that needs a fresh app before every test opts in with \`test.use({ appResetScope: 'test' })\`. When the app mounts \`@tapsmith/react-native\`, each reset is a warm, acknowledged in-app reset instead of a data wipe and cold launch (recommend adding it to React Native apps, with \`<TapsmithTestHooks>\` wrapping the root navigator so each reset remounts the screens; mounted beside the navigator, screens that stay mounted, such as tabs, keep the previous test's state). Declare a policy with \`test.use({ appReset: 'clear' | 'restart' | 'warm' | 'none', appResetScope: 'file' | 'test' })\` instead of writing \`restartApp()\` / \`launchApp({ clearData: true })\` in a \`beforeEach\`, and \`test.use({ appResetScope: 'test', appResetRoute: '/screen' })\` instead of a \`beforeEach\` that only opens each test's starting screen (the reset then lands there in one delivery; with the default file scope the route is only opened once per file); \`device.resetApp({ target })\` runs the same reset mid-test. Prefer deep links, API setup, setup projects, or saved app state over clicking through unrelated setup UI. Generate unique names/emails/IDs for data created during tests.
- Network routes clean up after themselves: a \`device.route()\` registered in a test, \`beforeEach\` or \`afterEach\` is removed after that test, and one registered in \`beforeAll\` stays for every test of its \`describe\` (or file) until that scope ends. Register a mock every test of a scope shares in \`beforeAll\`, and one a single test needs in that test.

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

### Coming from Playwright

Tapsmith's API is Playwright-shaped, but these differ:

- \`.click()\` → \`.tap()\` (also \`.doubleTap()\`, \`.longPress()\`).
- \`.fill(text)\` → \`.clearAndType(text)\` to replace a field's text, or \`.type(text)\` to add to it.
- \`.check()\` / \`.uncheck()\` → \`.setChecked(true)\` / \`.setChecked(false)\`.
- \`page\` → the \`device\` fixture: \`device.getByRole(...)\`.
- Taps do not scroll: call \`await locator.scrollIntoView()\` before tapping an element further down a list.

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

/**
 * Write `text` beside the file and rename it into place: AGENTS.md holds the
 * user's own text, which a write that fails half-way (a full disk) must not
 * lose. A symlink (to CLAUDE.md, say) stays one; its target is replaced.
 */
function replaceFile(filePath: string, text: string): void {
  const target = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, text);
    if (fs.existsSync(target)) fs.chmodSync(tmp, fs.statSync(target).mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Writes/updates the tapsmith section in <cwd>/AGENTS.md. Returns the file path. */
export function writeAgentsMd(cwd: string): string {
  const filePath = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  replaceFile(filePath, mergeAgentsMd(existing, renderAgentsSection(installedDocsDir(cwd))));
  return filePath;
}

/** Whether `text` has no Tapsmith section, one well-formed one, or markers that leave its extent a guess. */
function sectionState(text: string): 'none' | 'one' | 'malformed' {
  const begins = text.split(AGENTS_BEGIN).length - 1;
  const ends = text.split(AGENTS_END).length - 1;
  if (begins === 0 && ends === 0) return 'none';
  return begins === 1 && ends === 1 && text.indexOf(AGENTS_END) > text.indexOf(AGENTS_BEGIN) ? 'one' : 'malformed';
}

/**
 * Add the section to `<cwd>/AGENTS.md`, or bring an existing one up to date.
 * With stray or repeated markers nothing is written: replacing a section
 * whose extent is a guess could take the user's own text.
 */
export function updateAgentsMd(cwd: string): 'written' | 'unchanged' | 'malformed' {
  const filePath = path.join(cwd, 'AGENTS.md');
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
  if (existing !== undefined && sectionState(existing) === 'malformed') return 'malformed';
  const updated = mergeAgentsMd(existing, renderAgentsSection(installedDocsDir(cwd)));
  if (updated === existing) return 'unchanged';
  replaceFile(filePath, updated);
  return 'written';
}

/**
 * Rewrite the Tapsmith section of `<cwd>/AGENTS.md` with the docs path as it
 * is now. The wizard writes AGENTS.md before it offers to install Tapsmith,
 * and an install from a workspace package lands in the workspace root. A
 * file without exactly one well-formed section is left alone.
 */
export function refreshAgentsMdDocsDir(cwd: string): void {
  const filePath = path.join(cwd, 'AGENTS.md');
  if (!fs.existsSync(filePath)) return;
  const existing = fs.readFileSync(filePath, 'utf8');
  if (sectionState(existing) === 'one') updateAgentsMd(cwd);
}
