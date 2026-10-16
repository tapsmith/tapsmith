/**
 * What UI mode's Run all dispatches: every file, or a filtered tree's
 * selection (PILOT-729), grouped into project dependency waves when projects
 * are configured.
 */

import { collectTransitiveDeps, projectLabel, type ResolvedProject } from '../project.js';
import type { RunFileUseOptions } from '../worker-protocol.js';
import { selectionKey } from './run-selection.js';

/** One file of a Run all, as the dispatcher queues it. */
export interface PlannedFile {
  filePath: string
  projectUseOptions?: RunFileUseOptions
  projectName?: string
  /** Exact full names to run; omitted = the whole file. */
  fullNames?: readonly string[]
}

/** A wave's files for one project. */
export interface PlannedProject {
  project: ResolvedProject
  files: PlannedFile[]
}

export type RunAllPlan = { waves: PlannedProject[][] } | { files: PlannedFile[] }

export interface RunAllSuite {
  testFiles: readonly string[]
  /** Configured projects in dependency waves; undefined without real projects. */
  projectWaves?: ResolvedProject[][]
  /** The project each file runs under when there are no waves (the synthesized default). */
  projectForFile(filePath: string): ResolvedProject | undefined
}

/**
 * The files a Run all dispatches. With a `selection` (selection key → exact
 * full names, or undefined for the whole file) only the selected (project,
 * file) pairs run, each narrowed to its selected tests; with `runDeps` the
 * selected projects' dependency projects also run, whole, in their earlier
 * waves — as a scoped run does with the "run dependencies first" toggle on.
 */
export function planRunAll(
  suite: RunAllSuite,
  selection?: ReadonlyMap<string, readonly string[] | undefined>,
  runDeps?: boolean,
): RunAllPlan {
  if (suite.projectWaves) {
    const projects = suite.projectWaves.flat();
    let wholeProjects = new Set<string>();
    if (selection && runDeps) {
      const selected = projects.filter((p) => p.testFiles.some((f) => selection.has(selectionKey(projectLabel(p), f))));
      wholeProjects = collectTransitiveDeps(new Set(selected.flatMap((p) => p.dependencies)), projects);
    }
    const waves = suite.projectWaves
      .map((wave) => wave
        .map((project): PlannedProject => {
          const whole = !selection || wholeProjects.has(project.name);
          const files: PlannedFile[] = [];
          for (const file of project.testFiles) {
            const planned = planFile(file, project, whole ? undefined : selection);
            if (planned) files.push(planned);
          }
          return { project, files };
        })
        // An unfiltered run keeps empty projects so a failed dependency still
        // reports the projects it blocks, as before.
        .filter((p) => !selection || p.files.length > 0))
      .filter((wave) => wave.length > 0);
    return { waves };
  }
  const files: PlannedFile[] = [];
  for (const file of suite.testFiles) {
    const planned = planFile(file, suite.projectForFile(file), selection);
    if (planned) files.push(planned);
  }
  return { files };
}

/** One file under one project, or undefined when the selection leaves it out. */
function planFile(
  filePath: string,
  project: ResolvedProject | undefined,
  selection: ReadonlyMap<string, readonly string[] | undefined> | undefined,
): PlannedFile | undefined {
  const projectName = projectLabel(project);
  const key = selectionKey(projectName, filePath);
  if (selection && !selection.has(key)) return undefined;
  const fullNames = selection?.get(key);
  return {
    filePath,
    projectUseOptions: project?.use as RunFileUseOptions | undefined,
    projectName,
    ...(fullNames ? { fullNames } : {}),
  };
}
