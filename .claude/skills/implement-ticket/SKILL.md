---
name: implement-ticket
description: Implement a Jira ticket end to end and keep going until its PR is ready to merge. Understands the ticket and its Playwright precedent, plans the design, edge cases and test tiers up front, builds it test-first where a test can come first, then decides for itself when to run /review-loop and /qa-this-branch, when to commit, push and open a draft PR, how to answer CI failures and CodeRabbit or human review threads, and when the PR meets the ready-to-merge bar. Never merges. Resumable from its state file. Use when asked to implement, build, fix or pick up a ticket (e.g. "implement PILOT-123", "/implement-ticket PILOT-123").
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
`/review-loop` and `/qa-this-branch` (invoke them with the Skill tool).

## Arguments

`$ARGUMENTS` is free text. Tokens, in any order; leftover text is extra guidance for the
plan (constraints, hints, "don't touch X").

| token | meaning | default |
|---|---|---|
| `PILOT-123` (any `KEY-n`) | the ticket | required, unless resuming on a branch whose name carries it |
| `autonomous` | skip the plan checkpoint; record assumptions instead of asking | interactive |
| `base=<ref>` | branch to build on and target | `main` |
| `jira` | also move the ticket (In Progress at start, In Review at the end) and comment the PR link on it | no Jira writes |
| `leave-draft` | stop at the gate with the PR still a draft | mark it ready for review |
| `max-qa=<n>` | cap on QA → fix cycles before escalating | `3` |

## What you may and may not do

Invoking this skill **is** the authorisation to create a branch, commit (signed off),
push that branch, open and edit its PR, mark it ready for review, reply to and resolve
its review threads, and re-run its failed CI jobs. It is not authorisation for anything
else:

- **Never merge** the PR, push to `main`, force-push, delete branches, or change
  repository settings. The gate ends at "ready"; a human merges.
- **Never** bypass checks: no `--no-verify`, no skipping, deleting or weakening a test or
  assertion to go green, no `eslint-disable` without a real justification, no
  `continue-on-error`.
- **Never write to Jira** without the `jira` token, except what the user asks for.
  Follow-up tickets you would file go in the final report and the PR description as
  proposals.
- Keep secrets, personal paths and machine-specific details out of commits and the PR —
  the repo is public.

## When to stop and ask a human

Only these. Everything else you decide, and record the decision in the state file.

1. **The ticket is ambiguous in a way that changes what gets built** (not how), and
   neither the ticket's comments nor a Playwright precedent settles it. Interactive:
   batch every such question into the plan checkpoint. Autonomous: take the most
   conservative reading, record it as an assumption, and list it in the PR description.
2. **A public API shape has no Playwright precedent** and the ticket does not specify it.
3. **The ticket is too big for one reviewable PR** — propose the split before building.
4. **A loop will not converge**: `/review-loop` ends in `oscillation`; QA cycles hit
   `max-qa`; the same CI job fails for the same branch-caused reason after three fix
   attempts.
5. **`/qa-this-branch` returns `incomplete`** for a reason you cannot remove (device
   busy, environment you must not change), or raises `open_questions` about intent.
6. **A human reviewer requests changes you disagree with**, or asks a question only the
   user can answer.

When you stop, update the state file, say exactly what is blocked and what you need, and
leave the branch pushed and the PR in a coherent state.

## Phase 0 — Set up or resume

1. **Resume check first.** Look for `<scratchpad>/implement-ticket/<KEY>/state.md`, then a
   local or remote branch whose name carries the key (`git branch -a | grep -i <key>`),
   then an open PR (`gh pr list --search <KEY> --state open`). If any exists, follow
   `references/state.md` to resume from the recorded phase — never start over on top of
   existing work, and never create a second branch or PR for the same ticket.
2. **Clean start.** The working tree must be clean; if the user has uncommitted work in
   the main checkout, create a worktree
   (`git worktree add .claude/worktrees/<branch> origin/<base>`) instead of touching it.
   `git fetch origin`, then branch from `origin/<base>` using the naming in
   `references/pr-and-ci.md`.
3. **Write the state file** (`references/state.md`) and keep it current at every phase
   transition and decision.
4. With `jira`: move the ticket to In Progress.

## Phase 1 — Understand

Follow `references/planning.md` §1. In short: read the whole ticket (description, ACs,
**comments**, linked issues), check it is not already fixed on `<base>` or duplicated by
an open PR, read the code it touches and its existing tests, find the Playwright
equivalent and its exact contract, and for a bug, **reproduce it** — a bug you cannot
reproduce is not ready to fix; say so.

## Phase 2 — Plan (edge cases before code)

Write the plan file (`<scratchpad>/implement-ticket/<KEY>/plan.md`, format in
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
there are no genuine questions, say so and continue unless the user objects. Autonomous:
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

1. **`/review-loop`** — decide by the table below; pass `commit` so its fixes land as
   commits, and `base=<base>`. Read its outcome word: `clean` → go on; `max-rounds` →
   go on, and say in the PR that the loop hit its cap; `oscillation` → stop and ask.

   | Change | review-loop |
   |---|---|
   | product code (SDK, daemon, agents, proto, UI) | always, default rounds |
   | tests, tooling or CI only | `max-rounds=3` |
   | docs only, or a one-line fix with its test | skip; say so in the state file |

2. **Push and open a draft PR** (`references/pr-and-ci.md` — title, body, labels). CI
   only runs on PRs, so the PR exists to get CI going as early as it is worth the runner
   time: once the change is complete and reviewed, not for a half-built skeleton.
3. Start watching CI in the background (`references/pr-and-ci.md` §CI) and move straight
   on to QA — they run in parallel.

## Phase 5 — QA

Invoke `/qa-this-branch` with `autonomous ticket=<KEY> #<pr>` plus the plan's QA items as
focus text (focus adds emphasis; it never shrinks QA's matrix). On later cycles, add
`leads=<previous report path>`. Parse the last two lines of its reply (`QA_VERDICT:` /
`QA_REPORT:`) and act:

| Verdict | Do |
|---|---|
| `needs-fixes` | For each blocking finding: add the automated test its card suggests, watch it fail, fix, go green (Phase 3 discipline). Fix cheap minors too; propose tickets for pre-existing bugs. Then decide re-review (below), push, and re-run QA with `leads=`. |
| `incomplete` | Remove the gap if you can (rebuild, free a device, wait for one), then re-run. If you cannot, stop and ask (rule 5). |
| `ready-pending-ci` | Push if anything is unpushed, then wait for the listed checks (Phase 6). |
| `ready` | On to Phase 6. |

Every QA run is a full retest — never ask QA to skip anything because a previous cycle
passed it. `open_questions` in the report are rule 5: resolve them from the ticket if you
can, otherwise ask (interactive) or record the assumption in the PR (autonomous).

**What a change after review or QA re-triggers:**

| You changed | Re-run |
|---|---|
| product logic (more than a trivial, fully tested line) | `/review-loop` (`max-rounds=3`), then QA |
| a small fix with its own new test | QA only |
| tests, docs or comments only | package checks only; QA need not re-run |

After `max-qa` cycles without `ready`/`ready-pending-ci`, stop and ask (rule 4).

## Phase 6 — CI and review threads

Work these until both are clean (`references/pr-and-ci.md` has the commands):

- **CI** — every check on the PR's **head SHA** green, including both device E2E
  workflows, not just the required DCO check. A red job: read the failed log, decide
  branch-caused vs flake vs infra, and act (fix test-first; re-run failed jobs once for a
  flake with evidence; never paper over).
- **Review threads** — CodeRabbit reviews every PR and humans may too. Triage each
  unresolved thread like a review-loop card: fix it (with a test if it is a behaviour
  change), or reply with the reason it is not being changed. Resolve threads you fixed;
  leave a human's thread for the human unless they asked you to resolve it.

**Batch your pushes.** Each push cancels the in-flight E2E run (`cancel-in-progress`), so
collect fixes and push once, then wait. Any code change pushed here goes back through the
Phase 5 re-trigger table.

## Phase 7 — The ready-to-merge gate

All of these, checked on the current head SHA, and written into the state file as a
checklist with evidence:

- [ ] every AC in the plan is met or explicitly descoped in the PR with a reason;
- [ ] every planned edge case is tested, QA'd, or listed as out of scope in the PR;
- [ ] the last `/qa-this-branch` verdict is `ready` or `ready-pending-ci`, on a tree that
      differs from head only by tests/docs/comments — otherwise re-run it;
- [ ] `/review-loop` ended `clean` (or `max-rounds`, disclosed), or was skipped per the
      table, and no product logic changed after it without a re-review;
- [ ] every CI check on head is green; no job is green only because a step is advisory;
- [ ] no unresolved review thread you can act on; no outstanding "changes requested";
- [ ] the branch merges cleanly into `<base>` (merge `<base>` in if not, then re-check);
- [ ] every commit is signed off; the package checks pass locally;
- [ ] `docs/api-reference.md` and other affected docs are updated;
- [ ] the PR title and description are final and accurate (`references/pr-and-ci.md`) —
      what changed, how it was tested (tiers, QA verdict and its not-tested list), known
      limitations, assumptions, and follow-ups.

Then, unless `leave-draft`: `gh pr ready`, and if that triggers a first CodeRabbit review,
go back to Phase 6 for its threads. With `jira`: move the ticket to In Review and comment
the PR link.

## Final report

Plain text in your reply (structured-findings tools do not render in this terminal):
the PR link and state, the gate checklist with evidence pointers, what was assumed or
descoped, pre-existing bugs and proposed follow-up tickets, and anything a human must
decide before merging. End with:

```
IMPLEMENT_TICKET: <ready-to-merge|blocked|stopped-by-user>
PR: <url or none>
```

Save durable lessons (a new environment trap, a CI flake signature, a design rule a
reviewer taught you) to memory. Not the ticket's status — that lives in the PR.
