# State file and resuming

This workflow runs for hours and will outlive the context window. The state file is how
it survives a summary, a new session, or a second `/implement-ticket <KEY>` invocation.

Path: `<worktree root>/.claude/state/implement-ticket/<KEY>/state.md` — the **state dir**,
beside `plan.md`, `pr-body.md` and the QA reports. `.claude/*` is git-ignored (only
`.claude/skills/` is tracked), so nothing here is ever committed, and unlike the session
scratchpad it survives the session. Removing the worktree removes it; that is fine once
the PR has merged. Write it at every phase transition, after every decision, and after every
push — never only at the end.

```markdown
# implement-ticket state — <KEY>

- Ticket: <KEY> — <title>
- Mode: interactive | autonomous | worker · flags: jira? leave-draft? plan-review? max-qa=<n>
- Base: <base> · Branch: <branch> · Worktree: <path or "main checkout">
- PR: <url or none> · draft? yes/no
- Phase: 0-setup | 1-understand | 2-plan | 3-build | 4-review | 5-qa | 6-ci-threads | 7-gate | done | blocked
- Head SHA: <sha> · pushed: yes/no

## Slices
- [x] 1 <slice> — commit <sha>
- [ ] 2 <slice>

## Loops
- review-loop: <n runs> · last outcome <clean|max-rounds|oscillation|skipped (why)> at <sha> · ledger <path>
- QA cycles: <n>/<max> · last verdict <…> at <sha> · report <path>
- CI: last head run <run id> <state> · reruns: <job: count, reason>
- Review threads: <open count> · last checked <time>
- Device leases held: <targets, or none>

## Decisions and assumptions
- <time> <decision> — why

## TDD exceptions
- <slice/test> — <which exception and why>

## Blocked on
<only when Phase = blocked: exactly what is needed from whom>

## Gate
<the SKILL.md Phase 7 checklist, ticked with evidence pointers>
```

## Resuming

On invocation, or after noticing the conversation was summarised:

1. Read `state.md` and `plan.md`. If there is no state file (the worktree was removed, or
   the work was started by hand) but a branch or PR for the key exists, **rebuild the state** from the
   evidence: `git log origin/<base>..<branch>`, the PR body and checks, the review
   threads, and any `QA_REPORT` or review-loop ledger paths mentioned in the PR or
   commits. Write the reconstructed state file before doing anything else.
2. Check reality against it: the branch's head matches `Head SHA`; nothing uncommitted
   you did not expect; the PR's state. Reality wins — update the file.
3. Continue from the recorded phase. A half-done slice restarts from its red test. A
   review-loop that was mid-round resumes from its own ledger (it has its own resume
   rule). A QA run that was interrupted is re-run from scratch — QA is always a full
   retest anyway.
4. Never create a second branch or PR for the key, and never discard commits to "start
   clean".
