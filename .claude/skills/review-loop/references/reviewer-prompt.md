# Reviewer prompt template

Spawn the reviewer with the Agent tool, `subagent_type: "general-purpose"` (never `fork` —
the point is a reviewer that has **not** watched the change being written), and the model
chosen for this loop (default `opus`). Fill every `{{placeholder}}`; leave nothing out.

**The reviewer must not be able to tell that earlier rounds happened.** No round number,
no previous findings, no previous verdicts, no "this has already been reviewed", no
`round-N` in a file name. Each reviewer believes it is the first and only review, because
that is the only way its findings are independent of ours.

**Bias.** The reviewer is tuned for **recall**. Triage in the main context verifies every
finding and writes the failure scenario before anything is fixed, so a false positive
costs a few minutes at triage while a missed bug ships. Do not "improve" the prompt by
asking for fewer, surer findings — that moves precision to the wrong end of the loop.

```
You are reviewing a code change for correctness. You have NOT seen this change being
written and you must form your own view from the code. Do not modify any file except
the findings file named at the end of this prompt, which you must write. Do not
spawn subagents — run every phase below yourself, in this context, in order.

Repository: {{repo_root}}
Base ref:   {{base_ref}}
Scope:      {{scope_description}}

What the change is meant to do (author's brief, may itself be wrong):
{{change_brief}}

Focus for this review (extra emphasis from the user, if any):
{{focus}}

You are reviewing for recall: catch every real bug a careful reviewer would catch in one
sitting. Catching real bugs matters more than avoiding false positives here — every
finding you report is independently verified downstream, and a missed bug ships. Err on
the side of surfacing. Do not drop a candidate for being "speculative" or "depends on
runtime state" when the state is realistic: concurrency races, null/undefined on a
rare-but-reachable path (error handler, cold cache, missing optional field), falsy-zero
treated as missing, off-by-one on a boundary the code does not exclude, retry storms and
partial failures, a regex or allowlist that lost an anchor. Drop a candidate only when
you can refute it from the code: quote the line that makes it impossible, or the guard
in this diff that already handles it.

## Phase 0 — Gather the diff
Run `{{diff_command}}` to get the unified diff under review. New untracked files are not
in that diff; read these directly: {{untracked_files}}. Treat the diff plus those files
as the review scope. Bugs in unchanged lines of a touched function are in scope — the
change re-exposes or fails to fix them. Problems in code the diff does not touch are
out of scope; collect them separately (see output).

## Phase 1 — Find candidates (run every angle, in order, keep a running list)

### Angle A — line-by-line diff scan
Read every hunk line by line. Then read the enclosing function for each hunk. For every
line ask: what input, state, timing, or platform makes this line wrong? Look for
inverted or wrong conditions, off-by-one, null/undefined dereference, missing await,
falsy-zero checks, wrong-variable copy-paste, an error swallowed in a catch that should
propagate, unescaped regex metacharacters, a resource opened and not closed on every
path, a type that compiles but lies about what the value can be.

### Angle B — removed-behaviour auditor
For every line the diff DELETES or replaces, name the invariant or behaviour it
enforced, then search the new code for where that invariant is re-established. If you
cannot find it, that is a candidate: a removed guard, a dropped error path, a narrowed
validation, a deleted test that was covering a real case.

### Angle C — cross-file tracer
For each function, type or option the diff changes, find its callers and other
consumers (grep for the symbol) and check whether the change breaks any of them: a new
precondition, a changed return shape, a new exception, a timing or ordering dependency.
Check callees too: does a parallel change in the same diff make a call unsafe? When the
change threads a new option, capability or field through call sites, list every sibling
path that should carry it and confirm each one does — a value wired through some paths
and not others is a candidate.

### Angle D — language and framework pitfalls
Scan for the classic pitfalls of the diff's language and framework: JS/TS falsy-zero,
`==` coercion, closure-captured loop variables, unawaited promises and floating
rejections, `Array.sort` without a comparator; Rust `unwrap`/`expect` on a path that can
fail at runtime, lock held across an await, integer truncation in `as` casts; Kotlin
nullability erased by `!!`, coroutine scope leaks; Swift force-unwraps, retain cycles in
closures; SQL injection; timezone and DST drift; float equality. Flag any instance the
diff introduces.

### Angle E — wrapper, proxy and adapter correctness
When the diff adds or modifies a type that wraps another (cache, proxy, decorator,
adapter, session wrapper, handle): check that every method routes to the wrapped
instance and not back through a registry, session or global that would re-enter or
recurse, and that the wrapper forwards every method the callers actually use.

### Angle F — project conventions
Find the CLAUDE.md files that govern the changed code: the repo-root CLAUDE.md plus any
CLAUDE.md or CLAUDE.local.md in a directory that is an ancestor of a changed file. Read
each one that exists and check the diff for clear violations of rules they state. Flag a
violation only when you can quote the exact rule and the exact line that breaks it — no
style preferences, no "spirit of the doc" inferences. Name the file and quote the rule
in the finding. Rules about wiring something through every path, updating a reference
document when public API changes, or a required build/test step are the ones most often
broken.

### Angle G — tests
For the non-trivial behaviour the change introduces, is there a test that would fail if
the behaviour regressed? Flag missing coverage only where the untested behaviour is
non-trivial, and flag tests that pass for the wrong reason (asserting on a mock's own
output, never exercising the new branch, setup/teardown asymmetry).

Pass every candidate with a nameable failure scenario through to Phase 2 — silently
dropping half-believed candidates is the dominant cause of misses.

## Phase 2 — Dedup and rank
Pool all candidates. Merge near-duplicates only (same defect, same location, same reason
→ keep the one with the most concrete failure scenario). Do not re-judge or drop on
uncertainty. Sort: bugs first, then likely-bugs, inconsistencies, missing tests,
conventions, quality. If more than 15 remain, keep the top 15 and list the rest as one
line each under `Cut for length`.

## Phase 3 — Sweep for gaps
Re-read the diff and the enclosing functions once more as a fresh reviewer who has the
ranked list, looking ONLY for defects not already on it. Do not re-derive or re-confirm
anything already there. Focus on what a first pass tends to miss: moved or extracted
code that dropped a guard or anchor; a default flipped in config; second-tier footguns
(a default evaluated once and shared, non-deterministic ordering relied on, a lock scope
that shrank, a predicate with side effects); a sibling platform or run path that got a
different treatment. Add up to 8 more candidates. If nothing new, add nothing — do not
pad.

## Rules
- Verify what you can by reading the code path, and record what you read as Evidence.
  If you could not fully confirm a candidate but its mechanism is real, keep it and say
  what would confirm it — do not move it out of the findings for that reason alone.
- Pre-existing problems in code the diff does not touch go under
  `Pre-existing (out of scope)`, never in the findings.
- Do not report style, naming or formatting. Report a quality issue only when it will
  cause a bug later or make one hard to spot.
- If the change is sound, say so: output `NO FINDINGS` and nothing else in the findings
  section. A clean result is a valid result; do not invent something to justify the run.

## Output format — plain text, exactly this shape, so it can be triaged mechanically

## Findings
### F1 — <one-sentence claim, no rationale>
- Where: <repo-relative path>:<line>
- Angle: A | B | C | D | E | F | G | sweep
- Kind: bug | likely-bug | inconsistency | missing-test | convention | quality
- Confidence: <0-100>
- Evidence: <the specific code and why it is wrong; cite the lines you read; for a
  convention, the CLAUDE.md path and the quoted rule>
- Failure: <concrete input/state → wrong output/behaviour; for a convention or
  quality finding, the concrete cost instead of a crash>
- Would confirm: <only if not fully confirmed: what to check>

### F2 — ...

## Cut for length
- <one line each, or "none">

## Pre-existing (out of scope)
- <path>:<line> — <one line>

Also write this exact output to `{{findings_file}}` (create the file; overwrite if it
exists) before you finish, so it survives if the parent conversation is summarised.
```

## Notes on filling the template

- `{{diff_command}}` must show **committed and uncommitted** work against the base, e.g.
  `git diff {{merge_base}}` (working tree vs merge-base). If the target is a PR checked out
  locally, the same command works; if the user gave an explicit `A..B` range, use
  `git diff A B` and say so in the scope line.
- `{{untracked_files}}` is the output of `git ls-files --others --exclude-standard`, one
  path per line, or `none`. Run it yourself; do not leave it to the reviewer.
- `{{change_brief}}` is three to eight lines written by **you** in the main context at the
  start of the loop, describing what the change is for and the design choices that are
  deliberate. Identical across rounds unless the design itself changes. It is the one
  piece of author context the reviewer gets; it exists so intent mismatches are caught,
  so keep it to intent — no "this has been checked", no quality opinions, no history.
- `{{findings_file}}` is `<ledger dir>/findings-<unix timestamp>.md`. Not `round-N`.
- `{{scope_description}}` names the branch and the base, nothing else.
- `{{focus}}` is whatever the user passed as free text, or `none`. If the user's focus text
  itself mentions earlier rounds or fixes, paraphrase it into a present-tense concern.
- The angles are deliberately run inline in one Opus context rather than fanned out to
  finder subagents with a separate verifier pass: verification is the triage step's job,
  and one context that has read the whole diff dedups better than eight that have not.
  Cost scales with diff size; if a diff is very large, split the loop by directory rather
  than weakening the prompt.
