/**
 * Build and id detection for `tapsmith init`: `--yes` picks from it, and the
 * interactive wizard offers it.
 * Pure parsers are separated from exec wrappers for testability.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { globSync, type IgnoreLike } from 'glob';
import { androidSdkRoots } from './emulator.js';
import { tryExec } from './env-scan.js';
import { decodeXmlEntities } from './xml-entities.js';

// ─── Project layout (PILOT-832) ───

/**
 * Where a project keeps its native projects: a React Native app has
 * `android/` and `ios/`; a native Android Studio project has its
 * `settings.gradle(.kts)` at the root; a native Xcode project has its
 * `.xcodeproj` (or `.xcworkspace`) at the root, or one folder down beside a
 * Gradle project (Kotlin Multiplatform's `iosApp/`).
 */
export interface ProjectLayout {
  /**
   * The Gradle project's directory: `android` (React Native, or a native
   * repository's `Android/` Gradle project) or `.` (a native project at the root).
   */
  androidRoot: string | undefined;
  /** Project-relative Xcode workspaces and projects, workspaces first within a folder. */
  iosProjects: string[];
  /** An `ios/` directory exists (React Native), with or without an Xcode project in it yet. */
  hasIosDir: boolean;
}

/** Folders never searched for projects or builds: dependencies, tooling output and hidden folders. */
const SKIPPED_DIR = /^(?:node_modules|Pods|Carthage|.*\.noindex|\..*)$/;

/** Bundles and Xcode project packages: matched themselves, never searched inside. */
const OPAQUE_DIR = /\.(?:app|xcodeproj|xcworkspace)$/;

/**
 * The glob `ignore` for every search here: skipped folders are neither
 * matched nor entered, and bundles are matched but not entered — a string
 * pattern such as `**\/*.app/**` would also drop the bundle itself. `skip`
 * names more folders to leave out entirely.
 */
function searchIgnore(skip?: RegExp): IgnoreLike {
  // Never the search root itself: a project may live in a folder named `build`.
  const skipped = (p: { name: string; relative(): string }): boolean => p.relative() !== '' && (SKIPPED_DIR.test(p.name) || (skip?.test(p.name) ?? false));
  return {
    ignored: skipped,
    childrenIgnored: (p) => skipped(p) || (p.relative() !== '' && OPAQUE_DIR.test(p.name)),
  };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Xcode workspaces before projects, then by path; a project's own inner `project.xcworkspace` never counts. */
function xcodeProjectsIn(cwd: string, patterns: string[]): string[] {
  const found = globSync(patterns, {
    cwd,
    ignore: searchIgnore(/^build$/),
    posix: true,
  }).filter((p) => isDir(path.join(cwd, p)));
  const rank = (p: string): number => (p.endsWith('.xcworkspace') ? 0 : 1);
  return found.sort((a, b) => path.posix.dirname(a).localeCompare(path.posix.dirname(b)) || rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * A directory named exactly `name` in `dir`: on a case-insensitive disk a
 * plain stat also finds a native project's `iOS/` source folder, which is
 * not React Native's `ios/`.
 */
function hasDirNamed(dir: string, name: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.includes(name) && isDir(path.join(dir, name));
}

const GRADLE_ROOT_FILES = ['settings.gradle.kts', 'settings.gradle', 'gradlew'];
const GRADLE_SETTINGS = ['settings.gradle.kts', 'settings.gradle'];

function hasAnyFile(dir: string, names: readonly string[]): boolean {
  return names.some((f) => fs.existsSync(path.join(dir, f)));
}

/** The folder in `cwd` whose name is `name` in any case (`iOS/` for `ios`), exact case first. */
function dirNamedAnyCase(cwd: string, name: string): string | undefined {
  if (hasDirNamed(cwd, name)) return name;
  let entries: string[];
  try {
    entries = fs.readdirSync(cwd);
  } catch {
    return undefined;
  }
  return entries.find((e) => e.toLowerCase() === name && isDir(path.join(cwd, e)));
}

/**
 * The Gradle project: React Native's `android/` (another case of it, such as
 * a native repository's `Android/` beside `iOS/`, only when it is a Gradle
 * project itself), else a root `settings.gradle`. A root `settings.gradle`
 * whose `android/` has no settings of its own wins: there `android/` is one
 * of the root project's modules (libGDX), built with the root's gradlew.
 */
function androidRootOf(cwd: string): string | undefined {
  const rootGradle = hasAnyFile(cwd, GRADLE_SETTINGS);
  const dir = dirNamedAnyCase(cwd, 'android');
  if (dir !== undefined) {
    const ownSettings = hasAnyFile(path.join(cwd, dir), GRADLE_SETTINGS);
    if (ownSettings || (!rootGradle && (dir === 'android' || hasAnyFile(path.join(cwd, dir), GRADLE_ROOT_FILES)))) return dir;
  }
  return rootGradle ? '.' : undefined;
}

export function detectProjectLayout(cwd: string): ProjectLayout {
  const hasIosDir = hasDirNamed(cwd, 'ios');
  // A native repository's `iOS/` folder may hold its Xcode project a level
  // deeper (`iOS/MyApp/MyApp.xcodeproj`); React Native's ios/ is searched as before.
  const iosVariant = hasIosDir ? undefined : dirNamedAnyCase(cwd, 'ios');
  const iosProjects = hasIosDir
    ? xcodeProjectsIn(cwd, ['ios/*.xcworkspace', 'ios/*.xcodeproj', 'ios/*/*.xcworkspace', 'ios/*/*.xcodeproj'])
    : xcodeProjectsIn(cwd, [
      '*.xcworkspace', '*.xcodeproj', '*/*.xcworkspace', '*/*.xcodeproj',
      ...(iosVariant ? [`${iosVariant}/*/*.xcworkspace`, `${iosVariant}/*/*.xcodeproj`] : []),
    ]);
  return { androidRoot: androidRootOf(cwd), iosProjects, hasIosDir };
}

/** The layout has an Android project. */
export function hasAndroidProject(layout: ProjectLayout): boolean {
  return layout.androidRoot !== undefined;
}

/** The layout has an iOS project (an `ios/` directory or an Xcode project). */
export function hasIosProject(layout: ProjectLayout): boolean {
  return layout.hasIosDir || layout.iosProjects.length > 0;
}

// ─── Android ───

/**
 * Returns project-relative APK paths (posix-style globs, deterministic order):
 * any Gradle module's `build/outputs/apk/` in the Android project, so
 * `android/app/…` in a React Native project and `app/…` in an Android Studio
 * one. Outside an Android project there is nothing to search, and
 * a walk of a home directory would stall init.
 */
export function findApkCandidates(cwd: string): string[] {
  const root = detectProjectLayout(cwd).androidRoot;
  if (root === undefined) return [];
  return globSync(`${root === '.' ? '' : `${root}/`}**/build/outputs/apk/**/*.apk`, {
    cwd,
    nodir: true,
    posix: true,
    maxDepth: 12,
    ignore: searchIgnore(/^androidTest$/),
  }).filter((candidate) => {
    const parts = candidate.split(/[\\/]/);
    return !parts.includes('androidTest') && !/-androidTest\.apk$/i.test(candidate);
  }).sort();
}

/** A literal `applicationId "com.x"` (Groovy) or `applicationId = "com.x"` (Kotlin DSL). */
const APPLICATION_ID = /\bapplicationId\s*(?:=\s*)?\(?\s*["']([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)["']/;

/**
 * The app module's `applicationId` from `app/build.gradle(.kts)` in the
 * project's Gradle root, the package an APK built from it will carry
 * (before any build variant's suffix): the wizard's package prefill when there is
 * no APK to read. Only a literal: an id computed from a variable
 * is left for the user to type.
 */
export function detectGradleApplicationId(cwd: string, layout: ProjectLayout = detectProjectLayout(cwd)): string | undefined {
  if (layout.androidRoot === undefined) return undefined;
  for (const file of ['build.gradle.kts', 'build.gradle']) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(cwd, layout.androidRoot, 'app', file), 'utf8');
    } catch {
      continue;
    }
    // Line comments dropped first, so a commented-out id is not read.
    const id = APPLICATION_ID.exec(source.replace(/\/\/.*$/gm, ''))?.[1];
    if (id) return id;
  }
  return undefined;
}

/** Prefer debug builds when the glob found both debug and release artifacts. */
export function preferDebugApk(candidates: string[]): string[] {
  const debug = candidates.filter((c) => /debug/i.test(c));
  return debug.length > 0 ? debug : candidates;
}

export function parseAapt2Badging(output: string): string | undefined {
  const match = output.match(/package: name='([^']+)'/);
  return match?.[1];
}

export interface Aapt2Deps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  /** `aapt2` runs from PATH. */
  onPath: () => boolean;
}

/**
 * Locate aapt2: PATH, then the newest build-tools in each SDK Tapsmith looks
 * in — `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then the OS default where
 * Android Studio installs it without setting either.
 */
export function resolveAapt2(overrides: Partial<Aapt2Deps> = {}): string {
  const deps: Aapt2Deps = {
    env: process.env,
    platform: process.platform,
    home: os.homedir(),
    onPath: () => tryExec('aapt2', ['version']) !== undefined,
    ...overrides,
  };
  if (deps.onPath()) return 'aapt2';
  // execFile resolves .exe on PATH, but existsSync needs the explicit suffix.
  const binName = deps.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  for (const root of androidSdkRoots(deps.env, deps.platform, deps.home)) {
    const buildTools = p.join(root, 'build-tools');
    try {
      if (!isDir(buildTools)) continue;
      const versions = fs.readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) {
        const candidate = p.join(buildTools, v, binName);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      // Try the next SDK when this one is unreadable.
    }
  }
  return 'aapt2';
}

export function detectAndroidPackage(apkPath: string): string | undefined {
  const output = tryExec(resolveAapt2(), ['dump', 'badging', apkPath]);
  return output ? parseAapt2Badging(output) : undefined;
}

// ─── iOS ───

type AppleSdk = 'iphonesimulator' | 'iphoneos';

/** An XCUITest runner Xcode builds beside the app (`<Target>UITests-Runner.app`), never the app under test. */
function isTestRunner(app: string): boolean {
  return /-Runner\.app$/.test(app);
}

/**
 * `*-<sdk>/*.app` anywhere in the project: `ios/build/…` (React Native) and
 * `build/Build/Products/…` from `-derivedDataPath build` at the root of a
 * native project (PILOT-832). Bundles inside a bundle (watch apps,
 * extensions) and XCUITest runners are not apps to test.
 */
function findIosBuilds(cwd: string, sdk: AppleSdk): string[] {
  // `ios/` in a React Native project; in a native one, the top folder of each
  // Xcode project (the whole project when one is at the root) plus a root
  // `build/` (a build run from the root). Nothing outside an iOS project, as
  // for APKs: run in a home directory holding `~/MyApp/MyApp.xcodeproj`, a
  // whole-tree walk would reach other projects' builds in ~/Library.
  const layout = detectProjectLayout(cwd);
  if (!hasIosProject(layout)) return [];
  const tops = layout.hasIosDir ? ['ios'] : [...new Set(layout.iosProjects.map((p) => (p.includes('/') ? p.split('/')[0] : '.')))];
  const patterns = tops.includes('.')
    ? [`**/*-${sdk}/*.app`]
    : [...tops, ...(layout.hasIosDir ? [] : ['build'])].map((top) => `${top}/**/*-${sdk}/*.app`);
  return [...new Set(globSync(patterns, {
    cwd,
    posix: true,
    maxDepth: 12,
    ignore: searchIgnore(),
  }))].filter((app) => !isTestRunner(app)).sort();
}

/** Returns project-relative simulator .app bundle paths. */
export function findIosAppCandidates(cwd: string): string[] {
  return findIosBuilds(cwd, 'iphonesimulator');
}

/** Returns project-relative device (iphoneos) .app bundle paths. */
export function findIosDeviceAppCandidates(cwd: string): string[] {
  return findIosBuilds(cwd, 'iphoneos');
}

/** Where Xcode builds when nothing says otherwise (a build from the Xcode UI, or `xcodebuild` without `-derivedDataPath`). */
export const DEFAULT_DERIVED_DATA = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** `WorkspacePath` from a DerivedData folder's `info.plist` (an XML plist Xcode writes). */
function derivedDataWorkspace(dir: string): string | undefined {
  let xml: string;
  try {
    xml = fs.readFileSync(path.join(dir, 'info.plist'), 'utf8');
  } catch {
    return undefined;
  }
  const match = /<key>WorkspacePath<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  return match ? decodeXmlEntities(match[1]) : undefined;
}

/**
 * This project's builds in Xcode's DerivedData (absolute paths): the
 * `<Name>-<hash>` folders whose `info.plist` says they belong to one of its
 * Xcode projects, not another checkout of a project with the same name.
 * These paths are specific to this Mac, so
 * init offers them only when the project holds no build of its own.
 */
export function findDerivedDataApps(
  cwd: string,
  xcodeProjects: string[],
  sdk: AppleSdk,
  derivedData: string = DEFAULT_DERIVED_DATA,
): string[] {
  if (xcodeProjects.length === 0) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(derivedData);
  } catch {
    return [];
  }
  // Matched by WorkspacePath alone, not the folder name: Xcode rewrites the
  // name (`My App` becomes `My_App-<hash>`).
  const wanted = new Set(xcodeProjects.map((p) => realpathOr(path.resolve(cwd, p))));
  const apps: string[] = [];
  const matched: Array<{ workspace: string; apps: string[] }> = [];
  for (const entry of entries.sort()) {
    if (entry.lastIndexOf('-') <= 0) continue;
    const dir = path.join(derivedData, entry);
    const recorded = derivedDataWorkspace(dir);
    const workspace = recorded === undefined ? undefined : realpathOr(recorded);
    if (!workspace || !wanted.has(workspace)) continue;
    const products = path.join(dir, 'Build', 'Products');
    matched.push({
      workspace,
      apps: globSync(`*-${sdk}/*.app`, { cwd: products, posix: true })
        .filter((app) => !isTestRunner(app))
        .sort()
        .map((app) => path.join(products, app)),
    });
  }
  // A build of the bare .xcodeproj beside its own workspace (CocoaPods'
  // `App.xcworkspace` for `App.xcodeproj`, opened by mistake before `pod
  // install`) is not the app: the workspace's build wins, when the workspace
  // has one of this kind. Another project beside it keeps its builds.
  const stem = (p: string): string => p.replace(/\.(xcodeproj|xcworkspace)$/, '');
  const workspaces = new Set(matched.filter((m) => m.workspace.endsWith('.xcworkspace') && m.apps.length > 0).map((m) => stem(m.workspace)));
  for (const m of matched) {
    if (m.workspace.endsWith('.xcodeproj') && workspaces.has(stem(m.workspace))) continue;
    apps.push(...m.apps);
  }
  return apps;
}

export function detectIosBundleId(appPath: string): string | undefined {
  const plistPath = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plistPath)) return undefined;
  return tryExec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]);
}

// ─── Build hints (PILOT-832) ───

const BUILD_DOCS = 'https://tapsmith.dev/getting-started/#build-the-app-under-test';

/** `arg` as a shell reads it: bare when it is plain, else single-quoted. */
function shellArg(arg: string): string {
  return /^[\w./@:+=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The Xcode workspace or project to build with, as `xcodebuild` names it: the first workspace, else the first project. */
function xcodeBuildTarget(layout: ProjectLayout): { dir: string; flag: '-workspace' | '-project'; file: string; scheme: string } | undefined {
  const project = layout.iosProjects[0];
  if (!project) return undefined;
  const file = path.posix.basename(project);
  return {
    dir: path.posix.dirname(project),
    flag: file.endsWith('.xcworkspace') ? '-workspace' : '-project',
    file,
    scheme: file.replace(/\.(xcodeproj|xcworkspace)$/, ''),
  };
}

/**
 * How to build the app so init finds it, as a sentence naming the project's
 * own Gradle or Xcode project: `./gradlew assembleDebug` at the root of an
 * Android Studio project, in `android/` for React Native; for iOS,
 * `xcodebuild` with this project's workspace or project and
 * `-derivedDataPath build`, which writes the `.app` where init looks. A
 * React Native Debug build needs Metro, which a native one does not.
 */
export function nativeBuildHint(platform: 'android' | 'ios', layout: ProjectLayout, reactNative: boolean): string {
  if (platform === 'android') {
    const metro = reactNative ? '; a React Native Debug build also needs Metro running' : '';
    if (layout.androidRoot === '.') {
      return `Build one with \`./gradlew assembleDebug\`, which writes app/build/outputs/apk/debug/app-debug.apk (<module>/build/outputs/apk/ for a module not named app; see ${BUILD_DOCS})`;
    }
    const where = layout.androidRoot === undefined ? '' : `cd ${shellArg(layout.androidRoot)} && `;
    return `Build one first (e.g. \`${where}./gradlew assembleDebug\`${metro}; see ${BUILD_DOCS})`;
  }
  const target = xcodeBuildTarget(layout);
  if (!target) {
    return 'Build one for the simulator first (in the folder with your Xcode project: `xcodebuild -workspace <App>.xcworkspace -scheme <App> -sdk iphonesimulator -derivedDataPath build build`, '
      + `or -project <App>.xcodeproj without a workspace; see ${BUILD_DOCS})`;
  }
  // A React Native Debug build loads its JavaScript from Metro: Release runs on its own.
  const configuration = reactNative ? 'Release' : 'Debug';
  const cd = target.dir === '.' ? '' : `cd ${shellArg(target.dir)} && `;
  const out = `${target.dir === '.' ? '' : `${target.dir}/`}build/Build/Products/${configuration}-iphonesimulator/`;
  const metro = reactNative ? '; a Release build bundles the JavaScript, while a Debug one needs Metro running' : '';
  return `Build one for the simulator first with \`${cd}xcodebuild ${target.flag} ${shellArg(target.file)} -scheme ${shellArg(target.scheme)} -configuration ${configuration} -sdk iphonesimulator -derivedDataPath build build\`, `
    + `which writes the .app under ${out} (\`xcodebuild -list\` shows the schemes if yours is not ${target.scheme}${metro}; see ${BUILD_DOCS})`;
}

/**
 * The warning for a build init took from Xcode's DerivedData: the path is
 * this Mac's alone, so the config will not work for teammates or CI.
 */
export function derivedDataBuildWarning(app: string, layout: ProjectLayout, sdk: AppleSdk = 'iphonesimulator', reactNative = false): string {
  const using = `Using ${app} from Xcode's DerivedData: only this Mac has that path, and it changes when DerivedData is cleared. `;
  if (sdk === 'iphoneos') {
    return `${using}For a config that works on other machines, build the device app into the project with \`-derivedDataPath build\` `
      + '(see https://tapsmith.dev/platform/ios-physical-devices/) and set the device app path to it.';
  }
  return `${using}For a config that works on other machines and in CI, build into the project instead — ${nativeBuildHint('ios', layout, reactNative).replace(/^Build one for the simulator first/, 'build for the simulator')} — and set app to the new path.`;
}

// ─── Expo (PILOT-557) ───

/**
 * An Expo project, as `tapsmith init` needs it: whether its native projects
 * have been generated yet (a managed project has neither `android/` nor
 * `ios/` until `expo prebuild` or `expo run:*`), the ids its app config
 * declares, and whether it uses Tapsmith's warm-reset hooks.
 */
export interface ExpoProject {
  /** `expo.android.package` from the app config. */
  androidPackage?: string;
  /** `expo.ios.bundleIdentifier` from the app config. */
  iosBundleId?: string;
  hasAndroidDir: boolean;
  hasIosDir: boolean;
  /** `@tapsmith/react-native` is a dependency, so test builds want `EXPO_PUBLIC_TAPSMITH_HOOKS=1`. */
  usesTapsmithHooks: boolean;
}

const EXPO_DYNAMIC_CONFIG_FILES = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs', 'app.config.json'];
const EXPO_CONFIG_FILES = ['app.json', ...EXPO_DYNAMIC_CONFIG_FILES];

/** The ids an Expo app config declares: `app.json` (wrapped in `expo` or not) or `expo config` output. */
export function parseExpoAppConfig(config: unknown): { androidPackage?: string; iosBundleId?: string } {
  if (!isRecord(config)) return {};
  const exp = isRecord(config['expo']) ? config['expo'] : config;
  const android = isRecord(exp['android']) ? exp['android'] : {};
  const ios = isRecord(exp['ios']) ? exp['ios'] : {};
  const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
  return { androidPackage: nonEmpty(android['package']), iosBundleId: nonEmpty(ios['bundleIdentifier']) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * The project's resolved public app config. The project's own Expo CLI
 * (`expo config`) evaluates a dynamic `app.config.ts`/`.js` exactly as a
 * build would; when it can't run (dependencies not installed, a config that
 * throws), a static `app.json` is read instead — unless an `app.config.*`
 * exists, which takes app.json only as its base and may override the ids, so
 * nothing is read rather than a possibly stale id.
 */
export function readExpoAppConfig(cwd: string): unknown {
  let cli: string | undefined;
  try {
    const expoPkg = createRequire(path.join(cwd, 'noop.js')).resolve('expo/package.json');
    cli = path.join(path.dirname(expoPkg), 'bin', 'cli');
  } catch {
    // Not installed: fall back to app.json.
  }
  if (cli && fs.existsSync(cli)) {
    try {
      const out = execFileSync(process.execPath, [cli, 'config', '--json', '--type', 'public'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
      });
      return JSON.parse(out);
    } catch {
      // Fall through to the static read.
    }
  }
  if (EXPO_DYNAMIC_CONFIG_FILES.some((f) => fs.existsSync(path.join(cwd, f)))) return undefined;
  return readJson(path.join(cwd, 'app.json'));
}

/** The project's dependencies and devDependencies, or undefined without a readable package.json. */
function projectDependencies(cwd: string): Record<string, unknown> | undefined {
  const pkg = readJson(path.join(cwd, 'package.json'));
  if (!isRecord(pkg)) return undefined;
  return { ...(isRecord(pkg['devDependencies']) ? pkg['devDependencies'] : {}), ...(isRecord(pkg['dependencies']) ? pkg['dependencies'] : {}) };
}

/**
 * Whether the app that owns `dir` depends on `@tapsmith/react-native`. Walks
 * up from `dir` (a Tapsmith config often sits in an `e2e/` folder with its own
 * package.json) and stops at the first package.json that names the hooks
 * package, `react-native` or `expo` — that one is the app's.
 */
export function appDependsOnTapsmithHooks(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const deps = projectDependencies(current);
    if (deps && '@tapsmith/react-native' in deps) return true;
    if (deps && ('react-native' in deps || 'expo' in deps)) return false;
    if (path.dirname(current) === current) return false;
  }
}

/** A React Native app (bare or Expo), which usually targets both platforms. */
export function isReactNativeProject(cwd: string): boolean {
  const deps = projectDependencies(cwd);
  return deps !== undefined && ('react-native' in deps || 'expo' in deps);
}

/**
 * The Expo project at `cwd`, or undefined when it is not one: `expo` among
 * its dependencies and an app config (`app.json` or `app.config.*`) beside
 * its package.json. A bare React Native app has an `app.json` too, so the
 * dependency is what tells them apart.
 */
export function detectExpoProject(
  cwd: string,
  readConfig: (cwd: string) => unknown = readExpoAppConfig,
): ExpoProject | undefined {
  const deps = projectDependencies(cwd);
  if (!deps || !('expo' in deps)) return undefined;
  if (!EXPO_CONFIG_FILES.some((f) => fs.existsSync(path.join(cwd, f)))) return undefined;
  return {
    ...parseExpoAppConfig(readConfig(cwd)),
    hasAndroidDir: fs.existsSync(path.join(cwd, 'android')),
    hasIosDir: fs.existsSync(path.join(cwd, 'ios')),
    usesTapsmithHooks: '@tapsmith/react-native' in deps,
  };
}

const EXPO_BUILD_DOCS = 'https://tapsmith.dev/getting-started/#react-native-and-expo';
const HOOKS_FLAG = 'EXPO_PUBLIC_TAPSMITH_HOOKS=1';

/** What the hooks flag means for this project's test build, said beside the build command. */
function expoHooksNote(expo: ExpoProject): string {
  return expo.usesTapsmithHooks
    ? `${HOOKS_FLAG} keeps @tapsmith/react-native's warm-reset hooks on in a release build when the app passes `
      + '`enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}` to <TapsmithTestHooks> '
      + '(Expo does not inline EXPO_PUBLIC_* variables inside node_modules): set it for test builds only, never for store builds.'
    : `For sub-second resets between tests, mount @tapsmith/react-native with \`enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}\` and build test builds with ${HOOKS_FLAG} (https://tapsmith.dev/guides/warm-reset/).`;
}

/** The build step for one platform, as a sentence. */
function expoBuildStep(platform: 'android' | 'ios', expo: ExpoProject): string {
  const env = expo.usesTapsmithHooks ? `${HOOKS_FLAG} ` : '';
  if (platform === 'android') {
    // `expo run:android` resolves a device before it builds, so it fails with
    // no emulator or device; prebuild + gradle builds headless (as CI does).
    const generate = expo.hasAndroidDir ? '' : '`npx expo prebuild --platform android` (this Expo project has no android/ yet), then ';
    return `Build a release APK with ${generate}\`cd android && ${env}./gradlew assembleRelease\`, `
      + 'which writes android/app/build/outputs/apk/release/app-release.apk '
      + '(`npx expo run:android --variant release` builds and installs in one step, but needs a running emulator or device to install on).';
  }
  const generate = expo.hasIosDir ? '' : '`npx expo prebuild --platform ios` (this Expo project has no ios/ yet), then ';
  return `Build a simulator app with ${generate}\`cd ios && ${env}xcodebuild -workspace <App>.xcworkspace -scheme <App> `
    + '-configuration Release -sdk iphonesimulator -derivedDataPath build build`; '
    + '`npx expo run:ios --configuration Release` builds into Xcode\'s DerivedData instead, where init does not look.';
}

/**
 * How to build an Expo project's app so `tapsmith init` finds it: the release
 * build getting-started documents (a release build runs without Metro) for
 * each platform, with the hooks flag folded in when the app uses them, then
 * `alternative` (the flag that skips the build), the hooks note and the docs.
 */
export function expoBuildHint(platforms: Array<'android' | 'ios'>, expo: ExpoProject, alternative?: string): string {
  const steps = platforms.map((p) => {
    const step = expoBuildStep(p, expo);
    return platforms.length > 1 ? `${p === 'android' ? 'Android' : 'iOS'}: ${step}` : step;
  });
  return [...steps, ...(alternative ? [alternative] : []), expoHooksNote(expo), `See ${EXPO_BUILD_DOCS}`].join(' ');
}
