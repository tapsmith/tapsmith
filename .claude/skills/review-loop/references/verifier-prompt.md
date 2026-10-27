# Verifier prompt template

Spawn each verifier with the Agent tool, `subagent_type: "general-purpose"` (never `fork`),
with model `opus` whatever the loop's `model=` is (it changes only the reviewer), in the background. Spawn every verifier for
the round in one message, so they run in parallel. Fill every `{{placeholder}}`.

A verifier, like the reviewer, sees **no history**: no round number, no earlier cards, no
verdicts on this finding. A first repeat of a `won't-fix` or `invalid` card is verified
from scratch, which is what *Repeat findings* in `triage.md` asks for. The main context
compares the verdicts afterwards.

**Bias.** None. The reviewer was told to over-report, and the verifier is where precision
comes from: it must neither rubber-stamp a finding because the reviewer was confident, nor
dismiss one because the fix looks awkward. The bar is `triage.md`'s, word for word.

```
You are verifying code-review findings on a change. For each finding below, read the code
yourself and decide whether it is real, how it fails, how likely that is, and whether it
must be fixed. Do not modify any files. Do not spawn subagents.

Repository: {{repo_root}}
Base ref:   {{base_ref}}
Diff:       run `{{diff_command}}` (untracked files in scope: {{untracked_files}})

What the change is meant to do (author's brief):
{{change_brief}}

Intent sources — read these before judging; they say what the change is for and which
choices are deliberate: {{intent_files}}

How to triage: read {{triage_path}}, sections "The card", "Verify", "Repro, Expected,
Actual", "Likelihood", "Impact", "Verdict" and "Class". Follow them exactly: they define the
card, the fixed likelihood scale and the FIX bar. A finding that "X is inconsistent with Y"
where X is deliberate is still `real`; likelihood and impact decide its verdict.

For each finding:
1. Open the cited code and read the whole path it describes. Do not trust the reviewer's
   Evidence. Check its `Would confirm:` line if it has one.
2. Write the card. Use concrete repro steps, not categories. If you cannot reach the flaw,
   say so in step 1.
3. For a real finding, search for the rest of its class (the reviewer's `Instances`, if
   any, are leads to check, not facts) and write the `Class:` line.

Findings (verbatim from the reviewer):
{{findings}}

Return the cards as your final message, in the exact card format from {{triage_path}},
one per finding, titled with the finding's own id (`### F3 — <claim>`). Nothing else: no summary, no preamble. Do
not write them to a file; the parent records them.
```

## Notes on filling the template

- `{{repo_root}}`, `{{base_ref}}`, `{{diff_command}}`, `{{untracked_files}}` and
  `{{change_brief}}` are exactly what the round's reviewer got.
- `{{intent_files}}` is the `intent=` paths, absolute, or `none`. Never pass the ledger,
  the findings file or a QA report.
- `{{triage_path}}` is the absolute path of this skill's `references/triage.md`.
- `{{findings}}` is the reviewer's text for each finding (title line plus its bullets),
  unedited. A verifier gets one finding, or up to four that cite the same file.
- Keep the reviewer's ids (`F1`, `F2`…) in `{{findings}}`. You rename each card to
  `R<round>-F<n>` when you write it to the ledger, so no round number reaches a verifier.
- If a verifier's output does not follow the card format, send it one message asking for
  the exact format before using it. If one fails, or the heartbeat finds it silent
  (SKILL.md step 2), spawn a fresh one for its findings, at most twice per verifier. Never fill its cards in yourself.
