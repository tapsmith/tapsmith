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
 * workers for fresh helper code).
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

/** The file's path on disk, whether the runner was given a path or a `file:` URL. */
function diskPath(filePath: string): string {
  if (!filePath.startsWith('file:')) return path.resolve(filePath);
  try {
    return fileURLToPath(filePath);
  } catch {
    return filePath;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function forgetCommonJsModule(file: string): void {
  delete requireCache[file];
  try {
    const real = fs.realpathSync(file);
    if (real !== file) delete requireCache[real];
  } catch {
    // Gone from disk: the import reports that itself.
  }
}

/** A file being imported: the URL to import, and what to call once its tests are registered. */
export interface TestFileImport {
  url: string
  /**
   * Record how many tests the import registered. Throws when the file had
   * registered tests at an earlier import, is unchanged on disk since, and
   * registered none this time — the loader handed back the cached module, and
   * an empty file would pass for a green one.
   */
  registered(tests: number): void
}

/** Start importing a test file (`filePath` is a path or a `file:` URL). */
export function beginTestFileImport(filePath: string): TestFileImport {
  const file = diskPath(filePath);
  const previous = imports.get(file);
  let url = filePath;
  if (previous) {
    forgetCommonJsModule(file);
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
      imports.set(file, { tests, mtimeMs });
      if (
        tests === 0
        && previous !== undefined
        && previous.tests > 0
        && previous.mtimeMs !== undefined
        && previous.mtimeMs === mtimeMs
      ) {
        throw new Error(
          `${path.basename(file)} registered no tests on this run, but registered ${previous.tests} `
          + `when this process loaded it before, and the file has not changed since. The module `
          + `loader returned the earlier, cached copy of the file instead of loading it again, so `
          + `none of its tests could run. If a custom loader (--import / --loader) or a bundler `
          + `runs your tests, check that it loads a module again for a new URL query, or run `
          + `each project in its own \`tapsmith test --project <name>\` invocation.`,
        );
      }
    },
  };
}
