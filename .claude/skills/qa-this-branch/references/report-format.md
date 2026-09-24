# Report file contract

The report is read by people and by calling skills (e.g. an implement-ticket workflow that
decides whether to fix, push, open a PR or mark the PR ready). Keep the front matter
exact; the body is for humans.

Default path: `<scratchpad>/qa-this-branch/report-<unix-ts>.md` (override with
`report=`). Screenshots, traces and probe logs go beside it in `evidence/`.

## Front matter

```yaml
---
skill: qa-this-branch
verdict: needs-fixes            # ready | ready-pending-ci | needs-fixes | incomplete
verdict_reason: "F1: --workers 2 ignores the device pin on worker 1"
head_sha: 3f9c2e1…              # what was tested
base: main
merge_base: facaf56…
dirty_tree: false               # true = uncommitted changes were in scope
pushed: true
pr: 251                         # null if no PR exists yet
ticket: PILOT-342               # null if none found
mode: autonomous                # autonomous | interactive
budget_minutes: 90
elapsed_minutes: 64
counts: { findings_blocking: 1, findings_other: 2, pre_existing: 1, untested: 3 }
pending_ci:                     # checks the verdict depends on that have not passed on head_sha
  - "E2E iOS (all shards)"
  - "Web Tests: trace-viewer/network.spec.ts"
open_questions:                 # for a human; the caller should escalate, not guess
  - "AC2 is inferred: should an unknown pin be refused, or warn and auto-pick?"
findings:
  - id: F1
    severity: major             # blocker | major | minor | nit
    kind: regression            # regression | new-behaviour-broken | missing-requirement | docs-mismatch | dx | pre-existing
    title: "--workers 2 ignores the device pin on worker 1"
    modes: [2]
    platforms: [android]
    blocking: true
---
```

## Verdict rules

Take the first that applies:

1. **`needs-fixes`** — at least one **blocking** finding: severity `blocker` or `major`
   and kind other than `pre-existing`. The caller should fix, then re-run QA in full
   (passing this report as `leads=`).
2. **`incomplete`** — no blocking finding, but a `must-test` cell for an **intent row or
   new behaviour** is UNTESTED (environment, device busy, budget), or intent could not be
   established at all. The caller should resolve the gap or escalate to a human; it must
   not treat this as ready.
3. **`ready-pending-ci`** — no blocking finding, nothing critical untested, but
   `pending_ci` is non-empty. The caller should push (if needed) and confirm those checks
   pass on the pushed SHA; QA need not re-run unless the push changes code.
4. **`ready`** — no blocking finding, nothing critical untested, `pending_ci` empty.

`minor`/`nit` findings, `pre-existing` bugs and UNTESTED at-risk or break-it cells never
block by themselves — they are listed so the caller can decide (e.g. fix the minors
before marking the PR ready, file tickets for pre-existing bugs).

**Severity:**

- **blocker** — the ticket's core behaviour does not work; crash, hang, data loss; a whole
  run mode or platform broken; a security problem.
- **major** — a stated AC fails; a regression of existing behaviour; one mode or platform
  broken for the new behaviour; a misleading error on a common path.
- **minor** — an edge case fails with a workaround; a poor but not misleading error; docs
  out of step with behaviour.
- **nit** — cosmetic, wording, a message that could be clearer.

## Body sections

In this order:

1. **Verdict** — one line, and the reason.
2. **Findings** — one card each, most severe first:

   ```markdown
   ### F1 · major · regression — --workers 2 ignores the device pin on worker 1
   - **Modes / platforms:** 2 (headless parallel) · Android
   - **Repro:** exact commands, from a clean state
   - **Expected:** … (cite the AC or the base-branch behaviour)
   - **Actual:** … (quoted output)
   - **Evidence:** evidence/f1-worker-log.txt, trace field `…`
   - **Base branch:** behaves correctly at merge-base facaf56 → regression
   - **Automated test that should catch this:** `src/__tests__/dispatcher.test.ts` —
     assert each worker's init message carries the pin (or: "not automatable because …")
   - **Retest:** the probe to re-run after a fix
   ```

   The "automated test" line matters: a caller fixing the finding should add that test so
   the next QA round can subtract it.
3. **Intent** — each AC → `met` / `not met (F<n>)` / `untested (reason)`, tagged
   stated/inferred/standing; `unrequested` behaviour noted.
4. **Coverage table** — item × dimension → how tested → result → evidence.
   `covered:` and `pending-ci:` rows need no evidence of your own. Anything you ran that CI
   also runs carries its justification.
5. **Not tested** — every UNTESTED cell and why.
6. **Pre-existing bugs** — reproduced on the base too; not blocking.
7. **Open questions** and **decisions** made on the caller's behalf.
8. **Cleanup** — what you started, and whether you killed it.

No "previously verified" column; no citing earlier rounds.
