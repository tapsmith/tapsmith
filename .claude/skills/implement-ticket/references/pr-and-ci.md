# Branches, commits, the PR, CI and review threads

Facts about this repo that shape every rule below:

- **CI runs only on PRs** (and pushes to `main`/`release/**`). A pushed branch with no PR
  gets no CI at all.
- **Every push cancels the in-flight run** of each workflow (`cancel-in-progress: true`).
  The E2E workflows take tens of minutes; pushing in the middle throws that away.
- **PRs are squash-merged**, so branch history is not what lands on `main`. Merge
  commits on the branch are fine, and there is never a reason to force-push.
- **The `main` ruleset requires only the DCO check.** GitHub will offer the merge button
  long before the PR is actually ready; the gate in SKILL.md is the real bar.
- **CodeRabbit reviews PRs** and leaves review threads; it reviews again on later pushes.

## Branch

From `origin/<base>`, named by ticket type, key lowercased:

- bug → `fix/pilot-123-<short-slug>`
- story / task / improvement → `feat/pilot-123-<short-slug>`
- docs-only → `docs/pilot-123-<slug>`; tooling/CI → `chore/pilot-123-<slug>`

## Commits

- `git commit -s` on **every** commit — the DCO check is the one required check. Merge
  commits you create (merging `<base>` in) get a sign-off too.
- Descriptive imperative subject (`Refuse Android taps on covered elements`), a body that
  says why, and the attribution trailers this session's system prompt specifies. Do not
  hard-code trailers from memory — use the ones you were given.
- One commit per green slice; `/review-loop` with `commit` adds one per fix round. Never
  commit a red tree, and never amend or rebase commits that are already pushed.
- Stage explicit paths. Check `git status --short` before each commit so scratch files,
  `e2e/qa-tmp/` probes and local configs never get committed.
- The repo's pre-commit hook (`.githooks/pre-commit`, if `core.hooksPath` is set) runs the
  checks for touched components; a hook failure is a real failure — fix it.

## When to push

| Moment | Push? |
|---|---|
| mid-build, slices still to go | no — commits stay local |
| build complete, `/review-loop` done | **yes**, and open the draft PR |
| a QA cycle's fixes are all in and checked | yes, once |
| CI or review-thread fixes | batch them, then push once |
| docs/description-only tweaks while E2E is running | wait for E2E to finish, unless it is already red |

Before any push: package checks green, `git status` clean, and `git log origin/<branch>..HEAD`
(before the first push, when that ref does not exist yet: `git log origin/<base>..HEAD`)
lists what you expect.

## The PR

Open it as a **draft** once the change is complete and reviewed:

```bash
gh pr create --draft --base <base> --label <bug|enhancement|documentation|chore> \
  --title "<Imperative summary> (PILOT-123)" --body-file <state dir>/pr-body.md
```

Labels drive the release notes (`.github/release.yml`): `bug` for fixes, `enhancement`
for features, `documentation`, `chore` for tooling/CI.

The body follows `.github/PULL_REQUEST_TEMPLATE.md` and recent PRs (e.g. #246):

- **What this changes** — the rule or behaviour first, then the detail, grouped by AC or
  by ticket when one PR closes several. Say what is *not* changing when a reader would
  assume it is.
- **How it was tested** — tiers and test files; the TDD exceptions and why; the review
  loop's outcome and round count; the QA verdict with its **not-tested** list; the
  platforms, emulator/simulator vs physical.
- **Known limitations / assumptions** — every assumption you made on the ticket's
  behalf, and every descoped AC or edge case.
- **Pre-existing issues found** and **proposed follow-ups** — not fixed here.
- **Checklist** — the template's items, ticked honestly (`[na]` where it doesn't apply).
- End with the PR attribution lines from the system prompt.

Keep the body true as work continues: rewrite it (`gh pr edit <n> --body-file …`) after
each QA cycle and before the gate. A PR description that describes an earlier version of
the branch is a gate failure.

## CI

Watch in the background, so QA and other work continue meanwhile:

```bash
# first wait until checks have registered — right after a push, gh reports "no checks
# reported" and exits at once, which looks like a finished (or failed) watch
until [ "$(gh pr view <n> --json statusCheckRollup -q '.statusCheckRollup | length')" -gt 0 ]; do sleep 20; done
gh pr checks <n> --watch --fail-fast --interval 60   # run both in the background; returns at the first failure
```

Judge only runs on the **head SHA** (`gh pr view <n> --json headRefOid`) — older runs are
history. For any job you rely on that has `continue-on-error` steps, check the step
conclusions (qa-this-branch `references/automated-coverage.md` has the command).

**A red job — triage before acting:**

```bash
gh run view <run-id> --log-failed | tail -80
gh run list --branch main --workflow "<workflow name>" --limit 10 --json conclusion,headSha
```

- **Branch-caused** (fails on this branch, passes on recent `main`, and the failure is in
  code or behaviour you touched) → reproduce locally at the lowest tier, write the
  failing test first, fix, batch, push.
- **Known flake** (the same signature recurs on `main` or unrelated branches) → re-run the
  failed jobs once (`gh run rerun <run-id> --failed`) and record the evidence. Twice red
  with the same signature is no longer "a flake" for this PR: investigate.
- **Infra** (runner lost, setup failed before any test ran, no test artifacts) → re-run.
- A shard that times out or hangs is not automatically infra: check whether your change
  could make something wait.

Never "fix" CI by skipping, loosening or retrying a test in code.

## Review threads (CodeRabbit and humans)

List unresolved threads:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  pullRequest(number:$n){reviewDecision reviewThreads(first:100){nodes{id isResolved isOutdated
  path line comments(first:20){nodes{author{login} body url}}}}}}}' \
  -f o=tapsmith -f r=tapsmith -F n=<n> \
  -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not)'
```

For each unresolved thread, decide as a review-loop triage card would — read the code,
build the scenario, judge likelihood and impact:

- **Fix** → with a test if behaviour changes; after pushing, reply with what changed (and
  the commit). Resolve it if it is a bot's thread; leave a human's thread for them to
  resolve unless they asked you to.
- **Won't fix** → reply with the specific reason (the scenario cannot happen because …;
  Playwright does the same; out of scope, proposed as a follow-up) and resolve it if it
  is a bot's thread. Leave a human's thread open for them.
- **Question** → answer it; if only the user can answer, that is a stop-and-ask.

```bash
# reply
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(
  input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}' -f t=<thread id> -f b="<reply>"
# resolve
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=<thread id>
```

CodeRabbit is recall-biased like the review-loop reviewer: expect some invalid findings,
and give each a reasoned reply rather than blanket agreement. If it has not reviewed
within ~15 minutes of the PR opening (it may skip drafts), comment `@coderabbitai review`
on the PR. A human's "changes requested" (`reviewDecision: CHANGES_REQUESTED`) blocks the
gate until they re-review.

## Keeping up with the base

Check before the gate, and whenever GitHub reports a conflict:

```bash
gh pr view <n> --json mergeable,mergeStateStatus
git fetch origin && git merge origin/<base>     # resolve, run package checks, commit -s
```

A merge that changes files your branch touched is a code change: it goes through the
Phase 5 re-trigger table like any other.
