/**
 * Which file is a worker most likely to run next? Background preparation
 * arms the device for that file's declared isolation policy.
 *
 * Pure so it can be unit-tested; `ui-server.ts` supplies the inputs.
 */

import { resolveAppResetPolicy, type AppResetPolicy, type ResetCapabilities } from '../app-reset.js';
import type { TapsmithConfig, UseOptions } from '../config.js';
import type { TestTreeUseOptions } from './ui-protocol.js';
import type { Candidate } from './device-readiness.js';

export interface CandidateProject {
  name: string;
  /** Files (absolute paths) in tree order. */
  testFiles: string[];
  use?: UseOptions;
  effectiveConfig: TapsmithConfig;
  /** Bucket signature when per-project device targeting is in play. */
  bucketSignature?: string;
}

export interface CandidateInput {
  /** The worker's bucket; a worker only prepares for files its bucket can receive. */
  bucketSignature?: string;
  /** File + project the client currently has selected (highest-confidence guess). */
  selected?: { file: string; projectName?: string };
  /** Last file this worker ran. */
  lastRun?: { file: string; projectName?: string };
  /** Project of the most recent run on any worker. */
  lastRunProject?: string;
  projects: CandidateProject[];
  /** Root config when there are no real projects. */
  rootConfig: TapsmithConfig;
  /** Tree order of files (absolute paths) for the fallback. */
  treeFiles: string[];
  /** Per-file declared isolation options from discovery (file path → use). */
  fileUse: Map<string, TestTreeUseOptions | undefined>;
  capabilities?: ResetCapabilities;
  /** Files other workers already claimed as their candidate this round. */
  exclude?: Set<string>;
}

/** Resolve the policy a given file would run under for `project`. */
export function policyForFile(
  file: string,
  project: CandidateProject | undefined,
  input: Pick<CandidateInput, 'rootConfig' | 'fileUse' | 'capabilities'>,
): AppResetPolicy {
  const use = input.fileUse.get(file);
  const config = project?.effectiveConfig ?? input.rootConfig;
  // Project `use` is the base layer, the file's own declarations win — the
  // same merge the runner performs (runner.ts: projectUseOptions under
  // rootCtx.useOptions).
  const merged: Pick<TapsmithConfig, 'appReset' | 'appResetScope' | 'resetAppDeepLink' | 'rootDir'> = {
    rootDir: config.rootDir,
    resetAppDeepLink: config.resetAppDeepLink,
    appReset: (use?.appReset ?? project?.use?.appReset ?? config.appReset) as TapsmithConfig['appReset'],
    appResetScope: (use?.appResetScope ?? project?.use?.appResetScope ?? config.appResetScope) as TapsmithConfig['appResetScope'],
  };
  const appState = use?.appState ?? project?.use?.appState;
  return resolveAppResetPolicy(appState !== undefined ? { appState } : undefined, merged, input.capabilities);
}

function projectByName(input: CandidateInput, name: string | undefined): CandidateProject | undefined {
  if (name === undefined) return undefined;
  return input.projects.find((p) => p.name === name);
}

function servable(input: CandidateInput, project: CandidateProject | undefined): boolean {
  if (!input.bucketSignature) return true;
  if (!project?.bucketSignature) return true; // untagged files fall through to any worker, like dispatchNext
  return project.bucketSignature === input.bucketSignature;
}

function projectOfFile(input: CandidateInput, file: string): CandidateProject | undefined {
  return input.projects.find((p) => p.testFiles.includes(file));
}

/**
 * Candidate order:
 *  1. the client's selection (a file about to be run),
 *  2. the last file this worker ran (the edit → rerun loop),
 *  3. the first file of the last-run project,
 *  4. the first file in tree order this worker can serve.
 */
export function nextCandidate(input: CandidateInput): Candidate | undefined {
  const tryFile = (file: string | undefined, projectName: string | undefined, highConfidence: boolean): Candidate | undefined => {
    if (!file) return undefined;
    if (input.exclude?.has(file)) return undefined;
    const project = projectByName(input, projectName) ?? projectOfFile(input, file);
    if (!servable(input, project)) return undefined;
    const policy = policyForFile(file, project, input);
    // A restore is only worth pre-running when we are fairly sure this file is
    // next — a wrong guess would still cost the inline restore later, but the
    // archive restore itself is the expensive part.
    if (policy.appState && !highConfidence) return undefined;
    return { file, projectName: project?.name ?? projectName, policy };
  };

  return tryFile(input.selected?.file, input.selected?.projectName, true)
    ?? tryFile(input.lastRun?.file, input.lastRun?.projectName, true)
    ?? (() => {
      const p = projectByName(input, input.lastRunProject);
      return p ? tryFile(p.testFiles[0], p.name, true) : undefined;
    })()
    ?? (() => {
      for (const file of input.treeFiles) {
        const c = tryFile(file, undefined, false);
        if (c) return c;
      }
      return undefined;
    })();
}

/**
 * Merge a worker's newly reported reset capabilities into the server's
 * snapshot. Capabilities only ever upgrade: `true` wins over `false`/unset,
 * because a probe that missed the marker (hierarchy lag, app not yet
 * rendered) must not downgrade a capability an earlier reset positively
 * verified — the same never-downgrade rule the worker applies locally.
 */
export function mergeResetCapabilities(
  previous: ResetCapabilities | undefined,
  next: ResetCapabilities | undefined,
): ResetCapabilities | undefined {
  if (!previous) return next;
  if (!next) return previous;
  const merged: ResetCapabilities = { ...previous };
  for (const key of Object.keys(next) as Array<keyof ResetCapabilities>) {
    const value = next[key];
    if (value === undefined) continue;
    if (merged[key] === true) continue;
    Object.assign(merged, { [key]: value });
  }
  return merged;
}
