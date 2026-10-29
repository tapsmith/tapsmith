import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher, TestResultEntry, TestTreeEntry } from '../test-dispatcher.js';
import { getSessionResultsStore } from '../session-results.js';
import { clipText } from '../response-limits.js';

// The board names every failure, so each error is shortened to keep the whole
// board inside one MCP response (PILOT-657): its first line on the summary,
// 2,000 characters with details.
const BOARD_ERROR_CHARS = 200;
const DETAIL_ERROR_CHARS = 2_000;
const LINE_CHARS = 500;

type SuiteTestStatus = 'passed' | 'failed' | 'skipped' | 'interrupted' | 'not run';

interface SuiteTestRow {
  projectName?: string
  filePath: string
  fullName: string
  status: SuiteTestStatus
  error?: string
  warnings?: string[]
}

export function registerSuiteStatusTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_suite_status',
    'Report the status of every test in the discovered test tree — passed, failed, skipped, or not run — accumulated across all test runs in this MCP session. Unlike tapsmith_list_results (which only covers the most recent run), results build up across batched tapsmith_run_tests calls, so this shows the complete suite board including tests that have not run yet.',
    {
      file: z.string().optional().describe('Filter by file path substring'),
      details: z.boolean().optional().describe('List every test with its status (default false: per-file counts plus failed test names)'),
    },
    async ({ file, details }) => {
      await dispatcher.refreshTestFiles();
      const store = getSessionResultsStore(dispatcher);
      // Read-time merge: also captures runs this tool never saw start
      // (e.g. triggered from the UI or another attached MCP client).
      store.merge(dispatcher.getResults());

      const tree = dispatcher.getTestTree();
      let rows: SuiteTestRow[] = [];
      collectRows(tree, undefined, store, rows);
      // Before any bail on an empty tree: when every discovered file fails to
      // load, the tree *is* empty and these synthetic failures are the only
      // record the run happened. Answering "No test files discovered" there
      // reports nothing to see moments after reporting N failures.
      rows.push(...unmatchedFailures(store.all(), rows));
      if (rows.length === 0) {
        // Not "no tests match the filter": this bail runs before any filtering,
        // so saying that answered for a filter the caller never passed.
        const text = tree.length === 0
          ? 'No test files discovered.'
          : 'No tests found — the discovered test files declare none.';
        return { content: [{ type: 'text' as const, text }] };
      }
      if (file) rows = rows.filter((r) => r.filePath.includes(file));
      if (rows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No tests match the filter.' }] };
      }

      const lines: string[] = [];
      const total = rows.length;
      const counts = countByStatus(rows);
      const run = total - counts['not run'];
      lines.push(`Suite status: ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts['not run']} not run (${run}/${total} tests run)`);
      if (dispatcher.isRunning()) {
        lines.push('A test run is in progress — counts update as tests finish.');
      }
      lines.push('');

      // Group by project + file, preserving tree order.
      const groups = new Map<string, SuiteTestRow[]>();
      for (const row of rows) {
        const key = `${row.projectName ?? ''}::${row.filePath}`;
        const list = groups.get(key);
        if (list) list.push(row);
        else groups.set(key, [row]);
      }

      for (const groupRows of groups.values()) {
        const { projectName, filePath } = groupRows[0];
        const proj = projectName ? ` [${projectName}]` : '';
        const fileCounts = countByStatus(groupRows);
        const summary = (Object.entries(fileCounts) as Array<[SuiteTestStatus, number]>)
          .filter(([, n]) => n > 0)
          .map(([status, n]) => `${n} ${status}`)
          .join(', ');
        lines.push(`${filePath}${proj}: ${summary}`);
        for (const row of groupRows) {
          if (details) {
            lines.push(`  [${statusIcon(row.status)}] ${row.fullName}`);
            if (row.error) lines.push(`         Error: ${clipText(row.error, DETAIL_ERROR_CHARS)}`);
            for (const w of row.warnings ?? []) lines.push(`         Warning: ${clipText(w, LINE_CHARS)}`);
          } else if (row.status === 'failed') {
            const firstLine = row.error?.split('\n')[0];
            lines.push(`  FAIL: ${row.fullName}${firstLine ? ` — ${clipText(firstLine, BOARD_ERROR_CHARS)}` : ''}`);
          }
          if (!details) {
            for (const w of row.warnings ?? []) lines.push(`  WARN: ${row.fullName} — ${clipText(w, LINE_CHARS)}`);
          }
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

/**
 * Flatten the test tree into one row per test leaf, joined with the session's
 * accumulated results. Tests without a recorded result are 'not run'. Project
 * nodes set the projectName for everything beneath them, matching how run
 * results are keyed.
 *
 * A project node's name is used as-is. The dispatcher only builds project
 * nodes when the config declares projects of its own, so a node named
 * "default" is a project the user named that — and its results are recorded
 * under that name. Mapping it to `undefined` here missed every one of them and
 * reported a completed run as entirely 'not run'.
 */
function collectRows(
  nodes: TestTreeEntry[],
  projectName: string | undefined,
  store: ReturnType<typeof getSessionResultsStore>,
  out: SuiteTestRow[],
): void {
  for (const node of nodes) {
    if (node.type === 'test') {
      const result = store.get(projectName, node.filePath, node.fullName);
      out.push({
        projectName,
        filePath: node.filePath,
        fullName: node.fullName,
        status: result ? (result.status as SuiteTestStatus) : 'not run',
        error: result?.error,
        warnings: result?.warnings,
      });
    }
    if (node.children) {
      const childProject = node.type === 'project' ? node.name : projectName;
      collectRows(node.children, childProject, store, out);
    }
  }
}

/**
 * Failures that have no test-tree leaf to hang from.
 *
 * The board is built by walking the tree, which only knows tests a file
 * successfully declared. A file that fails to *load* — an import error, a
 * crashed worker — has no node at all, and its recorded failure would be the
 * one thing the whole-suite board never showed. Its tests are genuinely
 * unknown, so it appears as the single synthetic entry the dispatcher stored.
 */
function unmatchedFailures(all: TestResultEntry[], rows: SuiteTestRow[]): SuiteTestRow[] {
  const known = new Set(rows.map((r) => `${r.projectName ?? ''}::${r.filePath}::${r.fullName}`));
  // Only the flagged file-level entries, not any failed result that happens to
  // miss the tree: a test deleted since it last failed would otherwise be
  // resurrected onto the board forever.
  return all
    .filter((r) => r.status === 'failed' && r.fileLevelFailure)
    .filter((r) => !known.has(`${r.projectName ?? ''}::${r.filePath}::${r.fullName}`))
    .map((r) => ({
      projectName: r.projectName,
      filePath: r.filePath,
      fullName: r.fullName,
      status: 'failed' as const,
      error: r.error,
    }));
}

function countByStatus(rows: SuiteTestRow[]): Record<SuiteTestStatus, number> {
  const counts: Record<SuiteTestStatus, number> = { passed: 0, failed: 0, skipped: 0, interrupted: 0, 'not run': 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

function statusIcon(status: SuiteTestStatus): string {
  switch (status) {
    case 'passed': return 'PASS';
    case 'failed': return 'FAIL';
    case 'skipped': return 'SKIP';
    case 'interrupted': return 'STOP';
    case 'not run': return ' -- ';
  }
}
