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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCI } from 'ci-info';
import { minimatch } from 'minimatch';
import type { TapsmithConfig } from './config.js';
import { inspectDevBuild } from './dev-client.js';
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

/** Files always counted, per platform: compiled into the app whatever the build type. */
const NATIVE_EXTENSIONS = {
  android: new Set(['.kt', '.java', '.c', '.cc', '.cpp', '.h', '.dart']),
  ios: new Set(['.swift', '.m', '.mm', '.h', '.c', '.cc', '.cpp', '.dart']),
};
/** The other platform's native folder in a React Native or Flutter app: never in this build. */
const OTHER_PLATFORM_DIR = { android: 'ios', ios: 'android' } as const;
/** Files counted only when the build embeds its JavaScript (a Release React Native build). */
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
/** Expo's app config: read when the native app is built (prebuild), so a change needs a rebuild whatever the build type. */
const APP_CONFIG_NAMES = new Set(['app.json']);

/** Folders never holding app source, on top of the discovery ignore list. */
const SKIPPED_DIRS = new Set(['node_modules', 'Pods', 'DerivedData', 'build', 'dist', 'coverage', '__tests__', '__mocks__', 'tapsmith-results', 'tapsmith-report']);

/** Unit tests, type declarations and tooling configs: never in the app's build. */
const NON_APP_FILE_PATTERNS = [
  '*.test.*', '*.spec.*', '*.d.ts', 'tapsmith.config.*',
  'eslint.config.*', 'prettier.config.*', 'jest.config.*', 'vitest.config.*', 'jest.setup.*',
];

/** Markers of a project folder. */
const PROJECT_FILES = ['package.json', 'pubspec.yaml', 'settings.gradle', 'settings.gradle.kts', 'Package.swift'];

/** Bounds of one scan: a project far bigger than an app's gives up rather than stall a run. */
const DEFAULT_LIMITS = { maxEntries: 50_000, maxMs: 1_500 };

function isProjectDir(dir: string): boolean {
  if (PROJECT_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return true;
  try {
    return fs.readdirSync(dir).some((f) => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'));
  } catch {
    return false;
  }
}

/**
 * The app's project folder: the nearest folder above the build with a
 * project file (`package.json`, `pubspec.yaml`, `settings.gradle(.kts)`, an
 * `.xcodeproj` / `.xcworkspace`, `Package.swift`). A React Native or Flutter
 * app's `android/` or `ios/` folder stands for the app above it. Undefined
 * for a build outside any project (a download), or when the nearest one is
 * the home folder or the filesystem root.
 */
export function appSourceRoot(artifact: string, home = process.env.HOME): string | undefined {
  let dir = path.dirname(path.resolve(artifact));
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
}

/**
 * The app's source files modified after `artifact` was built, under the
 * app's project folder ({@link appSourceRoot}). Undefined when none is newer,
 * when the build or its project cannot be found, or when the scan ran past
 * its bounds (a monorepo far bigger than one app: no answer beats a slow one).
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
  const deadline = Date.now() + limits.maxMs;
  let visited = 0;
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
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
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (matchesTestIgnore(rel)) continue;
        pending.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      const counted = native.has(ext) || APP_CONFIG_NAMES.has(entry.name)
        || (opts.countJs && JS_EXTENSIONS.has(ext));
      if (!counted || isNonAppFile(entry.name)) continue;
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.promises.stat(abs)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > built) candidates.push({ file: abs, mtimeMs });
    }
  }
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

export type CheckedConfig = Pick<TapsmithConfig, 'platform' | 'apk' | 'app' | 'rootDir' | 'outputDir' | 'testMatch'> & { testIgnore?: string[] };

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
  warned.clear();
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
  deps: { ci?: boolean; now?: () => number; fresh?: boolean } = {},
): Promise<StaleBuild | undefined> {
  if (deps.ci ?? isCI) return undefined;
  const artifact = configuredArtifact(config);
  if (!artifact) return undefined;
  const built = buildTime(artifact);
  if (built === undefined) return undefined;
  const now = deps.now ?? Date.now;
  const key = `${artifact}\0${built}\0${config.rootDir}\0${(config.testMatch ?? []).join('\0')}`;
  const memo = checks.get(key);
  if (memo && !deps.fresh && now() - memo.at < CHECK_TTL_MS) return memo.result;
  const result = runCheck(config, artifact).catch(() => undefined);
  checks.set(key, { at: now(), result });
  return result;
}

async function runCheck(config: CheckedConfig, artifact: string): Promise<StaleBuild | undefined> {
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
    isTestCode: async () => {
      const files = await discoverTestFiles(config.testMatch ?? [], rootDir, config.testIgnore);
      const { testFileModules } = await import('./network-api-scan.js');
      const modules = await testFileModules(files).catch(() => files);
      return new Set([...files, ...modules].map((f) => path.resolve(f)));
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

/** Keys of the changes this process has warned about, so a long-lived worker warns once per edit. */
const warned = new Set<string>();

/**
 * A test-result warning for `stale`, the first time this process sees this
 * edit (file and modification time) of this build; undefined after that.
 */
export function takeStaleBuildWarning(stale: StaleBuild | undefined): string | undefined {
  if (!stale) return undefined;
  const key = `${stale.artifact}\0${stale.buildMtimeMs}\0${stale.newest}\0${stale.newestMtimeMs}`;
  if (warned.has(key)) return undefined;
  warned.add(key);
  return staleBuildMessage(stale);
}

/**
 * The stale builds of a run's devices: the run's own config and each
 * device's session config (a group can mix platforms), each build once.
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
