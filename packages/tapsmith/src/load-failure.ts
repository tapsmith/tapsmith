/**
 * Test files that fail to load.
 *
 * Such a file reports one failed result, titled by {@link fileLoadFailureTitle},
 * in place of its tests.
 *
 * ## Pointing a "module not found" error at the import that asked for it
 *
 * A test file that imports a missing module fails inside the module resolver,
 * so the error's stack holds only resolver frames and reporters have no user
 * frame to show a code frame for. The message does name the
 * specifier and the importing file, in one of the shapes Node, tsx and Vite
 * produce; this finds the import line in that file and adds a stack frame for
 * it, so the reporter's usual code-frame rendering shows the offending line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestTreeNode } from './ui-mode/ui-protocol.js';

/**
 * Title of the single failed result a test file that cannot be loaded reports
 * in place of its tests. It names the file, as the run's other synthetic
 * whole-file results do, because several reporters (line, dot, GitHub, JUnit)
 * print a result's title without its path. Shared with UI mode, whose tree
 * shows the same row for a file whose discovery failed, so a run's result
 * lands on it.
 */
export function fileLoadFailureTitle(filePath: string): string {
  return `${path.basename(filePath)} — failed to load`;
}

/**
 * UI mode's tree node for a file whose discovery failed to load it: the file,
 * holding the one failed row its runs report, with the load error on it.
 * Without it the file vanished from the tree, its error only on the server's
 * stderr, and a run's result for it had no row to land on.
 */
export function loadFailureTreeNode(filePath: string, error: string): TestTreeNode {
  const title = fileLoadFailureTitle(filePath);
  return {
    id: filePath,
    type: 'file',
    name: path.basename(filePath),
    filePath,
    fullName: path.basename(filePath),
    status: 'idle',
    children: [{
      id: `${filePath}::${title}`,
      type: 'test',
      name: title,
      filePath,
      fullName: title,
      status: 'failed',
      error,
    }],
  };
}

/**
 * Whether UI mode's tree node for a file is its load-failure node — as opposed
 * to a discovered file, or no node at all (a discovery process that crashed
 * without reporting, which leaves an error but no node).
 */
export function isLoadFailureNode(node: TestTreeNode | undefined): boolean {
  return node?.type === 'file'
    && node.children?.length === 1
    && node.children[0].fullName === fileLoadFailureTitle(node.filePath);
}

/**
 * The tree without the files that failed to load, for MCP's `getTestTree`.
 * UI mode keeps such a file in its own tree as a failed row, but that row is
 * not a test: MCP reports these files through `getDiscoveryErrors` instead,
 * as the headless dispatcher does, so listing the row as well would offer an
 * agent a test name that names no test and put a phantom "not run" test on
 * the suite board.
 */
export function withoutLoadFailedFiles<T extends { type: string; filePath: string; children?: T[] }>(
  nodes: T[],
  loadFailed: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): T[] {
  return nodes
    .filter((n) => !(n.type === 'file' && loadFailed.has(n.filePath)))
    .map((n) => (n.type === 'project' && n.children
      ? { ...n, children: withoutLoadFailedFiles(n.children, loadFailed) }
      : n));
}

/**
 * What UI mode does to its tree after a file run, given the run's results and
 * the load error the tree currently shows for the file (if any).
 *
 * The tree learns a file fails to load from discovery, but a test file is only
 * re-discovered when it changes itself: a helper it imports can break, or be
 * fixed, without that. So the run is the other source of truth —
 * - a load failure the row does not already show → show it (the helper broke);
 * - real results for a file shown as failed to load → re-discover it (the
 *   helper was fixed), bringing its tests back.
 */
export function loadFailureFollowUp(
  results: ReadonlyArray<{ status: string; error?: Error; fileLevelFailure?: boolean }>,
  shownError: string | undefined,
): { show: string } | { rediscover: true } | undefined {
  const loadFailure = results.find((r) => r.fileLevelFailure);
  if (loadFailure) {
    const message = loadFailure.error?.message ?? 'Failed to load';
    return message === shownError ? undefined : { show: message };
  }
  if (shownError !== undefined && results.length > 0) return { rediscover: true };
  return undefined;
}

/**
 * The test filter to run a file with in UI mode. Running a file's load-failure
 * row runs the whole file: the row names no test, and as a filter it would
 * skip every real test once the file loads again.
 */
export function runFilterForFile(filePath: string, testFilter: string | undefined): string | undefined {
  return testFilter === fileLoadFailureTitle(filePath) ? undefined : testFilter;
}

interface MissingImport {
  /** The specifier as written (tsx, Vite) or as resolved to a path (Node ESM). */
  specifier: string
  /** Absolute path of the file whose import failed. */
  importer: string
  /** A bare package name (Node's "Cannot find package"). */
  isPackage: boolean
}

const IMPORT_LINE_RE = /\b(import|require|from)\b/;
const STRING_LITERAL_RE = /(['"`])([^'"`\n]+)\1/g;

/** The `?t=<ms>` query Tapsmith appends to re-imported test files to bust the ESM cache. */
const CACHE_BUST_RE = /\?t=\d+/g;

/**
 * The error a file that failed to load reports: a copy of the thrown value
 * (the loader can re-throw the very same object for another import of the
 * file, which must not change under an earlier result), without the
 * cache-bust query tsx's CommonJS resolver leaves in the importer path — it
 * differs on every import, so one error would read as a new one each run — and
 * with a frame at the failing import for a missing module.
 */
export function loadErrorForReport(err: unknown): Error {
  const source = err instanceof Error ? err : new Error(String(err));
  const copy = Object.create(Object.getPrototypeOf(source) as object) as Error;
  // Own enumerable fields (`code`, `requireStack`, …), then the
  // non-enumerable ones Error keeps as own properties, as plain values.
  Object.assign(copy, source);
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(copy, key, { value, writable: true, configurable: true, enumerable: false });
  };
  define('message', source.message.replace(CACHE_BUST_RE, ''));
  if (source.stack !== undefined) define('stack', source.stack.replace(CACHE_BUST_RE, ''));
  if (Object.prototype.hasOwnProperty.call(source, 'name')) define('name', source.name);
  if (source.cause !== undefined) define('cause', source.cause);
  return withMissingImportFrame(copy);
}

/**
 * Return `error` with a stack frame at the failing import prepended to its
 * frames when it is a missing-module error whose import line can be found.
 * Any other error, or one whose importer cannot be read, is returned as is.
 */
export function withMissingImportFrame(error: Error): Error {
  try {
    const missing = parseMissingImport(error.message);
    if (!missing) return error;
    const loc = findImportLocation(missing);
    if (!loc) return error;
    const frame = `    at ${missing.importer}:${loc.line}:${loc.column}`;
    const stack = error.stack ?? '';
    const lines = stack.split('\n');
    const firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
    if (firstFrame === -1) {
      error.stack = stack ? `${stack}\n${frame}` : `${error.name}: ${error.message}\n${frame}`;
    } else {
      lines.splice(firstFrame, 0, frame);
      error.stack = lines.join('\n');
    }
  } catch {
    // Best effort: the error itself is what matters.
  }
  return error;
}

/** @internal — exported for unit testing. */
export function parseMissingImport(message: string): MissingImport | undefined {
  const head = /Cannot find (module|package) '([^']+)'/.exec(message);
  if (!head) return undefined;
  const isPackage = head[1] === 'package';
  const specifier = head[2];
  // Node ESM and Vite: "... imported from <importer>" (Vite quotes it).
  const importedFrom = /imported from '?([^'\n]+?)'?\s*$/m.exec(message);
  // tsx (CommonJS resolver): "Require stack:\n- <importer>\n- ...".
  const requireStack = /Require stack:\n- ([^\n]+)/.exec(message);
  const raw = importedFrom?.[1] ?? requireStack?.[1];
  if (!raw) return undefined;
  return { specifier, importer: toFilePath(raw.trim()), isPackage };
}

function toFilePath(raw: string): string {
  if (!raw.startsWith('file://')) return raw.replace(/\?.*$/, '');
  const url = new URL(raw);
  url.search = '';
  url.hash = '';
  return fileURLToPath(url);
}

function findImportLocation(missing: MissingImport): { line: number; column: number } | undefined {
  const source = fs.readFileSync(missing.importer, 'utf-8');
  const dir = path.dirname(missing.importer);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!IMPORT_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(STRING_LITERAL_RE)) {
      if (matchesSpecifier(m[2], missing, dir)) return { line: i + 1, column: (m.index ?? 0) + 1 };
    }
  }
  return undefined;
}

function matchesSpecifier(literal: string, missing: MissingImport, dir: string): boolean {
  if (literal === missing.specifier) return true;
  if (missing.isPackage) return literal.startsWith(`${missing.specifier}/`);
  // Node ESM reports the resolved path rather than the specifier as written.
  if (!path.isAbsolute(missing.specifier) || !literal.startsWith('.')) return false;
  const resolved = path.resolve(dir, literal);
  return resolved === missing.specifier || stripExt(resolved) === stripExt(missing.specifier);
}

function stripExt(p: string): string {
  return p.replace(/\.[cm]?[jt]sx?$/, '');
}
