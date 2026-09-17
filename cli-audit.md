# Tapsmith CLI audit — every command

Audit of all 15 subcommands plus the CLI shell (`--help`/`--version`, parser, dispatch), covering: purpose, output wording, bugs, cross-command references, overlaps, confusion, missing functionality, and overall DX. Line references are to `packages/tapsmith/src/` unless otherwise noted. Severity: **H**igh / **M**edium / **L**ow.

---

## 1. Command inventory — what each one is for

| Command | What it actually does | Verdict on purpose |
|---|---|---|
| `test [files...]` | Main entry: loads config, resolves projects + dependency waves, discovers files, re-execs under tsx, provisions device (ADB/emulator/simulator/physical), spawns daemon, installs app + agent, runs tests. Four paths: sequential, `--workers` dispatcher, `--watch`, `--ui`. | Clear |
| `show-trace <file.zip>` | Local HTTP server (127.0.0.1, ephemeral port) serving the bundled trace-viewer SPA + the zip; opens browser. | Clear |
| `show-report [dir]` | No server — opens `<dir>/index.html` (default `tapsmith-report`) as a `file://` URL. | Clear |
| `merge-reports [dir]` | Reads `*.jsonl` blobs (default `blob-report`), restores screenshots, replays merged result through config reporters. | Clear |
| `list-devices` | Ephemeral daemon → merged Android + iOS sim + iOS physical device table with actionable blockers. | Clear |
| `setup-ios` | **Simulator network-capture** prerequisite check only (mitmproxy + Network Extension approval). Name oversells scope. | Name misleading |
| `setup-ios-device` | Read-only preflight checklist for physical iOS (CLT, devicectl, iproxy, signing, pairing, build/profile advisories). | Clear |
| `build-ios-agent` | Signed `xcodebuild build-for-testing` for physical devices; team-ID resolution; prints config snippet. | Clear |
| `configure-ios-network <udid>` | Daemon RPC generates a `.mobileconfig` capture profile + 5-step install walkthrough. | Clear |
| `refresh-ios-network <udid>` | Same code as configure with `mode: 'refresh'` — only wording differs. | Overlap, see §5 |
| `verify-ios-network <udid>` | End-to-end HTTPS capture probe on a physical device with triaged fix hints. | Clear |
| `init` | Interactive wizard or `--yes` non-interactive; writes `tapsmith.config.ts`, example test, AGENTS.md section. | Clear |
| `verify` | Spawns a real `tapsmith test` on one test **file** (scaffolds a smoke test if none) and reports a verdict. | Clear (wording nit) |
| `doctor` | Static environment checklist (Core / Android / iOS / Network Capture) + inventory; `--json`. | Clear |
| `mcp-server` | MCP stdio server exposing 16 tools (snapshot, tap, type, run_tests, watch, …); also backs UI mode's HTTP transport. | Clear |

The physical-iOS workflow chains coherently: `setup-ios-device` → `build-ios-agent` → `tapsmith test` (basic), and `configure-ios-network` → install profile → `verify-ios-network`, with `refresh-ios-network` for Wi-Fi drift (also auto-suggested by `tapsmith test`, cli.ts:612).

---

## 2. High-severity bugs

**H1. `init` silently discards physical-device configuration for single-platform iOS.** The wizard's iOS flow collects `deviceAppPath` and offers a ~30s agent build (init.ts:262–271), but `generateConfig()` only emits the `ios-device` project in the multi-platform branch (init.ts:416–426). The single-platform branch (init.ts:374–387) writes `app: ios.appPath` — the simulator build — even when the user chose "Physical devices" only. The user completes the whole physical-device flow and gets a config that targets a simulator.

**H2. `tapsmith --help <cmd>` runs the command for real; `doctor --help` / `list-devices --help` also execute instead of printing help.** For commands in `subcommandsWithOwnHelp` (cli.ts:1727–1739), `--help` before the command name skips top-level help and dispatches without forwarding the flag (`forwardedArgs` only takes args *after* the command, cli.ts:99–112) — so `tapsmith --help init` launches the interactive wizard and `tapsmith -h verify` starts a real end-to-end verify run. Separately, `runDoctor`/`runListDevices` parse only `--json` (doctor.ts:340, list-devices.ts:309), so `list-devices --help` spawns a daemon and probes devices. Verified live.

**H3. Silent startup failure — exit-timer race in UI/watch/sequential setup.** The sequential `finally` schedules `setTimeout(() => process.exit(code), 0)` (cli.ts:2674); an escaping error reaches `main().catch` (cli.ts:2769) whose first statement is a dynamic `import('./dispatcher.js')`. In UI/watch mode that module was never loaded, so the import does real I/O and the exit timer wins — the process dies with code 1 and **no error message**. Repro: `tapsmith test --ui --ui-port <busy port>` → frozen launch table, silent exit (no `progress.fail` on the `server.listen` rejection path, ui-mode/ui-server.ts:3766–3777).

**H4. `--trace` / `--video` values are never validated.** cli.ts:1916–1921 casts the raw string; unknown modes hit `default: return false` in `shouldRecord`/`shouldRetain` (trace/trace-mode.ts:29–30, 72–73). `--trace retain-on-falure` (typo) silently records nothing. Playwright rejects invalid choices; this should be a hard parse error.

**H5. `refresh-ios-network` omits the one step that fixes a host-IP change.** The refresh walkthrough (configure-ios-network.ts:187–200) says: remove old profile, AirDrop + install new one. But the PAC URL (`http://<hostIp>:<port>/tapsmith.pac`) is set **manually** in Wi-Fi settings (iOS ignores the profile's proxy payload on unsupervised devices — configure's own step 4 explains this, lines 222–229). After a host-IP change — the stated reason to run refresh — the manually entered PAC URL is stale, and refresh never prints the new one nor mentions updating it. The command's dedicated purpose is defeated by its own output.

**H6. `merge-reports` ignores `--reporter`, and the docs promise an HTML report the default merge never produces.** cli.ts:1810 uses `createReporters(config.reporter ?? 'list')`; the parsed `--reporter` is only applied in the `test` path (cli.ts:1928–1929), which runs after `merge-reports` returns. So `tapsmith merge-reports --reporter html` is silently ignored, and with no `html` reporter in config the merge produces a terminal `list` report — while `docs/parallel-and-sharding.md:382`, `docs/api-reference.md:2376`, and the CI recipes in `docs/ci-setup.md:342–364` all promise/upload a `tapsmith-report/` directory that won't exist.

**H7. The MCP server's `tapsmith://api-reference` resource is dead everywhere.** mcp/index.ts:93 resolves one `..` short (`/repo/packages/docs/...`), and the npm tarball ships only `dist/` with no docs copy step — so the `existsSync` guard silently skips registration in every install layout, while `docs/mcp-server.md:314` advertises the resource.

**H8. Docs document flags/commands that don't exist.** `docs/api-reference.md` documents `tapsmith test --network` / `--no-network` — no such flag exists anywhere in cli.ts (network capture is only controlled via `trace` config). Same file: `setup-ios-device [udid]` (accepts no UDID; also claims DDI/USB/firewall checks that were intentionally removed or moved), and `build-ios-agent [--team <id>] [--device|--simulator]` (real flag is `--team-id`; `--device`/`--simulator` throw `Unknown flag`, build-ios-agent.ts:664). CLAUDE.md declares api-reference.md the single source of truth.

---

## 3. Medium-severity bugs

### Shared argument parser (affects most commands)
- **M1. Value-taking flags swallow the next token or silently accept a missing value.** `--device`, `--config`, `--grep`, `--grep-invert`, `--reporter`, `--trace`, `--video`, `--ui-dev-url` all do `rest[++i]` with no validation (cli.ts:1188–1284). Verified live: `tapsmith test --device --shard=abc` sets `device='--shard=abc'` and swallows the shard error; `--trace --grep foo` sets `trace='--grep'` (silently off per H4) and `foo` becomes a file arg; `tapsmith test --grep` runs the whole suite. Only `--project` validates (cli.ts:1263–1266).
- **M2. `--shard 1/4` (space form) errors with the generic "Unknown argument: --shard"** — every other flag accepts both forms; the error doesn't hint at `--shard=x/y` (cli.ts:1209, 1311).
- **M3. No "did you mean" on unknown commands**, and the error is followed by the full ~50-line help dump on stdout (cli.ts:1893–1897). `tapsmith badcommand --help` shows help and exits 0 (cli.ts:1736).

### Mode-dependent flag behavior in `test`
- **M4. `--force-install` is silently ignored in parallel mode** — only `setupSequentialDevice` consumes it (cli.ts:2289, 2506); `worker-runner.ts:137–189` unconditionally skips install when present. Doc also claims it reinstalls "the agent" — `forceInstall` never reaches agent installation anywhere.
- **M5. `--device` is silently ignored in parallel mode** (Android and iOS simulators) — `dispatcher.ts` reads `config.device` only in the physical-iOS branch (dispatcher.ts:1011–1012). `--workers 2 --device emulator-5554` can run on entirely different devices with no warning.
- **M6. A broken auto-discovered config silently falls back to defaults** (config.ts:487–489, console.warn + `DEFAULT_CONFIG`) — the run proceeds with default `testMatch`, no APK, wrong device, failing later in confusing ways. `--config <path>` correctly throws (config.ts:456–458).

### doctor
- **M7. Doesn't recognize `tapsmith.config.js`** (doctor.ts:139–146 tests only `.ts`/`.mjs`; `loadConfig` supports `.js` too, config.ts:472) — false "No tapsmith.config.ts found" while the same run loads that config for other checks.
- **M8. Human output never prints the `fix` field** (doctor.ts:97–105; fixes are JSON-only), contradicting `docs/getting-started.md:80` ("prints the exact command to fix it") and the AGENTS.md claim.
- **M9. `mitm-ca` fix is wrong twice** (doctor.ts:299): the daemon auto-generates the CA on first use (tapsmith-core/src/mitm_ca.rs:37–51), so it's not actionable; and the check runs on every platform while the suggested `setup-ios` is macOS-only.
- **M10. `ios-sim-agent` fix dead-ends**: "Run npx tapsmith init --yes (builds it)" — but init exits `CONFIG_EXISTS` on any initialized project (init.ts:518), the most likely state for a doctor user. Also hardcodes the arm64 package; x64 exists.
- **M11. "No Android devices connected" when a device is attached but unauthorized/offline** (doctor.ts:193 counts only `\tdevice` lines) — while the same JSON's `inventory` lists that very device. `list-devices` handles these states correctly.
- **M12. Asymmetric, silent platform gating**: no adb + no config `apk` → entire Android section skipped with no mention (doctor.ts:366–400), yet missing Xcode is a hard fail → exit 1 even for Android-only projects (doctor.ts:247).

### iOS commands
- **M13. `setup-ios-device` claims to catch "Developer Mode disabled" but never checks it** — `developerModeStatus` is parsed (ios-devicectl.ts:123–125) and used by list-devices, but `printDeviceStatus` (setup-ios-device.ts:398–420) looks only at `isPaired`. A paired device with Developer Mode off prints "ready for tapsmith test".
- **M14. npm-installed agent builds are invisible to preflight and auto-detect** — `build-ios-agent` writes to `~/.tapsmith/ios-agent/.build-device` (build-ios-agent.ts:63, 393–394), but `checkIosAgentBuilt` and `findDeviceXctestrun` only search cwd-relative paths (setup-ios-device.ts:266–269, ios-device-resolve.ts:72). After a successful build, `setup-ios-device` says "Not built yet" and `tapsmith test` says "Run tapsmith build-ios-agent first" — a loop, unless the user pastes the printed config snippet.
- **M15. Interactive redacted-SSID fallback is dead code** (configure-ios-network.ts:389–399) — the daemon filters redacted SSIDs to `None` and returns `success: false` (physical_device_proxy.rs:195–197, grpc_server.rs:4693–4713), which throws before the purpose-built prompt is reached.

### merge-reports / show-report
- **M16. No shard sanity checks in `mergeBlobs`** (reporters/blob.ts:151–202): empty dir → green "0 passed"; shard `{current,total}` and `version` fields written by the reporter are never read back, so missing shards pass silently and duplicate blobs double-count. Duplicates are realistic: the blob reporter appends a new timestamped `.jsonl` every run and never cleans the dir. Playwright errors on all of these.
- **M17. `show-report`'s browser-open error handling can never fire; on win32 it can never work.** `spawn()` ENOENT is emitted async on the child's unlistened `'error'` event, so the sync try/catch prints `✓ opened default browser` then crashes unhandled (cli.ts:1759–1765); on win32 it spawns `start`, a cmd.exe builtin that always ENOENTs. Same pattern in reporters/html.ts:86–87. The `open` package is already a dependency and used correctly by `show-trace`.

### init / verify / MCP
- **M18. `init --json` without `--yes` in a TTY launches the interactive wizard** — `--json` doesn't set `anySetupFlag` (init-noninteractive.ts:124; init.ts:497). A script probing with `--json` gets a figlet banner and a prompt.
- **M19. init's network-capture question conflates traces with network capture**: "Enable network trace capture?" actually controls `trace: { mode: 'retain-on-failure' }` entirely (init.ts:287, 372) — declining disables all trace recording (screenshots, snapshots), which the wording doesn't convey.
- **M20. init's path prompts validate only non-emptiness** (init.ts:95–99, 151–156) — a typo'd APK path fails silently at package detection and surfaces only at first `tapsmith test`.
- **M21. MCP `tapsmith_run_tests` descriptions are wrong**: `files` promises "glob patterns" but the always-taken dispatcher path exact-matches (mcp/headless-dispatcher.ts:85; globs only work in an unreachable spawn fallback); `device` says "ignored in UI mode" but is ignored in both modes. `docs/mcp-server.md:181` also mis-describes the `test` param (it's a case-insensitive substring across all files, not "full name, single file").
- **M22. doctor's inventory and `list-devices` can flatly disagree** — verified live: doctor listed ~15 simulators while `list-devices` printed "No devices detected" (doctor queries host tools directly, list-devices shows the daemon's booted-only view). Neither output explains the discrepancy.

---

## 4. Low-severity findings (grouped)

**Wording / output**
- `verify` says "Runs one test" but runs one test *file* (verify.ts:37–39); its 10-min timeout surfaces as "Test run produced no results (exit code unknown)" with no timeout mention (verify.ts:219).
- `verify-ios-network` prints literal `<udid>` placeholders in fix hints despite having the real UDID (verify-ios-network.ts:271–282); configure interpolates it.
- "Only 1 device(s) available… for parallel" (cli.ts:1409) — a `countLabel` helper exists at cli.ts:87 and isn't used; "for parallel" reads clipped.
- Help lists reporters "(list, line, dot, json, junit, html, github)" but `blob` is accepted and user-relevant for sharding (cli.ts:1705, reporter.ts:229). Unknown-reporter error appends raw `ERR_MODULE_NOT_FOUND` noise (reporter.ts:242) — relevant because Playwright-style `--reporter list,json` lands there.
- `show-trace` help says `<file.zip>`, its usage error says `<trace.zip>` (cli.ts:1673 vs 1772). `merge-reports` logs "Merging blob reports" *after* merging (cli.ts:1806–1807); corrupt blobs surface as `Fatal error: Unexpected token` + stack.
- `show-report`'s "No report found" gives no next step (the default run uses `list` only, so fresh users always hit it) and `show-report path/index.html` yields `.../index.html/index.html` (cli.ts:1751–1753).
- HTML report's copy-paste hint `npx tapsmith show-trace <basename>.zip` (reporters/html.ts:249, 272) only works if cwd is the report dir.
- MCP server reports version `0.1.0` to clients (mcp/index.ts:67; package is 0.3.3). `tapsmith_type` ignores clear-step failure (mcp/tools/device-actions.ts:52–54). `tapsmith_list_results` says "current session" but means "latest run" (results cleared per run, headless-dispatcher.ts:92).
- `setup-ios` exits 1 for the expected fresh-machine "not registered yet — nothing to fix" state (setup-ios.ts:162–172).
- `setup-ios-device`'s closing advice tells users to hand-set `device` and `iosXctestrun` (setup-ios-device.ts:505–509), both of which are auto-detected (cli.ts:790–806) — the docs correctly say minimal config is `platform + app + package`.
- Profile expiry uses `Math.floor` on negative deltas: expired one hour ago → "expired 1 day(s) ago" (ios-profile-expiry.ts:118, 138).
- "iOS 26 4" instead of "iOS 26.4" — `.replace(/-/g, ' ')` on runtime ids (env-scan.ts:65); visible in doctor inventory and init's simulator picker.
- Stale comments: setup-ios-device.ts:50–53 (moved firewall check), ios-device-resolve.ts:109 (nonexistent `--simulator` flag), ios-profile-expiry.ts:13–15, configure-ios-network.ts:344–346. Stale docstring: config.ts:129–132 ("dot in CI" — actual default is `list` everywhere).

**Behavior**
- `verify-ios-network` is the only iOS command with no macOS guard (verify-ios-network.ts:359–382) and hangs on non-TTY stdin (`promptEnter` has no `isTTY` check, :93–96) — unusable in scripts.
- Explicit file args to `test` aren't checked for existence — a typo'd path boots an emulator and installs the app before dying (test-file-discovery.ts:14–16).
- A file with zero registered tests produces a green exit-0 run; Playwright errors without `--pass-with-no-tests`.
- "Only N devices… single-worker mode" warning is suppressed for all-JS suites (quiet flag effectively inverted for projects that never tsx-re-exec, cli.ts:2342, 2415).
- `--ui --watch` silently drops `--watch` (cli.ts:1948–1951); `--ui-port`/`--ui-dev-url` without `--ui` silently ignored.
- `show-report`/`merge-reports` resolve against `process.cwd()` and never consult configured `outputFolder`/`rootDir` (cli.ts:1751, 1799 vs html.ts:35, blob.ts:67).
- `merge-reports` mutates its input dir (writes decoded screenshots into it, blob.ts:167–171) and always exits 0 even when the merged status is `failed` (matches Playwright, but the status is computed then discarded).
- Subcommand-parser usage errors surface as `Fatal error:` + stack trace via `main().catch` (`mcp-server --bogus`, `verify --badflag`), unlike the clean top-level one-liners.
- `--json` error envelopes differ per command: init/verify `{error:{code,message,fix}}`, list-devices `{error: "<string>"}`, doctor none. `CheckEntry.detail` in doctor JSON is declared but never populated.
- `pickNewestSimulator` can write a watchOS/tvOS device into the config when no iPhone simulators exist (init-noninteractive.ts:153).
- doctor re-executes adb/simctl for the inventory after already running them for checks (doctor.ts:439–445). mitmproxy detection is brew-only — pip/pipx installs false-warn (doctor.ts:308).
- Help's Options section presents `test`-only flags as global; `tapsmith show-trace foo.zip --force-install` is silently accepted. `--ui`/`--ui-port` are missing from Options; `--ui-dev-url` is undocumented entirely (fine if intentionally dev-only).

---

## 5. Cross-references and overlaps

**Cross-references: excellent.** All five agents mapped every "run `tapsmith X`" string across commands, reporters, docs, and AGENTS.md — **every referenced command exists and is spelled correctly**, and the iOS chain routes failures to the right fixer. The problems are semantic, not spelling: doctor's fixes that dead-end (M9, M10), refresh's incomplete walkthrough (H5), and one nit — configure's missing-UDID error sends users to `setup-ios-device` to find UDIDs when `list-devices` is the purpose-built answer (configure-ios-network.ts:339).

**Overlaps:**
- `configure-ios-network` vs `refresh-ios-network` — same code, wording-only difference (configure-ios-network.ts:14–17). Defensible for discoverability, but refresh's wording is currently strictly *worse* (H5), inverting the value of the dedicated command. Either fold into `configure-ios-network --refresh` or make refresh smarter — `checkHostIpDrift` (ios-host-ip-check.ts:107) already exists and could say whether a refresh is even needed.
- `doctor` inventory vs `list-devices` — half-duplicated with disagreeing views (M22). Worth either unifying the data source or annotating the difference ("12 simulators installed but not booted — tapsmith test boots the configured one automatically").
- `init` / `verify` / `doctor` — division of labor is clear and deliberately documented (`docs/agents.md`: doctor = static environment, init = write config, verify = dynamic proof). Good.
- `setup-ios` vs `setup-ios-device` — the worst naming pair. `setup-ios` is only about *simulator network capture*, but nothing in its name or help line says "simulator"; a physical-device user will plausibly run it first and get irrelevant mitmproxy instructions. Neither track's output mentions the other exists.

---

## 6. Missing functionality

**`test` (vs `playwright test`):**
- Config-exists-but-no-flag: `--retries` (notable: the CLI itself prints "Set retries to 1 or more to get videos" yet offers no flag), `--timeout`.
- Missing entirely: `--max-failures`/`-x` (no early-abort at all), `--list` (dry run), `forbidOnly` (a committed `test.only` silently shrinks the suite in CI — runner.ts:918), `--pass-with-no-tests`, `--last-failed` (watch mode's `f` key covers it interactively only), `--repeat-each`, `--only-changed`, `--quiet`, `--debug`, `--fail-on-flaky-tests`.
- At/above parity: `--shard`, `--grep`/`--grep-invert` (incl. per-project semantics), `--project` with automatic transitive deps (nicer than Playwright), `--video` as a CLI flag, zero-match → non-zero exit.

**Reporting:** `show-trace --port` (the underlying `showTrace()` already accepts `port` — one-line fix) and remote trace URLs; `show-report --port/--host` HTTP serving; `merge-reports --reporter` (H6) and `-o` output dir.

**iOS:** no teardown (`--fix-firewall` permanently disables stealth mode with nothing to restore it; nothing removes the sidecar, profile/CA, or sudoers rule); no physical-device equivalent of `doctor` (the pieces — trust probe, drift check, expiry — exist but only run inside `tapsmith test`); `setup-ios-device` has no `--json` (the other three health commands all do); `verify-ios-network` has no non-interactive/timeout mode.

**Setup/health:** `verify` has no `--project`/`--device` passthrough (can't verify one platform of a multi-platform config); `init --yes` can't skip the multi-minute iOS agent build; neither init nor doctor mentions MCP setup (a headline feature — init's AGENTS.md does, but the human output doesn't).

**Shell:** did-you-mean suggestions on unknown commands; uniform per-command `--help`.

---

## 7. Overall DX assessment

**What's strong** (worth keeping deliberately): every cross-command reference is real and correctly spelled; exit codes are consistent (1 on error, 0 on success including empty shards); all four `--json` modes are ANSI-clean and banner-suppressed; MCP stdio hygiene is perfect (nothing non-protocol on stdout); the verify-ios-network triage and run_tests zero-match errors are genuinely good error UX; `--project` dependency resolution beats Playwright's.

**Systemic themes behind most findings:**

1. **The hand-rolled parser is the root of the biggest bug cluster** (M1–M3, H4, the three-class `--help` behavior, flags-accepted-by-wrong-commands). CLAUDE.md's own principle is "don't reinvent the wheel" — adopting `commander`/`yargs` (or at minimum a shared `takesValue`+enum-validation helper and a per-command help registry) would fix H2, H4, M1–M3, and the `Fatal error:` stack traces on usage errors in one move.
2. **Advice strings are not tested against reality.** Doctor fixes that dead-end (M9, M10), refresh's missing step (H5), docs documenting nonexistent flags (H8), stale sample output in getting-started. A cheap guard: a unit test that extracts every `tapsmith <cmd>` / flag string from user-facing output and docs and asserts it against the real command/flag table.
3. **Silent degradation over loud failure.** Invalid trace modes record nothing (H4), broken configs fall back to defaults (M6), `--device`/`--force-install` are ignored in parallel mode (M4/M5), empty blob dirs merge green (M16), zero-test files pass. The codebase's stated bar is Playwright, and Playwright's signature behavior is failing loudly on exactly these.
4. **Two audiences, one output.** The `--json` modes show real investment in agent DX, but the human side lags in spots: doctor hides its fixes from humans (M8), init's next steps tell humans to run `--json` commands, error envelopes differ per command.
5. **The iOS physical-device chain is the most fragile surface** — most H/M findings per command. It's also inherently the hardest to test; H1, H5, M13, M14 all fail exactly the user who is following instructions correctly.

**Suggested fix order:** H1 (init writes wrong config) → H3 (silent exit) → H2 + H4 + M1 (parser/help overhaul) → H5 + H6 + H8 (output/docs that mislead) → M4/M5 (mode-dependent flags: honor or reject loudly) → the doctor fix-string cluster (M7–M12) → parity features (`--retries`, `forbidOnly`, `merge-reports --reporter`, `show-trace --port`).
