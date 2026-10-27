---
name: review-loop
description: Review → triage → fix → repeat until a fresh reviewer finds nothing worth fixing. A fresh-context reviewer (Opus by default; model= picks another) reviews the branch diff; the main context prints the findings; fresh verifier subagents verify each one and write its card (repro steps, expected and actual outcome, likelihood and impact, verdict, other instances of the same bug class); the main context prints the cards, fixes every FIX verdict across its whole class, runs the package-local checks, and starts the next round. Use when asked to review-loop, "review until clean", "loop review and fix", or to harden a just-implemented change before opening a PR.
---

# review-loop

You are running a review → triage → fix loop on the current change and you **do not stop
until a round comes back with nothing worth fixing**. You are replacing a manual workflow:
implement in one session, review in a second session on a different model, paste the
findings back, invent the bad scenario for each, decide, fix, repeat. Everything that was
copy-and-paste is now the ledger file; everything that was a second session is now a fresh
subagent.

Read `${CLAUDE_SKILL_DIR}/references/reviewer-prompt.md`, `verifier-prompt.md`,
`triage.md` and `ledger.md` before round 1. They are short and they are the contract.

## Roles

- **Reviewer** — a fresh `general-purpose` Agent (never `fork`), model from the `model=`
  argument, default `opus`. Its independence comes from the fresh context, not the model: with
  the default it may be the same model as the main context. Pass `model=` to get a
  genuinely different second opinion. It has not seen the change being written. It runs seven
  finder angles inline, dedups, sweeps for gaps, and is tuned for **recall**: every
  plausible defect comes back, because verification is the triage step's job. One
  reviewer per round, whole diff every round — fixes can break things the last round
  passed.
- **Verifiers** — fresh `general-purpose` Agents, always `opus` whatever `model=` says
  (`model=` picks a different second opinion for finding, never a weaker judge), run in
  parallel after each review. Each takes one finding (or a few that cite the same file),
  verifies it against the code, searches for other instances of the same bug class, and
  returns the triage card (`references/verifier-prompt.md`). They get the change brief and
  the `intent=` files, so they judge against what the change is for. Verification runs
  outside your context because it is mostly reading code, and in a long loop (or inside
  `/implement-ticket`, whose context is already large) everything read there would be
  re-read on every later turn. A verdict from a context that has not been arguing for the
  change is also the more independent one.
- **You (main context)** — match repeats against the ledger, dispatch the verifiers,
  check their cards against what you know of the intent, fix, check, decide when to stop.
  You know the intent of the change; the reviewer does not. That asymmetry is the point:
  the reviewer finds what you are blind to, you judge what the reviewer cannot see.
- **The user** — watches. Every round they see two printouts: the reviewer's findings
  list as it came back, and one triage card per finding (repro steps, expected, actual,
  likelihood, impact, verdict with reason) before any fix lands. Nothing is fixed or
  dismissed off-screen.

## Arguments

`$ARGUMENTS` is free text; any of these tokens may appear in any order, the rest is focus
text handed to the reviewer verbatim:

| token | meaning | default |
|-------|---------|---------|
| `#123` or `pr 123` | review that PR's diff; base is the PR's base branch | current branch vs default branch |
| `base=<ref>` | diff against this ref's merge-base with HEAD | repo default branch (`origin/HEAD`, else `main`, else `master`) |
| `<A>..<B>` | explicit range, committed work only | — |
| `model=<opus\|sonnet\|fable\|haiku>` | reviewer model (verifiers stay `opus`) | `opus` |
| `max-rounds=<n>` | safety cap on rounds in this run | `10` |
| `commit` | one commit per round with fixes, following the project's commit conventions (sign-off flag if the project requires DCO) | no commits; fixes stay in the working tree |
| `worktree=<path>` | review the branch checked out at this path, and make every fix, check and commit there (`git -C <path>`, absolute paths) — for callers whose own shell sits in another checkout | the current checkout |
| `intent=<path>[,<path>…]` | files that say what the change is for (a plan, a ticket export), read by every verifier along with the change brief — never given to the reviewer | none: verifiers get the change brief only |
| `ledger=<dir>` | directory for the ledger and findings files — pass a distinct one whenever several loops can run in one session (e.g. parallel workers sharing a scratchpad) | `<session scratchpad>/review-loop/` |

Unless an explicit `A..B` range was given, the diff is **merge-base → working tree**,
committed and uncommitted together, plus untracked files. Nothing the user has written is
out of the reviewer's sight.

## Step 0 — set up (once)

1. Resolve the repo root — `worktree=` if given, else the current checkout — and run
   every git command, check, edit and commit of the loop against it (`git -C <root>`,
   absolute paths): a shell whose working directory resets would otherwise review and
   commit in the wrong checkout. Resolve the base and record
   `git -C <root> merge-base HEAD <base>`. If HEAD *is* the base branch
   and the working tree is clean, stop and say there is nothing to review.
2. Decide the ledger path: `<ledger dir>/ledger.md`, where the ledger dir is `ledger=` or
   else `<session scratchpad>/review-loop/` (the scratchpad directory is named in your
   system prompt). **If that ledger already holds a finished run** (it ends with an
   `## Outcome:` record — e.g. a caller re-reviewing after later fixes), continue it
   rather than starting over: append a `## Run <k>` header with the new merge-base, a
   rewritten change brief and focus, keep numbering rounds from the last one (so card ids
   stay unique), and match repeats against every earlier card — so a `final` verdict
   from an earlier run is carried forward, not re-argued (unless its code has changed
   since, as step 2 says). `max-rounds` counts this run's
   rounds only. A ledger whose last round is unfinished is a resume (Ground rules), not
   a new run. Reviewer findings files go beside it as
   `findings-<unix timestamp>.md` — never a name that reveals the round. Create the
   directory.
3. Write the **change brief**: 3–8 lines on what the change is for and which design
   choices are deliberate. Write it from the conversation if you implemented the change
   here; otherwise from the PR description, commit messages and a first read of the diff.
   It is passed verbatim to every reviewer, so do not put opinions about quality in it.
4. Write the ledger header per `references/ledger.md`. Tell the user in one line that the
   loop has started, what the base is, and where the ledger lives.

## The loop

Repeat until a termination condition (below) is met. Round numbers start at 1.

### 1. Review

Spawn the reviewer with the prompt in `references/reviewer-prompt.md`, every placeholder
filled. The reviewer gets the diff, the change brief and the user's focus text — **nothing
about earlier rounds**: no round number, no prior findings, no prior verdicts, no
`round-N` file names. Set the round's ledger status to `reviewing`. Wait for the completion
notification — do not start triage on a prediction of what it will say, and do not do
other work on the tree while it reads.

If the reviewer's output does not follow the required format, do not guess at it: send it
one message asking for the output in the exact format, then continue. Save its output
verbatim to the round's findings file yourself — reviewers return findings as text
(a harness may refuse a subagent's file writes), and the file is what survives a
summary.

**As soon as it returns, print the findings list to the user** — one line per finding
with id, where, kind, confidence and the reviewer's claim, plus the pre-existing list — in
the shape given in `references/triage.md` under *What the user sees*. Print it as an
ordinary message before doing anything else. The user sees what the reviewer saw, before
you have formed an opinion about any of it.

### 2. Triage

Status `triaging`. Follow `references/triage.md` exactly:

1. **Match repeats yourself**, against the ledger (*Repeat findings*). A repeat of a
   `final` card or an `out-of-scope` one gets its one-line card now, with no verifier,
   **unless the code under it has changed**: a `final` card whose code the diff has
   changed since it was marked final, or an `out-of-scope` card whose function or block the diff now
   touches or makes more likely, goes to a verifier as a first repeat (step 2).
2. **Verify in parallel.** Spawn verifiers for every other finding in one message
   (`references/verifier-prompt.md`): one finding each, or up to four that cite the same
   file in one verifier, so the file is read once. A first repeat of a `won't-fix` or
   `invalid` card goes to a verifier like a new finding. The verifier is never shown the
   old card, which is exactly what *Repeat findings* asks for. Wait for every verifier to
   return. Do not start reading the code yourself meanwhile. A completion notification
   can be lost, so keep one background heartbeat while the reviewer (step 1) or any
   verifier is out (`for i in $(seq 1 10); do sleep 60; done; echo "WAIT_TIMEOUT: heartbeat"`,
   unless one is already running; re-arm it while any agent is out). When it fires, an
   agent still out is alive if its transcript changed in the last 10 minutes (the
   `output_file` its Agent call returned: `stat` its modification time, never read it).
   A reviewer or verifier never sits in a long wait, so 10 minutes of silence means
   stuck, not slow: a long review that keeps working is left alone however long it takes.
   A silent one gets one message to report; still silent at the next heartbeat, stop it
   (TaskStop) and spawn a fresh one for the same work (`references/verifier-prompt.md`
   for a verifier). Replace one agent at most twice; after that, stop and report it as an
   environment problem rather than loop.
3. **Check each card, then write it to the ledger** in the reviewer's order. Read it
   against the intent you know. If the card's repro, likelihood or impact rests on
   something the verifier could not know (an input the ticket rules out, a caller that
   never exists, a constraint stated outside the intent files), correct those lines, apply
   the bar to the corrected card, and record `Verdict corrected by main context: <the
   fact>`. That a choice was deliberate is never such a fact: deliberate choices are
   judged on likelihood and impact like anything else (`triage.md` *Verify*). If you simply disagree with
   its reading of the code or its likelihood, do not overrule it on your own: spawn one
   more fresh verifier on that finding. Two out of three is the verdict, recorded as
   `Verdict by vote: <the two verdicts and their one sentences>`. For a first repeat,
   compare the fresh card's verdict with the old card's, as *Repeat findings* says.

**When the round's triage is complete, print every card to the user** in the exact card
format, in ledger order, before making any fix. This is the user's chance to read why
each finding is or is not being fixed and to object before the tree changes. Do not wait
for a reply — the loop continues. In Claude Code a typed message is queued until the
current turn ends; only **Esc** interrupts, so say in one line after the cards that Esc is
how to stop a fix before it lands. An objection that arrives after the fix has landed is
still honoured: revert that fix, and the card records `Verdict overridden by user: …`.

### 3. Fix

Status `fixing`. Every `fix` verdict gets fixed in this round, in ledger order, with a
regression test where `triage.md` requires one. A fix covers **every instance** on the
card's `Class:` line, not just the cited one (`triage.md` *Fixing*). Record files touched
in the row.

### 4. Check

Status `checking`. Run the cheapest checks that cover the files you touched — package
typecheck, lint, and unit tests as the project's CLAUDE.md lists them. Never device or e2e
suites; never the full CI matrix. A failure is fixed in this round. Record the commands and
results in the ledger. If `commit` was given, commit now.

### 5. Close the round

If the round had at least one `fix`, status `done` and go to step 1. Otherwise status
`clean` and terminate.

**Design check after three fixing rounds in a row.** When this run's last three rounds
each had a `fix` verdict, stop before the next review and read those rounds' FIX cards
together. If they cluster on one mechanism, the design is usually the problem, not the
details: a heuristic gaining a case per round, or a fix keeping a promise the change did
not need to make. Then choose the principled rule, narrow the change, or drop the extra
promise, rather than patching the next case. Write a `Design check after round <n>:`
paragraph into the ledger saying what you looked at and what you decided, even when it is
"no pattern, carry on". Print it, and if the design changes, re-check the change brief.
Repeat the check after every further three fixing rounds. It never stops the loop or
changes the bar; the next round runs as usual.

## Termination

- **clean** — a round produced zero `fix` verdicts. This is the only success exit. A round
  whose findings were all `invalid`, `won't-fix`, `out-of-scope` or carried-forward repeats
  is clean; a round with `NO FINDINGS` is clean.
- **max-rounds** — the cap was reached with fixes still being made in the last round. Say
  so plainly; do not describe the tree as clean.
- **oscillation** — a fix would undo or contradict an earlier fix of the same finding
  (same `where`, substantially the same claim), or the same finding has been given `fix`
  in three different rounds. Something is being fixed back and forth, or is not
  converging. Stop, leave the tree as it is, and put the rows in front of the user. A
  second `fix` that completes an incomplete first one is not oscillation.
- **stopped-by-user** — the user interrupts. Update the ledger's outcome before replying.

Do not stop for any other reason. Not because the round was long, not because the reviewer
only found small things, not because you believe the next round will be clean. Run it.

## Final report

Print it as plain text in your reply — structured findings tools are not visible in this
user's terminal. Lead with the outcome word and the round count. Then:

- **Fixed** — one line per finding: id, the claim, likelihood, files touched, whether a
  test was added.
- **Won't fix** — id, claim, likelihood, the one-sentence reason.
- **Out of scope** — pre-existing problems found on the way, for the user to decide on.
- **Unresolved** — only when the outcome is not clean.
- The ledger path.

Keep it to what changes the reader's next action. The ledger holds the detail.

## Ground rules

- Verifiers are fresh too, and never see an earlier card for the finding they verify.
  Never verify in the main context, except to correct a fact that changes a card's repro,
  likelihood or impact (never "it was deliberate"), or to read a card closely enough to
  check it.
- The reviewer is **always** a fresh agent that believes it is the only review. Never
  `fork`, never review in the main context, never reuse a reviewer across rounds, never
  tell it what earlier reviewers found or what was decided. Independence is the whole
  value of the second opinion; the price — re-reported findings — is paid at triage by
  matching against the ledger, not by briefing the reviewer.
- Verdicts are judged on the card — likelihood and impact of the repro. A finding is not
  fixed because the reviewer sounded sure, and not dismissed because the fix looks fiddly.
- Everything the user should be able to object to is printed before it happens: the
  findings list before triage, the cards before fixes. Never fix or dismiss a finding
  that has not been shown.
- The tree the next reviewer sees must compile and pass the package-local checks. Never
  hand a broken tree to a review round.
- No commits unless `commit` was passed. Never push. Never open or edit a PR.
- The ledger is written **as you go**, not at the end. If the conversation is summarised
  mid-loop, re-read the ledger, find the round whose status is not `done`/`clean`, and
  resume from that step. Never restart from round 1 because context was lost.
- If the reviewer hits something it cannot read (a generated file, a binary), it reports
  the finding with a `Would confirm:` line; that is not a reason to widen its tool access.
