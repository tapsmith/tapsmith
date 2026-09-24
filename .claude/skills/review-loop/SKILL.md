---
name: review-loop
description: Review → triage → fix → repeat until a fresh reviewer finds nothing worth fixing. A fresh-context reviewer on a different model (Opus by default) reviews the branch diff; the main context prints the findings, then for each one verifies it, writes repro steps, expected and actual outcome, likelihood and impact, prints that card with its verdict, fixes every FIX verdict, runs the package-local checks, and starts the next round. Use when asked to review-loop, "review until clean", "loop review and fix", or to harden a just-implemented change before opening a PR.
---

# review-loop

You are running a review → triage → fix loop on the current change and you **do not stop
until a round comes back with nothing worth fixing**. You are replacing a manual workflow:
implement in one session, review in a second session on a different model, paste the
findings back, invent the bad scenario for each, decide, fix, repeat. Everything that was
copy-and-paste is now the ledger file; everything that was a second session is now a fresh
subagent.

Read `${CLAUDE_SKILL_DIR}/references/reviewer-prompt.md`, `triage.md` and `ledger.md`
before round 1. They are short and they are the contract.

## Roles

- **Reviewer** — a fresh `general-purpose` Agent (never `fork`), model from the `model=`
  argument, default `opus`. It has not seen the change being written. It runs seven
  finder angles inline, dedups, sweeps for gaps, and is tuned for **recall**: every
  plausible defect comes back, because verification is the triage step's job. One
  reviewer per round, whole diff every round — fixes can break things the last round
  passed.
- **You (main context)** — triage, fix, check, decide when to stop. You know the intent of
  the change; the reviewer does not. That asymmetry is the point: the reviewer finds what
  you are blind to, you judge what the reviewer cannot see.
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
| `model=<opus\|sonnet\|fable\|haiku>` | reviewer model | `opus` |
| `max-rounds=<n>` | safety cap | `8` |
| `commit` | one commit per round with fixes, following the project's commit conventions (sign-off flag if the project requires DCO) | no commits; fixes stay in the working tree |

Unless an explicit `A..B` range was given, the diff is **merge-base → working tree**,
committed and uncommitted together, plus untracked files. Nothing the user has written is
out of the reviewer's sight.

## Step 0 — set up (once)

1. Resolve the base and record `git merge-base HEAD <base>`. If HEAD *is* the base branch
   and the working tree is clean, stop and say there is nothing to review.
2. Decide the ledger path: `<session scratchpad>/review-loop/ledger.md` (the scratchpad
   directory is named in your system prompt). Reviewer findings files go beside it as
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
one message asking for the output in the exact format, then continue.

**As soon as it returns, print the findings list to the user** — one line per finding
with id, where, kind, confidence and the reviewer's claim, plus the pre-existing list — in
the shape given in `references/triage.md` under *What the user sees*. Print it as an
ordinary message before doing anything else. The user sees what the reviewer saw, before
you have formed an opinion about any of it.

### 2. Triage

Status `triaging`. Follow `references/triage.md` exactly: for each finding in order —
first match it against the ledger (repeats are handled per that file's *Repeat findings*
section), then verify by reading the code, write the repro steps, expected and actual
outcome, the likelihood on the fixed scale with its condition, the impact, and the
verdict with the one sentence that names what decided it. Write each card to the ledger
before opening the next finding.

**When the round's triage is complete, print every card to the user** in the exact card
format, in ledger order, before making any fix. This is the user's chance to read why
each finding is or is not being fixed and to object before the tree changes. Do not wait
for a reply — the loop continues. In Claude Code a typed message is queued until the
current turn ends; only **Esc** interrupts, so say in one line after the cards that Esc is
how to stop a fix before it lands. An objection that arrives after the fix has landed is
still honoured: revert that fix, and the card records `Verdict overridden by user: …`.

### 3. Fix

Status `fixing`. Every `fix` verdict gets fixed in this round, in ledger order, with a
regression test where `triage.md` requires one. Record files touched in the row.

### 4. Check

Status `checking`. Run the cheapest checks that cover the files you touched — package
typecheck, lint, and unit tests as the project's CLAUDE.md lists them. Never device or e2e
suites; never the full CI matrix. A failure is fixed in this round. Record the commands and
results in the ledger. If `commit` was given, commit now.

### 5. Close the round

If the round had at least one `fix`, status `done` and go to step 1. Otherwise status
`clean` and terminate.

## Termination

- **clean** — a round produced zero `fix` verdicts. This is the only success exit. A round
  whose findings were all `invalid`, `won't-fix`, `out-of-scope` or carried-forward repeats
  is clean; a round with `NO FINDINGS` is clean.
- **max-rounds** — the cap was reached with fixes still being made in the last round. Say
  so plainly; do not describe the tree as clean.
- **oscillation** — a finding with the same `where` and substantially the same claim has
  been given `fix` in two different rounds. Something is being fixed back and forth. Stop,
  leave the tree as it is, and put both rows in front of the user.
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
