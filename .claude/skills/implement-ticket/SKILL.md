---
name: implement-ticket
description: Implement a Jira ticket end to end and keep going until its PR is ready to merge. Understands the ticket and its Playwright precedent, plans the design, edge cases and test tiers up front, builds it test-first where a test can come first, then decides for itself when to run /review-loop and /qa-this-branch, when to commit, push and open a draft PR, how to answer CI failures and review threads (human or bot), and when the PR meets the ready-to-merge bar. Never merges unless given `merge`. Resumable from its state file. With `auto`, never asks the user anything and makes every decision itself, disclosed in the PR. Use when asked to implement, build, fix or pick up a ticket (e.g. "implement PILOT-123", "/implement-ticket PILOT-123").
---

# implement-ticket

You own this ticket from "what does it actually ask for" to "a PR a maintainer can merge
without reading anything twice". Nobody hands you the next step: you decide when to
test, review, QA, commit, push and open the PR, and you keep going until the
**ready-to-merge gate** (Phase 7) passes or a real blocker needs a human.

The bar is the project's: **Playwright is the bar** (CLAUDE.md). A change that works on
the happy path in one run mode is not done.

References, read when the phase needs them:

| File | Read in |
|---|---|
| `references/planning.md` | Phases 1–2: understanding the ticket, the edge-case catalogue, the plan file |
| `references/tdd.md` | Phase 3: when to go test-first, which tier, red/green per component |
| `references/pr-and-ci.md` | Phases 4–7: branch, commits, push cadence, the PR, CI triage, review threads |
| `references/state.md` | Phase 0 and whenever context was summarised: the state file and resuming |

`${CLAUDE_SKILL_DIR}` is this skill's directory; sibling skills are
`/review-loop` and `/qa-this-branch` (invoke `/review-loop` with the Skill tool; run
`/qa-this-branch` in a fresh subagent, as Phase 5 says).

**The skill-directory placeholder is not a shell variable.** Claude Code fills in the
`CLAUDE_SKILL_DIR` placeholder only in this SKILL.md; the Bash environment does not have
it, and the reference files contain the placeholder literally. This skill's directory is
`${CLAUDE_SKILL_DIR}` — use that absolute path wherever a command in a reference file
writes the `CLAUDE_SKILL_DIR` placeholder, or the command runs `/scripts/…` and fails.

## Arguments

`$ARGUMENTS` is free text. Tokens, in any order; leftover text is extra guidance for the
plan (constraints, hints, "don't touch X").

| token | meaning | default |
|---|---|---|
| `PILOT-123` (any `KEY-n`) | the ticket | required, unless resuming on a branch whose name carries it |
| `also=<KEY>,…` | further tickets combined into this one change: each is read as an intent source (Phase 1), its ACs join the plan and QA's intent (pass `ticket=` the primary key and the others as focus), and the PR title and body carry every key. State, branch and leases stay keyed on the primary | none |
| `auto` | never ask the user anything, at any point: every stop-and-ask becomes your own decision, disclosed in the PR, and the run ends only at a final result — see *Auto mode* | interactive |
| `base=<ref>` | branch to build on and target. Every workflow runs on a PR to any base, so the gate is the same as for `main` | `main` |
| `after=<branch>` | stack on another ticket's unmerged branch: start from `origin/<branch>`, review and QA against it, PR still targets `<base>` — see *Stacked branches*. Used by `/implement-tickets` in auto mode for dependent tickets | off |
| `no-jira` | make no Jira writes at all. By default the ticket moves to **In Progress** at the start, gets a comment with the PR link when the PR opens and one with the final result at the end, and is never moved to **Done** — that waits for the merge (Phase 7) | Jira updates on |
| `leave-draft` | stop at the gate with the PR still a draft — so iOS E2E, which skips drafts, has not run (Phase 7) | mark it ready for review |
| `merge` | once the gate passes, squash-merge the PR yourself (Phase 8). Overrides `leave-draft` | stop at ready; a human merges |
| `max-qa=<n>` | cap on QA → fix cycles before escalating | `3` |
| `worker` | run as one of several parallel workers under `/implement-tickets` — see *Worker mode* | off |
| `worktree=<path>` | do all work in this existing worktree (the coordinator created it) | Phase 0 decides |
| `plan-review` | (worker mode) stop after Phase 2 and return the plan for approval | off |
| `no-handoff` | never hand off (*Context hand-off*): do every wait yourself. The coordinator passes it to workers on the `sessions` host, which it cannot relaunch without the user | off |
| `continuation` | you are a fresh context that a standalone run handed Phases 6–8 to (*Context hand-off*): resume from the state file, never ask the user directly (return `blocked` with a `QUESTION:` block, as in worker mode), and never hand off again | off |

## What you may and may not do

Invoking this skill **is** the authorisation to create a branch, commit (signed off),
push that branch, open and edit its PR, mark it ready for review, reply to and resolve
its review threads, and re-run its failed CI jobs. It is not authorisation for anything
else:

- **Never merge** the PR — unless `merge` was given, and then only as Phase 8 says —
  and never push to `main`, force-push, delete branches, or change repository settings.
  Without `merge` the gate ends at "ready"; a human merges.
- **Never** bypass checks: no `--no-verify`, no skipping, deleting or weakening a test or
  assertion to go green, no `eslint-disable` without a real justification, no
  `continue-on-error`.
- **Jira writes are limited** to moving this ticket's status and commenting the PR link and
  result on it (none at all with `no-jira`), plus anything the user asks for.
  Follow-up tickets you would file go in the final report and the PR description as
  proposals.
- Keep secrets, personal paths and machine-specific details out of commits and the PR —
  the repo is public.

## Devices

Devices are shared — with other workers, other sessions and the user. Before any
device-holding work (a device-tier test, a local e2e file, anything QA does for you),
check and **lease** a target with the qa-this-branch skill's scripts:

```bash
"${CLAUDE_SKILL_DIR}/../qa-this-branch/scripts/device-availability.sh"        # target rule: qa-this-branch SKILL.md ground rules
"${CLAUDE_SKILL_DIR}/../qa-this-branch/scripts/device-lease.sh" acquire <udid-or-serial> <KEY>
```

Pick a target exactly as qa-this-branch's ground rules say — `device-availability.sh
--pick <platform> --owner <KEY>` prints one that is not `[IN USE]`, not attached and not
`[LEASED]` by someone else (sessions the user starts by hand never take leases, so
`[LEASED]` alone misses them); lease it, confirm it with `--check <id> --owner <KEY>`, and pin every run
to it with `--device`, or
lease the whole platform for a run that picks its own devices (`--workers N`, device groups),
as those ground rules describe.
Hold the lease only while you need the device; release it when that work is done
(`… release <target> <KEY>`), and always before you finish or block. Leases expire after
6 hours, so re-run `acquire` (it renews your own lease) before each device-holding launch
— **including immediately before invoking `/qa-this-branch` with `devices=`**, since QA
must not renew a lease it did not take — and never keep one device session (a UI or watch
run) open longer than the 6-hour TTL.
**If `--pick` exits 4**, nothing of that platform is booted: boot one (or let a
single-device run boot its configured device) — that is not "busy". **If none is free**
(`--pick` exits 1: every target in use or leased, or a live session's device unidentified), do device-free work and poll `--pick` every few minutes,
for up to 60 minutes. `acquire --wait` is only for waiting on a specific target that is
`[LEASED]` by another owner — it knows nothing about unleased live sessions and returns 0
at once for them — and run in the background it exits 0 = leased; 4 = still leased by
someone else; 3 = lock fault, not a busy device (retry once; if it recurs, report an
environment problem); 2 = your command was wrong (`--wait` takes whole minutes); 1 =
busy (only without `--wait`). Only exit 0 means you hold the lease. Still no device after
60 minutes: let QA mark those cells UNTESTED `device busy`; if that makes QA `incomplete`,
that is stop rule 5. Before you block or finish, stop any such waiter that is still
running (TaskStop), then release whatever it may have acquired.

## Waiting

Runs have hung for hours on a wait whose event never came or was missed: a review bot's
status sitting at "Review in progress" long after the PR merged, `gh pr checks --watch`
waiting forever on that bot check, a watcher still watching a SHA that a later push
replaced. So **every wait has a deadline**, in every mode:

- **A wait is a background command that ends by itself** — with `WAIT_DONE: …` when the
  thing happened, or `WAIT_TIMEOUT: …` (exit 124) at its deadline. Never a bare
  `--watch`, never an `until` loop without a deadline, and never ending a turn "waiting"
  with no such command running to wake you (a *Context hand-off* is not that: the state
  file records the wait and someone else watches it). Give the Bash call a `timeout` above the
  deadline (the background maximum is 2 hours), so the deadline, not the harness, ends it.
  Recipes: `references/pr-and-ci.md` §Waiting recipes. **Record each wait in the state
  file when you start or re-arm it** (the *Loops* CI line: `watching <what> on <sha>
  since <time>`). That keeps a run that is waiting correctly visibly alive, however long
  the wait (a macOS queue can take hours), to whoever checks on it.
- **A background subagent you wait on is a wait too** (a QA subagent, a `continuation`).
  Its completion notification can be lost and it can hang in a wait of its own, so unless
  a coordinator watches you (`worker`), keep a heartbeat while it runs:
  `for i in $(seq 1 110); do sleep 60; done; echo "WAIT_TIMEOUT: heartbeat"` in the
  background (Bash `timeout` 7200000), re-armed each time it fires. It is about two
  hours because every wake re-caches your whole context, and it is a loop of short
  sleeps because a single long `sleep` has been seen not to fire. On each heartbeat,
  apply the **liveness rule**: the subagent is alive if, within the last 2 hours (longer
  than any wait it legitimately sits in), its transcript changed (the `output_file` its
  Agent call returned: check the modification time with `stat`, never read it) or its
  files did (the state dir, where every wait is recorded as it starts or re-arms, or the
  QA report directory), or the PR moved. Never replace an agent on silence alone:
  message it once to report, and only if nothing changes within 30 more minutes, stop
  it (TaskStop) and follow its failure path (QA: re-run once; a continuation: spawn the
  one fresh continuation). Replace one agent at most twice; after that, report it as an
  environment problem instead of looping. `/review-loop` applies the same rule to its
  reviewer and verifiers, with a shorter window.
- **On waking, for whatever reason, re-read the real state** (`gh pr view`, `gh pr checks`,
  the lease list) before acting. A watcher's last line is a hint: it may describe an old
  head, or the event may have happened while you were busy elsewhere.
- **On `WAIT_TIMEOUT`, diagnose and choose**: re-arm (still making progress), nudge (a
  re-run or re-trigger, once), or record it as an unmet item and go on — never re-arm
  the same wait forever.

| Waiting for | Deadline | On timeout |
|---|---|---|
| CI checks to register after a push | 10 min | `gh run list --branch <branch> --limit 5`: no run for head → close and reopen the PR once (`gh pr close <n> && gh pr reopen <n>`, which re-fires its workflows); still none → infra (below) |
| CI (workflow checks) on one head | 100 min per watch; re-arm up to twice while jobs are moving | macOS jobs (`E2E iOS`) queued for a long time are waiting for the org's 5 macOS slots, not stuck — re-arm, never cancel them (a re-run goes to the back of the queue). Other jobs `queued` over 60 min with no runner, or running far past their usual time → cancel and re-run that run once (`gh run cancel <id>`, then `gh run rerun <id>`); still stuck → infra: tell the user (interactive) or `best-effort` with the evidence (`auto`) |
| a device | as *Devices* says (60 min of polling) | as *Devices* says |
| a human (a re-review, an answer) | do not wait | report it; the gate item stays unmet |

## Context hand-off

Every turn re-reads the whole conversation. By Phase 6 a run's context is typically
300–600k tokens, and from there on most turns are waits: polling CI and iOS E2E.
Waking from an idle wait also re-caches the whole context from scratch. The state file
exists so that a fresh context can pick the work up, and a fresh context costs a small
fraction of that per turn. So once the remaining work is mostly waiting, **hand off
rather than wait in a large context**. This changes who does the work, never what is
done: every review, QA cycle, CI check and gate item still happens, and a hand-off is not
a result.

**The hand-off point.** All of these hold: the last QA verdict is `ready` or
`ready-pending-ci` (or QA was skipped as trivial and recorded), every commit is pushed,
nothing is uncommitted, no `/review-loop` or QA run is in progress, and the next step is
a wait on CI or `E2E iOS` with nothing else left to do. That point recurs:
after the first QA cycle, after a pushed CI or thread fix, after `gh pr ready`. Never hand
off during Phases 0–5.

**How:**

1. Make the state file complete for a reader who has seen nothing else
   (`references/state.md`): phase, head SHA, the *Loops* line for every loop, the *Gate*
   checklist with the items already evidenced on head, every decision, and a **Next**
   line saying what is being waited on and what to do when it ends. *Next* also carries
   the exact `WAITING_ON:` line you return (step 3), written at the end of step 2 once
   its `since` is fixed: the state file, not your return message, is where the
   coordinator reads it when it re-arms a watch or resumes a batch.
2. Finish the review threads (Phase 6): every reply you are going to post is posted.
   Then note the UTC time (`date -u +%Y-%m-%dT%H:%M:%SZ`) and run the thread query once
   more. If anything appeared since your previous query, handle it and repeat this step;
   if handling it needs a code change, this is no longer a hand-off point (back to
   Phase 6). Otherwise that noted time is `WAITING_ON`'s `since`: now write the complete
   `WAITING_ON:` line into *Next*. Your own replies are older than it,
   so they do not wake the watch, and anything posted after your final query is newer, so
   it does. (Do not filter the watch by author instead: the account the workers push as is
   also the one the user reviews with.) Then stop your background waiters (TaskStop) and
   release your device leases.
3. Then, depending on how you are running:
   - **`worker`**: end with `IMPLEMENT_TICKET: handoff` and a `WAITING_ON:` line (*Final
     report*). The coordinator watches the PR and launches a fresh worker when there is
     something to do. It resumes from the state file.
   - **Standalone** (neither `worker` nor `continuation`): once, at the first hand-off
     point, spawn one fresh `general-purpose` subagent (background, no `isolation`) whose
     prompt is: *Invoke the Skill tool with skill `implement-ticket` and args `<your args>
     continuation worktree=<the checkout your branch is in>`, and follow that skill
     exactly. End your final message with the skill's result lines.* It owns the branch
     from then on: do no work on it yourself, and wait for it to finish. When it returns
     `blocked`, ask the user its question (interactive; with `auto` it never blocks) and
     relay the answer with `SendMessage`. Its final result is yours: report it. If it ends
     with an error or without result lines (an account limit, an API failure), re-read the
     state file and spawn one fresh continuation the same way; it resumes from the state
     file. If that one fails too, report `blocked` with what happened (with `auto`:
     `best-effort`, the PR left a draft, the reason in its description).
   - **`continuation`** or **`no-handoff`**: do not hand off. Do the waits yourself.

If you cannot spawn the subagent (the Agent tool is unavailable), carry on yourself and
note it in the state file.

**Resuming after a hand-off** is the ordinary resume (`references/state.md`), with one
rule: trust the state file's loop records. Do not re-read the ticket, re-plan, or re-run
review or QA unless the state file shows code that landed after them, or you are about to
change code yourself (then *When to review and QA* applies as usual).

## Worker mode

With `worker`, you are one of several `implement-ticket` runs coordinated by
`/implement-tickets`. Everything above still applies, with these changes:

- **Stay in your worktree.** Run every git and build command there, with absolute paths
  or `git -C <worktree>` — a subagent's shell can reset its working directory between
  calls, and a command that silently runs in the main checkout lands on the wrong branch. Never touch the main checkout, another worker's worktree, branch or PR.
- **Never ask the user directly.** With `auto`, decide it yourself (*Auto mode*); you
  return only a final result. Without `auto`, any stop-and-ask case (below) becomes a return: write
  the state file (`Phase: blocked (in <the phase you were in>)`), release your device
  leases, and end with the `blocked` result lines and a `QUESTION:` block (Final report).
  The coordinator batches questions and sends you the answer as a message; resume from the
  state file when it arrives. From Phase 6 on it launches a fresh worker instead, with the
  answer in its prompt (*Answer to your QUESTION: …*): take the answer from there, and the
  question from the state file's *Blocked on*.
- **No plan checkpoint**, unless `plan-review`: then stop after Phase 2 and return
  `IMPLEMENT_TICKET: planned` with the plan path; the coordinator replies "go" (with any
  corrections) and you continue from Phase 3.
- **Shared machine.** Builds, devices and CI runners are shared with the other workers:
  lease devices, and keep the push-batching rule strictly — every push costs CI time that
  other workers' PRs are queued behind.
- **Hand off at each hand-off point** (*Context hand-off*), including with `auto`, unless
  you were given `no-handoff`. The coordinator watches your PR while you are handed off
  and launches a fresh worker, saying in its prompt what woke it.
- **Main moves under you.** If the coordinator tells you another PR merged, check
  `gh pr view <n> --json mergeable`: only on `CONFLICTING` fetch, merge `origin/<base>`
  into your branch, and re-run the gate (Phase 7). Otherwise carry on — `main`'s own CI
  tests the combination (*Keeping up with the base* in `references/pr-and-ci.md`).

## When to stop and ask a human

Only these. Everything else you decide, and record the decision in the state file.
With `auto`, not even these: each has an auto-mode decision in *Auto mode* below.

1. **The ticket is ambiguous in a way that changes what gets built** (not how), and
   neither the ticket's comments nor a Playwright precedent settles it. Batch every
   such question into the plan checkpoint.
2. **A public API shape has no Playwright precedent** and the ticket does not specify it.
3. **The ticket is too big for one reviewable PR** — propose the split before building.
4. **A loop will not converge**: `/review-loop` ends in `oscillation`, or keeps hitting
   `max-rounds` without converging (Phase 4); QA cycles hit
   `max-qa`; the same CI job fails for the same branch-caused reason after three fix
   attempts.
5. **`/qa-this-branch` returns `incomplete`** for a reason you cannot remove (device
   busy, environment you must not change), or raises an `open_questions` item that a
   **stated** criterion depends on (a contradiction in the ticket itself).
6. **A human reviewer requests changes you disagree with**, or asks a question only the
   user can answer.
7. **The ticket cannot be read** (no Jira connector, or no access): ask the user to paste
   it; never guess a ticket's content from its key.

Not an immediate stop: a device check that says every target is taken, or that a live
session's device is unidentified. That is "device busy" — follow *Devices* (device-free
work, poll `--pick` for up to 60 minutes). Only if it persists and QA returns
`incomplete` because of it does rule 5 apply.

When you stop, update the state file, say exactly what is blocked and what you need, and
leave the branch pushed and the PR in a coherent state.

## Auto mode

With `auto`, nobody is watching and nobody will answer. **Never ask the user anything**:
no AskUserQuestion, no plan checkpoint, no "shall I…?", no ending a turn to wait for a
reply, no `blocked` result with a `QUESTION:` block. Keep going until one of the final
results below. `auto` combines with `worker`.

It changes **who decides, never what you may do**: *What you may and may not do* still
holds in full — never merge (except per Phase 8 with `merge`), force-push, bypass a check, write to Jira beyond the status and comments,
or disturb a device session you did not start. And it never lowers the gate: a PR is
marked ready only when every Phase 7 item genuinely passes.

**Disclose every decision a human would otherwise have made.** Log each one in the state
file under *Decisions and assumptions*, tagged `[auto]`, and in a **Decisions made in
auto mode** section of the PR description: the question, what you chose, the main
alternative, and why — written so a reviewer can overturn any of them in one read.

Each stop rule becomes a decision:

| Rule | In auto mode |
|---|---|
| 1 ambiguous scope | The most conservative reading that still delivers the ticket's evident purpose. Disclose. |
| 2 API with no Playwright precedent | Design it: the shape closest to Playwright's idioms (naming, an options object, return types, auto-waiting) and to Tapsmith's existing API, and the narrowest surface that meets the ACs — a surface is easier to grow than to take back. Disclose under the PR's decisions section as an **API decision for review**. |
| 3 too big for one PR | Deliver the whole ticket if it can be one PR with one reviewable commit per slice and a description that walks the slices. Only if parts are genuinely separable and the whole would be unreviewable: ship the first coherent part through the gate and list the rest as proposed follow-ups. |
| 4 `/review-loop` `oscillation` | Decide the oscillating finding on its merits, once (review-loop's own rule: pick, then stick), record that verdict in the ledger as `final` with why, and disclose it. Then run `/review-loop` again — it carries the final verdict forward — because a clean round is still required. |
| 4 `/review-loop` not converging | As Phase 4, but instead of asking: result `best-effort`, with the ledger's last unreviewed fixes listed in the PR. |
| 4 QA hits `max-qa` | Allow up to twice `max-qa` cycles in total. Still not `ready` → result `best-effort`. |
| 4 same CI failure after three fixes | Prove flake or infra if you can (a control re-run of the same job on `main`, the flake signatures in memory) and disclose with the evidence; otherwise result `best-effort`. |
| 5 QA `incomplete` | Device busy: keep doing device-free work and polling `--pick` (*Devices*) for up to 60 minutes, then once more for another 60 before re-running QA. Still `incomplete` → result `best-effort`, with QA's UNTESTED cells in the PR. An open question that a stated criterion depends on: take the reading most consistent with the ticket's purpose and Playwright, disclose, carry on. |
| 6 human review | A human reviewer outranks your preference: make the change they ask for unless it would break a stated AC, a test or the project's rules. If it would, reply on the thread with the reason, leave it unresolved, and that gate item fails → `best-effort`. A question only the user can answer: reply with your best answer marked as an assumption. |
| 7 unreadable ticket | Try every Jira connector the session has before giving up. Never guess a ticket's content: none can read it → result `held`, nothing created. |

**Never idle while unfinished** — every wait follows *Waiting* (deadlines, re-check on
wake). A *Context hand-off* is not idling: it hands a recorded wait to the coordinator or
a continuation. Your final message is a report, not an offer: no "want me to…?".

**Final results in auto mode** (in place of `blocked`):

- `ready-to-merge` — the gate passed; the PR is marked ready (unless `leave-draft`).
- `merged` — with `merge`: the gate passed and Phase 8 merged it.
- `ready-stacked` — the gate's first pass (Phase 7) passed on a stacked branch
  (`after=`); the PR stays draft until its dependency merges (*Stacked branches*), so
  iOS E2E has not run on it yet.
- `best-effort` — a PR exists but some gate item cannot be met without a human; it stays
  a **draft**, and the report and PR description list each unmet item and why.
- `held` — nothing to build: the ticket is unreadable, already fixed on `<base>`, or a
  duplicate of an open PR. Say which, with the evidence.

## Stacked branches

With `after=<branch>`, this ticket depends on another ticket's change that has not merged
yet. Build on it rather than wait for a merge nobody in an auto run will do:

- Phase 0: branch from `origin/<after branch>` instead of `origin/<base>`.
- Review and QA diff against the dependency, not `<base>`: pass `base=origin/<after branch>`
  to `/review-loop` and `base=<after branch>` to `/qa-this-branch`, so neither re-reviews
  the other ticket's commits.
- The PR targets `<base>` and stays a **draft**, its description opening with "Depends on
  #<n> — merge that first; until then this diff includes its commits."
- When the dependency merges: `git fetch origin && git merge origin/<base>` (never rebase
  or force-push — the squash-merge's content matches the dependency's commits, so the
  merge resolves; fix any conflict from later changes to the dependency), then re-run the
  gate against `<base>` and mark the PR ready (with `merge`, go on to Phase 8). Until then
  the result is `ready-stacked`.

## Phase 0 — Set up or resume

1. **Resume check first.** Find where the ticket's branch is checked out, if anywhere
   (`git worktree list`, matching the key as below): that checkout's state dir holds the
   state file, and you work there. Look for `<state dir>/state.md` (below), then a
   local or remote branch whose name carries the key as a whole token
   (`git branch -a | grep -iE '(^|[^0-9a-z])pilot-12([^0-9]|$)'` for PILOT-12 — an
   unanchored grep also matches PILOT-120…129),
   then an open PR (`gh pr list --search <KEY> --state open`, keeping only PRs whose title
   or branch carries the exact key — the search also matches PILOT-120…129). If any
   exists, follow
   `references/state.md` to resume from the recorded phase — never start over on top of
   existing work, and never create a second branch or PR for the same ticket.
2. **Clean start.** `git fetch origin` first. The working tree must be clean; if the user
   has uncommitted work in the main checkout, create a worktree
   (`git worktree add "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<branch>" origin/<base>`
   — anchored on the main checkout's root via the common git dir, so it lands in the
   main `.claude/worktrees/` even when run from inside another worktree) instead of
   touching it. Branch from `origin/<base>` (with `after=`, from `origin/<after branch>`) using the naming in
   `references/pr-and-ci.md`. With `worktree=`, the coordinator has already made a
   worktree (detached at `origin/<base>`): create your branch inside it
   (`git -C <worktree> switch -c <branch>`) and do not make another.
3. **Write the state file** in the **state dir**, `<worktree root>/.claude/state/implement-ticket/<KEY>/`
   (git-ignored, and unlike the session scratchpad it survives the session — so a new
   session, or a restarted coordinator, can resume). Format in `references/state.md`;
   keep it current at every phase transition and decision.
4. Unless `no-jira`: move the ticket to **In Progress** (the project's statuses are To Do,
   In Progress and Done; find the transition with `getTransitionsForJiraIssue`). Skip it if
   it is already there.

## Phase 1 — Understand

Follow `references/planning.md` §1. In short: read the whole ticket (description, ACs,
**comments**, linked issues), check it is not already fixed on `<base>` or duplicated by
an open PR, read the code it touches and its existing tests, find the Playwright
equivalent and its exact contract, and for a bug, **reproduce it** — a bug you cannot
reproduce is not ready to fix; say so.

## Phase 2 — Plan (edge cases before code)

Write the plan file (`<state dir>/plan.md`, format in
`references/planning.md` §3):

- **acceptance criteria** — stated, inferred and standing, as `/qa-this-branch` defines
  them, so QA and you are testing against the same list;
- **design** — the approach, the alternatives you rejected and why, and every embedder
  touched (CLAUDE.md's five run paths; prefer a **required** option over an optional one);
- **edge cases** — walk the catalogue in `references/planning.md` §2 and write down each
  that applies. Each one ends as **a test**, **a QA item**, or **explicitly out of scope
  with a reason**. An edge case with none of the three is not planned;
- **test plan** — for each AC and edge case, the lowest tier that can actually cover it
  (`references/tdd.md`), and which will be written first;
- **docs** — `docs/api-reference.md` for any public API change, and any other page whose
  workflow changes;
- **slices** — the order you will build it in, each slice ending green.

**Checkpoint.** Interactive: show the plan summary (ACs, design choice, edge cases, open
questions) and wait for a go-ahead or corrections — this is the one planned pause. If
there are no genuine questions, say so and continue unless the user objects. `auto`:
print the summary and continue.

## Phase 3 — Build, test-first where it fits

Work slice by slice (`references/tdd.md`):

1. Write the test for the slice's behaviour; run it and **watch it fail for the right
   reason** (the assertion, not an import error). For a bug, the first test reproduces it.
2. Write the least code that makes it pass; run it green.
3. Refactor with the tests green; run the package-local checks for what you touched
   (typecheck, lint, unit tests, knip — CLAUDE.md lists them per component).
4. Commit the slice (signed off, `references/pr-and-ci.md`). Do not push yet unless the
   push rules say so.

Where test-first does not fit (docs, CI config, a spike to learn an unknown API, agent
behaviour only an e2e test can see and no device is free), say so in the state file, and
still land the test in the same slice as the code. Nothing ships untested without the
reason written in the PR's "How it was tested".

Update docs in the slice that changes the behaviour, not at the end.

## Phase 4 — Review, then open the PR

When the plan's slices are all built and the package checks are green:

1. **`/review-loop` until clean**, unless the whole change is trivial (*When to review
   and QA*, Phase 5). Pass `commit` so its fixes land as commits, `worktree=<the checkout your
   branch is in>`, `base=origin/<base>` (after a fetch — local `<base>` may be stale, and
   a stale base puts upstream commits in the reviewed diff),
   `intent=<state dir>/plan.md` so its verifiers judge findings against the plan's ACs and
   design choices, and
   `ledger=<state dir>/review-loop/` — the **same** ledger every time, so parallel
   workers never share one, and each later run continues it and carries earlier `final`
   verdicts forward instead of re-arguing them. Leave `max-rounds` at its default. Read
   its outcome word:

   - `clean` → go on. Record the clean round's head SHA in the state file.
   - `max-rounds` → **not done**: the last round's fixes have not been reviewed. If the
     ledger's per-round FIX counts are falling, run it again (it continues the ledger for
     up to another `max-rounds`). If they are flat or rising, or a second consecutive run
     also hits the cap, it is not converging — usually a design problem, not a detail
     one: stop and ask (rule 4).
   - `oscillation` → stop and ask (rule 4).
   - `stopped-by-user` → stop, and report where the loop was left.

   (`auto`: non-convergence and oscillation are decided per *Auto mode*, not asked.)

2. **Push and open a draft PR** (`references/pr-and-ci.md` — title, body, labels), and
   unless `no-jira`, comment its link on the ticket. CI
   only runs on PRs, so the PR exists to get CI going as early as it is worth the runner
   time: once the change is complete and reviewed, not for a half-built skeleton. On a
   draft, CI runs everything except iOS E2E, which waits for the PR to be marked ready
   (Phase 7) because macOS runners are scarce.
3. Start watching CI in the background (`references/pr-and-ci.md` §CI) and move straight
   on to QA — they run in parallel.

## Phase 5 — QA

Run `/qa-this-branch` with `autonomous ticket=<KEY> #<pr> worktree=<the checkout your branch is in> report=<state dir>/qa-<unix-ts>/report.md` (one directory per cycle, so each cycle's evidence stays with its report)
plus the plan's QA items as focus text (focus adds emphasis; it never shrinks QA's
matrix). Always pass `lease-owner=<KEY>` so QA leases under your name — your own
device leases then never block the platform leases QA needs for mode 2 or device groups —
and, if you hold device leases, `devices=<ids>` so QA uses yours first. On later cycles, add `leads=<previous report path>`.

**Run it in a fresh subagent**, not inline: a `general-purpose` Agent (background, no
`isolation`) whose prompt is *Invoke the Skill tool with skill `qa-this-branch` and args
`<the args above>`, and follow it to completion. QA is read-only: never edit, commit or
push. End your reply with its `QA_VERDICT:` and `QA_REPORT:` lines.* QA reads and runs a
great deal, and run inline, all of that would stay in your context and be re-read on
every later turn. Its contract is already a report file plus two result lines, so it
loses nothing by running in a fresh context, and QA that has not seen your reasoning is
also a more independent check. While it runs, leave the branch alone: no edits, commits,
pushes or builds in the worktree. Your CI watch carries on in the background. If you
cannot spawn the subagent, invoke the skill inline and note it in the state file.

If the reply has no `QA_VERDICT:` line (the subagent failed), use the report file if
it was written; otherwise run the QA cycle again, once, before treating it as
`incomplete`. Parse the last two lines of its reply (`QA_VERDICT:` / `QA_REPORT:`), then read the
report file's verdict, blocking findings and open questions (the evidence is there if a
finding needs it), and act:

| Verdict | Do |
|---|---|
| `needs-fixes` | For each blocking finding: add the automated test its card suggests, watch it fail, fix, go green (Phase 3 discipline). Fix cheap minors too; propose tickets for pre-existing bugs. Then decide re-review (below), push, and re-run QA with `leads=`. |
| `incomplete` | Remove the gap if you can (rebuild; release a device *you* hold; wait for one by polling `--pick` as *Devices* says — never kill or disturb a session you did not start), then re-run. If you cannot, stop and ask (rule 5). |
| `ready-pending-ci` | Push if anything is unpushed, then wait for the listed checks (Phase 6) — except `e2e-ios`, which cannot run until Phase 7 marks the PR ready. |
| `ready` | On to Phase 6. |

Every QA run is a full retest — never ask QA to skip anything because a previous cycle
passed it. For each `open_questions` item: resolve it from the ticket if you can. One
about an **inferred** criterion is stop case 1 — take the conservative reading and
disclose it in the PR; one that a **stated**
criterion depends on is rule 5.

### When to review and QA — your call

`/review-loop` and `/qa-this-branch` are tools, not rituals: run them when they can find
something. For each change since the last clean review (or QA), ask: *could a careful
reviewer plausibly find a bug here that the tests would not catch?* — and for QA: *could
this change what a user sees or how a run behaves in a way the tests do not show?*

| Change | Review | QA |
|---|---|---|
| **trivial** — copy, wording or error-message text; a rename; a constant; a test-only tweak (a timeout, an assertion message); a one-line logic change whose effect is obvious and pinned by a test; docs and comments | skip | skip, unless the change shows up only on a device (copy on a screen QA would read) |
| **non-trivial** — control flow, error handling, timing or concurrency, state and lifecycle, public API, anything threaded through the five run paths, a conflict resolution that combines two pieces of logic | `/review-loop` until clean (Phase 4 rules) | re-run if product behaviour changed |

Treat it as non-trivial after all when trivial changes pile up in one area (together they
are not trivial), when the "one-liner" is a second attempt at the same review or QA
finding, or when you hesitated. When in doubt, review: a clean first round is cheap.

Record each skip in the state file (`<sha> — skipped review/QA: trivial, <why>`) and list
them in the PR's "How it was tested", so a reader sees exactly what landed after the last
clean review and why.

Batch first: collect a QA cycle's fixes (or a round of CI and thread fixes), then run one
`/review-loop` over all of them if any is non-trivial, then push once.

After `max-qa` cycles without `ready`/`ready-pending-ci`, stop and ask (rule 4) —
with `auto`, follow *Auto mode* for rules 4 and 5.

## Phase 6 — CI and review threads

Work these until both are clean (`references/pr-and-ci.md` has the commands). Whenever
what is left is a wait, that is a hand-off point (*Context hand-off*):

- **CI** — every check on the PR's **head SHA** green, including `E2E Android`, not just
  the required DCO check. `E2E iOS` reads *skipped* while the PR is a draft; it runs
  once Phase 7 marks the PR ready. A red job: read the failed log, decide
  branch-caused vs flake vs infra, and act (fix test-first; re-run failed jobs once for a
  flake with evidence; never paper over).
- **Review threads** — from humans, and from whatever review bot the repo has installed
  at the time (*Review bots* in `references/pr-and-ci.md`). Triage each
  unresolved thread like a review-loop card: fix it (with a test if it is a behaviour
  change), or reply with the reason it is not being changed. Resolve threads you fixed;
  leave a human's thread for the human unless they asked you to resolve it.

**Batch your pushes.** Each push cancels the in-flight E2E run (`cancel-in-progress`), so
collect fixes and push once, then wait. Once the PR is ready, every push also starts a
new iOS E2E run on the scarce macOS runners, so batching matters even more there. Any code change pushed here goes through
*When to review and QA* (Phase 5) first.

## Phase 7 — The ready-to-merge gate

All of these, checked on the current head SHA, and written into the state file as a
checklist with evidence:

- [ ] every AC in the plan is met or explicitly descoped in the PR with a reason;
- [ ] every planned edge case is tested, QA'd, or listed as out of scope in the PR;
- [ ] the last `/qa-this-branch` verdict is `ready` or `ready-pending-ci`, and every
      change since it is a recorded QA skip (*When to review and QA*) — otherwise re-run it;
      for a ticket that is trivial throughout, the recorded skip stands in for QA;
- [ ] the last `/review-loop` run ended `clean`, and every change in
      `git diff <its clean-round SHA>..HEAD` is a recorded trivial skip or a conflict-free
      merge of `<base>` (for a ticket that is trivial throughout, the recorded skip stands
      in for the loop). `max-rounds` never passes this item;
- [ ] every CI check on head is green, the `CI` and `E2E Android` workflows actually ran
      on head (zero checks is not green), and no job is green only because a step is
      advisory;
- [ ] `E2E iOS` ran on head **after the PR was marked ready** and passed — or never runs
      for this PR because it touches none of the workflow's `paths` (there is no `E2E iOS`
      run for head at all, not even a skipped draft one; say so in the PR);
- [ ] no unresolved review thread you can act on; no outstanding "changes requested";
- [ ] the branch merges cleanly into `<base>` (merge `<base>` in if not, then re-check);
- [ ] every commit is signed off; the package checks pass locally;
- [ ] `docs/api-reference.md` and other affected docs are updated;
- [ ] the PR title and description are final and accurate (`references/pr-and-ci.md`) —
      what changed, how it was tested (tiers, QA verdict and its not-tested list), known
      limitations, assumptions, and follow-ups.

`E2E iOS` skips drafts, so check the gate in two passes:

1. **Every item but `E2E iOS`.** When they all hold — and only then, so iOS runs on a
   head you expect to merge — mark the PR ready (`gh pr ready <n>`; a no-op once it is
   ready, after a pass-2 fix). With `leave-draft`, stop here
   instead: the PR stays a draft and the report lists iOS E2E as not run (it starts when
   someone marks the PR ready). A `ready-stacked` or `best-effort` PR also stops here.
2. **`E2E iOS` on head.** Wait for it (`references/pr-and-ci.md` §Waiting recipes, *E2E
   iOS after ready*). A red job is Phase 6 work as usual — the PR stays ready, and any fix
   re-opens pass 1 for what it touched. Threads posted meanwhile (a review bot may review
   only once the PR is ready) are Phase 6 work too. The gate passes when
   pass 1 still holds on the head where `E2E iOS` went green. Unless `no-jira`: comment the result on the ticket
(ready to merge, or what is still open) and leave it **In Progress** — the project has no
review status, and **Done** means merged — that happens in Phase 8 with `merge`, or when
you see the PR merged during the run (e.g. relayed by `/implement-tickets`).

## Phase 8 — Merge (only with `merge`)

`merge` is the user's standing approval to merge this PR **once the Phase 7 gate passes on
its head** — never a `best-effort`, `ready-stacked` or `blocked` PR, and never with
`--admin` or anything else that bypasses a required check or ruleset.

1. **Re-check right before merging**, on the PR as GitHub sees it now:
   `gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,reviewDecision,isDraft`.
   The head must be the SHA the gate passed on; no "changes requested"; no new
   unresolved thread since the gate (re-run the Phase 6 thread query).
2. **No conflict with the base.** Do not merge `origin/<base>` in just because it has
   moved: that push re-runs every workflow on the PR, and `main`'s own CI tests the
   combination after the squash-merge. Only if GitHub reports a conflict
   (`mergeable: CONFLICTING`) merge it in (Keeping up with the base), push, and run the
   gate again on the new head.
3. **Merge**, pinned to the gated head so nothing pushed in between slips through:

   ```bash
   gh pr merge <n> --squash --match-head-commit <gated sha>
   ```

   The repo squash-merges (subject `<PR title> (#<n>)`, gh's default). Do not pass
   `--delete-branch` — the branch stays; a human can delete it. If GitHub refuses the merge
   (a ruleset, a required review), do not work around it: report why, and finish
   `ready-to-merge`.
4. **After the merge:** confirm `gh pr view <n> --json state,mergeCommit` says `MERGED`;
   unless `no-jira`, move the ticket to **Done** and comment the merge commit; release any
   device leases; record it in the state file (`Phase: done`). Leave the worktree in place
   (it holds the state dir).

## Final report

Plain text in your reply (structured-findings tools do not render in this terminal):
the PR link and state, the gate checklist with evidence pointers, what was assumed or
descoped, pre-existing bugs and proposed follow-up tickets, and anything a human must
decide before merging. End with:

```
IMPLEMENT_TICKET: <merged|ready-to-merge|ready-stacked|best-effort|held|blocked|planned|handoff|stopped-by-user>
PR: <url or none>
STATE: <absolute path to state.md>
```

`ready-stacked`, `best-effort` and `held` are `auto`-mode results (*Auto mode*); `auto`
never returns `blocked` or `planned`. `handoff` is a `worker`'s interim return at a
hand-off point (*Context hand-off*). It is not a final result, and it ends with one more line:

```
WAITING_ON: <ci | e2e-ios | ci e2e-ios> on <full 40-character head SHA, from `git rev-parse HEAD`> since <UTC time noted just before your final thread query, e.g. 2026-10-26T14:05:00Z>
```

For a `handoff`, the report is just the result lines and one sentence on where things stand. When `blocked`, follow with the question, written so it can be answered without reading
anything else:

```
QUESTION: <the decision needed, one paragraph, with the context that makes it answerable>
OPTIONS: <a) … (recommended) | b) … | c) …>
DEFAULT: <what you will do if told "use your default">
```

Save durable lessons (a new environment trap, a CI flake signature, a design rule a
reviewer taught you) to memory. Not the ticket's status — that lives in the PR.
