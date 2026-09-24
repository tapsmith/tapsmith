# Triage: from finding to verdict

Triage happens in the **main** context, one finding at a time, in the order the reviewer
gave them. Every finding gets all four steps (verify, scenario, likelihood, verdict), and
its card is written to the ledger before the next finding is opened. Do not
batch-verdict ("F1–F4 all look fine").

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
fix is made. One card per finding, in the exact shape below, so the user can see why each
one is or is not being fixed and object before the tree changes.

## Repeat findings

The reviewer is never told what earlier rounds decided, so a fresh reviewer will often
re-report a finding already in the ledger. Before the verify step, check each new finding
against every earlier card by `where` and the substance of the claim:

- **Matches a `fix` card** — the code has changed since, so this is a new finding about the
  fixed code. Triage it normally. If the fix did not actually remove the problem, it will
  show up here — that is the loop working. If it earns a second `fix` verdict, that is the
  **oscillation** exit in SKILL.md: stop and put both cards in front of the user.
- **Matches a `won't-fix` or `invalid` card, first repeat** — two independent reviewers
  found it. Re-run the scenario and likelihood steps once, from scratch, without re-reading
  the old card first; then compare. If the new likelihood is higher than before, the
  verdict flips to `fix` and the card records the flip. If not, mark the card `final` with
  the sharpened reason.
- **Matches a `won't-fix` or `invalid` card already marked `final`** — carry the verdict
  forward: a one-line card `R<n>-F<m> — repeats R<a>-F<b>, verdict stands`. Spend no more
  time on it, and print it as that one line.
- **Matches an `out-of-scope` card** — carry forward the same way; it is already in the
  final report.

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

- **FIX** when likelihood is `rare` or above and the impact is worse than cosmetic (wrong
  result, hang, crash, data loss, silent degradation, misleading error, flaky test). Also
  **FIX** when likelihood is `rare` and impact is minor but the fix is a handful of lines
  with no plausible regression — cheap insurance is worth buying.
- **WON'T FIX** when likelihood is `unreachable` (the reason is the guard named on the
  card), or when the impact is cosmetic and the fix would add complexity or risk. The one
  sentence must be checkable by a fresh reviewer.
- **OUT OF SCOPE** when the problem is real but pre-existing and unrelated to this change.
  It is not fixed in this loop; it is listed in the final report for the user to decide.
  Exception: if the change makes the pre-existing problem *more* likely, it is FIX.
- **INVALID** — set at the verify step; see above.

Never soften a FIX into WON'T FIX because the round is getting long. The loop's job is to
keep going.

## Fixing

For every FIX in the round, in ledger order:

1. Make the smallest change that removes the repro. Follow the project's conventions
   (CLAUDE.md) and reuse existing helpers rather than adding parallel ones.
2. If the finding was a **bug** or **likely-bug**, add or extend a test whose steps are
   the card's Repro and whose assertion is the card's Expected — it fails without the fix
   and passes with it — unless the project has no test harness for that layer. A fix
   without a regression test must say why on the card.
3. Append `Fixed in: <files>` and `Test: <file or reason none>` to the card.

After the round's fixes, run the **cheapest checks that cover the touched files** — the
package-local typecheck, lint, and the unit test files for that package, as CLAUDE.md
lists them. Do not run device/e2e suites or anything that CI will run anyway. If a check
fails, fix it inside the same round before starting the next review; the next reviewer
must see a tree that compiles.
