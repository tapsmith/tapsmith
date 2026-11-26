---
name: implement-tickets
description: Implement several Jira tickets in parallel, each on its own branch, worktree and PR, until every PR is ready to merge. Plans the batch first (overlaps, dependencies, tickets to combine or split), then runs one /implement-ticket worker per ticket — background subagents by default, or background Claude sessions — with a parallelism cap, machine-wide device leases, one batched channel for the workers' questions, and re-gating after merges. Picks each worker's model by the ticket's difficulty (Sonnet or Opus, escalating to Opus when a Sonnet worker struggles, and to a Fable consult only when Opus is stuck), and cleans up after merged PRs (worktrees, local branches, DerivedData, leftover processes and sessions); `cleanup` does only that. Never merges unless given `merge` (then each worker merges its own PR once its gate passes). Resumable. With `auto`, runs the whole batch without asking the user anything, stacking dependent tickets instead of waiting for merges. Use when asked to implement, work through or parallelise several tickets at once (e.g. "/implement-tickets PILOT-12 PILOT-15 PILOT-19").
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
| `model=<auto\|opus\|sonnet>` | the workers' model: `auto` picks per ticket (*Models*); a model name forces it for every worker, with no escalation from it | `auto` |
| `fable=<ask\|auto\|off>` | whether an Opus worker that is stuck gets a one-off consult from Fable (*Models*). `ask` puts it in the next question batch | `ask` (interactive), `off` (`auto`) |
| `cleanup` | do nothing else: clean up every merged ticket's worktree and branch (*Cleanup*) and report | — |
| `base=<ref>` | base for every ticket, passed through to every worker. Every workflow runs on a PR to any base | `main` |

## Why the parallelism cap is low

Each worker builds the SDK, possibly the Rust daemon and an agent, in its own worktree
(gigabytes each; builds contend for CPU), leases devices for device tests and QA, and
opens a PR whose CI runs eight device-E2E shards, three of them on macOS runners that are
the scarce resource (5 concurrent jobs org-wide; iOS E2E waits until the PR leaves draft).
Past about three workers, parallel tickets mostly queue behind each other. Raise
`max-parallel` only for batches that are mostly device-free.

## Models

**Workers do the work, Opus judges it.** `/review-loop`'s verifiers always run on Opus
and its reviewer defaults to Opus, and implement-ticket pins its QA subagent to Opus. A
worker on a cheaper model is held to exactly the same gate: model choice changes what the
work costs, never the bar. Never cut review rounds, QA cycles or gate steps to save
tokens. If the budget is tight, pause or defer tickets instead.

**Tiers** (`model=auto`, decided in Phase 1 with a one-line reason):

- **opus** if the ticket touches the daemon (`packages/tapsmith-core`), either agent,
  `proto/` or the trace format; spans both platforms; involves concurrency, device timing,
  process lifecycle or app reset; adds public API with no Playwright precedent; or is a
  bug whose root cause is not yet known. **When unsure, opus.**
- **sonnet** for docs, error messages and hints, CLI and config plumbing, test-only
  changes, and small fixes inside one SDK area whose cause the ticket already names.
- Never haiku for a worker. **Fable is never a worker tier**: it is far more expensive
  per token, and a worker's context reaches hundreds of thousands of tokens. It is used
  only as a consult (below).

**Re-picking at relaunch** (`model=auto` only; a forced `model=` is used for every
launch). A fresh worker (Phase 6 on, subagent host) gets its model for the job it is
woken for:
- **sonnet** for a mechanical wake, whatever the ticket's starting tier, unless the
  ticket has escalated (then opus: an escalated ticket never steps back down): CI green
  and only the gate to re-run, bot or nit threads, a merge after the gate passed.
- **The ticket's tier** for a wake that needs judgment: a red CI run that is not a
  known flake, a conflict with the base, a human review asking for changes, an answer
  that changes the design, or a QA re-run's findings.

When unsure, use the ticket's tier. A sonnet relaunch of an opus ticket also gets
`escalate=early`; if it escalates, the next worker goes back on opus. On the `sessions` host, workers are messaged rather
than relaunched (*Worker hosts*), so only the starting tier and escalation apply.

**Escalation.** With `model=auto`, pass `escalate=early` to every sonnet worker. Pass
`escalate=stuck` to opus workers (tiered or forced) when `fable` is not `off`. A forced
`model=sonnet` worker never gets `escalate=`: it applies its own stop rules. With `escalate`, a worker stops at fixed
struggle points with `IMPLEMENT_TICKET: escalate` (implement-ticket *Escalation*). On
that result:

- **From sonnet:** launch a fresh worker on **opus** with *Escalated from sonnet:
  <ESCALATE line>* (plus `escalate=stuck` unless `fable=off`). The ticket's tier is opus
  from then on, for every later relaunch: never step back down after an escalation.
- **From opus:** a Fable consult, per `fable=`.
  - `ask`: add it to the pending questions. Ask *"<KEY>: Opus is stuck on <the
    ESCALATE line>. Consult Fable (expensive, one short-context call)?"* with the options
    *consult* and *let Opus apply its stop rules*.
  - `auto`: consult.
  - `off`, declined, or this ticket already had a consult: launch a fresh opus worker
    without `escalate=`, with *Escalation declined: apply your ordinary stop rules*.
- With a forced `model=`, there is no escalation between models. A `fable=` setting
  other than `off` still allows the consult for opus workers.

**A Fable consult** is one `general-purpose` Agent with `model: "fable"`, background, no
`isolation`, given a short brief instead of the worker's context. Its prompt contains:
- the ticket key and summary;
- the worktree path, and the instruction to read the state file's *Escalation* section
  and the diff (`git -C <worktree> diff origin/<base>...HEAD`);
- the evidence paths that section lists.

It asks for the root cause, a concrete plan, what to check first, and what result would
prove the diagnosis wrong. The consult may read anything and run read-only commands and
tests in the worktree. It may not edit, commit, push, lease devices or ask the user, and
it ends with `CONSULT: <one-line diagnosis>`. Save its reply to
`<state dir>/consult-<unix-ts>.md`, since subagents may not be able to write report
files. Then launch a fresh **opus** worker with *Consult: <that path>* and no
`escalate=`. One consult per ticket unless the user asks for another.

**Record it.** Keep the *Model* column current (`sonnet`, `opus`, `sonnet→opus`,
`opus+fable`). In *Model use*, record each tier's reason, every escalation and its
trigger, review rounds, QA cycles, the token usage each worker's result reports (when it
shows one), and whether each consult's plan worked. This is how the tiers get tuned: a
ticket that went sonnet→opus after many review rounds would have been cheaper on opus
from the start.

## The coordinator's state

`<main checkout>/.claude/state/implement-tickets/<batch-id>.md` (git-ignored; survives
the session). `<batch-id>` is the start date plus the keys sorted numerically, e.g.
`2026-09-25-PILOT-12-15-19`. Update it on every event.

```markdown
# implement-tickets — <batch-id>
- Mode: interactive | auto · host: subagents | sessions · max-parallel: <n>
- Pass-through flags: <…> · model: auto · fable: ask

| Ticket | Lane | Model | Worktree | Worker | Phase | PR | Result | Waiting on |
|---|---|---|---|---|---|---|---|---|
| PILOT-12 | parallel | opus | .claude/worktrees/pilot-12 | <agent id / session name> | 5-qa | #251 | — | — |
| PILOT-15 | after PILOT-12 | sonnet | — | — | queued | — | — | PILOT-12 merged |
| PILOT-19 | parallel | sonnet→opus | .claude/worktrees/pilot-19 | — (handed off) | handoff | #253 | — | ci on <head sha> (watch <task id>) |

## Batch plan
<lanes and the reason for each>

## Model use
- PILOT-19: sonnet (tier: <reason>) → opus at 4-review (escalate: review-loop max-rounds, FIX counts flat) · review rounds 5 · QA cycles 2 · tokens <from each worker's result, when shown>
- PILOT-12: opus → fable consult at 6-ci-threads (<trigger>) · plan worked: yes/no, <why>

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
- **Fable consults** run only with `fable=auto`; `fable=ask` counts as `off` here,
  since nobody is there to ask.
- **Your own decisions** (lanes, combining, parallelism, re-launches, model tiers and
  escalations) go in the state
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
or, once *Cleanup* has removed the worktree, its archived copy at
`<main checkout>/.claude/state/implement-tickets/archive/<KEY>/state.md`; its branch; its
PR, searched in every state (`gh pr list --search <KEY> --state all`, exact key)). A
ticket whose PR has **merged** is finished: record it as `merged` and never relaunch it.
Subagent workers from an earlier session are gone, so re-launch any other ticket
that is not `ready-to-merge` — `implement-ticket` resumes from its own state, on the model
its *Model* column now says (*Models*) — except a
ticket whose last result was `handoff`: re-arm its hand-off watch (Phase 3) from the
`WAITING_ON:` line in its state file's *Next* section instead, and launch a worker only when the watch ends. Never start a
second worktree, branch or PR for a ticket. Then run *Cleanup* for every merged ticket,
in this batch or an older one.

On the `sessions` host, workers do outlive the coordinator, so check before re-launching:
`claude agents --json` rows with `kind: "background"`, `name: "<KEY>"` and a `pid` are a
live worker. **Adopt** it instead of starting another in the same worktree: record its
`id`, and message it (`to: "<KEY>"`) *Coordinator is now <your session name>* plus a
request for its phase. Re-launch only the tickets with no live session.

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

Give each ticket a **model tier** with a one-line reason (*Models*), or the forced
`model=`.

Also check machine and CI capacity: how many tickets need devices (and which platform),
and whether the device pool can serve `max-parallel` workers at once.

**Checkpoint** (interactive): show the lane table with reasons and each ticket's model, plus every question you
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
   `auto` (never `plan-review`) in auto mode, plus `after=<branch>` for a stacked ticket,
   and `no-handoff coordinator=<your session name>` on the `sessions` host (*Worker hosts*).
   Add `escalate=early` for a sonnet worker under `model=auto`, or `escalate=stuck` for an
   opus one unless `fable=off` (*Models* → *Escalation*).
3. Record the worker's id/name, and move on. Launch all ready workers in one message so
   they start together. On the `sessions` host, also subscribe to each worker's
   `notify_when_idle` (*Worker hosts*), since its stop does not notify you.

A slot is a worker that is **building**: `max-parallel` caps building workers, not
started ones. A worker that returns `ready-to-merge`, `blocked`, `planned`, `handoff` or `escalate` is idle
and frees its slot. A ready worker may need resuming later (another PR merged and its
PR now conflicts: it must merge `main` and re-run its gate); until it has, report it as
`ready (conflicts with main)`, never plain `ready`. Resuming an idle
worker (relaying "go" or an answer) needs a free slot like starting a new one does —
resume in lane order, and queue the rest until slots free. Fill free slots from the
queue in lane order.

## Worker hosts

**Subagents (default).** An `Agent` call per worker — `general-purpose`, **no** `isolation`
(you made the worktree), `model` set to the ticket's model for this launch (*Models*),
running in the background — whose prompt is:

> Invoke the Skill tool with skill `implement-ticket` and args
> `<KEY> worker worktree=<path> …`, and follow that skill exactly. You are a worker in a
> batch coordinated by another agent; never ask the user anything directly. End your
> final message with the skill's result lines (`IMPLEMENT_TICKET:`, `PR:`, `STATE:`, and
> `QUESTION:`/`OPTIONS:`/`DEFAULT:` when blocked, `WAITING_ON:` on a hand-off,
> `ESCALATE:` on an escalation).

You are notified when each worker stops. To answer or instruct a stopped worker, send it
a message with `SendMessage` (its agent id is in the tool result; keep it in the state
file) — it resumes with its context intact, and on its original model, so a model change
always means a fresh worker. That suits a worker still in Phases 1–5,
whose context is worth keeping. **From Phase 6 on** (the state file's `Phase:` line; for a blocked worker, the phase in
`blocked (in <phase>)`),
launch a **fresh worker** instead: a new `Agent` call with the same prompt plus one line
saying why (*Woken by: …*, *Answer to your QUESTION: …*, *Main moved: …*, *Resume after
an infra stop*). It resumes from the state file. *Escalated from …*, *Consult: …* and
*Escalation declined* are one-shot lines: put them only in the first launch after that
escalation, never in later relaunches built from that prompt. A late-phase worker's context is
300–600k tokens, and messaging it re-caches all of that before it does anything
(implement-ticket *Context hand-off*). Never message a worker that returned `handoff`.
Its successor is the next fresh worker. Subagent workers can spawn their own
subagents (review-loop's reviewer) and load project skills; this was verified. They end
with this session, so a long batch should be resumable, and is (Phase 0).

**Background sessions (`sessions`).** Each worker is a full top-level Claude session that
outlives this one and that the user can `claude attach` to. Unlike a subagent, a session
worker's stop does **not** notify you, so it sends its result lines to you by message
(`coordinator=`, implement-ticket *Worker mode*). Your session name is the first line of
`ListAgents` ("This session is <name> [ref]").

Launching from here works when this session's permissions allow `claude --bg` (verified
under bypass permissions). Under auto mode the safety classifier may block it unless the
user has added a Bash allow rule for `claude --bg`. If it is blocked, **print one launch
command per ticket for the user to run**:

```bash
cd <main checkout> && claude --bg -n <KEY> --permission-mode auto --model <opus|sonnet> \
  "/implement-ticket <KEY> worker no-handoff worktree=<absolute worktree path> coordinator=<your session name> …"
# prints: backgrounded · <id> · <KEY>   (record <id> in the state file)
```

Session workers always get `no-handoff`. The point of this host is workers that keep
going without the coordinator, and a handed-off worker would sit idle until the
coordinator's hand-off watch relaunched it. So each does its own Phase 6–8 waits, and you
**message** it in every phase: the one exception to "fresh worker from Phase 6 on". That
costs tokens. Each message to a late-phase worker re-caches its whole context (300–600k
tokens), so batch what you send it. Use the subagent host when the token saving matters
more than surviving the coordinator.

Tracking, verified Oct 27 2026 with Claude Code 2.1.312:

- **Results arrive as messages.** A worker's `SendMessage` shows up in your conversation
  as `<cross-session-message from-name="<KEY>">` with its result lines, and is handled as
  a worker stop (Phase 3). Message it with `SendMessage` `to:` its `-n` name, within the rules above. A
  message to an idle session wakes it, and its reply came back within seconds. This worked
  across permission modes (coordinator bypass, worker auto). If a
  `[Cross-session delivery notice]` says the worker is holding your message for approval,
  tell the user to approve it there (`claude attach <id>`).
- **`claude agents --json`** lists every session on the machine, interactive ones
  included. Pick yours by `name`. Background rows have `kind: "background"`, `id`,
  `pid`, `status` (`busy` / `idle`) and `state` (`working` while running, `done` once its
  turn ends; `blocked` with a `pid` means it is probably waiting on a permission prompt,
  so tell the user to attach; a stopped session has no `pid` and can also show `blocked`).
- **`claude logs <id>`** prints the raw terminal screen, ANSI escapes and all, and only
  recent output. Strip it before searching (`sed 's/\x1b\[[0-9;?]*[A-Za-z]//g'`). Use it
  as a fallback when a worker stopped without messaging you. The worker's state file
  is the reliable record.
- **`notify_when_idle` is a slow backup.** `SendMessage` with `notify_when_idle: true`
  (one-shot; re-subscribe after each notice) delivers a `[Cross-session idle notice]`
  that quotes the worker's final output. In the probe it arrived minutes after the
  worker's own message, and after the session had been stopped. It means a turn ended,
  not that the worker stopped: a `no-handoff` worker ends turns while its background waits
  run. On a notice, read the worker's state file and its row (*Heartbeat*, Phase 3); it is
  not the main channel.
- **Stopping and re-launching:** `claude stop <id>` (the conversation is kept, so
  `claude attach` still works) in place of TaskStop. Re-launch with a fresh `claude --bg`
  command, which resumes from the worker's state file. Before any re-launch, stop the
  old session if its row still has a `pid`, so only one live session holds `<KEY>`.
  `claude rm <id>` deletes a finished
  worker's session; do that only after its PR is merged or the user is done with it.
- **Changing a session worker's model** (an escalation) works like any re-launch: `claude
  stop <id>`, then a fresh `claude --bg` with the new `--model` and the escalation line in
  its prompt. It resumes from the state file.

## Phase 3 — Run the batch

On every worker stop, read its result lines, update the table, then act:

| Result | Do |
|---|---|
| `planned` | Collect plans until every started worker has one (or a few minutes pass), then show them together: per ticket, the ACs, design choice, edge cases and open questions. Relay "go" with any corrections to each. |
| `blocked` | Add its question to the pending list. When no running worker is likely to add another soon, ask the user all pending questions at once (AskUserQuestion takes up to four per call, with each worker's `OPTIONS` and recommended `DEFAULT`). Relay each answer to its worker (from Phase 6 on, as a fresh worker launch with the answer in its prompt, except for a `no-handoff` session worker, which you message: *Worker hosts*) and record it. `auto`: never ask — see *Auto mode*. |
| `merged` (`merge`) | Record the merge commit; treat it as a merge (*Merges* below). Start the next queued ticket and any ticket waiting on this one. |
| `ready-to-merge` | Record the PR; tell the user it can be merged (with `merge`: say why the worker could not). Start the next queued ticket. |
| `escalate` | Free the slot and follow *Models* → *Escalation*: relaunch on opus, ask about or run a Fable consult, or relaunch with *Escalation declined*. Record it in *Model use*. The relaunch takes the next free slot ahead of new tickets. |
| `ready-stacked` / `best-effort` / `held` (auto) | Record it and its reason; free the slot. Start any ticket stacked on it (not on a `held` one). |
| `handoff` | Not a result: the worker is waiting for something listed in `WAITING_ON`. Record that and the head SHA, free the slot, and start a **hand-off watch** for its PR: implement-ticket's `references/pr-and-ci.md` §*Hand-off watch*, in the background (Bash `timeout` 7200000), one per PR. When it ends (`WAIT_DONE` or `WAIT_TIMEOUT`), launch a fresh worker (*Worker hosts*) with *Woken by: <the watch's last line>*, unless the PR has merged (`WAIT_DONE: PR is MERGED`, or `gh pr view` says so when a queued relaunch comes up, here or at Phase 0): then the ticket is `merged`, launch no worker, and handle it as a merge (*Merges*). Relaunches take the next free slot ahead of new tickets, since they are nearest to done. If no slot is free, set the row to `relaunch queued` with that line: its watch has done its job and is not re-armed, and the ticket gets exactly one fresh worker when a slot frees. |
| `stopped-by-user` / error / no result lines | Read its state file; re-launch it once (it resumes; on the `sessions` host, `claude stop` it first if it still has a `pid`); if it fails again, mark it held and tell the user. |

Between events, keep an eye on the batch:

- **Heartbeat.** Worker notifications can be missed, and a worker can hang in a wait
  of its own. While any worker or hand-off watch is running, keep one background heartbeat going —
  `for i in $(seq 1 30); do sleep 60; done; echo "WAIT_TIMEOUT: heartbeat"` (a loop of short sleeps: a single long `sleep` has been seen not to fire) — and
  re-arm it each time it fires. On every wake, whatever woke you, re-read reality: each
  worker's state file, branch head and PR (`gh pr view <n> --json state,headRefOid`).
  On the `sessions` host, also read each worker's `claude agents --json` row. No `pid`
  and no result message from it is a stop with no result lines (Phase 3 table).
  `state: blocked` with a `pid` is a permission prompt, so tell the user to attach. Any
  other row with a `pid` is alive, `done` included: a worker ends its turn while a
  background wait runs. If its state file holds a result it never sent you, handle that
  result; otherwise *Silent workers* covers it.
  Every handed-off ticket (not one marked `relaunch queued`) must have its hand-off
  watch running; re-arm any that is not,
  from the `WAITING_ON:` line in its state file's *Next* (never a guessed `since`).
- **Silent workers.** (A handed-off ticket has no worker running; its watch's deadline
  covers it.) A worker that has not returned, not pushed, and not changed anything in its
  state dir for **2 hours** is probably stuck in a wait. The state dir is
  `<worktree>/.claude/state/implement-ticket/<KEY>/`; check `state.md`, the review-loop
  ledger and the `qa-*` report directories, since a long `/review-loop` or a QA subagent
  writes there and not to `state.md`. Message it to report its phase and re-check what it
  is waiting for (implement-ticket *Waiting*), in any phase: one probe costs far less than
  killing work in progress. No change within 30 more minutes → stop it (TaskStop) and
  re-launch it once; it resumes from its state file. Before the relaunch, check
  `device-lease.sh list` for leases owned by `<KEY>`: a QA subagent the stopped worker
  started may still be running under them. Wait up to 30 minutes for them to clear, so two
  QA runs never share a device or worktree; if they do not, release them and say so in
  *Events*. A second hang → mark it held and say so.

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
  *Stacked branches*) and re-gates. GitHub deletes `<KEY>`'s branch on merge, so from
  then on the stacked worker compares against `origin/<base>`, not `after=`. If that stacked ticket is handed off, its watch will
  not notice the merge (the PR usually stays mergeable): stop the watch (TaskStop) and
  launch a fresh worker with *Main moved: <KEY> merged*. Unless `no-jira`, move the merged ticket to **Done**
  (statuses are To Do, In Progress, Done) if it is not there already (a `merge` worker
  does this itself). Then run *Cleanup* for the merged ticket.
- **Cross-ticket conflicts.** If two workers turn out to touch the same file after all
  (`git diff --stat` in each worktree), pause the later one with a message, and move it to
  a serial lane. A handed-off ticket has no worker to message: anything you need to tell
  it (this, a merge it depends on) goes as a fresh worker launch with that line, after
  stopping its watch.
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
owners; `release` each with its exact owner). Then run *Cleanup* for every merged ticket.
Include *Model use* in the report: each ticket's model path, and what the escalations and
consults bought. End with:

```
IMPLEMENT_TICKETS: <total> tickets: <merged> merged, <ready> ready-to-merge, <stacked> ready-stacked, <best-effort> best-effort, <held> held
PRS: <url> <url> …
```

## Cleanup

A merged ticket leaves behind a worktree (often over 1 GB, from `node_modules`, cargo
`target/` and Gradle output), a local branch, Xcode DerivedData for its path, and
sometimes processes and a worker session. GitHub deletes the PR's remote branch on merge
(a repository setting). Invoking this skill authorises removing the rest for a ticket
whose PR is **merged**, once every check below passes, and nothing else.

**When:**
- whenever you see a merge (Phase 3 *Merges*);
- at Phase 0 and Phase 4;
- on its own with the `cleanup` argument. Then sweep every worktree under
  `<main checkout>/.claude/worktrees/` and every local branch, whatever batch made it,
  and print what was removed and what was kept, with the reason.

**Which.** For each worktree, find its PR (`gh pr list --head <branch> --state all
--json number,state,headRefOid`; a detached worktree uses the PR its state file names).
Only `MERGED` qualifies. Keep a worktree whose PR is open, closed without merging, or
missing, and list it in the report. Never touch the main checkout, or a worktree outside
`.claude/worktrees/`.

**Checks.** Every one must pass. If any fails, keep everything for that ticket and say
which check failed.

1. The PR is `MERGED`.
2. No unpushed work. `git -C <worktree> status --porcelain` is empty, and HEAD is the
   PR's `headRefOid` or an ancestor of it (`git merge-base --is-ancestor`). If the commit
   is missing locally, `git fetch origin pull/<n>/head`. `git worktree remove` also
   deletes **ignored** files, so list them (`git -C <worktree> status --porcelain
   --ignored`). Build and test output that a rebuild recreates is fine:
   - dependency and build dirs: `node_modules/`, `target/`, `build/`, `dist/`, `.gradle/`,
     `Pods/`, `.expo/`, `ios-agent/.build*/`, `.swiftpm/`, `*.tsbuildinfo`,
     `agent/local.properties`;
   - generated sources: `packages/tapsmith/docs/` (the SDK build bundles it), `test-app/ios/`,
     `test-app/android/`, `test-app/expo-env.d.ts`, `native-ios-test-app/*.xcodeproj/`,
     `website/.astro/`, `website/src/content/docs/`;
   - test reports: `tapsmith-report/`, `tapsmith-results/`, `test-results/`, `blob-report/`;
   - `.DS_Store`, and `.claude/state/` (git lists it as one directory), whose ticket state
     *Remove* step 1 archives.
   Anything else ignored (`.env*`, `docs/superpowers/`, `dogfooding/`, `scratchpad/`,
   `e2e/qa-tmp/`, QA configs, `probe-*`, scratch notes, other `.claude/` files) keeps the
   worktree, and those paths go in the report so the user can move or delete them.
3. Nothing is still using it:
   - no worker, watch or consult for the ticket is running;
   - on the `sessions` host, its `claude agents --json` row has no `pid`. A worker that
     has sent a final result (`merged`, or `ready-to-merge` whose PR has since merged)
     stays idle with its `pid`, so `claude stop <id>` it first, then check;
   - no device lease is held by `<KEY>` or `qa:<branch>:*`;
   - no process has its working directory inside the worktree, or the worktree's path
     in its command line. Match the path exactly or followed by `/` (a shell sitting in
     the worktree root has a cwd with no trailing slash), and leave out the probe's own
     shell and its children, which carry the path in their own command lines:

     ```bash
     w=<worktree>
     lsof -d cwd -Fpn 2>/dev/null | awk -v w="$w" -v me=$$ \
       '/^p/{pid=substr($0,2)} /^n/{d=substr($0,2); if (pid!=me && (d==w || index(d, w"/")==1)) print pid, d}'
     ps -axo pid=,ppid=,command= | awk -v w="$w" -v me=$$ \
       '$1!=me && $2!=me { s=$0" "; if (index(s, w"/") || index(s, w" ")) print }'
     ```

   Tapsmith daemons, UI servers, Metro and node/tsx processes started from the worktree
   may be stopped (SIGTERM, then check again after 10 s). Any other process (a shell, an
   editor, the user's own terminal) means the worktree is still in use, so keep it.

**Remove, in this order** (log each in *Events*):

1. Archive the state dir: copy `<worktree>/.claude/state/implement-ticket/<KEY>/` to
   `<main checkout>/.claude/state/implement-tickets/archive/<KEY>/`.
2. Delete each `~/Library/Developer/Xcode/DerivedData/*` folder whose `info.plist`
   `WorkspacePath` (`/usr/libexec/PlistBuddy -c 'Print :WorkspacePath'`) is inside the
   worktree.
3. `git worktree remove <worktree>`, without `--force`. If it refuses, check 2 missed
   something: keep the worktree and report it.
4. `git branch -D <branch>` (squash merges make `-d` refuse), then `git worktree prune`.
5. On the `sessions` host, `claude rm <id>` for the ticket's worker session.

**Never remove** the shared iOS simulator agent cache or anything else under
`~/.tapsmith`, Gradle daemons or caches, an emulator or simulator (Tapsmith reclaims
the ones it launched, and a device may be in real use), or anything belonging to an
unmerged PR.

**With `cleanup` only:**
- **Local branches with no worktree** are deleted (`git branch -D`) when their PR merged
  and the branch tip is the PR's head or an ancestor of it.
- **Remote branches left from before GitHub's auto-delete setting** are deleted when
  their PR merged and the remote tip equals the PR's `headRefOid`. Never delete one with
  no PR, an open or unmerged-closed PR, or commits after the merge. Show the list with a
  count and confirm once before `git push origin --delete`, even with `auto`: this
  changes the shared repository, not just this machine.

Save durable lessons about running batches (capacity, a collision pattern) to memory —
not the batch's status, which lives in the PRs.
