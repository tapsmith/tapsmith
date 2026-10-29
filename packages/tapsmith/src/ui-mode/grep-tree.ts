/**
 * A config's `grep` / `grepInvert` applied to a discovered file's test tree.
 *
 * A test a grep leaves out is not part of the suite — not run, listed or
 * counted as skipped (docs/configuration.md) — so UI mode and the headless
 * MCP server leave it out of the tree they list. Runs do not rely on the
 * tree, which can be stale: the worker applies the same filters to what the
 * file holds when it runs (it passes them to `runTestFile`), as
 * `tapsmith test` does.
 */

import { hasGrepFilter, matchesTestFilter, passesSelectionFilters, type GrepFilters } from '../test-filter.js';
import { isLoadFailureNode } from '../load-failure.js';
import type { TestTreeNode } from './ui-protocol.js';

/**
 * A file's tree with only the tests the grep selects, and without the suites
 * that leaves empty; `undefined` when it selects none. The tree is returned
 * as it is without a grep, and so is a file that failed to load: which of its
 * tests a grep would select is unknown, so it keeps its failed row and its
 * runs report the load error, as `tapsmith test` does.
 */
export function pruneTreeByGrep(file: TestTreeNode, filters: GrepFilters): TestTreeNode | undefined {
  if (!hasGrepFilter(filters) || isLoadFailureNode(file)) return file;
  const prune = (node: TestTreeNode): TestTreeNode | undefined => {
    if (node.type === 'test') return passesSelectionFilters(node.fullName, filters) ? node : undefined;
    const children = (node.children ?? [])
      .map(prune)
      .filter((n): n is TestTreeNode => n !== undefined);
    return children.length > 0 ? { ...node, children } : undefined;
  };
  return prune(file);
}

/**
 * The tests a run of one file covers, as UI mode's tree shows them: the
 * file's rows under its project (the whole tree without one), narrowed by the
 * run's test filter and exact names. The tree is already pruned by the grep,
 * so a file no worker can run fails only the tests its run would have run.
 */
export function fileTestsInTree(
  tree: readonly TestTreeNode[],
  file: { filePath: string; projectName?: string; testFilter?: string; fullNames?: readonly string[] },
): TestTreeNode[] {
  const roots = file.projectName
    ? tree.filter((n) => n.type === 'project' && n.name === file.projectName).flatMap((n) => n.children ?? [])
    : tree;
  const tests: TestTreeNode[] = [];
  const walk = (nodes: readonly TestTreeNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'test') tests.push(node);
      if (node.children) walk(node.children);
    }
  };
  walk(roots.filter((n) => n.type === 'file' && n.filePath === file.filePath));
  return tests.filter((t) => (!file.testFilter || matchesTestFilter(t.fullName, file.testFilter))
    && (!file.fullNames || file.fullNames.includes(t.fullName)));
}
