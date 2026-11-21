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
 * workers for fresh helper code). So tests a helper declares at its top level
 * register only once: a re-import of an unchanged file that loses them fails
 * the file, saying why, rather than pass without them.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ImportRecord {
  /** How many tests the file registered the last time it was imported. */
  tests: number
  /** The modules it imports that declared some of those tests (real paths). */
  declaringModules: string[]
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
   * After the first import of a file in this process registered `tests`: a
   * fresh URL to import it again from when that was none. Another test file
   * may have imported this one already — Node then hands back that module,
   * evaluated under the other file — so an empty result is checked once.
   */
  reloadUrl(tests: number): string | undefined
  /**
   * Record the tests the import registered, by the file that declared each.
   * Throws when the file is unchanged since this process last loaded it and
   * tests it registered then cannot register again: a project would pass
   * without them.
   */
  registered(declaredIn: ReadonlyArray<string | undefined>): void
}

function freshUrl(filePath: string, file: string): string {
  forgetCommonJsModule(filePath, file);
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return `${filePath}?${TEST_FILE_IMPORT_QUERY}=${lastStamp}`;
}

/** Start importing a test file (`filePath` is a path or a `file:` URL). */
export function beginTestFileImport(filePath: string): TestFileImport {
  const file = diskPath(filePath);
  const previous = imports.get(file);
  const url = previous ? freshUrl(filePath, file) : filePath;
  // Recorded before the import resolves: a file whose import throws is
  // still in Node's cache, and must be re-imported fresh next time too.
  const mtimeMs = mtimeOf(file);
  imports.set(file, { tests: previous?.tests ?? 0, declaringModules: previous?.declaringModules ?? [], mtimeMs });
  return {
    url,
    reloadUrl(tests: number): string | undefined {
      return previous === undefined && tests === 0 ? freshUrl(filePath, file) : undefined;
    },
    registered(declaredIn: ReadonlyArray<string | undefined>): void {
      const tests = declaredIn.length;
      const declaringModules = [...new Set(declaredIn.flatMap((d) => {
        const real = d === undefined ? undefined : diskPath(d);
        return real === undefined || real === file ? [] : [real];
      }))];
      const unchanged = previous !== undefined && previous.mtimeMs !== undefined && previous.mtimeMs === mtimeMs;
      if (unchanged) {
        // The modules a test file imports load once per process, so tests
        // they declare at their top level do not register again.
        const lostModules = previous.declaringModules.filter((m) => !declaringModules.includes(m));
        // The record keeps the earlier import's, so the next import of the
        // unchanged file is held to it too, not to this short one.
        if (lostModules.length > 0) throw withoutFrames(lostModuleTestsMessage(path.basename(file), lostModules));
        if (tests === 0 && previous.tests > 0) throw withoutFrames(staleImportMessage(path.basename(file), previous.tests));
      }
      imports.set(file, { tests, declaringModules, mtimeMs });
    },
  };
}

/** An error about the file as a whole: Tapsmith's own frames would be all its stack shows. */
function withoutFrames(message: string): Error {
  const err = new Error(message);
  err.stack = `Error: ${message}`;
  return err;
}

function lostModuleTestsMessage(name: string, modules: string[]): string {
  const names = modules.map((m) => path.basename(m)).join(', ');
  return `${name} imports ${names}, which declares tests at its top level. A module loads once per `
    + `process, so those tests registered only the first time ${name} ran here, and this run `
    + '(another project, a retry or a rerun of the file) could not register them again. '
    + `Declare the tests in a function that ${name} calls, or move them into ${name}.`;
}

function staleImportMessage(name: string, before: number): string {
  return `${name} registered no tests on this run, but ${before} when this process loaded it before, `
    + 'and the file has not changed since. The module loader returned the earlier, cached copy of the '
    + 'file instead of loading it again, so none of its tests could run. If a custom loader '
    + '(--import / --loader) or a bundler runs your tests, check that it loads a module again for a '
    + 'new URL query, or run each project in its own `tapsmith test --project <name>` invocation.';
}
