# Spawning verifiers

Spawn each verifier with the Agent tool, `subagent_type: "general-purpose"` (never `fork`),
with model `opus` whatever the loop's `model=` is (it changes only the reviewer), in the
background. Spawn every verifier for the round in one message, so they run in parallel.

A verifier, like the reviewer, sees **no history**: no round number, no earlier cards, no
verdicts on this finding. A first repeat of a `won't-fix` or `invalid` card is verified
from scratch, which is what *Repeat findings* in `triage.md` asks for. The main context
compares the verdicts afterwards.

**Bias.** None. The reviewer was told to over-report, and the verifier is where precision
comes from: it must neither rubber-stamp a finding because the reviewer was confident, nor
dismiss one because the fix looks awkward. The bar is `triage.md`'s, word for word.

## The files

The verifier's standing instructions are in `verifier-instructions.md`; the verifier reads
that file itself, so it is never pasted into a prompt. What changes per round goes in files
too, so each Agent prompt stays a few lines long. That keeps the round out of your own
context, which is re-read on every later turn.

1. Make a fresh directory **outside the ledger directory**, so nothing a verifier can list
   reveals earlier rounds: `vdir=$(mktemp -d)`.
2. Write `$vdir/brief.md` once per round:

   ```
   Repository: <repo root>
   Base ref:   <base ref>
   Diff:       run `<diff command>`
   Untracked files in scope: <list, or none>
   Intent sources: <the intent= paths, absolute, or none>

   What the change is meant to do (author's brief):
   <the change brief>
   ```

   The repository, base, diff command, untracked files and change brief are exactly what
   the round's reviewer got. Never list the ledger, a findings file or a QA report.
3. For each verifier, write `$vdir/findings-<n>.md` with the reviewer's text for its
   findings (title line plus bullets), unedited, keeping the reviewer's ids (`F1`, `F2`…).
   A verifier gets one finding, or up to four that cite the same file. You rename each card
   to `R<round>-F<n>` when you write it to the ledger, so no round number reaches a
   verifier.

## The prompt

```
You are a code-review verifier. Read <absolute path of this skill's
references/verifier-instructions.md> and follow it exactly.
Brief: <$vdir/brief.md>
Findings: <$vdir/findings-<n>.md>
```

## When a verifier misbehaves

If a verifier's output does not follow the card format, send it one message asking for the
exact format before using it. If one fails, or the heartbeat finds it silent (SKILL.md
step 2), spawn a fresh one for its findings file, at most twice per verifier. Never fill its
cards in yourself.
