---
name: qa-this-branch
description: Manually QA a branch (checked out, named, or a PR) against its base and against what it was meant to do. Establishes intent from the Jira ticket, PR and docs (works with no PR and no acceptance criteria), triages the change type, maps it across every Tapsmith run mode, platform and UI pane, subtracts what CI already covers on this exact SHA, then hand-exercises and tries to break what is left. Writes a machine-readable report with a verdict (ready / ready-pending-ci / needs-fixes / incomplete) that a calling workflow can act on. Read-only: never edits source, commits, pushes or opens PRs. Every invocation is a full retest. Use when asked to QA, manually test, dogfood, or sanity-check a branch or PR, or as the QA step of an implement-ticket workflow.
---

# QA this branch

You are the QA engineer for this branch. Your deliverable is **a QA report backed by
evidence you personally collected** — not a code review, not a green CI badge. You may be
run by a person at the terminal or by another skill (e.g. an implement-ticket workflow
deciding whether the branch is ready for a PR or for merge), so the report is both
readable and parseable.

Six failure modes to design against, all of which have happened here before:

1. **A mode was never exercised.** Tapsmith assembles a run through seven separately
   wired paths, and CI only drives the sequential headless one on a device. A change that
   works in `tapsmith test` can be inert or broken in UI-mode MCP.
2. **A probe ran but proved nothing.** "The suite went green" does not prove the new code
   ran. Assert the specific observable (trace rung, log line, pane content, tool payload).
3. **The QA re-ran what CI runs.** Your scope is the **complement** of automated coverage
   — and only a check a machine re-runs on *this SHA* counts as coverage.
4. **The QA trusted a previous round.** Every invocation is a full retest (ground rules).
5. **The QA tested what the diff does, not what the branch was for.** A diff-derived
   inventory can only confirm the code does what it does. Missing behaviour is invisible
   to it, and that is the finding manual QA exists to catch.
6. **Only the happy path was tried.** Playwright is the bar: interruption, repetition,
   concurrency, recovery and error-message quality are in scope, not extras.

References — read each when its phase needs it, not all up front:

| File | Read in |
|---|---|
| `references/intent.md` | Phase 1 — where intent comes from, working ACs when there are none |
| `references/automated-coverage.md` | Phase 2 — what to subtract, and how to prove CI covers *this* SHA |
| `references/surface-map.md` | Phase 2 — change-type triage, changed path → modes/panes |
| `references/modes.md` | Phases 2–4 — the seven run modes, launch recipes, per-mode risks |
| `references/probes.md` | Phases 3–4 — probe recipes, environment traps, cleanup |
| `references/report-format.md` | Phase 5 — the report file contract and verdict rules |

`${CLAUDE_SKILL_DIR}` below is this skill's directory — the copy this session loaded,
whose instructions you are following. Use it for the scripts and references rather than
a repo-relative path: a worktree of an older branch may hold an older copy of the skill,
or none.

## Arguments

`$ARGUMENTS` is free text. Any of these tokens may appear in any order; leftover text is
**focus** — extra emphasis for Phase 3, never a reason to shrink the matrix.

| token | meaning | default |
|---|---|---|
| `#123` / `pr 123` | QA that PR's head; base = the PR's base | the current checkout |
| `branch=<name>` | QA that branch | the current checkout |
| `base=<ref>` | diff against this ref's merge-base | PR base, else `origin/HEAD`, else `main` |
| `ticket=<KEY>` | intent source | detected (`references/intent.md`) |
| `platform=ios\|android\|both` | device platforms to probe | from the triage; `both` for any device-affecting change |
| `budget=<minutes>` | wall-clock cap for Phases 3–4 | `90` |
| `leads=<path>` | a previous QA report whose findings become must-test rows | none |
| `report=<path>` | where to write the report | `<scratchpad>/qa-this-branch/report-<unix-ts>.md` |
| `devices=<id,…>` | device targets (UDIDs / serials) the caller has **already leased for you** — use only these, and do not lease or release them | lease your own (ground rules) |
| `autonomous` / `interactive` | see below | `interactive` if a person typed `/qa-this-branch`; `autonomous` if another skill or agent invoked you |

**Interactive** — show the plan (intent + matrix) and wait for the go-ahead before Phase 4;
ask when blocked. **Autonomous** — never wait for input. Write the plan file, print a
five-line summary of it, and carry on. When you would have asked, make the conservative
choice, record it under `decisions` in the report, and put the question you would have
asked under `open_questions`. Autonomous mode changes who decides, never how thoroughly
you test.

`leads=` findings are re-established by your own probe or dropped. They are **never
coverage**, and a lead marked fixed is still a must-test row: prove the fix.

## Ground rules

- **Read-only on the product.** Never edit tracked source, commit, push, open or comment
  on a PR, or transition a ticket — the caller owns those decisions. Throwaway probe files
  go in the scratchpad, or in `e2e/qa-tmp/` (not a dot-dir — see probes.md), removed before
  you report. In interactive mode, offer fixes once the report is done.
- **Every invocation is a full retest.** Re-derive intent, inventory and matrix every time.
  Memories, earlier reports, "live-verified" notes and published QA artifacts are
  background: they may tell you *how* to reach a state (launch recipe, environment trap,
  probe script), never *whether* to test it. No `covered: QA round N` cells, no citing
  earlier rounds as evidence — re-establish or leave out.
- **Devices: check, then claim.** Before anything device-holding (`tapsmith test`, `--ui`,
  any device MCP tool):

  ```bash
  "${CLAUDE_SKILL_DIR}/scripts/device-availability.sh"   # exit 0 = FREE, 3 = BUSY
  ```

  FREE → pick a listed target that is not `[LEASED]`, and **lease it before using it**:

  ```bash
  "${CLAUDE_SKILL_DIR}/scripts/device-lease.sh" acquire <udid-or-serial> "qa:<branch>"
  ```

  Exit 1 means another worker just took it — pick another. Release every lease you took
  in cleanup (`… release <target> "qa:<branch>"`). Parallel workers (implement-tickets)
  rely on leases; the availability check alone has a race between check and claim. With
  `devices=`, the caller already holds the leases: use only those targets.
  BUSY → use a target it lists as unheld and unleased; only when every target is taken,
  stop and ask (interactive) or mark the device cells UNTESTED `device busy: <what holds
  it>` (autonomous). Re-run it before each new device-holding launch. Booted simulators, running emulators, idle MCP servers and PPID-1
  orphans are **not** active use — the script already separates them. A collision symptom
  after claiming ("hierarchy contains no elements after relaunch", "Failed to connect to
  agent socket" that never recovers) means you took something: back off and report it.
- **Never re-run a check CI runs** — read its result for this SHA instead
  (`references/automated-coverage.md` has the table, how to prove the SHA matches, and the
  four narrow exceptions).
- **Test branch code, not published code — never `npx tapsmith`.** npx falls back to a
  published, npx-cached build with the same version number whenever the local bin is
  missing (a worktree's `e2e/`, the repo root), and `--no-install` does not stop it: it
  still runs the cached copy. The session's registered `tapsmith-headless` MCP server
  runs published code too. Always invoke the branch's CLI by path:
  `node <repo>/packages/tapsmith/dist/cli.js …` (from `e2e/`,
  `node ../packages/tapsmith/dist/cli.js …`).
- **Everything runs `dist/`**, so build before any probe (`cd packages/tapsmith && npm run
  build`) and restart server processes (UI server, MCP server) after any rebuild. Rust,
  agent and test-app changes need their own rebuilds, and a **fresh worktree has no local
  daemon build** — the npm daemon it falls back to may lack new RPCs (probes.md §0).
- **Budget.** Track elapsed time from the start of Phase 3. When the budget runs out, stop
  probing, mark the remaining cells UNTESTED `budget`, and report. Work in the priority
  order from Phase 3, so what is left is the least important.
- **Clean up** what you started (probes.md §10); never kill a session you did not start.

## Phase 0 — Set up the target

1. **Resolve target and base.** No arguments → the current checkout. `#123`/`branch=` that
   is not what's checked out → do **not** switch the user's checkout; create a worktree:
   `git worktree add .claude/worktrees/qa-<name> <ref>` (for a PR, `gh pr checkout <n>`
   inside it). Record `merge=$(git merge-base HEAD origin/<base>)` after `git fetch`.
2. **Record what you are testing**: `git rev-parse HEAD`, whether the tree is dirty
   (`git status --short` — uncommitted work is in scope, and CI has never seen it),
   whether the branch is pushed (`git rev-parse @{u}` / `git status -sb`), and whether a PR
   exists (`gh pr view --json number,url,baseRefName,headRefOid,body 2>/dev/null`). **No
   PR is a normal state** — intent then comes from the ticket and commits, and there is no
   CI evidence at all: every workflow is PR-triggered, so pushing alone runs nothing.
3. **Check the environment** once: node is arm64 (probes.md §0), and the builds you will
   need are fresh for this tree (SDK `dist/`, daemon, agents, test-app — probes.md §0 has
   the staleness checks). If HEAD is the base branch with a clean tree, stop: nothing to QA
   (verdict `incomplete`, reason `no change`).

## Phase 1 — Establish intent

Follow `references/intent.md`. Output, in the plan file:

- the **intent sources** you found (ticket key and summary, PR, commits, docs changes) and
  the ones that were absent;
- **working acceptance criteria**, each tagged `stated` (quoted from the ticket/PR) or
  `inferred` (with the text it came from), plus the project's standing criteria
  (intent.md lists them);
- **scope divergence**: criteria the diff does not appear to address (candidate
  `missing-requirement` findings — to be confirmed by probing, not by reading), and
  behaviour the diff adds that nothing asked for (note it; test it like any change).

Never block on missing ACs. Inferred criteria are tested like stated ones; a failure
against an inferred one is reported with the inference visible and the question under
`open_questions`.

## Phase 2 — Triage, inventory, matrix

1. **Triage** the change type(s) with the table at the top of `references/surface-map.md`.
   That decides the matrix columns: a docs-only or website branch does not get the
   seven-mode matrix; an SDK run-path change does; an agent change gets a platform split.
2. **Inventories**, from the full diff of every changed source file (read it all):
   - **(a) intent rows** — each working AC from Phase 1;
   - **(b) new behaviour** — each new user-observable behaviour, with the observable
     that proves it. If you cannot name the observable, you cannot QA it — reread the diff;
   - **(c) at-risk existing behaviour** — derived mechanically: look each changed path up
     in `references/surface-map.md` and ask what used to flow through that code that still
     must. Especially shared helpers with callers in other modes, per-session wiring (the
     five embedders in CLAUDE.md), proto changes, and default/fallback branches.
3. **Matrix**: rows = inventory items, columns = the dimensions from triage (modes from
   `references/modes.md`, split by platform where device behaviour differs; panes; CLI
   subcommands; docs pages). Each cell is one of:
   - **`covered: <job or spec> @ <sha>`** — an automated check that ran (or will run and
     has already passed) **on HEAD** would fail if this broke. Name it. Only CI or an
     automated spec fills this; `references/automated-coverage.md` says how to prove it.
   - **`pending-ci: <job or spec>`** — the right automated check exists but has not passed
     on this exact tree (no PR yet, dirty tree, in progress, or ran on an older SHA). Not probed
     by you; listed in the report so the caller knows which CI results the verdict hangs on.
   - **`must-test`** — with the reason it survived subtraction (mode CI never runs; spec
     does not assert this observable; state unreachable automatically; intent row; lead).
   - **`unaffected`** — with a reason. A whole row unaffected is a smell; re-check.

   Do the subtraction before planning probes. A typical SDK branch ends with most cells
   `covered`/`pending-ci` and the work on modes 2–7, assert-gaps, intent rows and artifacts.
4. **Write the plan file** (`<scratchpad>/qa-this-branch/plan.md`): intent, inventories,
   the full matrix including `covered` rows (so the reasoning is visible), and which probes
   need a device. Interactive: show it and wait. Autonomous: print a short summary, go on.

## Phase 3 — Choose probes

Only `must-test` cells get probes. **Priority order** (this is also the order you run them
in, and what the budget cuts from the bottom of):

1. intent rows and new behaviour, on the primary mode and platform;
2. the same across the modes CI never runs (2–7) and the second platform;
3. at-risk existing behaviour;
4. the break-it pass (below);
5. adjacent surfaces (docs examples, `doctor`, trace viewer, reporters).

**Cheapest sufficient rung** for each probe (recipes in `references/probes.md`):

1. **Read CI for HEAD** — instead of running the gates and suites yourself.
2. **`web-tests/` as a harness** — throwaway specs through `fake-ui-server.ts` /
   `trace-builder.ts`; no device; first choice for any pane change.
3. **MCP stdio probe harness** — headless MCP without a device (short of device tools),
   capturing the server's stderr.
4. **UI WebSocket probe** — prove a run reaches the UI feed; catch out-of-order messages.
5. **Real headless run on a device** — only for a mode CI does not run, an artifact you
   must read, or a red CI job you are reproducing. One file, not the suite.
6. **Live UI-mode session + browser** — the only rung that sees rendered panes; plan UI
   mode, UI watch and UI MCP probes so one launch serves all three.

Prefer probes that **read the artifact** (trace zip, reporter output, feed messages, MCP
payload, stderr), not the exit code.

**Break-it pass.** For each (a)/(b) row, apply every item below that fits and record which
you skipped and why:

- **Input** — invalid, empty, boundary, unusual config (foreign cwd, missing key, mixed
  platforms, a project name that doesn't exist).
- **Repetition** — a second run in the same session (the warm path differs from the cold
  one), a watch re-run, rapid re-triggers.
- **Interruption** — Ctrl-C, `stop_tests` mid-run, killing the daemon or agent mid-action,
  closing or reloading the browser tab mid-run.
- **Concurrency** — `--workers 2`, two sessions, UI button + MCP run at the same time.
- **Recovery** — after a failure or interruption, does the next run work without manual
  cleanup? Missing agent, stale build, device offline.
- **Parity** — the same probe on the other platform when device behaviour is involved.
- **Error DX** — when it fails, does the message say what went wrong and what to do? A
  vague or misleading error on a common path is a finding (kind `dx`).
- **Docs** — run each documented example the branch adds or changes verbatim, as a new
  user would; behaviour that contradicts the docs is a finding (kind `docs-mismatch`).
- **Leftovers** — after the probe, orphaned processes, port files, temp files.

## Phase 4 — Execute

Work in priority order, device-free rungs first within each priority. Device-free probes
that do not share state can run in parallel subagents (`general-purpose`, one probe spec
each, returning raw evidence); device-holding work stays in one lane per device.

For each `must-test` cell:

- Record the exact command or tool call and the raw evidence (quoted output, trace field,
  screenshot path under the scratchpad) showing the observable.
- On an unexpected result: reproduce once, then **check the base** (worktree at `$merge`,
  probes.md §9) before calling it a regression. Pre-existing bugs are reported separately
  and never block the verdict.
- If a probe fails for environment reasons after 2–3 attempts, mark the cell UNTESTED with
  the reason and move on — do not grind.

## Phase 5 — Report

Write the report file exactly as `references/report-format.md` specifies — front matter
(verdict, SHA, counts, pending CI, open questions) plus the sections below — then print in
the terminal:

- the one-line **verdict** with the reason;
- **Findings**, most severe first: kind, severity, repro, expected vs actual, modes and
  platforms, regression vs pre-existing, the automated test that should catch it, and the
  retest probe;
- **Intent**: each working AC → met / not met / untested, with inferred ones marked;
- **Coverage table**: item × dimension → how tested → result → evidence pointer
  (`covered:`/`pending-ci:` rows need no evidence of your own);
- **Not tested**: every UNTESTED cell with its reason — an honest gap beats a padded pass;
- **Open questions** and **decisions** made on the caller's behalf (autonomous);
- **Cleanup**: what you started, and whether you killed it.

End your final message with exactly these two lines, so a calling skill can parse them:

```
QA_VERDICT: <ready|ready-pending-ci|needs-fixes|incomplete>
QA_REPORT: <absolute path to the report file>
```

In interactive mode, offer an Artifact of the report if it is to be shared.

Save durable new facts to memory: a mode's launch recipe, an environment trap, a probe
technique that worked, an open bug worth investigating next time. Never save this round's
verdicts, coverage or "verified" claims — the next round is a full retest, and a stored
result only tempts it to subtract. Open findings go in as *bugs to investigate*.
