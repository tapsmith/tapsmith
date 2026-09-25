# The run modes, and what only each one can break

Seven user-facing modes, assembled by the **five embedders** CLAUDE.md lists (`cli.ts`,
`worker-runner.ts`, `ui-worker.ts`, `watch-run.ts`, `mcp/headless-dispatcher.ts` — UI watch
and UI MCP run through UI mode's `ui-worker.ts`). A per-session concern (capabilities,
install/preflight checks, passthrough hosts, a new config key) has to be wired through all
five embedders, and then observed working in all seven modes — each mode has its own
parent-side state and entry point. This is the list to walk for every inventory item.

How each mode is pinned to your lease (SKILL.md ground rules: lease, then pin):

| Mode | Pin |
|---|---|
| 1, 3, 5, 6 — a single-device `tapsmith test` (incl. `--watch`, `--ui`) | `--device <leased udid-or-serial>` |
| 2 — `--workers N`, and any multi-device group run | cannot be pinned (the CLI refuses `--device` with `--workers N`; group members auto-pick): lease `platform:<ios\|android>` instead |
| 4, 7 — MCP | `mcp-server` takes only `--config`. Pass `device` on `run_tests` and every device tool; make the session's **first** call one that names the device (`tapsmith_watch` and the listing tools take none), since the first device-naming call pins the session and an unpinned run auto-picks any device |

All commands assume `cd packages/tapsmith && npm run build` has just run and node is
arm64 (`references/probes.md` §0). They invoke the branch's CLI by path from `e2e/`
(`node ../packages/tapsmith/dist/cli.js …`) — never `npx tapsmith`, which silently runs a
cached published build whenever the local bin is missing (SKILL.md ground rules). Before any launch that holds
a device, run `"${CLAUDE_SKILL_DIR}/scripts/device-availability.sh"` (SKILL.md ground
rules) — no mode needs the user's permission when it reports FREE.

---

## 1. Headless sequential — `src/cli.ts`

```bash
cd e2e && node ../packages/tapsmith/dist/cli.js test tests/home.test.ts -c tapsmith.config.ios.mjs --device <leased udid>
```

The only path device CI exercises — on both platforms, 5 shards each, on your PR — so
it is the best-covered and the least interesting to re-test. Do not re-run the e2e
suite here. It is still the only place CLI arg parsing, `--shard`, reporters and
`show-report`/`show-trace` output are wired, and those are where a hand-check pays.

Check: exit code, reporter output, the trace zip contents, and any new CLI flag's
rejection path (bad value, mutually-exclusive combination — e.g. `--watch` with
`--shard`, `--ui` with `--shard`).

## 2. Headless parallel workers — `src/worker-runner.ts` + `src/dispatcher.ts`

```bash
cd e2e && node ../packages/tapsmith/dist/cli.js test tests/<file-a>.test.ts tests/<file-b>.test.ts -c tapsmith.config.ios.mjs --workers 2
```

The CLI only parallelises when a wave has more files than one worker can take
(`cli.ts`: `effectiveWorkers = min(workers, files in the largest wave)`); with a single
file it silently runs **sequentially** and mode 2 is never exercised. Give it at least
two files in the same project, and confirm from the output that workers ran (per-worker
lines, `Worker 0 (…)`/`Worker 1 (…)`) before recording the cell as mode 2.

Only path with worker-protocol serialisation (`src/worker-protocol.ts`): anything that
must reach a test run has to survive being sent to a forked child. Per-worker daemons and
per-worker device claims live here.

**Both device workflows pass `--workers 1`, so CI never runs this path at any
concurrency.** Any change that crosses the fork boundary is unverified until you run
it here — this is one of the highest-value cells in the matrix.

Check: both workers actually got the state (not just worker 0); no cross-worker device or
socket-name collision; merged reporter/trace output.

## 3. Headless watch — `src/watch.ts`, `src/watch-run.ts`, `src/watch-queue.ts`

```bash
cd e2e && node ../packages/tapsmith/dist/cli.js test -c tapsmith.config.ios.mjs --device <leased udid> --watch
# then change a file's *content* (append a comment line, restore it after) — `touch` does not trigger
```

Forks a **fresh child per re-run**, so state must be re-derived or re-passed on every
re-run, not just at startup. Queueing/debounce of rapid edits lives here.

Watch runs nothing at startup (it waits at the keypress menu), its `a`/`f`/`q` keys need a
real TTY (drive it with Python `pty.fork()`, not a pipe), and its log is full of ANSI
escapes — strip them before grepping for `Summary:`.

Check: first run vs. re-run behave identically (a startup-only wiring bug shows up as a
re-run that degrades); a change to a *non-test* source file still triggers what it
should; the device/daemon is reused rather than re-claimed per re-run.

## 4. Headless MCP — `src/mcp/**`, dispatch via `src/mcp/headless-dispatcher.ts`

```bash
node packages/tapsmith/dist/cli.js mcp-server --config e2e/tapsmith.config.ios.mjs
```

Forks the same `watch-run.ts` children as mode 3, but the parent-side state is separate —
sharing child code does **not** mean sharing the wiring. Tools:
`list_tests`, `run_tests`, `stop_tests`, `suite_status`, `list_results`, `read_trace`,
`watch`, `session_info`, `list_devices`, plus the device tools (`tap`, `type`, `swipe`,
`press_key`, `snapshot`, `screenshot`, `launch_app`, `test_locator`) — all prefixed
`tapsmith_` on the wire (`tapsmith_test_locator`).

Check: the server logs discovery and run failures **to stderr only** — a tool result can
look clean over a real failure, so always capture stderr. `run_tests` wants absolute
paths. Ambiguous/unknown `project` must be refused with candidates, not silently
defaulted. A stopped run must report `interrupted`, not a phantom file failure.

The session's registered `tapsmith-headless` server is convenient but runs
**npx-cached published code** — see the ground rules. Use the stdio probe harness, or
re-register against `node <repo>/packages/tapsmith/dist/cli.js mcp-server`.

## 5. UI mode — `src/ui-mode/ui-server.ts` + `src/ui-mode/ui-worker.ts` + the SPA

```bash
cd e2e && node ../packages/tapsmith/dist/cli.js test --ui -c tapsmith.config.ios.mjs --device <leased udid> --ui-port 7788
```

It holds the device for its whole lifetime — the longest claim of any mode — so run the
availability check first, and plan every UI-mode, UI-watch and UI-MCP probe before
launching so one session serves all three. Two listening ports: the
WebSocket/HTTP port for the SPA, and the MCP port (default 9274, random if taken; printed
as `MCP ready at http://127.0.0.1:<port>/mcp` and published to
`~/.tapsmith/daemons/ui-port-<projecthash>`).

`ui-worker.ts` is a third worker implementation — state threaded for modes 1–4 is not
automatically here. The SPA is a separate surface again: see `references/surface-map.md`
for the pane inventory, and prefer `web-tests/` for pane behaviour.

Gotchas: the launch re-execs under tsx, so the pid you started is a wrapper — find the
real server with `lsof -nP -iTCP:<port> -sTCP:LISTEN` before TERMing it. Never pipe the
launch through `head` (SIGPIPE kills it mid-boot). A worker that dies while idle wedges
the session at "A test run is already in progress"; `stop_tests` recovers it.

## 6. UI watch — the watch toggle inside UI mode

UI mode has its own watch implementation; `--watch` is *ignored* when combined with
`--ui`. So watch behaviour verified in mode 3 says nothing about here.

Check: toggling watch on/off from the UI, an edit triggering a re-run, the tree and
statuses updating rather than resetting, and re-runs while a run is in flight.

## 7. UI MCP — the UI server's `/mcp` HTTP endpoint (`src/mcp/http-session-router.ts`)

If a `tapsmith-ui` MCP server is registered in your local Claude Code config (`.mcp.json`
is git-ignored, so this is per-machine), it points at
`http://localhost:9274/mcp` and **only connects while a UI session is running** — a
ConnectionRefused there means no UI server, not a broken feature. After launching one,
the session may need `/mcp` reconnected before `mcp__tapsmith-ui__*` tools appear.

Same tool surface as mode 4 but a different transport, a different dispatcher, and a
different session model (it drives the *user's* live UI session). This is the mode most
often forgotten.

Check: an MCP-triggered run really reaches the UI feed (`run-start` / `test-start` /
`run-end`) and renders in the panes — a run that succeeds over MCP but never appears in
the UI is a real bug, catchable with the ws probe. Also check `stop_tests` mid-run,
concurrent MCP + UI-button runs, and that device tools operate on the UI session's device
rather than claiming a second one.

---

## Adjacent surfaces, easy to forget

- **Trace viewer** — `tapsmith show-trace <trace.zip>`. Shares its whole inspection layer
  with UI mode, so a component change hits both.
- **Reporters / `show-report` / `merge-reports`** — `src/reporters/**`.
- **`tapsmith doctor`, `verify`, `init`, `list-devices`** — environment-facing commands
  that read the same config and resolution code as the run paths.
- **Both agents and the Rust daemon** — a proto or capability change must be verified on
  the device, not just in the SDK.
