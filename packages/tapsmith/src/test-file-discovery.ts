import * as path from 'node:path';
import * as fs from 'node:fs';
import { glob } from 'glob';
import { minimatch } from 'minimatch';

/**
 * Directories never searched for tests, and never watched for new ones: the
 * dependency, build and tooling trees of a JS / React Native / Expo project.
 * They are never tests, and an Expo app's `ios/Pods` and `ios/build` alone hold
 * tens of thousands of files — watching them kept UI mode unresponsive for
 * minutes after it said it was ready (PILOT-713). `ios/Pods` also symlinks
 * headers back into `node_modules`, which a watcher would otherwise follow.
 *
 * Build directories are anchored under `ios/` and `android/`, so a `build`
 * directory elsewhere (one holding tests, say) is still searched.
 */
export const DEFAULT_TEST_IGNORE = [
  '**/node_modules/**',
  '**/dist/**',
  // CocoaPods, Xcode and Gradle output of a native or prebuilt (Expo) app.
  '**/Pods/**',
  '**/ios/build/**',
  '**/DerivedData/**',
  '**/android/**/build/**',
  '**/android/**/.cxx/**',
  '**/.gradle/**',
  '**/.expo/**',
];

export async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  extraIgnore?: string[],
): Promise<string[]> {
  const ignore = [...DEFAULT_TEST_IGNORE, ...(extraIgnore ?? [])];
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      absolute: true,
      ignore,
    });
    files.push(...matches);
  }

  return [...new Set(files)].sort();
}

// ─── Positional test-file arguments ───

export interface TestFileArgResolution {
  /** Absolute paths, each argument's matches in order, deduplicated. */
  files: string[];
  /** The arguments that selected no file, as given. */
  unmatched: string[];
  /** Glob-looking arguments that globbed nothing and selected files read as a regex. */
  readAsRegex: string[];
}

/**
 * Resolve `tapsmith test [args...]` to test files, the way Playwright reads
 * its positional arguments — before any device or daemon work, so an argument
 * that matches nothing fails at once instead of after device setup.
 *
 * Each argument is, in order of precedence:
 * - an existing file (absolute, or relative to the first of `roots` that has
 *   it): selected as is, even outside `testMatch` (with projects, the caller
 *   still needs a project whose `testMatch` covers it to run it under);
 * - an existing directory holding discovered test files: those files (one
 *   holding none is read on as below);
 * - a glob: the discovered test files it matches, relative to any root or as
 *   an absolute pattern — or, when it matches none, a filter as below, since
 *   `*`, `?`, `[]` and `{}` are regex syntax too;
 * - anything else: a filter over the discovered test files' paths relative to
 *   `roots[0]` (rootDir) — a case-insensitive regular expression (`/re/flags`
 *   for explicit flags), or a literal substring when it is not a valid one.
 *   Playwright matches the absolute path; the relative one keeps a filter from
 *   matching every file through the name of a directory above them.
 *
 * Directories, globs and filters select only from `candidates` (the files
 * `testMatch` discovered), so they never pull a helper module in as a test.
 */
export function resolveTestFileArgs(
  args: string[],
  candidates: string[],
  roots: string[],
): TestFileArgResolution {
  const rootDir = roots[0];
  const files = new Set<string>();
  const unmatched: string[] = [];
  const readAsRegex: string[] = [];

  for (const arg of args) {
    const { matches, byRegexAfterGlob } = matchTestFileArg(arg, candidates, roots, rootDir);
    if (matches.length === 0) unmatched.push(arg);
    else if (byRegexAfterGlob) readAsRegex.push(arg);
    for (const file of matches) files.add(file);
  }

  return { files: [...files], unmatched, readAsRegex };
}

/**
 * The "No tests found" error for a run whose file selection came out empty:
 * what each argument failed to select, and how arguments are read.
 */
export function noTestFilesFoundMessage(opts: {
  args: string[];
  unmatched: string[];
  outsideProjects: string[];
  testMatch: string[];
  rootDir: string;
  /** `--project` narrowed the run, so an unselected project may cover a file. */
  projectsSelected?: boolean;
  /** Whether a config file was loaded; without one, `init` is the next step. */
  configFound: boolean;
}): string {
  const lines = ['No tests found.'];
  const testMatch = opts.testMatch.join(', ');
  // A project with no config has most likely not been set up: say so, as
  // `verify` and `doctor` do (PILOT-569).
  const initHint = opts.configFound
    ? []
    : [`No tapsmith.config.ts (or .js, .mjs) found in ${opts.rootDir}. To set Tapsmith up here, run: npx tapsmith init`];
  if (opts.args.length === 0) {
    lines.push(`No file under ${opts.rootDir} matches testMatch ${testMatch}.`, ...initHint);
    return lines.join('\n');
  }
  for (const arg of opts.unmatched) {
    lines.push(`  "${arg}" matched no test file.`);
  }
  for (const file of opts.outsideProjects) {
    lines.push(`  ${file} is not matched by any${opts.projectsSelected ? ' selected' : ''} project's testMatch, so no project runs it.`);
  }
  lines.push(
    'Each argument is a file, a directory, a glob, or a regular expression matched against the test file paths '
    + `(relative to ${opts.rootDir}); directories, globs and expressions select among the files testMatch discovers (${testMatch}).`,
    ...initHint,
  );
  return lines.join('\n');
}

function matchTestFileArg(
  arg: string,
  candidates: string[],
  roots: string[],
  rootDir: string,
): { matches: string[]; byRegexAfterGlob?: boolean } {
  for (const root of roots) {
    const resolved = path.resolve(root, arg);
    const stat = statOrUndefined(resolved);
    if (stat?.isFile()) return { matches: [resolved] };
    if (stat?.isDirectory()) {
      // A directory with no test file in it (an app's own `login/` source
      // directory, say) does not end the search: the next root, then the
      // name as a filter, may still select tests.
      const prefix = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
      const inside = candidates.filter((file) => file.startsWith(prefix));
      if (inside.length > 0) return { matches: inside };
    }
  }

  // `*`, `?`, `[]` and `{}` are regex syntax too (`login.*test`), so an
  // argument that globs nothing is still read as a filter. `/re/flags` is
  // always a filter.
  if (!EXPLICIT_REGEX.test(arg) && normalizeGlobPattern(arg).split('/').some(hasGlobMagic)) {
    const pattern = normalizeGlobPattern(arg).replace(/^\.\//, '');
    const globbed = candidates.filter((file) => {
      if (minimatch(normalizeGlobPattern(file), pattern)) return true;
      return roots.some((root) => {
        const relative = relativeTestPath(file, root);
        return !relative.startsWith('../') && minimatch(relative, pattern);
      });
    });
    if (globbed.length > 0) return { matches: globbed };
    const filter = testFileFilter(arg);
    return { matches: candidates.filter((file) => filter(relativeTestPath(file, rootDir))), byRegexAfterGlob: true };
  }

  const filter = testFileFilter(arg);
  return { matches: candidates.filter((file) => filter(relativeTestPath(file, rootDir))) };
}

const EXPLICIT_REGEX = /^\/(.+)\/([a-z]*)$/;

function testFileFilter(arg: string): (relativePath: string) => boolean {
  const explicit = EXPLICIT_REGEX.exec(arg);
  try {
    // `g` and `y` make one RegExp carry lastIndex from one file to the next.
    const re = explicit ? new RegExp(explicit[1], explicit[2].replace(/[gy]/g, '')) : new RegExp(arg, 'i');
    return (relativePath) => re.test(relativePath);
  } catch {
    const needle = arg.toLowerCase();
    return (relativePath) => relativePath.toLowerCase().includes(needle);
  }
}

function statOrUndefined(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

export function relativeTestPath(filePath: string, rootDir: string): string {
  return path
    .relative(rootDir, path.resolve(rootDir, filePath))
    .split(path.sep)
    .join('/');
}

export function matchesTestFile(
  filePath: string,
  patterns: string[],
  rootDir: string,
  extraIgnore?: string[],
): boolean {
  const relative = relativeTestPath(filePath, rootDir);
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return false;

  if (matchesTestIgnore(relative, extraIgnore)) return false;
  return patterns.some((pattern) => minimatch(relative, normalizeGlobPattern(pattern)));
}

export function matchesTestIgnore(relativePath: string, extraIgnore?: string[]): boolean {
  const relative = normalizeGlobPattern(relativePath).replace(/\/+$/, '');
  if (!relative) return false;

  for (const pattern of DEFAULT_TEST_IGNORE) {
    if (matchesIgnorePattern(relative, pattern)) return true;
  }
  if (extraIgnore) {
    for (const pattern of extraIgnore) {
      if (matchesIgnorePattern(relative, pattern)) return true;
    }
  }
  return false;
}

/**
 * The `ignored` predicate for a watcher that looks for new or changed test
 * files under `rootDir`: true for anything outside `rootDir`, inside `.git` or
 * `outputDir` (traces and screenshots written during a run), or in a
 * DEFAULT_TEST_IGNORE directory. Given a directory, it keeps the watcher from
 * descending into it at all.
 */
export function isIgnoredDiscoveryWatchPath(filePath: string, rootDir: string, outputDir: string): boolean {
  const resolved = path.resolve(rootDir, filePath);
  const relative = relativeTestPath(resolved, rootDir);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return true;
  if (relative.split('/').includes('.git') || matchesTestIgnore(relative)) return true;

  const outputRelative = path.relative(outputDir, resolved);
  return outputRelative === '' || (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative));
}

/**
 * The `ignored` predicate for headless watch mode, which watches the
 * directories of the test files it runs (recursively) and those files by name.
 * Within rootDir it skips what isIgnoredDiscoveryWatchPath() skips, except the
 * files in `watchedByName` (`tapsmith test --watch <file>` can select a file
 * anywhere). Outside rootDir (an explicitly selected file's directory) it skips
 * nothing.
 */
export function isIgnoredWatchModePath(
  filePath: string,
  rootDir: string,
  outputDir: string,
  watchedByName: ReadonlySet<string>,
): boolean {
  const resolved = path.resolve(rootDir, filePath);
  if (watchedByName.has(resolved)) return false;
  const relative = relativeTestPath(resolved, rootDir);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return false;
  return isIgnoredDiscoveryWatchPath(resolved, rootDir, outputDir);
}

export function getTestDiscoveryWatchRoots(patterns: string[], rootDir: string): string[] {
  const roots = new Set<string>();
  for (const pattern of patterns) {
    let candidate = path.resolve(rootDir, staticDirectoryPrefix(pattern));
    const relative = path.relative(rootDir, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      candidate = rootDir;
    }
    while (!isExistingDirectory(candidate) && candidate !== rootDir) {
      candidate = path.dirname(candidate);
    }
    roots.add(candidate);
  }
  return [...roots].sort();
}

function normalizeGlobPattern(pattern: string): string {
  return pattern.replaceAll('\\', '/');
}

function matchesIgnorePattern(relativePath: string, pattern: string): boolean {
  const normalizedPattern = normalizeGlobPattern(pattern);
  return minimatch(relativePath, normalizedPattern)
    || minimatch(`${relativePath}/__tapsmith_ignore_probe__`, normalizedPattern);
}

function staticDirectoryPrefix(pattern: string): string {
  const normalized = normalizeGlobPattern(pattern).replace(/^\.\//, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const firstGlob = parts.findIndex(hasGlobMagic);
  const staticParts = firstGlob >= 0
    ? parts.slice(0, firstGlob)
    : parts.slice(0, Math.max(0, parts.length - 1));
  return path.join(...staticParts);
}

function hasGlobMagic(part: string): boolean {
  return /[*?[\]{}]/.test(part) || /^[!+@?*]\(.+\)$/.test(part);
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}
