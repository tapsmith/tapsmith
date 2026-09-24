# Probe recipes

Ordered cheapest first. Everything here assumes a fresh build:

```bash
cd packages/tapsmith && npm run build      # with an arm64 node — see §0
```

## 0. Environment and build freshness (once per session, and after each rebuild)

**Node must be arm64.** Check, don't assume — whether this shell runs under Rosetta has
changed over time:

```bash
node -p process.arch     # arm64 → nothing to do
```

If it prints `x64`, esbuild/tsx break in forked children (UI-mode discovery fails for
every file with an empty error; `@esbuild/darwin-arm64 present but needs darwin-x64`), and
`npm ci` installs x64 `@tapsmith/*` packages. Put an arm64 node **first on PATH via a
symlink** — `arch -arm64 node` is not enough, children re-resolve `node` from PATH:

```bash
ARM_NODE=$(for n in ~/.nvm/versions/node/*/bin/node; do
  [ "$("$n" -p process.arch 2>/dev/null)" = arm64 ] && echo "$n"; done | tail -1)
SHIM=<this session's scratchpad>/nodebin
mkdir -p "$SHIM" && ln -sf "$ARM_NODE" "$SHIM/node"
export PATH="$SHIM:$(dirname "$ARM_NODE"):$PATH"
```

`Cannot find module @rollup/rollup-darwin-x64` means node_modules is arm64 and the shell
picked the wrong node: fix PATH, do not reinstall.

**Builds must be of this tree.** A stale build tests nothing and fails in ways that look
like product bugs. Check each one the triage says you need:

| Build | Freshness check | Rebuild |
|---|---|---|
| SDK `dist/` | `dist/` mtimes newer than your last edit / checkout | `cd packages/tapsmith && npm run build`; restart UI/MCP servers |
| Daemon | `ls -l packages/tapsmith-core/target/release/tapsmith-core` vs `git log -1 --format=%cd -- packages/tapsmith-core` | `cargo build --release`. **A fresh worktree has none**: `daemon-bin.ts` then falls back to the npm-installed daemon, which may lack new RPCs (symptom: first run passes, every later run fails `12 UNIMPLEMENTED` on `ResetApp`). Build it or set `TAPSMITH_DAEMON_BIN` |
| Android agent | APK mtime vs `git log -1 -- agent/` | `./gradlew assembleDebug`; the runner must reinstall it. Read the gradle log for `BUILD SUCCESSFUL` — piped or backgrounded exit codes lie |
| iOS agent | `strings` on the *running* runner's xctest binary for a new symbol (`pgrep -f TapsmithAgentUITests-Runner`) | the CLAUDE.md `xcodebuild build-for-testing` recipe. The resolver prefers the `~/.tapsmith/ios-simulator-agent` cache over fresh builds, and a runner is not reinstalled unless you `xcrun simctl uninstall <udid> dev.tapsmith.agent.xctrunner`; pin a fresh build with a scratch config setting `iosXctestrun` |
| Test app | `stat` the APK / `.app` vs `git log -1 --format=%ad -- test-app/app/` | rebuild (with `EXPO_PUBLIC_TAPSMITH_HOOKS=1` for the hooks build). A test app older than the newest `test-app/` commit makes brand-new e2e tests fail against old screens |

**Worktree specifics.** Use the scripts via `${CLAUDE_SKILL_DIR}` (the skill copy this
session loaded), not the worktree's own `.claude/skills/`, which may be older or absent;
invoke the CLI by path (`node ../packages/tapsmith/dist/cli.js` from `e2e/`), never npx; `npm ci` is needed in `packages/tapsmith`
(and `web-tests/` if used) before the first build.

## 1. Read CI — do not re-run it

`automated-coverage.md` has the job table and the four checks that a run really covers
HEAD (SHA match, not advisory, the spec actually ran, it asserts your observable). With no
PR there is no CI run at all — every workflow is PR-triggered — so those cells are
`pending-ci`.

## 2. `web-tests/` as a harness (not as a suite)

Do not run `npm test` here — CI's Web Tests job does, on every push. What this
project gives *you* is a device-free way to reach pane states no spec produces, in
seconds per iteration.

```bash
cd packages/tapsmith && npm run build          # or build:ui-mode / build:trace-viewer
cd ../../web-tests && npm ci && npx playwright install chromium
npx playwright test --project=ui-mode -g "<your throwaway spec>"
npm run test:ui                                # interactive — best for exploring
```

It tests **`dist/`**, so rebuild after every SPA edit or you silently test the old bundle.
A `ui-protocol.ts` or `trace/types.ts` change needs the full `npm run build`.

Write a throwaway spec for the pane state the existing specs don't produce:
`ui-mode/fake-ui-server.ts` can push any `ServerMessage`, push binary screen frames,
record every `ClientMessage` the SPA sends, and drop the socket to exercise the reconnect;
`trace-viewer/trace-builder.ts` builds any archive in memory. Do not spy on
`window.WebSocket` in `addInitScript` — Playwright's own shim discards yours; probe from
inside `page.evaluate`.

If you *author* a spec, it earns its keep only if you **revert the fix, rebuild, and
watch that spec (and only that spec) go red**, then restore. That is writing coverage,
not duplicating it — one of the few reasons to run this project's Playwright at all.

## 3. Headless MCP over stdio, without an MCP client

A throwaway `.mjs` that imports the MCP SDK **by absolute path** out of
`packages/tapsmith/node_modules/@modelcontextprotocol/sdk/dist/esm/client/{index,stdio}.js`
(nothing to install), spawns

```
node <repo>/packages/tapsmith/dist/cli.js mcp-server --config tapsmith.config.ios.mjs
```

with `cwd` set to `e2e/` and `stderr: 'pipe'`, then drives tool calls.

- **Capture and print the child's stderr** — discovery and run failures are logged only
  there, so tool results alone hide real breakage. This is the whole point of the harness.
- `run_tests` needs **absolute** paths; relative ones return "no tests executed".
- Swap `command` for `packages/tapsmith/node_modules/.bin/tsx` to A/B the tsx loader when
  discovery counts look wrong.
- The SDK client's `close()` sends SIGTERM and **orphans the daemon** — that is a harness
  artifact (real clients shut down cleanly); `pgrep -fl tapsmith-core` and kill yours.
- To confirm a finding against a *real* client before reporting it:

```bash
claude -p "<call the tool>" \
  --mcp-config '{"mcpServers":{"tapsmith":{"command":"node","args":["<repo>/packages/tapsmith/dist/cli.js","mcp-server","--config","<cfg>"]}}}' \
  --strict-mcp-config --allowedTools "mcp__tapsmith__<tool>"
```

## 4. UI-mode MCP over HTTP

Same harness, transport swapped for
`StreamableHTTPClientTransport(new URL('http://127.0.0.1:<mcpPort>/mcp'))`. Find the port
from the UI server's `MCP ready at …` line, or `~/.tapsmith/daemons/ui-port-<projecthash>`
(removed on clean exit). Add a `noWait` mode — fire `run_tests` without awaiting, sleep,
then `stop_tests` — to exercise stop and concurrency.

Alternatively use the session's `mcp__tapsmith-ui__*` tools against the UI server you
launched; reconnect `/mcp` if they don't appear.

## 5. UI WebSocket probe — prove a run reaches the UI

```js
// import the ws client, NOT Node's native WebSocket (undici fails the handshake here)
const { default: WebSocket } = await import('<repo>/packages/tapsmith/node_modules/ws/wrapper.mjs');
```

The UI server listens on two ports; the ws one is the non-MCP one (`lsof -nP -iTCP
-sTCP:LISTEN -a -p <ui-server-pid>`). Send the same `ClientMessage` the SPA would — see
`src/ui-mode/ui-protocol.ts`, e.g. `{type:'run-file', filePath, projectName}` after the
`test-tree` message arrives (`filePath` must be the exact tree value) — and log every
server message with timestamps. Out-of-order or spurious messages pinpoint display bugs
immediately. Run this in parallel with an MCP-triggered run to prove mode 7 reaches the
feed.

## 6. Real device runs

Run `"${CLAUDE_SKILL_DIR}/scripts/device-availability.sh"` first and act on its verdict (FREE → claim a listed
target; BUSY → use an unheld one, or ask). Do not hand-roll a `pgrep` check: the raw
process list is dominated by orphans and idle MCP servers that are not active use.

**The e2e suite is CI's job** — it runs on both platforms, 5 shards each, on your PR.
So a device run here needs one of three reasons: a mode CI does not exercise, an
artifact you need to read, or a red CI job you are reproducing. Pick the narrowest
target that gives you that, and never run the whole suite "to check".

```bash
cd e2e
# an artifact to inspect (§8) — one file, trace forced on
PATH="$SHIM:$PATH" node ../packages/tapsmith/dist/cli.js test tests/<file>.test.ts -c tapsmith.config.ios.mjs --trace on
# mode 2: parallel workers. CI passes --workers 1, so no job covers this at all
PATH="$SHIM:$PATH" node ../packages/tapsmith/dist/cli.js test tests/<file>.test.ts -c tapsmith.config.android.mjs --workers 2
# mode 3: headless watch. No CI job starts a watch coordinator
PATH="$SHIM:$PATH" node ../packages/tapsmith/dist/cli.js test tests/<file>.test.ts -c tapsmith.config.ios.mjs --watch
```

Configs: `tapsmith.config.{mjs,ios.mjs,android.mjs,ios-device.mjs,ios-mixed.mjs}` and the
`*-ci*` variants. `npx` is safe **from `e2e/` in the main checkout** (symlinked to
`packages/tapsmith`); it is not safe from the repo root, and does not work in a worktree.

**Throwaway probe tests** go in `e2e/qa-tmp/<name>.test.ts` with a config at
`e2e/qa-<name>.config.mjs` that spreads an existing one and sets `testMatch:
["**/qa-tmp/<name>.test.ts"]`. Not a dot-dir — glob skips those, so `e2e/.qa-tmp/` is
silently undiscovered — and there is no `testDir` option. Pick a `testMatch` no existing
config matches, so a colleague's live UI session does not pick your files up. Remove both
and confirm with `git status --short` before reporting.

Emulator/simulator caveats: right after navigation the Android a11y tree can lag the
rendered screen by whole screens, so a single clean "element absent" probe is not truth —
`waitForIdle` and re-probe before concluding. A cold software-GPU emulator makes every
action ~10s, which looks like a hang.

## 7. Live UI session + browser

Check `"${CLAUDE_SKILL_DIR}/scripts/device-availability.sh"` first (the UI server takes a device for its whole
lifetime — the longest-held claim of any mode), then:

```bash
cd e2e && PATH="$SHIM:$PATH" node ../packages/tapsmith/dist/cli.js test --ui -c tapsmith.config.ios.mjs --ui-port 7788
```

Never pipe this through `head` (SIGPIPE kills it mid-boot). Then drive the page with
`chrome-devtools` MCP (`new_page`, `take_snapshot`, `click`, `fill`, `list_console_messages`,
`take_screenshot`) or `claude-in-chrome`. Screenshot each pane you claim to have checked.

Shutting down: the launch re-execs under tsx, so the pid you started is a wrapper —
`kill -TERM` on it leaves the real server, its daemons and the ui-port file alive. Find
the real one with `lsof -nP -iTCP:7788 -sTCP:LISTEN` and TERM that. Ctrl-C (process group)
is fine.

Known non-bugs to not chase: `ConnectionRefused` from `tapsmith-ui` when no UI server is
running; a session wedged at "A test run is already in progress" after an idle worker died
(`stop_tests` recovers it) and leaked `ui-worker` children on worker retirement — both
pre-existing on `main`. A headless session sharing a simulator with a `--ui` run gets
permanently wedged (`Failed to connect to agent socket`); a fresh session recovers.

## 8. Reading the artifacts

```bash
node packages/tapsmith/dist/cli.js show-trace e2e/tapsmith-results/<...>/trace.zip
unzip -l trace.zip && unzip -p trace.zip trace.json | jq '<the field your change writes>'
```

Or the `read_trace` MCP tool. Asserting the specific trace field/rung is what separates a
verified item from "the suite went green".

## 9. Base-branch A/B (regression vs. pre-existing)

```bash
merge=$(git merge-base HEAD origin/main)
git worktree add /private/tmp/.../scratchpad/base "$merge"   # build there; keeps your tree intact
```

A worktree is safer than `git stash` when a probe is mid-flight. Compare byte-identically
(`git show "$merge":<file> | diff - <file>`) before calling any behaviour a regression.

## 10. Cleanup checklist

First release every device lease you took (`scripts/device-lease.sh list` shows them;
`release <target> <owner>` for each of yours). Never release another owner's lease.

`"${CLAUDE_SKILL_DIR}/scripts/device-availability.sh"` lists the leftovers it found under "Leftovers" — that
section is your cleanup list.

```bash
pgrep -fl tapsmith-core          # daemons you orphaned (no ESTABLISHED conn = orphan)
pgrep -f ui-worker               # PPID 1 = orphan from a dead UI server, safe to kill
pgrep -fl xcodebuild             # iOS agents outlive their daemons and accumulate
ls ~/.tapsmith/daemons/          # stale ui-port / registry entries
git worktree remove <path>
```

Kill what you started, plus orphans that are provably nobody's (PPID 1, or a daemon with
no client). Never kill a live session: anything the availability check flagged as an
*active-use* signal is off limits unless the user says otherwise.

Two traps when killing leftovers, both of which silently no-op:

- **`adb logcat` ignores SIGTERM** — a plain `kill` (or `pkill -f`) leaves it running.
  Use `kill -9`.
- **This shell is zsh, which does not word-split unquoted `$vars`** — `for p in $pids`
  and `kill $pids` pass the whole newline-joined list as one argument (`illegal pid`).
  Pipe through `xargs` instead:

```bash
ps -eo pid,ppid,command | grep 'adb .*logcat' | grep -v grep |
  awk '$2==1 {print $1}' | xargs -n1 kill -9
```
