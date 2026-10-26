---
name: implement-tickets
description: Implement several Jira tickets in parallel, each on its own branch, worktree and PR, until every PR is ready to merge. Plans the batch first (overlaps, dependencies, tickets to combine or split), then runs one /implement-ticket worker per ticket — background subagents by default, or background Claude sessions — with a parallelism cap, machine-wide device leases, one batched channel for the workers' questions, and re-gating after merges. Never merges unless given `merge` (then each worker merges its own PR once its gate passes). Resumable. With `auto`, runs the whole batch without asking the user anything, stacking dependent tickets instead of waiting for merges. Use when asked to implement, work through or parallelise several tickets at once (e.g. "/implement-tickets PILOT-12 PILOT-15 PILOT-19").
---

# implement-tickets

You are the **coordinator**. You do not implement tickets; `/implement-ticket` does, one
worker per ticket, and each worker already knows how to take its ticket to a
ready-to-merge PR. Your job is what no single worker can see: which tickets collide,
which must wait for which, how many can run at once on one machine and one CI budget,
and how to get the user's decisions to the workers without interrupting the user five
times.

Nothing here relaxes a worker's own rules. Workers merge only with `merge`, each its own PR
after its own gate (implement-ticket Phase 8); you never merge anything yourself.

## Arguments

| token | meaning | default |
|---|---|---|
| `PILOT-12 PILOT-15 …` | the tickets | required (or `jql=`) |
| `jql="<query>"` | take the tickets from a Jira search instead | — |
| `max-parallel=<n>` | workers running at once | `3` |
| `sessions` | run workers as background Claude sessions instead of subagents (see *Worker hosts*) | subagents |
| `auto` | never ask the user anything until the batch is finished: no checkpoint, no plan reviews, no question batches; every worker runs with `auto`, and dependent tickets are stacked instead of waiting for merges — see *Auto mode* | interactive |
| `merge` | passed through: each worker squash-merges its PR once its gate passes; dependent tickets then wait for the real merge instead of stacking | a human merges |
| `no-jira`, `leave-draft`, `max-qa=<n>` | passed through to every worker | worker defaults (Jira updates on) |
| `base=<ref>` | base for every ticket, passed through to every worker. Every workflow runs on a PR to any base | `main` |

## Why the parallelism cap is low

Each worker builds the SDK, possibly the Rust daemon and an agent, in its own worktree
(gigabytes each; builds contend for CPU), leases devices for device tests and QA, and
opens a PR whose CI runs eight device-E2E shards, three of them on macOS runners that are
the scarce resource (5 concurrent jobs org-wide; iOS E2E waits until the PR leaves draft).
Past about three workers, parallel tickets mostly queue behind each other. Raise
`max-parallel` only for batches that are mostly device-free.

## The coordinator's state

`<main checkout>/.claude/state/implement-tickets/<batch-id>.md` (git-ignored; survives
the session). `<batch-id>` is the start date plus the keys sorted numerically, e.g.
`2026-09-25-PILOT-12-15-19`. Update it on every event.

```markdown
# implement-tickets — <batch-id>
- Mode: interactive | auto · host: subagents | sessions · max-parallel: <n>
- Pass-through flags: <…>

| Ticket | Lane | Worktree | Worker | Phase | PR | Result | Waiting on |
|---|---|---|---|---|---|---|---|
| PILOT-12 | parallel | .claude/worktrees/pilot-12 | <agent id / session name> | 5-qa | #251 | — | — |
| PILOT-15 | after PILOT-12 | — | — | queued | — | — | PILOT-12 merged |
| PILOT-19 | parallel | .claude/worktrees/pilot-19 | — (handed off) | handoff | #253 | — | ci coderabbit on abc123 (watch <task id>) |

## Batch plan
<lanes and the reason for each>

## Questions
- <time> PILOT-19: <question> → <answer, when given>

## Events
- <time> <event>
```

## Auto mode

With `auto`, the user has handed over every decision for the whole batch. **Never ask the
user anything** — no AskUserQuestion, no checkpoint, no batched questions, no ending a
turn to wait for a reply — until Phase 4's final report. It never widens what anyone may
do (workers merge only with `merge`; you never do), and it never lowers a worker's gate.

- **Workers run with `auto`** and decide their own stop cases (implement-ticket *Auto
  mode*), so they return only final results. If one returns `blocked` anyway, do not ask
  the user: reply "auto mode: decide this yourself per implement-ticket's *Auto mode*,
  disclose it in the PR, and continue".
- **Your own decisions** (lanes, combining, parallelism, re-launches) go in the state
  file's *Events*, tagged `[auto]`, and in the final report.
- **Dependent tickets are stacked**, not left waiting for a merge nobody will do (Phase 1)
  — with `merge`, they wait for the real merge instead.
- **Never idle while the batch is unfinished** — keep the *Heartbeat* running (Phase 3).
  When the only thing left is a human merging, finish the batch (Phase 4) instead of
  waiting: a later `/implement-tickets` run resumes it.

## Phase 0 — Resume or start

If a coordinator state file exists for these keys (match on the keys part of the name,
`*-<sorted keys>.md` — the date prefix is the start date, not today's), or any ticket already has a worktree,
branch or PR, **resume**: rebuild the table from the state file and from reality (each
ticket's worktree state file at `<worktree>/.claude/state/implement-ticket/<KEY>/state.md`,
its branch, its PR). Workers from an earlier session are gone, so re-launch any ticket
that is not `ready-to-merge` — `implement-ticket` resumes from its own state — except a
ticket whose last result was `handoff`: re-arm its hand-off watch (Phase 3) from the
state file's *Next* line instead, and launch a worker only when the watch ends. Never start a
second worktree, branch or PR for a ticket.

## Phase 1 — Plan the batch

For every ticket, a quick read — not the worker's full plan: summary, type, acceptance
criteria, comments, links, and the code areas it will touch (grep the modules the
description names). Then decide a **lane** for each:

- **parallel** — independent of the others.
- **after <KEY>** — it depends on another ticket's change (a Jira "is blocked by" link,
  or it builds on code the other one introduces). Do not stack branches: squash merges
  make stacked PRs conflict. The dependent ticket waits until the other PR has
  **merged**, then starts from the new `main`. Tell the user which merge unblocks it.
- **serial with <KEY>** — both change the same files or the same behaviour (e.g. two
  tickets in `runner.ts` or `app-reset.ts`). Parallel branches there mean merge
  conflicts and, worse, two designs for one mechanism. Run them one after the other.
- **combine with <KEY>** — really one change (one root cause, one PR's worth). Propose
  combining; one worker takes both: `/implement-ticket <primary KEY> also=<other KEY> …`
  (implement-ticket reads every key's ticket, and its state and branch are keyed on the
  primary). Record the pairing in the coordinator state so a resume finds both.
- **hold** — too big for one PR, too unclear to start, already fixed, or a duplicate. Say
  why and what would unblock it.

**Auto mode lanes.** `hold` only for a ticket that is already fixed, a duplicate, or
unreadable — a big or unclear ticket goes to a worker, which splits or decides it
(implement-ticket's *Auto mode*). `after <KEY>` and `serial with <KEY>` become
**stacked on <KEY>**: start the ticket once `<KEY>`'s worker returns `ready-to-merge`,
`ready-stacked` or `best-effort`, from a worktree detached at `<KEY>`'s branch head
(`git worktree add --detach <path> origin/<KEY's branch>`), and pass the worker
`after=<KEY's branch>`. A chain stacks in order; never stack on a `held` ticket — its
dependants are held too, with that reason.

**With `merge`, dependants wait for the merge instead.** The dependency's worker merges
it when its gate passes, so start an `after`/`serial` ticket from the new `origin/<base>`
once `<KEY>` returns `merged` — no stacking. Only if `<KEY>` ends without merging
(`ready-to-merge` because GitHub refused, `best-effort`) do its dependants stack on it as
above (`auto`), or wait for the user (interactive).

Also check machine and CI capacity: how many tickets need devices (and which platform),
and whether the device pool can serve `max-parallel` workers at once.

**Checkpoint** (interactive): show the lane table with reasons, plus every question you
already know the tickets raise, and wait once. `auto`: take the conservative option
(serial rather than parallel when unsure; separate rather than combine), record it, go
on.

## Phase 2 — Launch workers

For each ticket that is ready to start, up to `max-parallel` running at once:

1. **Create its worktree** from the up-to-date base, detached (the worker creates and
   names its own branch):

   ```bash
   git fetch origin
   git worktree add --detach "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.claude/worktrees/<key-lowercase>" origin/<base>
   ```
2. **Start the worker** on its host (below) with:
   `/implement-ticket <KEY> worker worktree=<absolute worktree path> base=<base> [also=<KEY>] [plan-review] [pass-through flags]`
   — `plan-review` in interactive mode, so the user approves every plan in one batch;
   `auto` (never `plan-review`) in auto mode, plus `after=<branch>` for a stacked ticket.
3. Record the worker's id/name, and move on. Launch all ready workers in one message so
   they start together.

A slot is a worker that is **building**: `max-parallel` caps building workers, not
started ones. A worker that returns `ready-to-merge`, `blocked`, `planned` or `handoff` is idle
and frees its slot. A ready worker may need resuming later (another PR merged and its
PR now conflicts: it must merge `main` and re-run its gate); until it has, report it as
`ready (conflicts with main)`, never plain `ready`. Resuming an idle
worker (relaying "go" or an answer) needs a free slot like starting a new one does —
resume in lane order, and queue the rest until slots free. Fill free slots from the
queue in lane order.

## Worker hosts

**Subagents (default).** An `Agent` call per worker — `general-purpose`, **no** `isolation`
(you made the worktree), running in the background — whose prompt is:

> Invoke the Skill tool with skill `implement-ticket` and args
> `<KEY> worker worktree=<path> …`, and follow that skill exactly. You are a worker in a
> batch coordinated by another agent; never ask the user anything directly. End your
> final message with the skill's result lines (`IMPLEMENT_TICKET:`, `PR:`, `STATE:`, and
> `QUESTION:`/`OPTIONS:`/`DEFAULT:` when blocked, `WAITING_ON:` on a hand-off).

You are notified when each worker stops. To answer or instruct a stopped worker, send it
a message with `SendMessage` (its agent id is in the tool result; keep it in the state
file) — it resumes with its context intact. That suits a worker still in Phases 1–5,
whose context is worth keeping. **From Phase 6 on** (the state file's `Phase:` line),
launch a **fresh worker** instead: a new `Agent` call with the same prompt plus one line
saying why (*Woken by: …*, *Answer to your QUESTION: …*, *Main moved: …*, *Resume after
an infra stop*). It resumes from the state file. A late-phase worker's context is
300–600k tokens, and messaging it re-caches all of that before it does anything
(implement-ticket *Context hand-off*). Never message a worker that returned `handoff`.
Its successor is the next fresh worker. Subagent workers can spawn their own
subagents (review-loop's reviewer) and load project skills; this was verified. They end
with this session, so a long batch should be resumable, and is (Phase 0).

**Background sessions (`sessions`).** Each worker is a full top-level Claude session that
outlives this one and that the user can `claude attach` to. Launching them from here is
blocked by auto mode's safety classifier unless the user has added a Bash allow rule for
`claude --bg`. Without that rule, **print one launch command per ticket for the user to
run**, then track them:

```bash
cd <main checkout> && claude --bg -n <KEY> --permission-mode auto \
  "/implement-ticket <KEY> worker worktree=<absolute worktree path> …"
claude agents --json        # find each worker by its name; state, id
claude logs <id>            # recent output — look for the IMPLEMENT_TICKET lines
```

Message a session worker with `SendMessage` to its name (`ListAgents` lists local
sessions). This host has not been exercised end to end yet: the first time it is used,
verify the listing, logs and messaging steps and correct this section.

## Phase 3 — Run the batch

On every worker stop, read its result lines, update the table, then act:

| Result | Do |
|---|---|
| `planned` | Collect plans until every started worker has one (or a few minutes pass), then show them together: per ticket, the ACs, design choice, edge cases and open questions. Relay "go" with any corrections to each. |
| `blocked` | Add its question to the pending list. When no running worker is likely to add another soon, ask the user all pending questions at once (AskUserQuestion takes up to four per call, with each worker's `OPTIONS` and recommended `DEFAULT`). Relay each answer to its worker and record it. `auto`: never ask — see *Auto mode*. |
| `merged` (`merge`) | Record the merge commit; treat it as a merge (*Merges* below). Start the next queued ticket and any ticket waiting on this one. |
| `ready-to-merge` | Record the PR; tell the user it can be merged (with `merge`: say why the worker could not). Start the next queued ticket. |
| `ready-stacked` / `best-effort` / `held` (auto) | Record it and its reason; free the slot. Start any ticket stacked on it (not on a `held` one). |
| `handoff` | Not a result: the worker is waiting for something listed in `WAITING_ON`. Record that and the head SHA, free the slot, and start a **hand-off watch** for its PR: implement-ticket's `references/pr-and-ci.md` §*Hand-off watch*, in the background (Bash `timeout` 7200000), one per PR. When it ends (`WAIT_DONE` or `WAIT_TIMEOUT`), launch a fresh worker (*Worker hosts*) with *Woken by: <the watch's last line>*. Relaunches take the next free slot ahead of new tickets, since they are nearest to done. |
| `stopped-by-user` / error / no result lines | Read its state file; re-launch it once (it resumes); if it fails again, mark it held and tell the user. |

Between events, keep an eye on the batch:

- **Heartbeat.** Worker notifications can be missed, and a worker can hang in a wait
  of its own. While any worker is running, keep one background heartbeat going —
  `sleep 1800; echo "WAIT_TIMEOUT: heartbeat"` (Bash `timeout` above 30 min) — and
  re-arm it each time it fires. On every wake, whatever woke you, re-read reality: each
  worker's state file, branch head and PR (`gh pr view <n> --json state,headRefOid`).
  Every handed-off ticket must have its hand-off watch running; re-arm any that is not.
- **Silent workers.** (A handed-off ticket has no worker running; its watch's deadline
  covers it.) A worker that has not returned, not changed its state file
  (`<worktree>/.claude/state/implement-ticket/<KEY>/state.md` mtime) and not pushed for
  **2 hours** is probably stuck in a wait: message it to report its phase and re-check
  what it is waiting for (implement-ticket *Waiting*). From Phase 6 on, stop it
  (TaskStop) and launch a fresh worker instead of messaging it (*Worker hosts*). No change within 30 more minutes →
  stop it (TaskStop) and re-launch it once; it resumes from its state file. A second
  hang → mark it held and say so.

- **Merges.** Without `merge`, nobody in the batch merges; still poll, since the user may.
  When a PR in the batch merges (`gh pr view <n> --json state`), check the other open
  PRs' `mergeable`: only a worker whose PR now **conflicts** merges `origin/<base>` and
  re-runs its gate. A handed-off ticket's watch already ends on `CONFLICTING`, so it needs
  no message. Don't send the others round CI again just because `main` moved —
  `main`'s own CI on each merge commit tests the combination. Watch that run (`gh run list
  --branch main --commit <sha>`); if it goes red, find the PR whose change broke it and
  have that worker (or a new one) fix forward on a new PR. `E2E iOS` cancels an older
  `main` run when a newer merge lands, so a `cancelled` run there is neither a failure
  nor something to wait for: watch the newest `main` commit's run instead, which tests
  every merge since the last green one — if it goes red, the culprit is among those. Start any ticket whose lane was
  `after <KEY>`. A worker stacked on `<KEY>` merges `origin/<base>` (implement-ticket
  *Stacked branches*) and re-gates. Unless `no-jira`, move the merged ticket to **Done**
  (statuses are To Do, In Progress, Done) if it is not there already (a `merge` worker
  does this itself).
- **Cross-ticket conflicts.** If two workers turn out to touch the same file after all
  (`git diff --stat` in each worktree), pause the later one with a message, and move it to
  a serial lane.
- **Devices.** `device-lease.sh list` (qa-this-branch scripts) shows who holds what; an
  expired lease is reaped automatically. A worker waiting on a device for hours means the
  pool is too small for the batch — lower parallelism for device-heavy tickets.

Print a one-screen status table to the user whenever something changes state, not on a
timer.

## Phase 4 — Finish

The batch is done when every ticket is `merged`, `ready-to-merge` or `held` with a
reason — in auto mode, when every ticket has a final result (`merged`, `ready-to-merge`,
`ready-stacked`, `best-effort` or `held`); report stacked PRs with the merge order they need. Print:
the table (ticket → PR → state), what the user must decide or merge and in which order
(dependencies first), the questions answered on their behalf, and follow-ups the workers
proposed. Clean up only what is safe: device leases your workers left behind — owners
`<KEY>` and the QA runs they started, `qa:<their branch>:*` (`device-lease.sh list` shows
owners; `release` each with its exact owner) — never a worktree whose PR is still open. End with:

```
IMPLEMENT_TICKETS: <total> tickets: <merged> merged, <ready> ready-to-merge, <stacked> ready-stacked, <best-effort> best-effort, <held> held
PRS: <url> <url> …
```

Save durable lessons about running batches (capacity, a collision pattern) to memory —
not the batch's status, which lives in the PRs.
