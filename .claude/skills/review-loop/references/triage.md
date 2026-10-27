# Triage: from finding to verdict

Triage is split. The **main** context matches repeats against the ledger, then hands
every finding that needs a card to a fresh **verifier** subagent (`verifier-prompt.md`).
Verifiers run in parallel and follow this file's *The card* and *Verdict* sections. The
main context then checks each card against the intent (SKILL.md step 2) and writes them to
the ledger in the reviewer's order. Every finding gets all the steps (verify, scenario,
likelihood, verdict, class), each on its own card. Never batch-verdict ("F1–F4 all look
fine").

The reviewer is deliberately recall-biased: it was told to surface every plausible defect
and let this step sort them out. Expect a longer list than a human reviewer would send
and a real share of `invalid` verdicts. That is the design working, not a bad round — the
precision lives here. A `Would confirm:` line on a finding tells you what the reviewer
could not check; check it.

## What the user sees

Two printouts per round, both as ordinary messages in the conversation — not only in the
ledger file, and never via a structured findings tool (it does not render in this
terminal).

**1. The findings list**, the moment the reviewer returns and before any triage:

```
Round 3 review — 6 findings (3 bug, 1 likely-bug, 1 missing-test, 1 convention); 2 pre-existing
R3-F1  packages/tapsmith/src/runner.ts:212     bug 85       Retry counter never reset between files
R3-F2  packages/tapsmith/src/config.ts:88      bug 70       primaryDevicePin ignores group override
...
Pre-existing (not triaged): packages/tapsmith/src/cli.ts:40 — unhandled rejection on SIGINT
```

One line per finding: id, where, kind and confidence, the reviewer's claim verbatim. If
the reviewer said `NO FINDINGS`, print that and the round is clean.

**2. The triage cards**, once every finding in the round has been triaged and before any
fix is made, in ledger order:

- **In full**, in the exact shape below, every card that will change the tree: each FIX,
  each flipped verdict, and each verdict settled by a vote. These are the ones the user
  must be able to object to before an edit lands.
- **One line** for every other card (WON'T FIX, INVALID, OUT OF SCOPE, carried-forward
  repeats): `R3-F4 — <claim> · WON'T FIX — <its one-sentence verdict reason>`. The full
  card is in the ledger for anyone who wants it.

Printed text stays in the conversation for every later turn, so print each card once.

## Repeat findings

The reviewer is never told what earlier rounds decided, so a fresh reviewer will often
re-report a finding already in the ledger. Before the verify step, check each new finding
against every earlier card by `where` and the substance of the claim:

- **Matches a `fix` card** — the code has changed since, so this is a new finding about the
  fixed code. Triage it normally. If the fix did not fully remove the problem, it shows up
  here and gets a second `fix` — that is the loop working: an incomplete fix, not
  oscillation. It **is** the **oscillation** exit in SKILL.md when the new fix would undo
  or contradict the earlier one (putting back what it removed, or reintroducing the
  problem it solved), or when the same finding reaches a **third** `fix` — then stop and
  put the cards in front of the user.
- **Matches a `won't-fix` or `invalid` card, first repeat** — two independent reviewers
  found it. Triage it again from scratch — verify, scenario, likelihood, impact and
  verdict — without re-reading the old card first; then compare **verdicts**, not a
  single field. An `invalid` card had no reproducible scenario, so a fresh card that
  verifies as real is new evidence in its own right. If the fresh verdict is `fix` —
  because the scenario now reproduces, or likelihood or impact rose (the diff may have
  changed either) — the verdict flips and the card records the flip and why. If not,
  mark the card `final` with the sharpened reason.
- **Matches a `won't-fix` or `invalid` card already marked `final`** — carry the verdict
  forward, unless the diff has changed the code the card is about since it was marked
  final (then treat it as a first repeat again): a one-line card `R<n>-F<m> — repeats R<a>-F<b>, verdict stands`. Spend no more
  time on it, and print it as that one line.
- **Matches an `out-of-scope` card** — carry forward the same way; it is already in the
  final report. Exception: if the current diff now touches the code involved (changes a line in the same function
  or block), or makes
  the problem more likely or worse, it is no longer pre-existing — triage it normally.

Repeats do not count as `fix` verdicts for the round unless they flipped, so a round of
nothing but known repeats is a clean round.

## The card

```
### R3-F1 — Retry counter never reset between files
Where: packages/tapsmith/src/runner.ts:212 · bug · reviewer confidence 85
Verify: real
Repro:
  1. A spec file's first test fails and is retried twice (retries: 2 in config).
  2. The next spec file in the same worker starts.
  3. Its first test fails once.
Expected: the test is retried up to twice, like any other.
Actual:   `_retriesUsed` is still 2 from the previous file, so it is reported failed
          after one attempt.
Likelihood: likely — any run with retries enabled and more than one failing file per
            worker; CI hits this on every flaky day.
Impact: a passing-on-retry test is reported as a hard failure; the run goes red and the
        developer chases a flake that the retry policy should have absorbed.
Verdict: FIX — likely, wrong CI verdict, three-line fix with a unit test.
Class: per-file counters kept on the worker instead of the file run — also
       packages/tapsmith/src/runner.ts:240 (`_softFailures`); searched: every field the
       worker resets in `startFile`.
```

### Verify

Open the file at the cited line and read the code path yourself. Then write one of:

- `real` — the code does what the reviewer says and it is wrong.
- `real-but-different: <corrected claim>` — there is a problem here, but not the one
  described. The card's title keeps the reviewer's claim; the rest of the card describes
  the real problem.
- `invalid: <the line or guard that refutes it>` — the reviewer misread the code or
  described behaviour that cannot occur. The card stops here: no repro, no likelihood,
  `Verdict: INVALID — <one sentence>`.

A **convention** finding (Angle F) is verified by reading the quoted rule in the named
CLAUDE.md: if the rule says what the reviewer says and the line breaks it, it is real,
and its Repro/Expected/Actual describe what the rule exists to prevent. The reviewer had
no context on intent: a finding that "X is inconsistent with Y" where X was deliberate is
still `real` — the likelihood and verdict steps decide it, not the fact it was intended.

### Repro, Expected, Actual

- **Repro** is a numbered list of the concrete steps a person, CI, or the runtime takes to
  reach the flaw. Specific inputs, not categories: the flag, the value, the platform, the
  timing. Two to five steps. If you cannot write steps that actually reach the flaw, say
  so in step 1 ("no path found: …") — that becomes `unreachable` below.
- **Expected** is what should happen at the end of those steps.
- **Actual** is what does happen, followed through to the symptom someone would see. "The
  variable is wrong" is not an outcome; "the run is reported green with 3 tests skipped"
  is.

### Likelihood

How often the repro actually occurs in real use, on a fixed scale, always followed by
the condition that has to hold:

| level | meaning |
|-------|---------|
| `certain` | happens on every pass through the changed path |
| `likely` | needs a common condition — a normal flag, an ordinary input, one platform |
| `occasional` | needs a timing or environment coincidence that normal use produces now and then (the classic flake) |
| `rare` | needs an unusual combination a real user or CI could still produce |
| `unreachable` | needs a state the code prevents; name the guard |

Be honest in both directions: do not inflate to justify a fix, do not deflate to avoid
one. If two scenarios are plausible, write the worse one and note the other in a word.

### Impact

One or two sentences: the symptom, who sees it (user, CI, maintainer), and the blast
radius (one test, one run, corrupted state, silent wrong answer). Silent wrong answers
and misleading errors count as high impact even when the code does not crash.

### Verdict

Judge the **card**, not the reviewer's wording or confidence, and not how fiddly the fix
looks. Write `Verdict: <WORD> — <one sentence naming the likelihood and impact that
decided it>`.

- **FIX** when either:
  - likelihood is `occasional` or above and the impact is worse than cosmetic (wrong
    result, hang, crash, data loss, silent degradation, misleading error, flaky test); or
  - likelihood is `rare` and the impact is a security problem, data loss, or a silently
    wrong result (a run reported green that should be red, a wrong answer with no error).
- **WON'T FIX** otherwise — likelihood `unreachable` (the reason is the guard named on
  the card); `rare` with any lesser impact (reason: `below the bar`, naming the rare
  condition); or cosmetic impact at any likelihood when the fix would add complexity or
  risk. A cheap fix is not a reason to fix: every fix costs a review round and adds code
  for the next reviewer to find edges in, and a loop that buys cheap insurance on every
  rare edge never converges. The one sentence must be checkable by a fresh reviewer.
- **OUT OF SCOPE** when the problem is real but pre-existing and unrelated to this change.
  It is not fixed in this loop; it is listed in the final report for the user to decide.
  Exception: if the change makes the pre-existing problem *more* likely, it is FIX.
- **INVALID** — set at the verify step; see above.

### Class

For a `real` finding, name the **pattern**, not just the line: the mistake that, made once
here, is likely made elsewhere (the same unguarded call, the same missed run path, the same
copy-pasted condition). Search the diff scope for every other instance, and the touched
files around it, and list each one with its location and the search you ran. Write
`Class: <pattern> — none other (searched: …)` when there is none. An instance in code
the diff does not touch (no changed line in the same function or block; unchanged lines
inside a function the diff modifies are in scope, as the reviewer's scope rule says) is
pre-existing: list it with `(pre-existing)`, and it is not
fixed here unless the change makes it more likely. Instances share the card's verdict
only if the same repro reaches them. One that needs a different repro, or has a lower
likelihood, gets its own line saying so, and the fixer treats it as its own finding.

The bar is the same in round 1 and round 10. Never soften a FIX into WON'T FIX because
the round is getting long, and never tighten it either — convergence comes from the bar,
applied evenly, and from final verdicts carrying forward. The loop's job is to keep going.

## Fixing

For every FIX in the round, in ledger order:

1. Make the smallest change that removes the repro **at every instance on the `Class:`
   line** that shares the verdict. Fixing one line of a class leaves the rest for later
   rounds to find one at a time, which is how loops fail to converge. Follow the project's
   conventions (CLAUDE.md) and reuse existing helpers rather than adding parallel ones.
2. If the finding was a **bug** or **likely-bug**, add or extend a test whose steps are
   the card's Repro and whose assertion is the card's Expected — it fails without the fix
   and passes with it — unless the project has no test harness for that layer. A fix
   without a regression test must say why on the card.
3. Append `Fixed in: <files>` and `Test: <file or reason none>` to the card. The test covers
   the class where one test can, e.g. a table of every instance; otherwise it covers the
   cited instance and the card says why the others have none.

After the round's fixes, run the **cheapest checks that cover the touched files** — the
package-local typecheck, lint, and the unit test files for that package, as CLAUDE.md
lists them. Do not run device/e2e suites or anything that CI will run anyway. If a check
fails, fix it inside the same round before starting the next review; the next reviewer
must see a tree that compiles.
