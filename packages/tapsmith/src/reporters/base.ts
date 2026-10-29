/**
 * Shared ANSI helpers and utilities for console-based reporters.
 */

import * as fs from 'node:fs';
import { buildCodeSnippet } from '../trace/code-frame.js';
import { extractStack, userStackFrames } from '../trace/trace-collector.js';
import type { TestResult } from '../runner.js';

// ─── ANSI codes ───

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
export function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
export function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
export function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

// ─── Formatting helpers ───

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function statusIcon(status: 'passed' | 'failed' | 'skipped'): string {
  switch (status) {
    case 'passed': return green('✓');
    case 'failed': return red('✗');
    case 'skipped': return yellow('○');
  }
}

export function formatSummaryLine(
  passed: number,
  failed: number,
  skipped: number,
  durationMs: number,
  setupDurationMs?: number,
  flaky?: number,
): string {
  const parts = [
    passed > 0 ? green(`${passed} passed`) : null,
    flaky ? yellow(`${flaky} flaky`) : null,
    failed > 0 ? red(`${failed} failed`) : null,
    skipped > 0 ? yellow(`${skipped} skipped`) : null,
  ].filter(Boolean);

  let timing: string;
  if (setupDurationMs != null && setupDurationMs > 0) {
    const testDuration = Math.max(0, durationMs - setupDurationMs);
    timing = ` | ${formatDuration(durationMs)} (setup ${formatDuration(setupDurationMs)}, tests ${formatDuration(testDuration)})`;
  } else {
    timing = ` | ${formatDuration(durationMs)}`;
  }

  return bold('Summary: ') + parts.join(', ') + dim(timing);
}

/**
 * ` (retry #N)` after a retry attempt's title, as Playwright prints it, so a
 * second line for the same test reads as a retry rather than as the test
 * running twice by mistake (PILOT-569). Empty for a first attempt.
 */
export function retrySuffix(retry: number | undefined): string {
  return retry != null && retry > 0 ? ` (retry #${retry})` : '';
}

export function countFlaky(tests: TestResult[]): number {
  return tests.filter((t) => t.status === 'passed' && t.retry != null && t.retry > 0).length;
}

/**
 * Format the flaky-tests section for run summaries: each test that passed on
 * retry, with the first failed attempt's error and linked trace so the
 * failure is diagnosable without re-running. Returns '' when nothing flaked.
 */
export function formatFlakySection(
  tests: TestResult[],
  opts: { showWorkerTags?: boolean; showProjectTags?: boolean } = {},
): string {
  const flakyTests = tests.filter((t) => t.status === 'passed' && t.retry != null && t.retry > 0);
  if (flakyTests.length === 0) return '';
  const lines: string[] = [];
  lines.push(`  ${yellow(`${flakyTests.length} flaky`)}`);
  for (const test of flakyTests) {
    const worker = opts.showWorkerTags ? workerTag(test.workerIndex) : '';
    const project = opts.showProjectTags ? projectTag(test.project) : '';
    lines.push(`    ${worker}${project}${test.fullName}`);
    if (test.firstAttemptError) {
      lines.push(formatError(test.firstAttemptError));
    }
    lines.push(...formatWarnings(test));
    if (test.tracePath) {
      const tag = test.failedAttemptArtifacts?.trace ? ' (failed attempt)' : '';
      lines.push(`        ${dim(`Trace${tag}: npx tapsmith show-trace ${test.tracePath}`)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** A test's warnings (e.g. a dialog the preflight closed), one indented line each. */
export function formatWarnings(test: Pick<TestResult, 'warnings'>, indent = '        '): string[] {
  return (test.warnings ?? []).map((w) => `${indent}${yellow(`⚠ ${w}`)}`);
}

export function workerTag(workerIndex: number | undefined): string {
  if (workerIndex == null) return '';
  return dim(`[worker ${workerIndex}]`) + ' ';
}

export function projectTag(project: string | undefined): string {
  if (!project) return '';
  return dim(`[${project}]`) + ' ';
}

/** A stack line that is a frame (`    at …`). */
const FRAME_LINE_RE = /^\s*at\s/;

/**
 * The first `max` frames of an error's stack worth showing under its message:
 * Tapsmith's own and Node's internal frames filtered out *before* the cap, so
 * the test's frame is never pushed out by SDK wrappers (PILOT-841). Errors
 * with no user frame keep their raw frames ({@link userStackFrames}).
 */
export function errorStackFrames(error: Error, max: number): string[] {
  if (!error.stack) return [];
  // The stack opens with "<name>: <message>", which the reporter prints on its
  // own: the frames start at its first "at" line. Matching the header against
  // error.name and error.message instead misses whenever they changed after
  // the stack was taken — --workers, watch and merged reports rebuild errors
  // as new Error(message) under another name, and the runner appends
  // "--- Additionally ---" blocks to the message — and a multi-line message's
  // later lines then fill the frame cap.
  const lines = error.stack.split('\n');
  const first = lines.findIndex((line) => FRAME_LINE_RE.test(line));
  if (first === -1) return [];
  return userStackFrames(lines.slice(first)).slice(0, max);
}

export function formatError(error: Error, indent: string = '        '): string {
  const lines: string[] = [];
  // Every line under the indent: a multi-line message's later lines (a
  // matcher's Expected/Received, a start error's detail) would otherwise
  // start at column 0, under nothing.
  for (const line of error.message.split('\n')) lines.push(line === '' ? '' : `${indent}${red(line)}`);

  if (error.stack) {
    // Find the first user-code frame via extractStack, which owns the
    // framework-frame classification: it skips tapsmith internals in BOTH
    // layouts (packages/tapsmith/* in the monorepo, node_modules/* for npm
    // installs) plus node internals. An ad-hoc '/packages/tapsmith/' check
    // here once missed npm installs and rendered snippets of dist/runner.js.
    const userLoc = extractStack(error.stack)[0];

    // Show code snippet from the user frame
    const snippet = userLoc ? extractCodeSnippet(userLoc.file, userLoc.line) : null;
    if (snippet) {
      lines.push('');
      for (const sl of snippet.lines) {
        const gutter = String(sl.lineNumber).padStart(snippet.gutterWidth);
        if (sl.highlight) {
          lines.push(`${indent}${red('>')} ${red(gutter)} ${red('|')} ${red(sl.text)}`);
        } else {
          lines.push(`${indent}  ${dim(gutter)} ${dim('|')} ${dim(sl.text)}`);
        }
      }
      lines.push('');
    }

    for (const line of errorStackFrames(error, 3)) {
      lines.push(`${indent}${dim(line.trim())}`);
    }
  }
  return lines.join('\n');
}

// ─── Code snippet extraction ───

function extractCodeSnippet(filePath: string, lineNum: number): ReturnType<typeof buildCodeSnippet> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, 'utf-8');
    return buildCodeSnippet(source, lineNum);
  } catch {
    return null;
  }
}
