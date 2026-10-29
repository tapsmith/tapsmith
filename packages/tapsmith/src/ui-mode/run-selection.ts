/**
 * The tests a filtered "Run all" runs.
 *
 * Playwright's UI mode runs only the tests visible in the tree when a filter is
 * applied. The client derives that set from the tree it is showing and sends it
 * with `run-all`; the server checks it against the suite it discovered and runs
 * exactly those tests, one dispatch per (project, file).
 *
 * Shared by the SPA and the server, so it must stay free of Node imports.
 */

import type { RunSelectionEntry, TestTreeNode } from './ui-protocol.js';

// ─── Client: the visible tests ───

/**
 * Every test in a (filtered) tree, grouped by project and file in tree order.
 * Test names are exact full names; a file appears once per project it shows
 * under, so a test visible under two projects runs on both.
 */
export function visibleRunSelection(tree: readonly TestTreeNode[]): RunSelectionEntry[] {
  const entries: RunSelectionEntry[] = [];
  const byKey = new Map<string, RunSelectionEntry>();
  const walk = (nodes: readonly TestTreeNode[], projectName: string | undefined): void => {
    for (const node of nodes) {
      if (node.type === 'project') {
        walk(node.children ?? [], node.name);
        continue;
      }
      if (node.type === 'test') {
        const key = selectionKey(projectName, node.filePath);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { filePath: node.filePath, ...(projectName !== undefined ? { projectName } : {}), tests: [] };
          byKey.set(key, entry);
          entries.push(entry);
        }
        entry.tests!.push(node.fullName);
        continue;
      }
      walk(node.children ?? [], projectName);
    }
  };
  walk(tree, undefined);
  return entries;
}

// ─── Server: what the selection runs ───

/** Map key for one (project, file) pair of a selection. */
export function selectionKey(projectName: string | undefined, filePath: string): string {
  return JSON.stringify([projectName ?? null, filePath]);
}

export interface SelectionSuite {
  /** Every discovered test file. */
  testFiles: readonly string[]
  /**
   * The configured (non-synthesized) projects and their files, or undefined
   * when the config has none — then entries carry no project.
   */
  projects?: ReadonlyArray<{ name: string; testFiles: readonly string[] }>
  /**
   * Whether `fullName` stands for the whole file rather than one test — the
   * row a file that failed to load shows in place of its tests. Running it
   * means running the file.
   */
  isWholeFileName(filePath: string, fullName: string): boolean
}

/**
 * The selection as the server will run it: selection key → the exact full
 * names to run in that file, or `undefined` for the whole file.
 *
 * The selection comes from a client's tree, which can be stale (a file deleted
 * or a project renamed since it rendered) or simply malformed: entries naming
 * a file or project the suite does not have, or no test, are dropped rather
 * than run. Duplicate entries for one (project, file) merge.
 */
export function resolveRunSelection(
  entries: unknown,
  suite: SelectionSuite,
): Map<string, readonly string[] | undefined> {
  const resolved = new Map<string, string[] | undefined>();
  if (!Array.isArray(entries)) return resolved;
  const files = new Set(suite.testFiles);
  const projects = suite.projects ? new Map(suite.projects.map((p) => [p.name, new Set(p.testFiles)])) : undefined;

  for (const raw of entries as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const { filePath, projectName, tests } = raw as Record<string, unknown>;
    if (typeof filePath !== 'string' || !files.has(filePath)) continue;

    let project: string | undefined;
    if (projects) {
      if (typeof projectName !== 'string' || !projects.get(projectName)?.has(filePath)) continue;
      project = projectName;
    }

    const key = selectionKey(project, filePath);
    // No test list means the whole file.
    if (tests === undefined) {
      resolved.set(key, undefined);
      continue;
    }
    if (!Array.isArray(tests)) continue;
    const names = tests.filter((t): t is string => typeof t === 'string');
    if (names.length === 0) continue;
    if (names.some((n) => suite.isWholeFileName(filePath, n))) {
      resolved.set(key, undefined);
      continue;
    }
    if (resolved.has(key)) {
      const prior = resolved.get(key);
      // Already the whole file: nothing to add.
      if (prior === undefined) continue;
      for (const n of names) if (!prior.includes(n)) prior.push(n);
      continue;
    }
    resolved.set(key, [...new Set(names)]);
  }
  return resolved;
}
