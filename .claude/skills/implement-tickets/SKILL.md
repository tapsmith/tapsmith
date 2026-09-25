---
name: implement-tickets
description: Implement several Jira tickets in parallel, each on its own branch, worktree and PR, until every PR is ready to merge. Plans the batch first (overlaps, dependencies, tickets to combine or split), then runs one /implement-ticket worker per ticket — background subagents by default, or background Claude sessions — with a parallelism cap, machine-wide device leases, one batched channel for the workers' questions, and re-gating after merges. Never merges. Resumable. Use when asked to implement, work through or parallelise several tickets at once (e.g. "/implement-tickets PILOT-12 PILOT-15 PILOT-19").
---

# implement-tickets

You are the **coordinator**. You do not implement tickets; `/implement-ticket` does, one
worker per ticket, and each worker already knows how to take its ticket to a
ready-to-merge PR. Your job is what no single worker can see: which tickets collide,
which must wait for which, how many can run at once on one machine and one CI budget,
and how to get the user's decisions to the workers without interrupting the user five
times.

Nothing here relaxes a worker's own rules. Workers never merge; neither do you.

## Arguments

| token | meaning | default |
|---|---|---|
| `PILOT-12 PILOT-15 …` | the tickets | required (or `jql=`) |
| `jql="<query>"` | take the tickets from a Jira search instead | — |
| `max-parallel=<n>` | workers running at once | `3` |
| `sessions` | run workers as background Claude sessions instead of subagents (see *Worker hosts*) | subagents |
| `autonomous` | skip the batch checkpoint and plan reviews | interactive |
| `jira`, `leave-draft`, `max-qa=<n>` | passed through to every worker | worker defaults |
| `base=<ref>` | base for every ticket, passed through to every worker. CI only runs on PRs to `main`, so a non-main base is a stop-and-ask for the whole batch before any worker starts | `main` |

## Why the parallelism cap is low

Each worker builds the SDK, possibly the Rust daemon and an agent, in its own worktree
(gigabytes each; builds contend for CPU), leases devices for device tests and QA, and
opens a PR whose CI runs ten device-E2E shards, five of them on macOS runners that are
the scarce resource. Past about three workers, parallel tickets mostly queue behind each
other. Raise `max-parallel` only for batches that are mostly device-free.

## The coordinator's state

`<main checkout>/.claude/state/implement-tickets/<batch-id>.md` (git-ignored; survives
the session). `<batch-id>` is the start date plus the keys sorted numerically, e.g.
`2026-09-25-PILOT-12-15-19`. Update it on every event.

```markdown
# implement-tickets — <batch-id>
- Mode: interactive | autonomous · host: subagents | sessions · max-parallel: <n>
- Pass-through flags: <…>

| Ticket | Lane | Worktree | Worker | Phase | PR | Result | Waiting on |
|---|---|---|---|---|---|---|---|
| PILOT-12 | parallel | .claude/worktrees/pilot-12 | <agent id / session name> | 5-qa | #251 | — | — |
| PILOT-15 | after PILOT-12 | — | — | queued | — | — | PILOT-12 merged |

## Batch plan
<lanes and the reason for each>

## Questions
- <time> PILOT-19: <question> → <answer, when given>

## Events
- <time> <event>
```

## Phase 0 — Resume or start

If a coordinator state file exists for these keys (match on the keys part of the name,
`*-<sorted keys>.md` — the date prefix is the start date, not today's), or any ticket already has a worktree,
branch or PR, **resume**: rebuild the table from the state file and from reality (each
ticket's worktree state file at `<worktree>/.claude/state/implement-ticket/<KEY>/state.md`,
its branch, its PR). Workers from an earlier session are gone, so re-launch any ticket
that is not `ready-to-merge` — `implement-ticket` resumes from its own state. Never start a
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

Also check machine and CI capacity: how many tickets need devices (and which platform),
and whether the device pool can serve `max-parallel` workers at once.

**Checkpoint** (interactive): show the lane table with reasons, plus every question you
already know the tickets raise, and wait once. Autonomous: take the conservative option
(serial rather than parallel when unsure; hold rather than combine), record it, go on.

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
   — `plan-review` in interactive mode, so the user approves every plan in one batch.
3. Record the worker's id/name, and move on. Launch all ready workers in one message so
   they start together.

A slot is a worker that is **building**: `max-parallel` caps building workers, not
started ones. A worker that returns `ready-to-merge`, `blocked` or `planned` is idle
and frees its slot. A ready worker may need resuming later (another PR merged: it must
merge `main` and re-run its gate); until it has, report it as `ready (stale vs main)`,
never plain `ready`. Resuming an idle
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
> `QUESTION:`/`OPTIONS:`/`DEFAULT:`/`DEFAULT_SAFE:` when blocked).

You are notified when each worker stops. To answer or instruct a stopped worker, send it
a message with `SendMessage` (its agent id is in the tool result; keep it in the state
file) — it resumes with its context intact. Subagent workers can spawn their own
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
| `blocked` | Add its question to the pending list. When no running worker is likely to add another soon, ask the user all pending questions at once (interactive; AskUserQuestion takes up to four per call, with each worker's `OPTIONS` and recommended `DEFAULT`). Autonomous: answer from the ticket, its comments and Playwright precedent where they settle it; otherwise reply "use your default" **only if the worker said `DEFAULT_SAFE: yes`**. A `DEFAULT_SAFE: no` question stays unanswered: the ticket is `held`, its slot is freed, and the question goes in the final report for the user. Relay each answer to its worker and record it. |
| `ready-to-merge` | Record the PR; tell the user it can be merged. Start the next queued ticket. |
| `stopped-by-user` / error / no result lines | Read its state file; re-launch it once (it resumes); if it fails again, mark it held and tell the user. |

Between events, keep an eye on the batch:

- **Merges.** When a PR in the batch merges (`gh pr view <n> --json state`), tell every
  other worker with an open PR: "`<KEY>`'s PR merged; fetch, merge `origin/<base>`, re-run
  your gate." Start any ticket whose lane was `after <KEY>`.
- **Cross-ticket conflicts.** If two workers turn out to touch the same file after all
  (`git diff --stat` in each worktree), pause the later one with a message, and move it to
  a serial lane.
- **Devices.** `device-lease.sh list` (qa-this-branch scripts) shows who holds what; an
  expired lease is reaped automatically. A worker waiting on a device for hours means the
  pool is too small for the batch — lower parallelism for device-heavy tickets.

Print a one-screen status table to the user whenever something changes state, not on a
timer.

## Phase 4 — Finish

The batch is done when every ticket is `ready-to-merge` or `held` with a reason. Print:
the table (ticket → PR → state), what the user must decide or merge and in which order
(dependencies first), the questions answered on their behalf, and follow-ups the workers
proposed. Clean up only what is safe: device leases your workers left behind — owners
`<KEY>` and the QA runs they started, `qa:<their branch>:*` (`device-lease.sh list` shows
owners; `release` each with its exact owner) — never a worktree whose PR is still open. End with:

```
IMPLEMENT_TICKETS: <ready>/<total> ready-to-merge, <held> held
PRS: <url> <url> …
```

Save durable lessons about running batches (capacity, a collision pattern) to memory —
not the batch's status, which lives in the PRs.
