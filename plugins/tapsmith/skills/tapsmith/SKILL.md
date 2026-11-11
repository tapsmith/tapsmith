---
name: tapsmith
description: Write, run and debug Tapsmith mobile tests (Android and iOS, Playwright-style API). Use when a project has a tapsmith.config.ts or *.tapsmith.ts tests, or the user asks to add, fix, run or debug a Tapsmith test, find a locator for an element on a phone screen, or work out why a Tapsmith test failed.
---

# Tapsmith tests

Tapsmith tests drive a real Android emulator or iOS simulator with a Playwright-shaped API
(`device.getByRole(...)`, `expect(locator).toBeVisible()`). This skill covers the loop:
find locators on the live screen, write the test, run it, and read the trace when it fails.

## Read the docs of the installed version first

The tapsmith package ships its docs. Read them from the project rather than from memory or the
web, so they match the version the tests run with:

```
node_modules/tapsmith/docs/<page>.md
```

(In a monorepo, the `node_modules` of the package that holds `tapsmith.config.ts`.) Links
between pages are relative, so follow them as file paths. Which page for what:

| Need | Page |
|---|---|
| Every method, option and assertion | `api-reference.md` |
| Structuring tests, screen objects, resets, auth | `writing-tests.md` |
| Choosing a locator | `locators.md` |
| The MCP tools and their arguments | `mcp-server.md` |
| Running unattended from an agent, `--json` output | `agents.md` |
| A failure: errors, traces, logs, retries | `debugging.md`, `trace-viewer.md` |
| Config options | `configuration.md` |
| Network mocks (`device.route()`) | `network.md` |

If `node_modules/tapsmith` is missing, Tapsmith is not installed in this project: say so and
suggest `npm install -D tapsmith`, then `npx tapsmith init`. Do not install a global copy.

## Tools

The plugin registers one MCP server, **`tapsmith`**, run from the project's own Tapsmith
install. It works in the session the user can see whenever there is one:

- **UI mode.** With `npx tapsmith test --ui` running in the project, every tool call goes to
  that session. Runs and device actions show in its window, and the agent shares its device,
  test tree and results.
- **Headless.** With no UI session, it runs on a device of its own.

The server checks on every call, so a UI session the user starts or closes later is picked up
without a restart. `tapsmith_session_info` ends with a `## Mode` section saying which one the
session is in. Each mode has its own results and watches: after a switch (a tool result says
when one happened), read them again rather than assuming the earlier ones.

When headless, tell the user they can watch the agent work by running `npx tapsmith test --ui`
in the project. Do not start a UI session yourself unless asked.

Key tools:

- `tapsmith_snapshot`: the screen's accessibility tree, with locators the device has checked.
- `tapsmith_test_locator`: how many elements a locator matches right now.
- `tapsmith_run_tests`: run files, or one test with `test: "<part of its name>"`.
- `tapsmith_read_trace`: a failed test's steps, error and screen.
- `tapsmith_screenshot`, `tapsmith_tap`, `tapsmith_type`, `tapsmith_swipe`: look at the
  device and get the app to the screen under test.

Headless, the server never boots a simulator or launches an emulator. If a tool says the
configured device is not running, tell the user which one to start (the error names it), or to
start `npx tapsmith test --ui`, which boots its own.

## Finding a locator

Follow this loop for every locator. Never put a locator in a test that
`tapsmith_test_locator` has not confirmed.

1. Get the app to the screen under test (`tapsmith_tap`, a deep link, or a test that stops there).
2. `tapsmith_snapshot`, and take a suggested locator, or write one.
3. `tapsmith_test_locator` with it, until it counts exactly 1 match (or the element a deliberate
   `.first()` / `.nth()` picks).
4. Only then put it in the test.

Prefer accessibility-first locators, in this order: `getByRole('button', { name: 'Save' })`,
`getByText`, `getByLabel`, `getByPlaceholder`, `getByDescription`, then `getByTestId`. Avoid
`locator({ xpath })`. `locators.md` covers the rules on each platform.

Without MCP, ask the user to pick the element in UI mode: the pick button in the device mirror
of `npx tapsmith test --ui` shows locators the device has checked (`ui-mode.md`).

## Writing the test

- Test files end in `.tapsmith.ts` (the config's `testMatch`).
- Put a reused screen's locators in a **screen object**: a class that takes `Device`, exposes
  each locator as a getter, and has methods for multi-step actions (`login()`), not one-line
  wrappers around `.tap()`. Keep assertions in the tests. If the project already has a
  `screens/` folder or a fixtures module, follow it. `writing-tests.md#screen-object-pattern`
  has the full pattern.
- Assertions auto-wait: `await expect(locator).toBeVisible()`, `toHaveText()`. Never add
  sleeps or `waitForTimeout`.
- Taps do not scroll: `await locator.scrollIntoView()` before tapping something further down.
- From Playwright: `.click()` is `.tap()`, `.fill(text)` is `.clearAndType(text)`, `page` is the
  `device` fixture.
- Let Tapsmith reset the app between files (the default) rather than restarting it in a
  `beforeEach`. Declare a different policy with `test.use({ appReset, appResetScope })`
  (`writing-tests.md#test-isolation`).

## Running one test

- MCP: `tapsmith_run_tests` with `files: ["tests/login.tapsmith.ts"]` and
  `test: "signs in"` (a case-insensitive part of the full name). `tapsmith_list_tests` lists
  the exact names.
- CLI: `npx tapsmith test tests/login.tapsmith.ts --grep "signs in"`. Add
  `--reporter json` for machine-readable results in `tapsmith-results/results.json`.

Do not run the whole suite while working on one behaviour.

## When a test fails

1. Read the failure `tapsmith_run_tests` returns: the error, the steps before it, device logs and
   a screenshot. It names the trace file.
2. `tapsmith_read_trace` on that trace for the full step list (`include_screenshots: true` to see
   the screens). The CLI equivalent is `npx tapsmith show-trace <trace.zip>`, which opens a
   viewer for the user. Traces are recorded only when tracing is on: pass
   `--trace retain-on-failure` on the CLI, or set `trace` in the config.
3. A locator that matched nothing: the error may list locators that match the same words. Go
   back to *Finding a locator* on the screen in the trace; do not edit and re-run blind.
4. Anything else: `debugging.md` lists the common errors and what they mean.

Environment problems (no device, a missing SDK, a build that will not install) are diagnosed by
`npx tapsmith doctor --json`: each failing check includes a `fix`.
