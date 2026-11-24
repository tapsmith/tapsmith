/** `tapsmith test --list`: the tests a run would run, one per line. */

import * as path from 'node:path';

export interface ListedTest {
  /** Unset when the config declares no projects. */
  project?: string
  file: string
  fullName: string
  /** Where the test was declared: usually in `file`, or in a helper it imports. */
  location?: { file: string; line: number; column?: number }
}

/** Playwright's listing, with the test's full name as `--grep` matches it. */
export function formatTestListing(tests: ListedTest[], rootDir: string): string {
  const lines = ['Listing tests:'];
  for (const { project, file, fullName, location } of tests) {
    const { file: declaredIn, line, column } = location ?? { file, line: undefined, column: undefined };
    const at = [path.relative(rootDir, declaredIn).split(path.sep).join('/'), line, column]
      .filter((part) => part !== undefined).join(':');
    lines.push(`  ${project !== undefined ? `[${project}] › ` : ''}${at} › ${fullName}`);
  }
  const files = new Set(tests.map((t) => t.file)).size;
  lines.push(`Total: ${tests.length} ${tests.length === 1 ? 'test' : 'tests'} in ${files} ${files === 1 ? 'file' : 'files'}`);
  return lines.join('\n');
}
