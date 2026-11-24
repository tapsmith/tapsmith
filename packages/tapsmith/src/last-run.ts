/**
 * `--last-failed`: what the last `tapsmith test` run failed, kept in
 * `<outputDir>/.last-run.json` as Playwright keeps it.
 *
 * The file is not recorded in the output ledger, so the clearing a run starts
 * with (output-ledger.ts) leaves it alone; each run overwrites it when it ends.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileLoadFailureTitle } from './load-failure.js';
import { KEEP_OUTPUT_ENV } from './output-ledger.js';
import { projectLabel, type ResolvedProject } from './project.js';
import type { FullResult } from './reporter.js';

const LAST_RUN_FILE = '.last-run.json';

/** A test the last run failed. */
export interface LastRunTest {
  /** Relative to `rootDir`, with `/` separators. */
  file: string
  /** Unset when the config declares no projects. */
  project?: string
  /** The full title (`describe > test`). */
  title: string
}

interface LastRunConfig {
  rootDir: string
  outputDir: string
}

function lastRunPath(config: LastRunConfig): string {
  return path.resolve(config.rootDir, config.outputDir, LAST_RUN_FILE);
}

function relativeFile(config: LastRunConfig, file: string): string {
  return path.relative(config.rootDir, file).split(path.sep).join('/');
}

/**
 * Record what this run failed, for the next one's `--last-failed`.
 * Best-effort: a directory that cannot be written never fails the run.
 */
export function writeLastRun(config: LastRunConfig, result: Pick<FullResult, 'status' | 'tests'>): void {
  // `tapsmith verify`'s run is a check of the setup, not the user's last run.
  if (process.env[KEEP_OUTPUT_ENV] === '1') return;
  const failedTests = result.tests
    .filter((t) => t.status === 'failed' && t.filePath !== undefined)
    .map((t): LastRunTest => ({
      file: relativeFile(config, t.filePath!),
      ...(t.project !== undefined ? { project: t.project } : {}),
      title: t.fullName,
    }));
  try {
    const file = lastRunPath(config);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ status: result.status, failedTests }, undefined, 2)}\n`);
  } catch {
    // Without it, --last-failed runs everything.
  }
}

/** What the last run failed; `undefined` when there is no record of one. */
export function readLastRun(config: LastRunConfig): LastRunTest[] | undefined {
  try {
    const info: unknown = JSON.parse(fs.readFileSync(lastRunPath(config), 'utf-8'));
    const tests = (info as { failedTests?: unknown } | null)?.failedTests;
    return Array.isArray(tests) && tests.every(isLastRunTest) ? tests : undefined;
  } catch {
    return undefined;
  }
}

function isLastRunTest(value: unknown): value is LastRunTest {
  const test = value as Partial<Record<keyof LastRunTest, unknown>> | null;
  return typeof test === 'object' && test !== null
    && typeof test.file === 'string' && typeof test.title === 'string'
    && (test.project === undefined || typeof test.project === 'string');
}

/**
 * Cut every project down, in place, to the tests the last run failed: its
 * `testFiles` to the files that hold one, and `fullNames` to the tests. A
 * setup project (one another project depends on) runs whole for a dependent
 * that has a test to run; with none, it runs its own failures, if any.
 *
 * `namesOf`: the tests of a file this run could select, or `undefined` when
 * they are not known: the file then runs whole, since a recorded title may be
 * gone. So does a file with a failure that stood for all of it (it failed to
 * load, or its device could not start).
 *
 * Returns the run's files as one deduplicated, sorted list.
 */
export function selectLastFailed(
  projects: ResolvedProject[],
  failed: LastRunTest[],
  config: LastRunConfig,
  namesOf: (file: string, project: ResolvedProject) => string[] | undefined,
): string[] {
  const own = new Map(projects.map((p) => [p, failuresOf(p, failed, config, namesOf)]));
  const done = new Set<ResolvedProject>();
  const cut = (project: ResolvedProject): void => {
    if (done.has(project)) return;
    done.add(project);
    const dependents = projects.filter((p) => p.dependencies.includes(project.name));
    dependents.forEach(cut);
    if (dependents.some((p) => p.testFiles.length > 0)) return; // runs whole
    const failures = own.get(project)!;
    project.testFiles = project.testFiles.filter((f) => failures.has(f));
    project.fullNamesByFile = new Map([...failures].flatMap(([f, names]) => (names ? [[f, names] as const] : [])));
  };
  projects.forEach(cut);
  return [...new Set(projects.flatMap((p) => p.testFiles))].sort();
}

/** The project's failed tests by file; `undefined` for a file that runs whole. */
function failuresOf(
  project: ResolvedProject,
  failed: LastRunTest[],
  config: LastRunConfig,
  namesOf: (file: string, project: ResolvedProject) => string[] | undefined,
): Map<string, string[] | undefined> {
  const label = projectLabel(project);
  const result = new Map<string, string[] | undefined>();
  for (const file of new Set(project.testFiles)) {
    const rel = relativeFile(config, file);
    const titles = new Set(failed.filter((t) => t.file === rel && t.project === label).map((t) => t.title));
    if (titles.size === 0) continue;
    const names = namesOf(file, project);
    if (names === undefined) {
      result.set(file, undefined);
      continue;
    }
    const selected = names.filter((n) => titles.has(n));
    const wholeFile = [...titles].some((t) =>
      (t === fileLoadFailureTitle(file) || t === path.basename(file)) && !names.includes(t));
    if (wholeFile) {
      if (names.length > 0) result.set(file, undefined);
    } else if (selected.length > 0) {
      result.set(file, selected);
    }
  }
  return result;
}
