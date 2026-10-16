import { describe, it, expect } from 'vitest';
import { isPlannedTest, planRunAll, type PlannedFile, type RunAllPlan } from '../ui-mode/run-all-plan.js';
import { selectionKey } from '../ui-mode/run-selection.js';
import type { ResolvedProject } from '../project.js';

function project(name: string, testFiles: string[], dependencies: string[] = [], synthesized = false): ResolvedProject {
  return {
    name, testFiles, dependencies, synthesized,
    use: { appReset: 'none' },
    effectiveConfig: {} as ResolvedProject['effectiveConfig'],
    deviceSignature: name,
  } as ResolvedProject;
}

const A = '/repo/a.test.ts';
const B = '/repo/b.test.ts';
const SETUP = '/repo/setup.test.ts';

const setup = project('setup', [SETUP]);
const android = project('android', [A, B], ['setup']);
const ios = project('ios', [A], ['setup']);
const waves = [[setup], [android, ios]];

/** Each wave as `project: file[names]` strings, for readable assertions. */
function describeWaves(plan: RunAllPlan): string[][] {
  if (!('waves' in plan)) throw new Error('expected a wave plan');
  return plan.waves.map((w) => w.map((p) => `${p.project.name}: ${p.files.map(describeFile).join(', ')}`));
}

function describeFile(f: PlannedFile): string {
  const base = f.filePath.split('/').pop()!;
  return f.fullNames ? `${base}[${f.fullNames.join('|')}]` : base;
}

const suite = { testFiles: [SETUP, A, B], projectWaves: waves, projectForFile: () => undefined };

describe('planRunAll', () => {
  it('runs every file of every project, wave by wave, with no selection', () => {
    expect(describeWaves(planRunAll(suite))).toEqual([
      ['setup: setup.test.ts'],
      ['android: a.test.ts, b.test.ts', 'ios: a.test.ts'],
    ]);
  });

  it('keeps a project with no files in an unfiltered run, so a failed dependency still reports it', () => {
    const empty = project('empty', [], ['setup']);
    const plan = planRunAll({ ...suite, projectWaves: [[setup], [empty]] });
    expect(describeWaves(plan)).toEqual([['setup: setup.test.ts'], ['empty: ']]);
  });

  it('runs only the selected tests of the selected (project, file) pairs', () => {
    const selection = new Map([[selectionKey('ios', A), ['logs in']]]);
    expect(describeWaves(planRunAll(suite, selection))).toEqual([['ios: a.test.ts[logs in]']]);
  });

  it('runs a whole file for a selection entry with no test list', () => {
    const selection = new Map<string, readonly string[] | undefined>([[selectionKey('android', B), undefined]]);
    const plan = planRunAll(suite, selection);
    expect(describeWaves(plan)).toEqual([['android: b.test.ts']]);
  });

  it('runs the selected projects\' dependencies whole, first, when asked to', () => {
    const selection = new Map([[selectionKey('android', A), ['logs in']]]);
    expect(describeWaves(planRunAll(suite, selection, true))).toEqual([
      ['setup: setup.test.ts'],
      ['android: a.test.ts[logs in]'],
    ]);
  });

  it('runs a selected dependency project whole when deps run first', () => {
    const selection = new Map([
      [selectionKey('setup', SETUP), ['one']],
      [selectionKey('ios', A), ['logs in']],
    ]);
    expect(describeWaves(planRunAll(suite, selection, true))).toEqual([
      ['setup: setup.test.ts'],
      ['ios: a.test.ts[logs in]'],
    ]);
    // Without deps-first it stays narrowed to what was selected.
    expect(describeWaves(planRunAll(suite, selection))).toEqual([
      ['setup: setup.test.ts[one]'],
      ['ios: a.test.ts[logs in]'],
    ]);
  });

  it('plans a flat file list without projects, keyed with no project name', () => {
    const synthesized = project('default', [A, B], [], true);
    const flat = { testFiles: [A, B], projectForFile: () => synthesized };
    const all = planRunAll(flat);
    expect('files' in all && all.files.map(describeFile)).toEqual(['a.test.ts', 'b.test.ts']);
    expect('files' in all && all.files[0].projectName).toBeUndefined();
    expect('files' in all && all.files[0].projectUseOptions).toEqual({ appReset: 'none' });

    const some = planRunAll(flat, new Map([[selectionKey(undefined, B), ['x']]]));
    expect('files' in some && some.files.map(describeFile)).toEqual(['b.test.ts[x]']);
  });
});

describe('isPlannedTest', () => {
  const files: PlannedFile[] = [
    { filePath: A, fullNames: ['logs in'] },
    { filePath: B },
  ];

  it('takes every test of a whole file and only the listed names of a narrowed one', () => {
    expect(isPlannedTest(files, B, 'anything')).toBe(true);
    expect(isPlannedTest(files, A, 'logs in')).toBe(true);
    expect(isPlannedTest(files, A, 'logs out')).toBe(false);
    expect(isPlannedTest(files, SETUP, 'one')).toBe(false);
  });
});
