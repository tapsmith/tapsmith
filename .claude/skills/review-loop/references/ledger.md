# Ledger

The ledger is the loop's only state. It lives at `<ledger dir>/ledger.md` — the
`ledger=` directory, else `<session scratchpad>/review-loop/` — decided once in step 0 and
reused. Write it before the first
review and update it after **every** triage card and every fix — never only at the end of
a round. If the conversation is summarised mid-loop, the ledger is how the loop resumes:
re-read it, find the last incomplete card, continue.

The ledger holds the same cards the user sees printed (format in `triage.md`), so there
is one format to keep right, and a resumed session can re-print a round verbatim.

```markdown
# review-loop ledger

- Repo: <repo root>
- Base: <base ref> (merge-base <sha>)
- Scope: <what is being reviewed, one line>
- Reviewer model: <model>
- Max rounds: <n>
- Commit per round: yes | no
- Started: <ISO timestamp>

## Change brief
<3–8 lines, written once, passed verbatim to every reviewer>

## Focus
<user's free text, or none>

## Round 1 — <status: reviewing | triaging | fixing | checking | clean | done>
Reviewer findings file: <path>   (findings-<timestamp>.md — the reviewer never sees a round number)
Findings list as printed: <n> findings (<kinds>); <m> pre-existing

### R1-F1 — <claim>
Where: … · <kind> · reviewer confidence <n>
Verify: real | real-but-different: … | invalid: …
Repro:
  1. …
Expected: …
Actual:   …
Likelihood: <level> — <condition>
Impact: …
Verdict: FIX | WON'T FIX | OUT OF SCOPE | INVALID — <one sentence>
Fixed in: <files>            (FIX only, appended after the fix)
Test: <file, or why none>    (FIX only)

### R2-F4 — repeats R1-F2, verdict stands      (one-line card for a final repeat, in a later round)

Pre-existing (not triaged):
- <path>:<line> — <one line>

Checks after fixes: <commands run and result, or "none needed">

## Round 2 — ...
```

Keep the `id` as `R<round>-F<n>` so a repeated finding can point at its earlier card
(`repeats R1-F3`). A WON'T FIX / INVALID card gains `(final)` after its first independent
repeat has been re-examined and the verdict stood; later repeats are carried forward as
one-line cards without re-triage. A flipped card keeps both the old and the new
Likelihood lines so the flip is visible.

The `Round N` heading's status word is what tells a resumed session where it was.

## Termination record

When the loop stops, append:

```markdown
## Outcome: clean | max-rounds | oscillation | stopped-by-user
- Rounds run: <n>
- Fixed: <count> (<ids>)
- Won't fix: <count> (<ids>)
- Out of scope: <count> (<ids>)
- Invalid: <count> (<ids>)
- Unresolved (only when not clean): <ids with one line each>
```
