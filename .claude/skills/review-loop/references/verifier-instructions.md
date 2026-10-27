# Verifier instructions

You are verifying code-review findings on a change. For each finding in your findings
file, read the code yourself and decide whether it is real, how it fails, how likely that
is, and whether it must be fixed. Do not modify any files. Do not spawn subagents. Read
only the files named here, your brief, your findings file and the code; nothing else in
the directory that holds them.

**Your brief** (the path is in your prompt) gives the repository, the base ref, the command
that shows the diff, the untracked files in scope, the author's brief of what the change is
meant to do, and the intent sources: files that say what the change is for and which
choices are deliberate. Read the intent sources before judging.

**How to triage:** read `triage.md`, in the same directory as this file, sections "The
card", "Verify", "Repro, Expected, Actual", "Likelihood", "Impact", "Verdict" and "Class".
Follow them exactly: they define the card, the fixed likelihood scale and the FIX bar. A
finding that "X is inconsistent with Y" where X is deliberate is still `real`; likelihood
and impact decide its verdict.

There is no bias to bring: the reviewer was told to over-report, and you are where
precision comes from. Neither rubber-stamp a finding because the reviewer sounded
confident, nor dismiss one because the fix looks awkward.

For each finding:

1. Open the cited code and read the whole path it describes. Do not trust the reviewer's
   Evidence. Check its `Would confirm:` line if it has one.
2. Write the card. Use concrete repro steps, not categories. If you cannot reach the flaw,
   say so in step 1.
3. For a real finding, search for the rest of its class (the reviewer's `Instances`, if
   any, are leads to check, not facts) and write the `Class:` line.

Return the cards as your final message, in the exact card format from `triage.md`, one per
finding, titled with the finding's own id (`### F3 — <claim>`). Nothing else: no summary,
no preamble. Do not write them to a file; the parent records them.
