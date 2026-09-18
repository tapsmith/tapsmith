# Web tests

Playwright suites for Tapsmith's two web apps. **No device, emulator, simulator,
or daemon required** — the whole thing runs in under 20 seconds on any machine
and in CI.

| Project | App | Driven by |
|---|---|---|
| `ui-mode` | UI mode SPA (`src/ui-mode/`) | an intercepted WebSocket |
| `trace-viewer` | standalone trace viewer (`src/trace-viewer/`) | an intercepted trace archive |

The two apps share their whole inspection layer — `ActionsPanel`,
`ScreenshotPanel`, `DetailTabs`, `NetworkTab`, `HierarchyTree`,
`LocatorPlayground` and `TimelineFilmstrip` are imported by UI mode from the
trace viewer. Those are covered through the **trace-viewer** project, where a
static archive is far less setup than choreographing a live session, and the
coverage lands on both apps. The **ui-mode** project covers what only it has: the
test tree, run control, the live device mirror, workers, and the MCP feed.

## Running

```bash
# once, and after any change to either app (the suites test the built bundles)
cd ../packages/tapsmith && npm ci && npm run build

cd ../../web-tests
npm ci
npx playwright install chromium

npm test                                  # everything
npx playwright test --project=ui-mode
npx playwright test --project=trace-viewer
npm run test:ui                           # Playwright's UI runner, for authoring
npm run typecheck
```

Because the suites run against `dist/`, **rebuild after changing either app**:
`cd ../packages/tapsmith && npm run build:ui-mode` (or `build:trace-viewer`).

Changing `ui-protocol.ts` or `trace/types.ts` needs the full `npm run build`
instead — `protocol.ts` and `trace-types.ts` here import the emitted `.d.ts`
files, which come from the `tsc` step rather than either Vite build, so
`npm run typecheck` would otherwise check against stale types.

## How it works

Neither app's data comes from the server. `serve.mjs` serves only the two built
`index.html` files; every payload is fulfilled from the test process.

- **UI mode** has exactly two inputs: one WebSocket, and two download-only HTTP
  routes. Everything the user sees — the tree, statuses, trace actions,
  screenshots, hierarchy XML, network entries, device-mirror frames — arrives as
  a `ServerMessage`. `ui-mode/fake-ui-server.ts` intercepts the socket with
  Playwright's `page.routeWebSocket()` and never calls `connectToServer()`, so
  **the route is the server**. It can push any message, push binary screen
  frames, record every `ClientMessage` the SPA sends, and drop the connection to
  exercise the 1s reconnect.
- **The trace viewer** takes a `?trace=<url>` parameter and `fetch`es it.
  `trace-viewer/trace-builder.ts` builds an archive in memory and the fixture
  fulfils that request. The archive layout is the viewer's real input contract,
  read off `parseTraceZip`.

Serving over HTTP rather than `file://` matters for UI mode: `use-websocket.ts`
derives its socket URL from `location.host`.

`protocol.ts` and `trace-types.ts` are the only files reaching into
`packages/tapsmith/dist`. Types come from the SDK's own `ui-protocol.ts` and
`trace/types.ts`, so a fixture whose shape drifts fails `npm run typecheck`
rather than silently exercising nothing — which has already caught several
mis-shaped fixtures.

## Layout

```text
web-tests/
  serve.mjs            static server for both built apps
  protocol.ts          UI mode's wire protocol, re-exported
  trace-types.ts       the trace-archive format, re-exported
  png.ts               minimal PNG encoder, used by both halves
  panes/               pane objects for the shared inspection components
  ui-mode/
    fixtures.ts        the fake server + UI-mode panes
    fake-ui-server.ts  the routeWebSocket harness
    messages/          builders for trees, trace events, screen frames
    panes/             test explorer, run controls, device pane, MCP panel
    specs/
  trace-viewer/
    fixtures.ts        the archive-serving harness + panes
    trace-builder.ts   builds archives, and the events inside them
    specs/
```

## Pane objects

The mobile suite in `e2e/` uses the screen-object pattern documented in
`docs/writing-tests.md`; these suites apply the same conventions to the web apps'
panes:

- **One class per pane**, wrapping `page`. Panes for shared components live in
  the top-level `panes/` so both projects use the same ones.
- **Getters, not constructor assignments** — each access yields a fresh lazy
  locator.
- **Multi-step flows as methods**, so specs read as intent:
  `explorer.runNode("smoke")`, `network.openDetailTab("Response")`.
- **No assertions in pane objects.** They expose locators and actions; specs
  decide what to assert.
- Panes are trimmed to what the specs exercise. An unverified locator is a
  liability, not a head start — several written ahead of their specs turned out
  to be wrong.

## Locators

Accessible locators first — `getByRole`, `getByLabel`, `getByTitle`. The classes
in `styles/ui-mode.css.ts` are styling hooks and only incidentally stable, so
nothing here selects on them. Where a surface had no accessible name, the fix was
to give it the ARIA it should already have had:

| Surface | Now |
|---|---|
| Test tree, view hierarchy | `tree` of `treeitem`s with `aria-level`/`-expanded`/`-selected` |
| Detail tabs, worker tabs, screenshot stages | `tablist`/`tab` wired to their panel with `aria-controls`/`tabpanel`, keyboard-operable |
| Status filters, network filter pills | `aria-pressed` toggle groups — they filter in place rather than switching panels |
| Network request list | already a real `<table>` — rows and cells by native role |
| Every filter and search box | `aria-label` (a placeholder is not a label) |
| Elapsed time | `role="timer"` |
| Console output, MCP feed | `role="log"` |
| Connection strip, mirror placeholder | `role="status"` |
| Highlighted source line | `aria-current` — the line the selected action came from |
| Notification banners | `role="alert"` (errors) / `role="status"` (notices) |
| Mirror canvas | labelled, per worker in the grid |
| Theme select, per-row run/watch buttons, close buttons | labelled |

### Locate structurally, assert the value

Nothing is located by its text content. A text locator conflates finding with
asserting, so a wrong value reports "element not found" rather than showing what
it actually said:

```ts
await expect(runControls.connection).toHaveText("Disconnected")     // role="status"
await expect(runControls.passedCount).toHaveText("1 passed")        // data-testid
await expect(explorer.statusFilterCount("Fail")).toHaveText("1")    // data-testid
```

`getByTestId` is the deliberate fallback where there is genuinely no semantics to
appeal to — bare numbers, message strings, and list rows with no role of their
own: `node-duration`, `filter-count`, `count-passed`/`-failed`/`-skipped`,
`tests-empty`, `run-notification`, `preflight-message`, `mirror-status`/`-hint`,
`call-grid`, `no-content`, `log-entry`, `log-message`, `error-entry`, `source-line`,
`source-filename`, `net-detail-body`, `hierarchy-row`, `hierarchy-properties`,
`locator-code`, `locator-match-count`, `locator-strict-warning`, `film-frame`,
`timeline-meta`, `viewer-title`, `screenshot-empty`, `viewer-empty`, `pick-note`, `mcp-entry`,
`mcp-agent`, `mcp-empty`, `actions-list`, `action-item`, `locator-suggestions`,
`locator-option`, `explorer-pane`, `explorer-resize`, `source-line` (which also
carries `data-line`, its 1-based line number).

Two exceptions worth knowing.

A tree row's `data-type` and `data-status` carry type and status, because ARIA has
no role or state meaning "this test failed" and those are pre-existing product
attributes rather than styling hooks. Both are applied via `.and()` on top of the
role, so the accessible locator stays primary.

### Roles and keyboard operability

A role that describes an interactive widget is a promise the widget can be
operated. Where the promise was new, the keyboard support went in with it:

- **Tab strips** — the detail tabs and screenshot stages were clickable `div`s
  reachable only by mouse. They are now focusable, with Left/Right, Home/End and
  Enter/Space, and each tab points at its panel via `aria-controls` with a
  matching `role="tabpanel"`. The worker tabs were already `<button>`s, so Tab
  and Enter worked before the role; they gained arrow keys and the same panel
  wiring.
- **Only things that switch panels are tabs.** The status filters narrow the same
  tree in place, so they are an `aria-pressed` toggle group, not a tabset — the
  model the network filter pills already used. Calling them tabs implied a panel
  switch that never happens.
- Tabs stay **individually tabbable** rather than adopting APG's roving-tabindex
  pattern. Several of these strips are plain buttons already in the tab order;
  switching to roving would make Tab skip the whole group, taking away behaviour
  keyboard users have today. Arrow keys are additive. The trade is more tab stops.
- **The pane resize grips deliberately carry no `separator` role.** Arrow-key
  resizing is not implemented, only one of the six grips would have been
  labelled, and a separator with no `aria-valuenow` describes a control that
  cannot be adjusted. They are addressed by test id instead.
- **The trees keep `treeitem` without arrow-key navigation** — a knowing gap.
  Row selection and expansion have always been mouse-only, so this is not a
  regression, and the roles earn their place in a screen reader's browse mode,
  where `aria-level` and `aria-expanded` convey a shape that plain `div`s cannot.
  In focus mode the gap is real. Implementing it means a flattened visible-node
  list and roving focus across two components with separate expansion state —
  and it has to reckon with `resolveShortcut`, which only bails for
  `INPUT`/`TEXTAREA`/`SELECT`/contenteditable, so newly focusable rows would sit
  in the same keydown space as the bare `r`/`f`/`w` shortcuts. That is the shape
  of the #103 bug, so it belongs in its own change.

The **action list and the locator suggestions are deliberately not listboxes**,
even though they look like single-select lists. Both interleave non-option content
with their rows — the action list has group headers (`beforeAll Hooks`, `Test`)
and the playground has a section label and the WebView setup hint — and a listbox
may only contain options, so the role would hide exactly that content from
assistive tech. Neither has the keyboard operability a listbox promises either.
They stay generic and are addressed by test id, with selection reported through
`data-selected`.

Note also that `getByRole`'s `name` matches by **substring** unless you pass
`exact`. That matters wherever one label contains another — `Pick` and `Picking…`
being the case that bit us: an assertion on the inactive label passed whether or
not pick mode had exited.

## Writing a spec

UI mode — push protocol messages:

```ts
import { test, expect } from "../fixtures.js"
import { GESTURES_FILE } from "../messages/scenarios.js"

test("marks a test failed", async ({ app, explorer }) => {
  await explorer.expandAll()

  app.send({
    type: "test-status",
    fullName: "Gestures screen > smoke",
    filePath: GESTURES_FILE,
    status: "failed",
    error: "boom",
  })

  await expect(explorer.node("smoke")).toHaveAttribute("data-status", "failed")
})
```

The `app` fixture is the common case: loaded, one-file tree, idle. Take `ui`
instead when a spec needs a different starting state, then call `ui.open()` —
`routeWebSocket` has to be registered before the SPA opens its socket, and the
seed is replayed on every connect, exactly as the real server re-pushes state on
reconnect.

Trace viewer — describe an archive:

```ts
import { test, expect } from "../fixtures.js"
import { actionEvent } from "../trace-builder.js"

test("lists the traced actions", async ({ viewer, actions }) => {
  await viewer.open({
    events: [
      actionEvent({ actionIndex: 0, action: "launchApp" }),
      actionEvent({ actionIndex: 1, action: "doubleTap" }),
    ],
  })

  await expect(actions.items).toHaveCount(2)
})
```

## Regression coverage

Several specs pin bugs that shipped and were found by hand. Keep them honest:
revert the fix, rebuild, and confirm the spec goes red — and that nothing else
does.

| Spec | Bug |
|---|---|
| `ui-mode/specs/run-lifecycle.spec.ts` → `#103` | `Cmd+Shift+R` matched the bare `r` shortcut and fired a run on the way out (`e9ce4ef`) |
| `ui-mode/specs/run-lifecycle.spec.ts` → `#186` | An `afterAll` attribution re-tag reset a finished test to running, so `run-end` erased its failure and trace (`e9639ce`) |
| `ui-mode/specs/run-lifecycle.spec.ts` → `#147` | An MCP-initiated run showed no pending state (`06eace0`) |
| `ui-mode/specs/run-lifecycle.spec.ts` → in-flight actions | The Actions panel looked empty while an action was in flight (`abcf347`) |
| `ui-mode/specs/mcp-panel.spec.ts` → failed tool call | An errored agent tool call showed as a red row with no message — found while writing these tests |

## Not covered

Deliberately out of scope, so nobody assumes otherwise:

- **Anything server-side.** The harness replaces `ui-server.ts` and
  `show-trace-server.ts`, so bugs in those are invisible here. Both have their
  own vitest coverage.
- **The real socket, and a real archive on disk.** Both are intercepted. What a
  *generated* archive contains is covered instead by
  `packages/tapsmith/src/__tests__/trace-archive-contents.test.ts` (the whole
  record-and-package path, mocked device) and `e2e/verify-trace-archive.mjs`
  (one archive recorded against a live emulator/simulator in CI).
- **Visual regression.** The mirror is a `<canvas>` and the CSS is oklch- and
  webfont-heavy, so stable snapshots would need a pinned docker image. Worth
  revisiting once it is clear which surfaces are worth pinning.
- **Trace and video downloads**, the `Log` detail tab, filmstrip thumbnail
  selection, and the drag-and-drop path into the viewer.
