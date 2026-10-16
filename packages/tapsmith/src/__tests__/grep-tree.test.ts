import { describe, it, expect } from 'vitest';
import { fileTestsInTree, grepSelectsNothing, pruneTreeByGrep } from '../ui-mode/grep-tree.js';
import { grepFiltersFor } from '../test-filter.js';
import { loadFailureTreeNode } from '../load-failure.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';

const FILE = '/suite/login.test.ts';

function test(fullName: string): TestTreeNode {
  return { id: `${FILE}::${fullName}`, type: 'test', name: fullName.split(' > ').pop()!, filePath: FILE, fullName, status: 'idle' };
}

function suite(fullName: string, children: TestTreeNode[]): TestTreeNode {
  return { id: `${FILE}::${fullName}`, type: 'suite', name: fullName.split(' > ').pop()!, filePath: FILE, fullName, status: 'idle', children };
}

function file(children: TestTreeNode[]): TestTreeNode {
  return { id: FILE, type: 'file', name: 'login.test.ts', filePath: FILE, fullName: 'login.test.ts', status: 'idle', children };
}

const names = (node: TestTreeNode | undefined): string[] =>
  !node ? [] : node.type === 'test' ? [node.fullName] : (node.children ?? []).flatMap(names);

const tree = file([
  test('smoke: opens'),
  suite('Login', [
    test('Login > smoke: submits'),
    test('Login > rejects a bad password'),
  ]),
  suite('Logout', [test('Logout > clears the session')]),
]);

describe('pruneTreeByGrep', () => {
  it('leaves the tree as it is without a grep', () => {
    expect(pruneTreeByGrep(tree, grepFiltersFor({}))).toBe(tree);
  });

  it('keeps only the tests the grep selects, and drops suites left empty', () => {
    const pruned = pruneTreeByGrep(tree, grepFiltersFor({ grep: /smoke/ }));
    expect(names(pruned)).toEqual(['smoke: opens', 'Login > smoke: submits']);
    expect(pruned!.children!.map((n) => n.fullName)).toEqual(['smoke: opens', 'Login']);
    // Ids are untouched, so status updates still find the rows.
    expect(pruned!.children![1].children![0].id).toBe(`${FILE}::Login > smoke: submits`);
  });

  it('applies grepInvert and the project filters with the root ones', () => {
    const pruned = pruneTreeByGrep(tree, grepFiltersFor({ grepInvert: /smoke/ }, { grep: /Log/ }));
    expect(names(pruned)).toEqual(['Login > rejects a bad password', 'Logout > clears the session']);
  });

  it('drops a file the grep selects nothing in', () => {
    expect(pruneTreeByGrep(tree, grepFiltersFor({ grep: /checkout/ }))).toBeUndefined();
    expect(pruneTreeByGrep(file([]), grepFiltersFor({ grep: /checkout/ }))).toBeUndefined();
  });

  it('keeps a file that failed to load: which of its tests a grep selects is unknown', () => {
    const failed = loadFailureTreeNode(FILE, 'SyntaxError');
    expect(pruneTreeByGrep(failed, grepFiltersFor({ grep: /checkout/ }))).toBe(failed);
  });

  it('does not change the tree it was given', () => {
    const before = JSON.stringify(tree);
    pruneTreeByGrep(tree, grepFiltersFor({ grep: /smoke/ }));
    expect(JSON.stringify(tree)).toBe(before);
  });
});

describe('grepSelectsNothing', () => {
  it('is true for a discovered file whose tests the grep all leaves out', () => {
    expect(grepSelectsNothing(tree, grepFiltersFor({ grep: /checkout/ }))).toBe(true);
  });

  it('is false when the grep selects a test, or without a grep', () => {
    expect(grepSelectsNothing(tree, grepFiltersFor({ grep: /smoke/ }))).toBe(false);
    expect(grepSelectsNothing(tree, grepFiltersFor({}))).toBe(false);
    expect(grepSelectsNothing(file([]), grepFiltersFor({}))).toBe(false);
  });

  it('is false when the tests are unknown: a file that failed to load, or was never discovered', () => {
    expect(grepSelectsNothing(loadFailureTreeNode(FILE, 'boom'), grepFiltersFor({ grep: /checkout/ }))).toBe(false);
    expect(grepSelectsNothing(undefined, grepFiltersFor({ grep: /checkout/ }))).toBe(false);
  });
});

// PILOT-593: a file no worker can run fails each of its tests — only those
// its run would have run, so not the ones the config's grep leaves out.
describe('fileTestsInTree', () => {
  const OTHER = '/suite/other.test.ts';
  const project = (name: string, files: TestTreeNode[]): TestTreeNode => ({
    id: `project::${name}`, type: 'project', name, filePath: '', fullName: name, status: 'idle', children: files,
  });
  const other: TestTreeNode = { ...file([]), id: OTHER, filePath: OTHER, children: [{ ...test('smoke: elsewhere'), filePath: OTHER }] };

  it('reads a grep-pruned tree: one smoke and one non-smoke test fail only the smoke one', () => {
    const smokeOnly = (n: TestTreeNode) => pruneTreeByGrep(n, grepFiltersFor({ grep: /smoke/ }))!;
    const unservable = file([test('smoke: opens'), test('settings: saves')]);
    const pruned = [project('android', [smokeOnly(unservable), other])];
    expect(fileTestsInTree(pruned, { filePath: FILE, projectName: 'android' }).map((t) => t.fullName)).toEqual(['smoke: opens']);
  });

  it('scopes to the project, and narrows by the test filter and exact names', () => {
    const projects = [project('android', [tree]), project('ios', [file([test('ios only')])])];
    expect(fileTestsInTree(projects, { filePath: FILE, projectName: 'ios' }).map((t) => t.fullName)).toEqual(['ios only']);
    expect(fileTestsInTree(projects, { filePath: FILE, projectName: 'android', testFilter: 'LOGIN' }).map((t) => t.fullName))
      .toEqual(['Login > smoke: submits', 'Login > rejects a bad password']);
    expect(fileTestsInTree(projects, { filePath: FILE, projectName: 'android', fullNames: ['smoke: opens'] }).map((t) => t.fullName))
      .toEqual(['smoke: opens']);
  });

  it('reads the whole tree without projects', () => {
    expect(fileTestsInTree([tree, other], { filePath: OTHER }).map((t) => t.fullName)).toEqual(['smoke: elsewhere']);
  });
});
