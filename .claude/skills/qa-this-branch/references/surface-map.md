# Change type → dimensions, and changed file → what it can break

## Step 1 — triage the change type

Classify every changed path (a branch is often several types). The type decides the
matrix columns, so a docs branch is not forced through the seven-mode matrix and an agent
change is not QA'd on one platform.

| Type | Paths | Matrix columns | Typical probes |
|---|---|---|---|
| **SDK run path** | `packages/tapsmith/src/` outside `ui-mode/`, `trace-viewer/` | the 7 modes (`modes.md`) × platform where device behaviour differs | mode probes; read the trace |
| **Web UI** | `src/ui-mode/**`, `src/trace-viewer/**` | the panes below × {UI mode, trace viewer} | `web-tests` harness; live UI session for rendering |
| **Daemon** | `packages/tapsmith-core/**` | platform × modes that reach the changed RPC | release build + `TAPSMITH_DAEMON_BIN`; device run |
| **Agent** | `agent/**`, `ios-agent/**` | that platform (both if shared behaviour) × the actions it serves | rebuild + reinstall, prove the running binary is new, device run |
| **Protocol** | `proto/tapsmith.proto` | every consumer: SDK, daemon, both agents | device run on both platforms |
| **Environment CLI** | `init*`, `doctor`, `verify*`, `setup-*`, `create-avd`, `build-ios-agent`, `env-scan` | subcommand × machine state (fresh project, missing SDK, no device, `--json`) | run into a scratch dir / fake PATH |
| **RN hooks** | `packages/tapsmith-react-native/**` | hooks build vs hook-less build × platform; the reset rung | rebuild test-app with hooks, read the trace's reset row |
| **Docs** | `docs/**`, `README.md`, JSDoc on public API | each changed claim | run each changed example verbatim; check it matches behaviour |
| **Website** | `website/**` | pages changed; light/dark; phone width | `npm run build` then preview + browser (CI checks only that it builds) |
| **Packaging / release** | `npm-packages/**`, `scripts/**`, `package.json` `files`/`exports`, `release.yml`, `prepare-release.yml`, `tag-release.yml` | what a user installs | `npm pack --dry-run`; install the tarball into a scratch project and run `tapsmith --version`/a test |
| **CI only** | `.github/workflows/**` | which jobs now run or no longer run, and when | read the diff; confirm on the PR's own run that the job ran/skipped as intended |
| **Test only** | `e2e/**`, `web-tests/**`, `src/__tests__/**` | does the test fail without the fix? does it run in CI? | revert the fix → watch it go red; grep the CI shard log for it |
| **Test app** | `test-app/**` | every e2e test that visits the changed screen | rebuild + reinstall; stale-build check (probes.md §0) |
| **Agent skills** | `.claude/skills/**` (tracked) | skill text: each changed instruction; scripts: each behaviour | read the text for contradictions and stale facts (commands, paths, CI facts) and try any changed command; run each changed script's cases, including concurrent ones for `device-lease.sh` |
| **No QA surface** | `CLAUDE.md`, comments only, and the rest of `.claude/` (git-ignored: `settings.local.json`, `worktrees/`, `state/`) | none | say so; verdict follows from the rest of the branch |

If a changed path is not in the tables below, find its importers
(`grep -rn "from '.*<basename>" packages/tapsmith/src`) and map those instead.

## Step 2 — changed file → what it can break

## TypeScript SDK — `packages/tapsmith/src/`

| Changed path | Modes at risk | Notes |
|---|---|---|
| `runner.ts`, `device.ts`, `element-handle.ts`, `expect.ts`, `selectors.ts`, `webview-*.ts`, `network.ts`, `api-request.ts`, `fixtures.ts` | **all 7** | the shared core every path runs; also changes trace contents, so both viewers |
| `app-reset.ts`, `session-preflight.ts`, `attempt-fence.ts`, `abort.ts` | **all 7**, per-session wiring | classic seven-times-wiring code; assert the trace rung, not pass/fail |
| `config.ts`, `project.ts`, `test-file-discovery.ts`, `test-filter.ts` | all 7 + `doctor`/`verify`/`list-devices` | `rootDir` resolution depends on cwd — check from a foreign cwd |
| `cli.ts` | 1 (+ arg parsing for every subcommand) | flag validation and mutually-exclusive combos |
| `worker-runner.ts`, `dispatcher.ts`, `worker-protocol.ts` | 2 | serialisation across the fork boundary |
| `watch.ts`, `watch-run.ts`, `watch-queue.ts`, `child-scripts.ts` | 3, 4 (shared children), 5/6 (child-scripts) | re-derive per re-run |
| `mcp/index.ts`, `mcp/test-dispatcher.ts`, `mcp/events.ts`, `mcp/session-results.ts`, `mcp/config-loader.ts`, `mcp/tools/**` | **4 and 7** | shared by the stdio server *and* the UI server — check both transports |
| `mcp/headless-dispatcher.ts`, `mcp/connection.ts`, `mcp/port-file.ts` | 4 | port-file also governs daemon ownership vs. UI sessions |
| `mcp/http-session-router.ts` | 7 | UI-mode MCP only |
| `ui-mode/ui-server.ts` | 5, 6, 7 | server code loads at startup: rebuild **and restart** |
| `ui-mode/ui-worker.ts`, `ui-mode/ui-discover.ts` | 5, 6 | the third worker implementation |
| `ui-mode/ui-protocol.ts` | 5, 6, 7 + `web-tests/protocol.ts` | needs the full `npm run build` (emits `.d.ts`), not just `build:ui-mode` |
| `ui-mode/main.tsx`, `ui-mode/components/**`, `ui-mode/hooks/**`, `ui-mode/styles/**`, `keyboard-shortcuts.ts`, `tabstrip.ts`, `device-readiness.ts`, `readiness-candidate.ts`, `source-stream.ts`, `mcp-agents.ts` | UI panes (below) | cover with `web-tests --project=ui-mode`; `npm run build:ui-mode` first |
| `trace-viewer/components/**`, `trace-viewer/*.ts` | **trace viewer AND UI mode** | UI mode imports these; cover with `web-tests --project=trace-viewer` |
| `trace/**` | both viewers + `read_trace` MCP tool + `show-trace` | trace format is a contract |
| `reporters/**`, `reporter.ts`, `action-progress*.ts` | 1, 2, 3 output; `show-report`, `merge-reports` | |
| `daemon-bin.ts`, `agent-resolve.ts`, `grpc-client.ts` | all 7 | resolution order (daemon-bin.ts): `TAPSMITH_DAEMON_BIN` → monorepo build relative to cwd → npm platform package → monorepo build relative to `dist/` → PATH; test at least the env-var and monorepo paths |
| `emulator.ts`, `ios-simulator*.ts`, `ios-device*.ts`, `ios-*network*.ts`, `create-avd.ts`, `setup-ios*.ts`, `build-ios-agent.ts`, `verify*.ts`, `doctor.ts`, `env-scan.ts` | device bring-up for all 7 + those subcommands | usually needs a real device; `--json` modes are cheap to check |
| `init*.ts`, `agents-md.ts`, `legacy-cleanup.ts` | `tapsmith init` | run it into a scratch dir |
| `telemetry.ts`, `telemetry-cli.ts` | all 7 (one event per file, tagged by `runMode`) | the payload key list is a public contract (`docs/telemetry.md`); check opt-outs and each embedder's `runMode` |
| `file-lock.ts`, `port-utils.ts` | concurrency across all modes | test with two sessions, not one |

## Other components

| Changed path | Consequence |
|---|---|
| `packages/tapsmith-core/**` (Rust) | all modes. `cargo build --release`, and make sure the SDK resolves *that* binary (`TAPSMITH_DAEMON_BIN`) rather than an npm-installed one |
| `agent/**` (Kotlin) | Android device behaviour. `./gradlew assembleDebug`, and the runner must reinstall the APK — a rebuilt agent that was never reinstalled is the classic false negative |
| `ios-agent/**` (Swift) | iOS device behaviour. Rebuild for simulator; the SDK scans Xcode DerivedData, so a build elsewhere is invisible |
| `proto/tapsmith.proto` | SDK + daemon + both agents must agree. `buf lint proto/`, `buf breaking`, then a real device run |
| `e2e/**` | test-only, but a changed shared helper/screen object affects other e2e tests |
| `web-tests/**` | test-only |
| `test-app/**` | changes what every e2e test sees; rebuild/reinstall the app |
| `.github/workflows/**` | CI only — read the diff, don't run it; note which jobs would now (not) run |
| `packages/tapsmith-react-native/**` | the in-app reset rung on both platforms; hook-less fallback (`e2e-android-hookless.yml` covers only on listed paths) |
| `docs/**` | the website (synced by `website/scripts/sync-docs.mjs`) and user expectations; broken links fail the Website job |
| `website/**` | the docs site only; the Changelog page is fed by `sync-releases.mjs` from GitHub releases |
| `npm-packages/**`, `scripts/bump-version.sh` | what gets published and resolved by `daemon-bin.ts` / `agent-resolve.ts`; version lockstep across packages |

## UI-mode pane inventory

Walk this list for any SPA change and mark each pane affected / not.

**UI-mode only** (`src/ui-mode/components/`, covered by `web-tests --project=ui-mode`):

- **Test Explorer** (`TestExplorer.tsx`) — tree, expand/collapse, filters, per-test status,
  discovery errors, project grouping.
- **Run Controls** (`RunControls.tsx`) — run/stop, run-selected, worker count, watch
  toggle, project selection, run timer.
- **Device pane** (`DevicePane.tsx`, `DeviceFrame.tsx`, `DeviceMirror.tsx`,
  `MirrorPickOverlay.tsx`, `mirror-coords.ts`, `use-screen-mirror.ts`) — live mirror
  frames, canvas sizing from the decoded bitmap, tap/swipe/type interaction, coordinate
  normalisation, pick mode.
- **Device Activity** (`DeviceActivityPanel.tsx`) — readiness/bring-up progress and
  device log feed.
- **MCP panel** (`mcp-agents.ts`, `mcp-panel.spec.ts`) — connected agents and their
  activity feed; the surface that shows mode 7 working.
- **Layout / shell** (`Layout.tsx`, `tabstrip.ts`, `ResizeHandle.tsx`,
  `use-persisted-state.ts`) — pane sizes and tab state, persisted across reloads.
- **Connection** (`use-websocket.ts`) — 1s reconnect, post-reload socket, stale state
  after reconnect.
- **Keyboard shortcuts** (`keyboard-shortcuts.ts`) — including modifier-chord guards.

**Shared with the trace viewer** (`src/trace-viewer/components/`, covered by
`web-tests --project=trace-viewer`, but a change lands on **both** apps):

- **Actions panel** (`ActionsPanel.tsx`) — action list, selection, timings, errors.
- **Screenshot panel** (`ScreenshotPanel.tsx`) — before/after, zoom.
- **Detail tabs** (`DetailTabs.tsx`) — tab switching and per-tab emptiness.
- **Network tab** (`NetworkTab.tsx`) — entries, bodies, filtering.
- **Hierarchy tree** (`HierarchyTree.tsx`, `hierarchy-utils.ts`) — a11y tree rendering.
- **Locator playground** (`LocatorPlayground.tsx`, `selector-generation.ts`,
  `selector-matching.ts`, `selector-pick.ts`, `selector-uniqueness.ts`) — generation,
  match counts, uniqueness, pick mode.
- **Timeline filmstrip** (`TimelineFilmstrip.tsx`), **TopBar**, source view
  (`source-view-utils.ts`).
