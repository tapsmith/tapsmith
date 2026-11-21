/**
 * How the runner imports a test file, so that every run of it registers its
 * tests — however many times one process runs it.
 *
 * A test file registers its tests as a side effect of being evaluated, and
 * Node evaluates a module once per URL. One process runs the same file again
 * whenever a second project shares it, a file is retried, a persistent
 * parallel worker is handed it again, or UI mode re-runs it. A plain second
 * `import()` returns the cached module, nothing registers, and the run
 * reports that file as empty — green, having run nothing.
 *
 * So the runner, not each embedder, decides: the first import of a file in a
 * process uses its plain path, and every later one a URL no import has used
 * before, after dropping the file from the CommonJS module cache — a test
 * file tsx compiled to CommonJS (any project without `"type": "module"`), or a
 * plain CommonJS `.js` file, is cached there by path and a new URL alone does
 * not re-evaluate it. Only the test file itself is re-evaluated; the modules
 * it imports stay cached for the life of the process (UI mode recycles its
 * workers for fresh helper code). So tests a helper registers at its top level
 * register only once: a re-import of an unchanged file that registers fewer
 * tests than before fails the file, saying why, rather than pass without them.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ImportRecord {
  /** How many tests the file registered the last time it was imported. */
  tests: number
  /** The file's mtime at that import, when it could be read. */
  mtimeMs: number | undefined
}

/**
 * The query a re-import appends to the file's URL. Not Vite's `t`: Vite-based
 * loaders (vitest among them) strip a `?t=` timestamp from a plain path, and
 * would hand back the cached module.
 */
export const TEST_FILE_IMPORT_QUERY = 'tapsmithImport';

const imports = new Map<string, ImportRecord>();
const requireCache = createRequire(import.meta.url).cache;
/** The last cache-bust stamp handed out: unique, so two imports in one millisecond never share a URL. */
let lastStamp = 0;

/**
 * The file's real path on disk, whether the runner was given a path or a
 * `file:` URL: Node caches a module under its real path, so two spellings of
 * one file through a symlink are one module, and must be one record here.
 */
function diskPath(filePath: string): string {
  let file = filePath;
  if (filePath.startsWith('file:')) {
    try {
      file = fileURLToPath(filePath);
    } catch {
      return filePath;
    }
  }
  file = path.resolve(file);
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function forgetCommonJsModule(filePath: string, file: string): void {
  // Keyed by the path the loader resolved: the real path, or the path as
  // given under --preserve-symlinks.
  delete requireCache[file];
  if (!filePath.startsWith('file:')) delete requireCache[path.resolve(filePath)];
}

/** A file being imported: the URL to import, and what to call once its tests are registered. */
export interface TestFileImport {
  url: string
  /**
   * Record how many tests the import registered. Throws when the file is
   * unchanged on disk since this process last loaded it and registered fewer
   * tests this time: the tests it lost cannot run, and the project would
   * pass without them.
   */
  registered(tests: number): void
}

/** Start importing a test file (`filePath` is a path or a `file:` URL). */
export function beginTestFileImport(filePath: string): TestFileImport {
  const file = diskPath(filePath);
  const previous = imports.get(file);
  let url = filePath;
  if (previous) {
    forgetCommonJsModule(filePath, file);
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    url = `${filePath}?${TEST_FILE_IMPORT_QUERY}=${lastStamp}`;
  }
  // Recorded before the import resolves: a file whose import throws is
  // still in Node's cache, and must be re-imported fresh next time too.
  const mtimeMs = mtimeOf(file);
  imports.set(file, { tests: previous?.tests ?? 0, mtimeMs });
  return {
    url,
    registered(tests: number): void {
      const lost = previous !== undefined
        && tests < previous.tests
        && previous.mtimeMs !== undefined
        && previous.mtimeMs === mtimeMs;
      if (!lost) {
        imports.set(file, { tests, mtimeMs });
        return;
      }
      // The record keeps the earlier count, so the next import of the
      // unchanged file is held to it too, not to this short one.
      throw new Error(lostTestsMessage(path.basename(file), tests, previous.tests));
    },
  };
}

function lostTestsMessage(name: string, tests: number, before: number): string {
  const head = `${name} registered ${tests === 0 ? 'no tests' : `${tests} of its ${before} tests`} on this run, `
    + `but ${before} when this process loaded it before, and the file has not changed since. `
    + 'Tapsmith loads a test file again for each project, retry and rerun that runs it in one process, '
    + `but ${tests === 0 ? 'none' : 'the rest'} of its tests did not register again:`;
  const helper = 'test() calls at the top level of a module the test file imports register only the first '
    + 'time that module loads. Move them into the test file, or into a function the test file calls.';
  if (tests > 0) return `${head} ${helper}`;
  return `${head}\n  - ${helper}\n  - A custom loader (--import / --loader) or bundler may have returned the `
    + 'cached copy of the file: check that it loads a module again for a new URL query.\n'
    + 'Running each project in its own `tapsmith test --project <name>` invocation avoids both.';
}
