/**
 * Local file paths → the portable spelling a trace archive records (format
 * v2+, see trace-format.ts): POSIX, relative to the project's `rootDir`.
 *
 * Node-only; the packager applies it at write time so the collector's live
 * events (which UI mode opens locally) keep their absolute paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AnyTraceEvent, SourceLocation } from './types.js';

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve through the nearest existing ancestor, so a deleted file still
 * lands under its symlink-resolved directory. */
function realpathNearest(p: string): string {
  const missing: string[] = [];
  let current = p;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return p;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathOrSelf(current), ...missing);
}

const escapes = (rel: string): boolean => rel === '..' || rel.startsWith('../') || path.isAbsolute(rel);

/**
 * The archive spelling of a local file path: POSIX separators, relative to
 * `rootDir`. An already-relative path is taken to be rootDir-relative (as
 * config paths are) and only normalised; a file outside `rootDir` climbs
 * with `..` rather than naming the recording machine's layout.
 *
 * Symlinks are resolved when the lexical answer escapes `rootDir`, because
 * Node reports realpath'd module paths while a config's `rootDir` may be
 * spelled through a link (macOS `/tmp` → `/private/tmp`). Once the lexical
 * answer escapes, the physical one is used even if it escapes too (a
 * monorepo helper beside a linked rootDir): a realpath'd frame measured from
 * a linked root mixes two views of the filesystem, and only the physical
 * relative path is the same on a machine where the root is not linked.
 */
export function toArchivePath(file: string, rootDir: string): string {
  if (!file) return file;
  const normalised = file.replace(/\\/g, '/');
  if (!path.isAbsolute(normalised)) {
    return path.posix.normalize(normalised).replace(/^(\.\/)+/, '');
  }
  const toPosix = (rel: string): string => rel.split(path.sep).join('/') || '.';
  const lexical = toPosix(path.relative(rootDir, normalised));
  if (!escapes(lexical)) return lexical;
  const physical = toPosix(path.relative(realpathOrSelf(rootDir), realpathNearest(normalised)));
  return path.isAbsolute(physical) ? lexical : physical;
}

/** Maps a local file path to its archive spelling. */
export type ArchivePathMapper = (file: string) => string;

/**
 * A {@link toArchivePath} that also knows the lexical spelling of `knownFiles`
 * (the test file and other discovery-supplied paths). A stack frame names a
 * module by its realpath, so when a directory under `rootDir` is a symlink
 * into another tree, the frame's physical path escapes `rootDir` and
 * `toArchivePath` alone would record it as `../../elsewhere/…` while the test
 * file reads `e2e/a.test.ts`.
 *
 * So every directory between a known file and `rootDir` whose physical
 * location differs from its lexical one is remembered, and a path under one
 * of them is re-spelled through it (longest match wins) — whether the link's
 * target lies outside `rootDir` or inside it (`e2e` → `shared/e2e`). That covers
 * the test file's siblings too — a screen object in `e2e/screens/` beside a
 * test in `e2e/tests/` — not just the test file. A known file that is itself a
 * link maps directly.
 */
export function archivePathMapper(rootDir: string, knownFiles: readonly string[] = []): ArchivePathMapper {
  const byFile = new Map<string, string>();
  const byDir = new Map<string, string>();
  for (const known of knownFiles) {
    if (!known || !path.isAbsolute(known)) continue;
    const resolved = path.resolve(known);
    // Only a file spelled under rootDir has a lexical chain to map back to:
    // the walk below climbs its directories in lockstep with its
    // rootDir-relative spelling, which a path reaching rootDir from outside
    // (through links) does not have.
    if (escapes(path.relative(rootDir, resolved).split(path.sep).join('/'))) continue;
    const lexicalRel = toArchivePath(known, rootDir);
    byFile.set(realpathNearest(resolved), lexicalRel);
    let dir = path.dirname(resolved);
    let relDir = path.posix.dirname(lexicalRel);
    while (relDir !== '.') {
      const physical = realpathOrSelf(dir);
      if (physical !== dir) byDir.set(physical, relDir);
      dir = path.dirname(dir);
      relDir = path.posix.dirname(relDir);
    }
  }
  const dirs = [...byDir].sort(([a], [b]) => b.length - a.length);

  // One packaging maps the same handful of files once per frame of every
  // step; each mapping costs realpath/exists syscalls, so remember them.
  const cache = new Map<string, string>();
  return (file) => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    const mapped = mapUncached(file);
    cache.set(file, mapped);
    return mapped;
  };

  function mapUncached(file: string): string {
    const direct = toArchivePath(file, rootDir);
    // Seeds are consulted even when `direct` stays inside rootDir: a link whose
    // target is elsewhere under rootDir would otherwise win with its target.
    if (!file || (byFile.size === 0 && dirs.length === 0)) return direct;
    const normalised = file.replace(/\\/g, '/');
    if (!path.isAbsolute(normalised)) return direct;
    const physical = realpathNearest(path.resolve(normalised));
    const exact = byFile.get(physical);
    if (exact) return exact;
    for (const [dir, relDir] of dirs) {
      // Segment boundary: a link to /x/e2e must not claim /x/e2e2/….
      if (physical.startsWith(dir + path.sep)) {
        return `${relDir}/${physical.slice(dir.length + 1).split(path.sep).join('/')}`;
      }
    }
    return direct;
  }
}

const portableFrame = (frame: SourceLocation, toPath: ArchivePathMapper): SourceLocation =>
  ({ ...frame, file: toPath(frame.file) });

/**
 * Copies of `events` with every structured source path (`sourceLocation`,
 * `stack[]`) rewritten to its archive spelling. Free text — messages, error
 * stacks — is display-only and left as recorded. The input is not mutated:
 * UI mode streams the same objects with absolute paths it opens locally.
 */
export function withPortablePaths(
  events: readonly AnyTraceEvent[],
  toPath: ArchivePathMapper,
): AnyTraceEvent[] {
  return events.map((event) => {
    if (event.type !== 'action' && event.type !== 'assertion') return event;
    if (!event.sourceLocation && !event.stack) return event;
    return {
      ...event,
      ...(event.sourceLocation ? { sourceLocation: portableFrame(event.sourceLocation, toPath) } : {}),
      ...(event.stack ? { stack: event.stack.map((f) => portableFrame(f, toPath)) } : {}),
    };
  });
}
