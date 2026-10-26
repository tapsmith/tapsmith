# Branches, commits, the PR, CI and review threads

Facts about this repo that shape every rule below:

- **CI runs only on PRs** (and pushes to `main`/`release/**`). A pushed branch with no PR
  gets no CI at all. Every workflow runs on a PR to any base, so a stacked PR that
  targets the branch below it gets the full pipeline, `E2E iOS` included.
- **Every push cancels the in-flight run** of each workflow (`cancel-in-progress: true`).
  The E2E workflows take tens of minutes; pushing in the middle throws that away.
- **`E2E iOS` skips draft PRs** (its checks read *skipped*) and starts when the PR is
  marked ready (`ready_for_review`). It also never runs on a PR that touches only docs,
  the website, the Android agent, Android-only e2e files, tooling or other workflows (the
  `paths` lists in `e2e-ios.yml`). The org gets 5 concurrent macOS jobs across every
  workflow and PR, so iOS runs are kept for code that is about to merge.
- **PRs are squash-merged**, so branch history is not what lands on `main`. Merge
  commits on the branch are fine, and there is never a reason to force-push.
- **The `main` ruleset requires only the DCO check.** GitHub will offer the merge button
  long before the PR is actually ready; the gate in SKILL.md is the real bar.
- **Review bots come and go.** Whatever bot is installed at the time may leave review
  threads; *Review bots* below says how to treat them.

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
| build complete, `/review-loop` clean (or skipped as trivial) | **yes**, and open the draft PR |
| a QA cycle's fixes are all in, checked, and reviewed where non-trivial | yes, once |
| CI or review-thread fixes | batch them, `/review-loop` until clean if any is non-trivial, then push once |
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
- **How it was tested** — tiers and test files; the TDD exceptions and why; changes that skipped review or QA as trivial, and why; the review
  loop's outcome and round count; the QA verdict with its **not-tested** list; the
  platforms, emulator/simulator vs physical.
- **Known limitations / assumptions** — every assumption you made on the ticket's
  behalf, and every descoped AC or edge case.
- **Pre-existing issues found** and **proposed follow-ups** — not fixed here.
- **Decisions made in auto mode** (`auto` runs only) — every call a human would otherwise
  have made: the question, the choice, the main alternative, why. API shapes designed
  without a Playwright precedent are flagged here as **API decision for review**. A
  `best-effort` PR also lists each unmet gate item and why.
- **Checklist** — the template's items, ticked honestly (`[na]` where it doesn't apply).
- End with the PR attribution lines from the system prompt.

Keep the body true as work continues: rewrite it (`gh pr edit <n> --body-file …`) after
each QA cycle and before the gate. A PR description that describes an earlier version of
the branch is a gate failure.

## CI

Watch in the background, so QA and other work continue meanwhile, with the deadline
recipes below (*Waiting recipes*) — never a bare `gh pr checks --watch`: it also waits on
review bots' checks, whose status can sit at pending forever.

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

## Review threads (humans and bots)

List unresolved threads:

```bash
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  pullRequest(number:$n){reviewDecision reviewThreads(first:100){nodes{id isResolved isOutdated
  path line comments(first:20){nodes{author{login} body url}}}}}}}' \
  -f o=tapsmith -f r=tapsmith -F n=<n> \
  -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved|not)'
```

For each unresolved thread, decide as a review-loop triage card would — read the code,
build the scenario, judge likelihood and impact, against the same FIX bar
(review-loop's `references/triage.md`, *Verdict*):

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

A human's "changes requested" (`reviewDecision: CHANGES_REQUESTED`) blocks the gate
until they re-review.

### Review bots

The repo's review bot changes over time, and is often rate-limited or out of quota, so
nothing here names one. Treat a bot as a second opinion, never as the gate:

- **Its threads are review threads.** Triage each as above. Bots are recall-biased like
  the review-loop reviewer, so expect some invalid findings, and give each a reasoned reply
  rather than blanket agreement.
- **Never wait for a bot, nudge it, or gate on it.** A bot that has not reviewed, or that
  posted a rate-limit notice, changes nothing; the clean `/review-loop` on head is the
  review bar. Its summary comments and status checks are not threads: ignore them.

## Waiting recipes

Each runs in the background (`run_in_background`, Bash `timeout` 7200000) and ends with
`WAIT_DONE: …` or `WAIT_TIMEOUT: …` (exit 124). SKILL.md *Waiting* has the deadlines and
what to do on a timeout. A failed `gh` call (network, rate limit, wrong directory) means
"unknown, keep waiting" — never "done". Set `R`, `n` and `head` first:

```bash
R=tapsmith/tapsmith; n=<pr>; head=$(gh pr view $n -R $R --json headRefOid -q .headRefOid)
```

**CI checks registered** (right after a push `gh` reports no checks, which looks like a
finished watch). CI means checks with a workflow; DCO, review bots and other apps have none:

```bash
end=$((SECONDS+600))
until [ "$(gh pr checks $n -R $R --json workflow -q '[.[] | select(.workflow != "")] | length' 2>/dev/null || echo 0)" -gt 0 ]; do
  [ $SECONDS -ge $end ] && { echo "WAIT_TIMEOUT: no CI checks registered for $head"; exit 124; }
  sleep 20
done; echo "WAIT_DONE: CI checks registered for $head"
```

**CI finished on this head** (returns at the first failure, or as soon as head moves):

```bash
end=$((SECONDS+6000))
while :; do
  now=$(gh pr view $n -R $R --json headRefOid -q .headRefOid 2>/dev/null) || now=$head
  [ "$now" = "$head" ] || { echo "WAIT_DONE: head moved off $head"; exit 0; }
  b=$(gh pr checks $n -R $R --json workflow,bucket -q '[.[] | select(.workflow != "") | .bucket]' 2>/dev/null) || b=""
  case "$b" in *'"fail"'*) echo "WAIT_DONE: a CI check failed on $head"; exit 0;; esac
  case "$b" in ""|"[]"|*'"pending"'*) ;; *) echo "WAIT_DONE: CI finished on $head"; exit 0;; esac
  [ $SECONDS -ge $end ] && { echo "WAIT_TIMEOUT: CI still pending on $head"; exit 124; }
  sleep 60
done
```

**E2E iOS after ready** — the newest run for head that is not a draft's all-skipped run
(those conclude `skipped`; a run still going has no conclusion yet). It works the same
after a pass-2 fix, when the run started at push time. A head with no `E2E iOS` run at
all after 10 minutes is outside the workflow's `paths`, which meets the gate item. Long
queues for macOS runners are normal — this is not a stuck run:

```bash
end=$((SECONDS+6000)); start=$SECONDS
q='if length == 0 then "none" else (([.[] | select(.conclusion != "skipped")][0]) // {status: "waiting"} | "\(.status) \(.conclusion // "")") end'
while :; do
  now=$(gh pr view $n -R $R --json headRefOid -q .headRefOid 2>/dev/null) || now=$head
  [ "$now" = "$head" ] || { echo "WAIT_DONE: head moved off $head"; exit 0; }
  r=$(gh run list -R $R --workflow e2e-ios.yml --commit $head --limit 10 \
      --json status,conclusion -q "$q" 2>/dev/null) || r=""
  case "$r" in
    completed*) echo "WAIT_DONE: E2E iOS $r on $head"; exit 0;;
    none) [ $((SECONDS-start)) -ge 600 ] && { echo "WAIT_DONE: no E2E iOS run for $head (outside its paths)"; exit 0; };;
  esac
  [ $SECONDS -ge $end ] && { echo "WAIT_TIMEOUT: E2E iOS ${r:-unknown} on $head"; exit 124; }
  sleep 60
done
```

`WAIT_DONE: E2E iOS completed success` is the pass, and so is `no E2E iOS run` (say so in
the PR); any other conclusion is a red check for Phase 6. Only the draft's skipped run 10
minutes after `gh pr ready` (`waiting`) is the *CI checks to register* timeout in SKILL.md
*Waiting*.

**Hand-off watch** — run by the `/implement-tickets` coordinator, not a worker, for a
worker that returned `handoff` (SKILL.md *Context hand-off*). It ends at the first thing a
worker must act on, or once everything in `WAITING_ON` is done. Set `need`, `head` and
`since` from the `WAITING_ON` line:

```bash
R=tapsmith/tapsmith; n=<pr>; head=<sha>; need="<ci e2e-ios, as WAITING_ON lists>"; since=<WAITING_ON's since time>
# unresolved threads with a comment newer than the worker's last thread check
thr() { gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(last:1){nodes{createdAt}}}}}}}' \
  -f o=tapsmith -f r=tapsmith -F n=$n \
  -q "[.data.repository.pullRequest.reviewThreads.nodes[] | select((.isResolved|not) and (.comments.nodes[0].createdAt > \"$since\"))] | length" 2>/dev/null; }
end=$((SECONDS+6000)); start=$SECONDS
q='if length == 0 then "none" else (([.[] | select(.conclusion != "skipped")][0]) // {status: "waiting"} | "\(.status) \(.conclusion // "")") end'
while :; do
  p=$(gh pr view $n -R $R --json headRefOid,mergeable,state,reviewDecision \
      -q '"\(.headRefOid) \(.mergeable) \(.state) \(.reviewDecision)"' 2>/dev/null) || p=""
  if [ -n "$p" ]; then
    read -r ph pm ps pr <<<"$p"
    [ "$ph" = "$head" ] || { echo "WAIT_DONE: head moved off $head"; exit 0; }
    [ "$ps" = OPEN ] || { echo "WAIT_DONE: PR is $ps"; exit 0; }
    [ "$pm" = CONFLICTING ] && { echo "WAIT_DONE: PR conflicts with its base"; exit 0; }
    [ "$pr" = CHANGES_REQUESTED ] && { echo "WAIT_DONE: changes requested on $head"; exit 0; }
  fi
  t=$(thr) || t=""
  [ -n "$t" ] && [ "$t" -gt 0 ] && { echo "WAIT_DONE: review thread activity since $since"; exit 0; }
  pending=""
  case " $need " in *" ci "*)
    b=$(gh pr checks $n -R $R --json workflow,bucket -q '[.[] | select(.workflow != "") | .bucket]' 2>/dev/null) || b=""
    case "$b" in *'"fail"'*) echo "WAIT_DONE: a CI check failed on $head"; exit 0;;
                 ""|"[]") [ $((SECONDS-start)) -ge 600 ] && { echo "WAIT_DONE: no CI checks registered for $head after 10 min"; exit 0; }
                          pending="$pending ci";;
                 *'"pending"'*) pending="$pending ci";; esac;;
  esac
  case " $need " in *" e2e-ios "*)
    r=$(gh run list -R $R --workflow e2e-ios.yml --commit $head --limit 10 --json status,conclusion -q "$q" 2>/dev/null) || r=""
    case "$r" in "completed success") ;;
                 completed*) echo "WAIT_DONE: E2E iOS $r on $head"; exit 0;;
                 none) [ $((SECONDS-start)) -ge 600 ] || pending="$pending e2e-ios";;
                 *) pending="$pending e2e-ios";; esac;;
  esac
  [ -z "$pending" ] && { echo "WAIT_DONE: $need done on $head"; exit 0; }
  [ $SECONDS -ge $end ] && { echo "WAIT_TIMEOUT:$pending still pending on $head"; exit 124; }
  sleep 120
done
```

Each wait in it ends on its own deadline, matching the worker's recipes and the SKILL.md
*Waiting* table: CI checks that never register end it after 10 minutes, and so does a head
with no `E2E iOS` run at all (outside its `paths`; the `… done` line). Any reply or new
thread since `since` ends it, so a thread posted while the worker was handing off is not
missed, and neither is one hidden by another thread being resolved. The fresh worker
re-reads the real state on waking, as *Waiting* requires. On `WAIT_TIMEOUT`, the
coordinator launches a fresh worker too: diagnosing a stuck run is the worker's job
(SKILL.md *Waiting* table).

## Keeping up with the base

Before the Phase 7 gate passes, merge the base in only when GitHub reports a conflict, or
when the branch needs something that has since landed on it. After the gate passes, only
on a conflict (Phase 8). Never merge it just because it moved: every push re-runs every
workflow on the PR (iOS E2E included unless its `paths` exclude the PR, on the scarce
macOS runners), and `main`'s own CI tests the combination after the squash-merge.

```bash
gh pr view <n> --json mergeable,mergeStateStatus   # CONFLICTING → merge the base in
git fetch origin && git merge origin/<base>     # resolve, run package checks, commit -s
```

A merge that changes files your branch touched is a code change: it goes through the
Phase 5 *When to review and QA* like any other.
