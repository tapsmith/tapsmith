# Web tests (`web-tests/`)

```bash
npm ci
npx playwright install chromium
npm run typecheck                          # tsc --noEmit
npm run test                               # both projects
npx playwright test --project=ui-mode
npx playwright test --project=trace-viewer
npm run test:ui                            # Playwright's UI runner, for authoring
```
Hermetic Playwright suites for the two web apps — **no device or daemon needed**, ~20s for all of
them. Two projects: `ui-mode` drives the SPA through an intercepted WebSocket
(`page.routeWebSocket()`); `trace-viewer` drives the standalone viewer through an intercepted trace
archive. The inspection components both apps share (DetailTabs, NetworkTab, HierarchyTree,
LocatorPlayground, ActionsPanel, ScreenshotPanel) are covered via `trace-viewer`, where a static
archive is much less setup than a live session.

Both suites test the **built bundles**, so `npm run build` in `packages/tapsmith` must run first —
and again after any change to either app. Pane objects follow the same screen-object conventions as
`e2e/screens/` (see `docs/writing-tests.md`). See `web-tests/README.md` for the locator policy and
what is deliberately not covered.
