# Understanding and planning

## 1. Understand the ticket

- **Read all of it.** Description, acceptance criteria, **every comment** (scope changes,
  "also handle X", and decisions land there), linked issues ("split from", "blocks",
  "duplicates"), and attachments. Fetch it with whichever Jira connector in this session
  reaches the project (load via ToolSearch). No connector → ask the user to paste it; do
  not guess a ticket's content from its key.
- **Is it already done?** `git log origin/<base> -E --grep '<KEY>([^0-9]|$)'`,
  `gh pr list --search <KEY> --state all` (then keep only exact-key matches — PILOT-12
  must not match PILOT-123), and a read of the current code. A ticket fixed as a side effect of another
  PR gets a short report, not a new PR.
- **Read the code and its tests.** Every file the change will touch, its callers
  (`grep -rn`), and the tests that already cover it. Know what currently happens before
  deciding what should.
- **Find the Playwright precedent.** Tapsmith deliberately tracks Playwright's API shape.
  For any API-shaped ticket, find the equivalent Playwright API and its exact contract
  (auto-waiting or not, timeout semantics, what it throws, strictness) from Playwright's
  docs or source. Check **each sibling API's own contract** before generalising a rule
  across them — e.g. only `isVisible`/`isHidden` are non-waiting in Playwright;
  extending that to `isEnabled`/`isChecked` was wrong and got reverted.
- **Reproduce a bug before fixing it.** The lowest tier that shows it: a unit test, a
  scratch script against `dist/`, or a device run (check and lease a device first — SKILL.md
  *Devices*). Record the repro in the state
  file. Cannot reproduce → investigate why (stale build, environment, already fixed)
  before writing code, and say so if it stays unreproduced.

## 2. Edge-case catalogue

Walk every heading; write down each case that applies to this ticket. Each one must end
as a test, a QA item, or "out of scope because …".

**Run paths.** Which of the five embedders (CLAUDE.md: `cli.ts`, `worker-runner.ts`,
`ui-worker.ts`, `watch-run.ts`, `mcp/headless-dispatcher.ts`) does this reach? A
per-session concern must be wired through all of them — make it a **required** option on
`runTestFile` (or the relevant init message) so a missed embedder is a compile error, not
a silent default. Then the seven user-facing modes: sequential, `--workers N`, watch,
headless MCP, UI mode, UI watch, UI MCP.

**Platforms.** Android emulator, iOS simulator, physical iOS; a mixed Android+iOS config;
multi-device (`use.devices`) groups. Does the agent on each platform support what the SDK
now asks for?

**Lifecycle.** Cold first run vs warm second run in the same session (reset paths differ);
watch re-runs (a fresh child each time — state re-derived, not inherited); a worker
respawned mid-session; the app killed or crashed mid-test; the daemon or agent dying.

**Interruption and timing.** Ctrl-C, `stop_tests`, a test timeout mid-action, an abort
racing a retry; auto-wait deadlines (does the new code respect the caller's timeout?);
slow CI runners (a bound that passes locally and fails on a cold emulator).

**Concurrency.** Two sessions on one machine, two workers on one device target, port or
socket-name collisions, file locks, the UI server and headless MCP claiming the same
device.

**Inputs and config.** Empty, invalid, boundary and unusual values; a missing key; a
config loaded from a foreign cwd (`rootDir` resolution); project filters that match
nothing or several; CLI flag combinations that must be refused (with a message naming
the conflict).

**Compatibility and contracts.** Proto changes (SDK + daemon + both agents); the trace
archive format (`docs/trace-format.md` — types, schema and docs move together; bump
`TRACE_FORMAT_VERSION` if an existing reader could misread); the telemetry payload
(closed key set — do not add fields casually); the public API (`docs/api-reference.md`);
existing user configs that must keep working.

**Failure experience.** What does the user see when it goes wrong? Every new failure path
gets an actionable message: what happened, why, what to do. Environment friction the user
could hit belongs in the product (a guided error, a `doctor` check), not in a local
workaround.

**Resources.** Processes, ports, temp files and port files cleaned up on success, failure
and interruption.

**Guard against over-engineering, too.** A defensive guard for a state nothing can
produce ("dormant guard") draws reviewer churn and hides real design. If a case cannot
happen, write down why and do not code for it.

## 3. The plan file

`<state dir>/plan.md` (SKILL.md Phase 0):

```markdown
# <KEY>: <ticket title>

## Intent
<2–4 lines: the problem, who hits it, what done looks like>

## Acceptance criteria
AC1 [stated]   … — source
AC2 [inferred] … — from "<quoted text>"
AC3 [standing] works in every run mode the change reaches

## Design
<approach; embedders touched; rejected alternatives and why; Playwright precedent>

## Edge cases
E1 <case> → test: <tier, file>        | QA: <mode/platform> | out of scope: <reason>
…

## Test plan
<AC/edge id> → <tier> → <test file> → first? yes/no (why not)

## Docs
<pages to update>

## Slices
1. <slice> — ends green with <tests>
…

## Assumptions and open questions
<each with the conservative default you will take if unanswered>
```

Keep it current: when an edge case is discovered during the build, add it here with its
outcome. The PR description's "How it was tested" and "Known limitations" come from this
file.
