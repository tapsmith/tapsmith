/**
 * "Your app code changed after this build".
 *
 * Tapsmith tests the build the config names (`apk` / `app`), never the
 * source: an edit to the app shows up only after a rebuild. Someone used to
 * Expo Go or live reload edits a screen, re-runs, and gets either a failure
 * that reads like a wrong locator or, worse, a pass against the old build.
 * So a run says so when the app's source files are newer than the build.
 *
 * The check is a cheap modification-time scan of the app's project (found
 * from where the build lives), skipping the dependency, build and tooling
 * trees test discovery skips. JavaScript counts only when the build embeds
 * it: a Debug or dev-client build loads it from Metro, where an edit is live.
 * Tapsmith's own test files and what they import never count, since a test
 * is re-read every run. Skipped in CI, where the build comes from the
 * pipeline and checked-out files carry checkout times.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isCI } from 'ci-info';
import { minimatch } from 'minimatch';
import { allTestMatchPatterns, type TapsmithConfig } from './config.js';
import { inspectDevBuild } from './dev-client.js';
import { derivedDataWorkspace } from './derived-data.js';
import { forgetStaleBuildWarnings, markStaleBuildWarned, staleBuildWarned } from './stale-build-warnings.js';
import { discoverTestFiles, matchesTestIgnore } from './test-file-discovery.js';

/** What {@link findSourceChangedAfterBuild} found. */
export interface StaleBuild {
  /** The configured build, absolute. */
  artifact: string
  /** The most recently modified source file newer than the build, absolute. */
  newest: string
  /** {@link newest} relative to the app's project root, `/`-separated. */
  newestRelative: string
  /** How many source files are newer than the build, {@link newest} included. */
  count: number
  /** {@link newest}'s modification time (ms). */
  newestMtimeMs: number
  /** The build's modification time (ms). */
  buildMtimeMs: number
}

/**
 * Files always counted, per platform: compiled or packaged into the app
 * whatever the build type. Code and Gradle scripts; iOS storyboards, xibs,
 * property lists, entitlements and the Xcode project. Android resources
 * (anything under a `res` folder) and manifests, and iOS asset catalogs
 * (anything inside an `.xcassets` folder), count whole.
 */
const NATIVE_EXTENSIONS = {
  android: new Set(['.kt', '.java', '.c', '.cc', '.cpp', '.h', '.dart', '.gradle', '.kts']),
  ios: new Set(['.swift', '.m', '.mm', '.h', '.c', '.cc', '.cpp', '.dart', '.storyboard', '.xib', '.plist', '.entitlements', '.pbxproj',
    '.xcconfig', '.strings', '.xcstrings']),
};
/** Build files counted by name, per platform. */
const NATIVE_FILE_NAMES = {
  android: new Set(['gradle.properties', 'google-services.json']),
  ios: new Set(['Podfile', 'GoogleService-Info.plist']),
};
/**
 * Assets a JavaScript bundle embeds (`require('./logo.png')`, imported JSON),
 * counted with the JavaScript. Not the JSON of tools and package managers.
 */
const JS_ASSET_EXTENSIONS = new Set(['.json', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ttf', '.otf', '.mp3', '.mp4', '.lottie']);
const NON_ASSET_JSON = /^(?:package(?:-lock)?|tsconfig(?:\..*)?|jsconfig|eas|tapsmith|lerna|nx|turbo|biome|components|composer|vercel|netlify|renovate|\.[^.].*)\.json$/;
/** The other platform's native folder in a React Native or Flutter app: never in this build. */
const OTHER_PLATFORM_DIR = { android: 'ios', ios: 'android' } as const;
/** Files counted only when the build embeds its JavaScript (a Release React Native build). */
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
/** Expo's app config: read when the native app is built (prebuild), so a change needs a rebuild whatever the build type. */
const APP_CONFIG_NAMES = new Set(['app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs']);

/** Folders never holding app source, on top of the discovery ignore list. */
const SKIPPED_DIRS = new Set(['node_modules', 'Pods', 'DerivedData', 'build', 'dist', 'coverage', '__tests__', '__mocks__', 'tapsmith-results', 'tapsmith-report',
  // Xcode's per-user and shared IDE state inside a project or workspace.
  'xcuserdata', 'xcshareddata']);

/**
 * Test sources of native and Flutter projects, never in the app's build:
 * Gradle's test source sets (`src/test`, `src/testDebug`, `src/androidTest`,
 * `src/sharedTest`, `testFixtures`), Flutter's `test/`, `integration_test/`
 * and `test_driver/`, and Xcode test targets (`MyAppTests/`, `MyAppUITests/`).
 */
const TEST_DIR = /^(?:test|androidTest|sharedTest|testFixtures)(?:[A-Z]\w*)?$|^(?:integration_test|test_driver)$|Tests$/;

/** Unit tests, type declarations and tooling configs: never in the app's build. */
const NON_APP_FILE_PATTERNS = [
  '*.test.*', '*.spec.*', '*_test.dart', '*.d.ts', 'tapsmith.config.*',
  'eslint.config.*', 'prettier.config.*', 'jest.config.*', 'vitest.config.*', 'jest.setup.*',
];

/** Markers of a native or Flutter project folder. */
const PROJECT_FILES = ['pubspec.yaml', 'settings.gradle', 'settings.gradle.kts', 'Package.swift'];

/**
 * Whether `dir` is a React Native or Expo app: a `package.json` that depends
 * on `react-native` or `expo`, or an Expo app config beside it. A plain
 * package (a test project that keeps a downloaded build) is not: nothing in
 * it is built into the app.
 */
function isJsAppDir(dir: string): boolean {
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return false;
  }
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  return 'react-native' in deps || 'expo' in deps
    || [...APP_CONFIG_NAMES].some((f) => fs.existsSync(path.join(dir, f)));
}

/** Bounds of one scan: a project far bigger than an app's gives up rather than stall a run. */
const DEFAULT_LIMITS = { maxEntries: 50_000, maxMs: 1_500 };

function isProjectDir(dir: string): boolean {
  if (PROJECT_FILES.some((f) => fs.existsSync(path.join(dir, f))) || isJsAppDir(dir)) return true;
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  } catch {
    return false;
  }
}

/**
 * The app's project folder: the nearest folder above the build that is an
 * app project (`pubspec.yaml`, `settings.gradle(.kts)`, an `.xcodeproj` /
 * `.xcworkspace`, `Package.swift`, or a React Native / Expo `package.json`).
 * A React Native or Flutter app's `android/` or `ios/` folder stands for the
 * app above it. A build in Xcode's DerivedData stands for the workspace or
 * project Xcode recorded it was built from. Undefined for a build outside any
 * app project (a download, also one kept in a separate test project), or
 * when the nearest one is the home folder or the filesystem root.
 */
export function appSourceRoot(artifact: string, home = process.env.HOME): string | undefined {
  let dir = path.dirname(path.resolve(artifact));
  // A build in Xcode's DerivedData (`…/DerivedData/<Name>-<hash>/Build/…`):
  // Xcode records which workspace or project it was built from.
  const segments = dir.split(path.sep);
  const at = segments.lastIndexOf('DerivedData');
  if (at >= 0 && segments[at + 2] === 'Build') {
    const workspace = derivedDataWorkspace(segments.slice(0, at + 2).join(path.sep));
    if (!workspace) return undefined;
    dir = path.dirname(workspace);
  }
  for (;;) {
    if (home && path.resolve(dir) === path.resolve(home)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    if (isProjectDir(dir)) {
      const name = path.basename(dir);
      if ((name === 'android' || name === 'ios')
        && ['package.json', 'pubspec.yaml'].some((f) => fs.existsSync(path.join(parent, f)))) {
        return parent;
      }
      return dir;
    }
    dir = parent;
  }
}

/**
 * When the build was made: an APK's modification time, or the newest of a
 * `.app` bundle's top-level entries (every build rewrites the executable or
 * the signature). Undefined when it cannot be read.
 */
export function buildTime(artifact: string): number | undefined {
  try {
    const st = fs.statSync(artifact);
    if (!st.isDirectory()) return st.mtimeMs;
    let newest = st.mtimeMs;
    for (const entry of fs.readdirSync(artifact)) {
      try {
        newest = Math.max(newest, fs.lstatSync(path.join(artifact, entry)).mtimeMs);
      } catch {
        // Gone mid-read: the others still date the build.
      }
    }
    return newest;
  } catch {
    return undefined;
  }
}

/**
 * An Android resource or asset (under a Gradle source set's `res` or
 * `assets`, e.g. `app/src/main/res/…`) or manifest, or a file of an iOS asset catalog.
 * Judged on the path below the app's project folder, so neither a folder
 * above the project nor a JavaScript `src/res/` or `src/common/assets/`
 * folder counts.
 */
function isPackagedResource(platform: 'android' | 'ios', root: string, rel: string, name: string): boolean {
  if (platform === 'ios') return rel.split('/').some((seg) => seg.endsWith('.xcassets'));
  if (name === 'AndroidManifest.xml') return true;
  const m = /^(?:(.*)\/)?src\/[^/]+\/(?:res|assets)(?:\/|$)/.exec(rel);
  // Only a Gradle module's source set (`app/src/main/res`): the folder above
  // `src` has a build script. A JavaScript `src/common/assets` has none.
  return !!m && isGradleModule(path.join(root, m[1] ?? ''));
}

const gradleModules = new Map<string, boolean>();

function isGradleModule(dir: string): boolean {
  let known = gradleModules.get(dir);
  if (known === undefined) {
    known = fs.existsSync(path.join(dir, 'build.gradle')) || fs.existsSync(path.join(dir, 'build.gradle.kts'));
    gradleModules.set(dir, known);
  }
  return known;
}

function isNonAppFile(name: string): boolean {
  return NON_APP_FILE_PATTERNS.some((p) => minimatch(name, p, { dot: true }));
}

/** Options for {@link findSourceChangedAfterBuild}. */
export interface StaleBuildCheckOptions {
  /** The build's platform: which native sources count, and which folder is the other platform's. */
  platform: 'android' | 'ios'
  /** Count JavaScript and TypeScript sources (the build embeds its bundle). */
  countJs: boolean
  /** Folders the scan leaves out entirely (the Tapsmith project, its output). */
  skipDirs?: string[]
  /** Whether a candidate is a test, or a module a test imports. Asked only when some file is newer. */
  isTestCode?: (files: string[]) => Promise<Set<string>>
  /** Scan bounds. */
  limits?: { maxEntries: number; maxMs: number }
  /**
   * Where to keep each build's content baseline (see {@link findSourceChangedAfterBuild});
   * none when unset.
   */
  baselineDir?: string
}

/**
 * The app's source files modified after `artifact` was built, under the
 * app's project folder ({@link appSourceRoot}). Undefined when none is newer,
 * when the build or its project cannot be found, or when the scan ran past
 * its bounds (a monorepo far bigger than one app: no answer beats a slow one).
 *
 * A newer file whose content is known to be what the build was made from is
 * left out, since a rebuild would find nothing to do (Gradle compares
 * content and leaves the APK as it is) and the warning could never clear.
 * The evidence: the content hash the file had while it was still older than
 * this build (`baselineDir`: every check records the files it finds older),
 * or git ({@link unchangedSinceBuild}). Without evidence the file counts: a
 * stale build that passes in silence is worse than a warning too many.
 */
export async function findSourceChangedAfterBuild(
  artifact: string,
  opts: StaleBuildCheckOptions,
): Promise<StaleBuild | undefined> {
  const built = buildTime(artifact);
  if (built === undefined) return undefined;
  const root = appSourceRoot(artifact);
  if (!root) return undefined;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const skip = new Set([
    path.resolve(artifact),
    path.join(root, OTHER_PLATFORM_DIR[opts.platform]),
    ...(opts.skipDirs ?? []).map((d) => path.resolve(d)),
  ]);
  const native = NATIVE_EXTENSIONS[opts.platform];
  // Flutter packages its declared assets into every build, Debug included.
  const flutter = fs.existsSync(path.join(root, 'pubspec.yaml'));
  const deadline = Date.now() + limits.maxMs;
  let visited = 0;
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  const asBuilt: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > limits.maxEntries || Date.now() > deadline) return undefined;
      const abs = path.join(dir, entry.name);
      if (skip.has(abs)) continue;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name) || TEST_DIR.test(entry.name)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (matchesTestIgnore(rel)) continue;
        pending.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      const relDir = path.relative(root, dir).split(path.sep).join('/');
      const counted = native.has(ext) || APP_CONFIG_NAMES.has(entry.name) || NATIVE_FILE_NAMES[opts.platform].has(entry.name)
        || isPackagedResource(opts.platform, root, relDir, entry.name)
        || (flutter && (entry.name === 'pubspec.yaml' || relDir === 'assets' || relDir.startsWith('assets/')))
        || (opts.countJs && (JS_EXTENSIONS.has(ext) || (JS_ASSET_EXTENSIONS.has(ext) && !NON_ASSET_JSON.test(entry.name))));
      if (!counted || isNonAppFile(entry.name)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.promises.stat(abs)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > built) candidates.push({ file: abs, mtimeMs });
      else asBuilt.push(abs);
    }
  }
  const baseline = opts.baselineDir ? await updateBaseline(opts.baselineDir, artifact, built, root, asBuilt) : undefined;
  if (baseline) {
    const same = await Promise.all(candidates.map(async (c) => {
      const recorded = baseline[relativeTo(root, c.file)];
      return recorded !== undefined && recorded === await contentHash(c.file);
    }));
    candidates.splice(0, candidates.length, ...candidates.filter((_, i) => !same[i]));
  }
  if (candidates.length === 0) return undefined;
  // Git only for files the baseline knows nothing about: one it recorded
  // differently is known to differ from the build, whatever git says.
  const unknown = candidates.filter((c) => baseline?.[relativeTo(root, c.file)] === undefined).map((c) => c.file);
  const unchanged = await unchangedSinceBuild(root, unknown, built);
  if (unchanged.size > 0) candidates.splice(0, candidates.length, ...candidates.filter((c) => !unchanged.has(c.file)));
  if (candidates.length === 0) return undefined;
  const tests = opts.isTestCode ? await opts.isTestCode(candidates.map((c) => c.file)) : new Set<string>();
  const changed = candidates.filter((c) => !tests.has(path.resolve(c.file)));
  if (changed.length === 0) return undefined;
  changed.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? -1 : 1));
  const newest = changed[0]!;
  return {
    artifact: path.resolve(artifact),
    newest: newest.file,
    newestRelative: path.relative(root, newest.file).split(path.sep).join('/'),
    count: changed.length,
    newestMtimeMs: newest.mtimeMs,
    buildMtimeMs: built,
  };
}

function relativeTo(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

/** A file's content hash; undefined when it cannot be read or is too big to be worth it. */
async function contentHash(file: string): Promise<string | undefined> {
  try {
    const st = await fs.promises.stat(file);
    if (st.size > MAX_BASELINE_FILE_BYTES) return undefined;
    return createHash('sha1').update(await fs.promises.readFile(file)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Largest file a baseline hashes, and most files one check adds to it. */
const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_ADDS = 5_000;

/** The default home of the build baselines: `~/.tapsmith/stale-build`. */
export function defaultBaselineDir(): string {
  return path.join(os.homedir(), '.tapsmith', 'stale-build');
}

/**
 * Read this build's baseline (the content hash of each source file, taken
 * while it was older than the build, by root-relative path), add the files
 * `asBuilt` lists that it lacks, and write it back. A baseline of another
 * build of the same path is replaced. Undefined when it cannot be read or
 * written: then only git can say a newer file is unchanged.
 */
async function updateBaseline(
  dir: string,
  artifact: string,
  built: number,
  root: string,
  asBuilt: string[],
): Promise<Record<string, string> | undefined> {
  const file = path.join(dir, `${createHash('sha1').update(path.resolve(artifact)).digest('hex')}.json`);
  let hashes: Record<string, string> = {};
  try {
    const saved = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { built?: unknown; hashes?: unknown };
    if (saved.built === built && saved.hashes && typeof saved.hashes === 'object') hashes = saved.hashes as Record<string, string>;
  } catch {
    // None yet, or unreadable: start this build's afresh.
  }
  let added = 0;
  for (const abs of asBuilt) {
    if (added >= MAX_BASELINE_ADDS) break;
    const rel = relativeTo(root, abs);
    if (hashes[rel] !== undefined) continue;
    const hash = await contentHash(abs);
    if (hash === undefined) continue;
    hashes[rel] = hash;
    added++;
  }
  if (added > 0) {
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ artifact: path.resolve(artifact), built, hashes }));
      await fs.promises.rename(tmp, file);
    } catch {
      // Read-only home: this check still uses what it hashed.
    }
  }
  return hashes;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
  });
}

/**
 * The files among `files` whose content is exactly what the commit checked
 * out when the build was made holds, after a round trip: HEAD went to
 * another commit since the build and is back on that one (a checkout of
 * another branch and back), so the files' modification times moved with the
 * checkouts, not their content. The commit is the one HEAD pointed to at
 * `builtMs`, from HEAD's reflog. Without a round trip nothing is filtered:
 * a build made from uncommitted edits holds them, and a file reverted to the
 * commit since (`git checkout -- file`, a stash) really differs from the build. Empty outside a git repository, when the
 * reflog does not reach back to the build, or on any git failure: then
 * modification times decide alone.
 */
export async function unchangedSinceBuild(root: string, files: string[], builtMs: number): Promise<Set<string>> {
  const unchanged = new Set<string>();
  if (files.length === 0) return unchanged;
  const top = (await git(root, ['rev-parse', '--show-toplevel']))?.trim();
  if (!top) return unchanged;
  const reflog = await git(top, ['reflog', 'show', '--format=%H %gd', '--date=unix', 'HEAD']);
  if (!reflog) return unchanged;
  const builtSec = Math.floor(builtMs / 1000);
  // Newest first: HEAD now, the commits it moved through since the build,
  // then the one it was on when the build was made.
  let current: string | undefined;
  let commit: string | undefined;
  const since: string[] = [];
  for (const line of reflog.split('\n')) {
    const m = /^([0-9a-f]{40,64}) \S*@\{(\d+)\}$/.exec(line.trim());
    if (!m) continue;
    current ??= m[1];
    if (Number(m[2]) > builtSec) {
      since.push(m[1]!);
      continue;
    }
    commit = m[1];
    break;
  }
  // Only a round trip: HEAD is back on the build's commit after being on
  // another one. A stash, `checkout -b` or a commit since says nothing
  // about a file now equal to the commit (the build may hold an uncommitted
  // edit that was reverted since).
  if (!commit || current !== commit || !since.some((sha) => sha !== commit)) return unchanged;
  let realTop: string;
  let realRoot: string;
  try {
    realTop = fs.realpathSync(top);
    realRoot = fs.realpathSync(root);
  } catch {
    return unchanged;
  }
  const scope = path.relative(realTop, realRoot).split(path.sep).join('/') || '.';
  if (scope.startsWith('..')) return unchanged;
  // What the commit holds under the app's folder, and which of those files
  // differ from it now (by content): no argument list, so no size limit.
  const [tree, diff] = await Promise.all([
    git(top, ['ls-tree', '-r', '-z', '--name-only', commit, '--', scope]),
    git(top, ['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', commit, '--', scope]),
  ]);
  if (tree === undefined || diff === undefined) return unchanged;
  const committed = new Set(tree.split('\0').filter(Boolean));
  const differing = new Set(diff.split('\0').filter(Boolean));
  for (const file of files) {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      continue;
    }
    const rel = path.relative(realTop, real).split(path.sep).join('/');
    if (committed.has(rel) && !differing.has(rel)) unchanged.add(file);
  }
  return unchanged;
}

/** Where the docs explain it. */
export const STALE_BUILD_DOCS_URL = 'https://tapsmith.dev/getting-started/#after-you-change-the-app';

/**
 * One line for the user, e.g. `src/app/todos.tsx changed after app-release.apk
 * was built: …`. Kept under 500 characters, where MCP clips a warning line.
 */
export function staleBuildMessage(stale: StaleBuild): string {
  const others = stale.count > 1 ? ` (and ${stale.count - 1} other app file${stale.count > 2 ? 's' : ''})` : '';
  return `${stale.newestRelative}${others} changed after ${path.basename(stale.artifact)} was built. `
    + 'Tapsmith tests the installed build, not your source: rebuild the app to test the change. '
    + STALE_BUILD_DOCS_URL;
}

// ─── The check for a run ───

export type CheckedConfig = Pick<TapsmithConfig, 'platform' | 'apk' | 'app' | 'rootDir' | 'outputDir' | 'testMatch'> & Partial<Pick<TapsmithConfig, 'projects'>>;

/** The configured build, resolved; undefined when the config names none. Never throws. */
export function configuredArtifact(config: Pick<TapsmithConfig, 'platform' | 'apk' | 'app' | 'rootDir'>): string | undefined {
  const build = config.platform === 'ios' ? config.app : config.apk;
  return build ? path.resolve(config.rootDir, build) : undefined;
}

/** How long one check's answer is reused: a run's files share it, the next run looks again. */
const CHECK_TTL_MS = 30_000;

const checks = new Map<string, { at: number; result: Promise<StaleBuild | undefined> }>();

/** Forget remembered answers (tests). */
export function resetStaleBuildChecks(): void {
  checks.clear();
  gradleModules.clear();
  forgetStaleBuildWarnings();
}

/**
 * {@link findSourceChangedAfterBuild} for a config: its build, its test files
 * and their imports left out, and the Tapsmith project folder when it is a
 * subfolder of the app's (an `e2e/` folder). Answers are reused for 30 s per
 * build (and its modification time), so the files of one run pay for one
 * scan. Undefined in CI, without a configured build, and on any failure:
 * this is advice, never a reason for a run to fail.
 */
export async function checkStaleBuild(
  config: CheckedConfig,
  deps: { ci?: boolean; now?: () => number; fresh?: boolean; baselineDir?: string } = {},
): Promise<StaleBuild | undefined> {
  if (deps.ci ?? isCI) return undefined;
  const artifact = configuredArtifact(config);
  if (!artifact) return undefined;
  const built = buildTime(artifact);
  if (built === undefined) return undefined;
  const now = deps.now ?? Date.now;
  const key = `${artifact}\0${built}\0${config.rootDir}\0${allTestMatchPatterns(config).join('\0')}`;
  const memo = checks.get(key);
  if (memo && !deps.fresh && now() - memo.at < CHECK_TTL_MS) return memo.result;
  const result = runCheck(config, artifact, deps.baselineDir ?? defaultBaselineDir()).catch(() => undefined);
  checks.set(key, { at: now(), result });
  return result;
}

/**
 * The modules of the tests' import graph that are test code: the ones in a
 * top-level folder of the app's project that holds test files (`e2e/`,
 * `tests/`). A module elsewhere is app code a test happens to import (shared
 * test ids, strings): the app's build holds it too, so an edit to it still
 * needs a rebuild.
 */
function testSideModules(root: string, testFiles: string[], modules: string[]): string[] {
  const topFolder = (file: string): string | undefined => {
    const rel = path.relative(root, path.resolve(file));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    const segments = rel.split(path.sep);
    return segments.length > 1 ? segments[0] : undefined;
  };
  const testFolders = new Set(testFiles.map(topFolder).filter((f): f is string => f !== undefined));
  return modules.filter((m) => {
    const folder = topFolder(m);
    return folder !== undefined && testFolders.has(folder);
  });
}

async function runCheck(config: CheckedConfig, artifact: string, baselineDir: string): Promise<StaleBuild | undefined> {
  const root = appSourceRoot(artifact);
  if (!root) return undefined;
  const rootDir = path.resolve(config.rootDir);
  const skipDirs = [path.resolve(rootDir, config.outputDir)];
  // A Tapsmith project in a subfolder of the app (its own `e2e/` package):
  // nothing in it is the app.
  const fromRoot = path.relative(root, rootDir);
  if (fromRoot && !fromRoot.startsWith('..') && !path.isAbsolute(fromRoot)) skipDirs.push(rootDir);
  const info = inspectDevBuild(artifact);
  return findSourceChangedAfterBuild(artifact, {
    platform: config.platform === 'ios' ? 'ios' : 'android',
    countJs: info?.embedsJs === true,
    skipDirs,
    baselineDir,
    isTestCode: async () => {
      // Every project's tests, not only the ones this run selects: any of
      // them may import the file.
      const files = await discoverTestFiles(allTestMatchPatterns(config), rootDir);
      const { testFileModules } = await import('./network-api-scan.js');
      const modules = await testFileModules(files).catch(() => files);
      return new Set([...files, ...testSideModules(root, files, modules)].map((f) => path.resolve(f)));
    },
  });
}

// ─── In a run ───

/**
 * Append the stale-build hint to a failed test's error, so the failure itself
 * (the CLI's report, UI mode's error panel, MCP's results) says the build may
 * not hold the code it tested. Once per error: one error object can fail
 * several tests (a `beforeAll`), and a retry reports the same one again.
 */
export function addStaleBuildHint(error: Error, stale: StaleBuild | undefined): void {
  if (!stale) return;
  const hint = `Note: ${staleBuildMessage(stale)}`;
  if (error.message.includes(hint)) return;
  try {
    error.message = `${error.message}\n\n${hint}`;
  } catch {
    // A frozen or getter-only message: the run-level warning still says it.
  }
}

/**
 * The test-result warning for `stale` and its key, while no result this
 * session has carried it yet for this edit (file and modification time) of
 * this build; undefined after that. Call {@link markStaleBuildWarningShown}
 * once a result actually carries it: a file whose tests are all skipped or
 * filtered out shows nothing, and the next file must still say it. Watch and
 * MCP children share the session's record through their parent
 * (`stale-build-warnings.ts`).
 */
export function pendingStaleBuildWarning(stale: StaleBuild | undefined): { key: string; message: string } | undefined {
  if (!stale) return undefined;
  const key = `${stale.artifact}\0${stale.buildMtimeMs}\0${stale.newest}\0${stale.newestMtimeMs}`;
  return staleBuildWarned(key) ? undefined : { key, message: staleBuildMessage(stale) };
}

/** A test result carried the warning with this key ({@link pendingStaleBuildWarning}). */
export function markStaleBuildWarningShown(key: string): void {
  markStaleBuildWarned(key);
}

/**
 * The stale builds of a run's devices: the run's own config and each
 * device's session config, each build once.
 * `fresh` looks again whatever an earlier check found (a file just changed).
 */
export async function checkStaleBuilds(configs: CheckedConfig[], opts: { fresh?: boolean } = {}): Promise<StaleBuild[]> {
  const seen = new Set<string>();
  const unique = configs.filter((c) => {
    const artifact = configuredArtifact(c);
    if (!artifact || seen.has(artifact)) return false;
    seen.add(artifact);
    return true;
  });
  const results = await Promise.all(unique.map((c) => checkStaleBuild(c, { fresh: opts.fresh }).catch(() => undefined)));
  return results.filter((r): r is StaleBuild => r !== undefined);
}
