import { describe, it, expect } from 'vitest';
import { resolveRunSelection, selectionKey, visibleRunSelection, type SelectionSuite } from '../ui-mode/run-selection.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';

// ─── Tree builders (the shapes ui-discover.ts and ui-server.ts emit) ───

function test(filePath: string, fullName: string, prefix = ''): TestTreeNode {
  return { id: `${prefix}${filePath}::${fullName}`, type: 'test', name: fullName.split(' > ').pop()!, filePath, fullName, status: 'idle' };
}

function suite(filePath: string, fullName: string, children: TestTreeNode[], prefix = ''): TestTreeNode {
  return { id: `${prefix}${filePath}::${fullName}`, type: 'suite', name: fullName.split(' > ').pop()!, filePath, fullName, status: 'idle', children };
}

function file(filePath: string, children: TestTreeNode[], prefix = ''): TestTreeNode {
  return { id: `${prefix}${filePath}`, type: 'file', name: filePath.split('/').pop()!, filePath, fullName: filePath.split('/').pop()!, status: 'idle', children };
}

function project(name: string, children: TestTreeNode[]): TestTreeNode {
  return { id: `project::${name}`, type: 'project', name, filePath: '', fullName: name, status: 'idle', children };
}

const A = '/repo/a.test.ts';
const B = '/repo/b.test.ts';

describe('visibleRunSelection', () => {
  it('collects every test of a flat tree by file, with exact full names', () => {
    const tree = [
      file(A, [test(A, 'logs in'), suite(A, 'Login', [test(A, 'Login > submits'), suite(A, 'Login > nested', [test(A, 'Login > nested > deep')])])]),
      file(B, [test(B, 'b one')]),
    ];
    expect(visibleRunSelection(tree)).toEqual([
      { filePath: A, tests: ['logs in', 'Login > submits', 'Login > nested > deep'] },
      { filePath: B, tests: ['b one'] },
    ]);
  });

  it('keeps a file under each project it shows in, named by that project', () => {
    const tree = [
      project('android', [file(A, [test(A, 'logs in', 'project::android::')], 'project::android::')]),
      project('ios', [file(A, [test(A, 'logs in', 'project::ios::')], 'project::ios::')]),
    ];
    expect(visibleRunSelection(tree)).toEqual([
      { filePath: A, projectName: 'android', tests: ['logs in'] },
      { filePath: A, projectName: 'ios', tests: ['logs in'] },
    ]);
  });

  it('is empty for an empty tree', () => {
    expect(visibleRunSelection([])).toEqual([]);
  });

  it('skips files and suites left with no test', () => {
    expect(visibleRunSelection([file(A, [suite(A, 'empty', [])])])).toEqual([]);
  });
});

describe('resolveRunSelection', () => {
  const flat: SelectionSuite = {
    testFiles: [A, B],
    isWholeFileName: (f, n) => n === `${f.split('/').pop()} — failed to load`,
  };
  const withProjects: SelectionSuite = {
    ...flat,
    projects: [{ name: 'android', testFiles: [A, B] }, { name: 'ios', testFiles: [A] }],
  };

  it('maps each entry to its exact names', () => {
    const r = resolveRunSelection([{ filePath: A, tests: ['x', 'y'] }], flat);
    expect([...r]).toEqual([[selectionKey(undefined, A), ['x', 'y']]]);
  });

  it('drops files the suite does not have, and entries with no test', () => {
    const r = resolveRunSelection([
      { filePath: '/repo/gone.test.ts', tests: ['x'] },
      { filePath: A, tests: [] },
      { filePath: B, tests: [42, 'b'] },
      null,
      'nonsense',
    ], flat);
    expect([...r]).toEqual([[selectionKey(undefined, B), ['b']]]);
  });

  it('is empty when the selection is not a list', () => {
    expect(resolveRunSelection(undefined, flat).size).toBe(0);
    expect(resolveRunSelection({ filePath: A }, flat).size).toBe(0);
  });

  it('runs the whole file for a missing test list or the load-failure row', () => {
    const r = resolveRunSelection([
      { filePath: A },
      { filePath: B, tests: ['b.test.ts — failed to load'] },
    ], flat);
    expect(r.get(selectionKey(undefined, A))).toBeUndefined();
    expect(r.has(selectionKey(undefined, A))).toBe(true);
    expect(r.has(selectionKey(undefined, B))).toBe(true);
    expect(r.get(selectionKey(undefined, B))).toBeUndefined();
  });

  it('keys by project, and drops projects the suite does not have or that lack the file', () => {
    const r = resolveRunSelection([
      { filePath: A, projectName: 'android', tests: ['x'] },
      { filePath: A, projectName: 'ios', tests: ['x'] },
      { filePath: B, projectName: 'ios', tests: ['b'] },
      { filePath: A, projectName: 'web', tests: ['x'] },
      { filePath: A, tests: ['x'] },
    ], withProjects);
    expect([...r.keys()]).toEqual([selectionKey('android', A), selectionKey('ios', A)]);
  });

  it('ignores a project name when no projects are configured', () => {
    const r = resolveRunSelection([{ filePath: A, projectName: 'default', tests: ['x'] }], flat);
    expect([...r.keys()]).toEqual([selectionKey(undefined, A)]);
  });

  it('merges duplicate entries, and a whole-file entry wins', () => {
    const merged = resolveRunSelection([
      { filePath: A, tests: ['x', 'x'] },
      { filePath: A, tests: ['y', 'x'] },
    ], flat);
    expect(merged.get(selectionKey(undefined, A))).toEqual(['x', 'y']);

    const whole = resolveRunSelection([
      { filePath: A, tests: ['x'] },
      { filePath: A },
      { filePath: A, tests: ['y'] },
    ], flat);
    expect(whole.has(selectionKey(undefined, A))).toBe(true);
    expect(whole.get(selectionKey(undefined, A))).toBeUndefined();
  });
});
