/**
 * How the CLI reports a config file that could not be imported.
 *
 * The error's message names the file — with `:<line>:<col>` for a syntax
 * error — and is printed once, followed by a code frame of the offending
 * line. The loader's stack (tsx, esbuild and Tapsmith frames) is noise to a
 * user fixing a typo: only frames in their own files are shown, and the full
 * stack is left to `TAPSMITH_DEBUG`.
 */

import * as fs from 'node:fs';
import type { ConfigLoadFailure } from './config.js';
import { buildCodeSnippet } from './trace/code-frame.js';
import { extractStack } from './trace/trace-collector.js';

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';

const MAX_USER_FRAMES = 3;

export function formatConfigLoadFailure(
  err: Error,
  failure: ConfigLoadFailure,
  opts: { color?: boolean } = {},
): string {
  const color = opts.color ?? true;
  const red = (s: string): string => (color ? `${RED}${s}${RESET}` : s);
  const dim = (s: string): string => (color ? `${DIM}${s}${RESET}` : s);

  const lines = [red(err.message)];
  const cause = err.cause instanceof Error ? err.cause : undefined;
  // A syntax error is located by the message itself; anything else that
  // happened in the user's code (the config throwing) by its stack.
  const userFrames = !failure.location && cause?.stack ? extractStack(cause.stack) : [];
  const at = failure.location ?? userFrames[0];
  const frame = at ? codeFrame(at.file, at.line, at.column, { red, dim }) : undefined;
  if (frame) lines.push('', ...frame);
  if (userFrames.length > 0) {
    lines.push('');
    for (const f of userFrames.slice(0, MAX_USER_FRAMES)) lines.push(dim(`    at ${f.file}:${f.line}:${f.column}`));
  }
  return lines.join('\n');
}

function codeFrame(
  file: string,
  line: number,
  column: number | undefined,
  style: { red: (s: string) => string; dim: (s: string) => string },
): string[] | undefined {
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf-8');
  } catch {
    return undefined;
  }
  const snippet = buildCodeSnippet(source, line);
  if (!snippet.lines.some((l) => l.highlight)) return undefined;
  // A file's trailing newline is not a line worth showing.
  const shown = [...snippet.lines];
  while (shown.length > 0 && !shown[shown.length - 1].highlight && shown[shown.length - 1].text === '') shown.pop();
  const out: string[] = [];
  for (const sl of shown) {
    const gutter = String(sl.lineNumber).padStart(snippet.gutterWidth);
    if (!sl.highlight) {
      out.push(style.dim(`    ${gutter} | ${sl.text}`));
      continue;
    }
    out.push(`  ${style.red('>')} ${gutter} | ${sl.text}`);
    if (column !== undefined && column >= 1) {
      // Tabs stay tabs so the caret lines up with the line above.
      const pad = sl.text.slice(0, column - 1).replace(/[^\t]/g, ' ');
      out.push(`    ${' '.repeat(snippet.gutterWidth)} | ${pad}${style.red('^')}`);
    }
  }
  return out;
}
