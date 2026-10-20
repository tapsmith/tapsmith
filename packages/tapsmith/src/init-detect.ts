/**
 * Build and id detection for `tapsmith init`: `--yes` picks from it, and the
 * interactive wizard offers it.
 * Pure parsers are separated from exec wrappers for testability.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { globSync } from 'glob';
import { tryExec } from './env-scan.js';

// ─── Android ───

/** Returns project-relative APK paths (posix-style globs, deterministic order). */
export function findApkCandidates(cwd: string): string[] {
  return globSync('android/**/build/outputs/apk/**/*.apk', {
    cwd,
    nodir: true,
    ignore: ['**/node_modules/**', '**/build/outputs/apk/androidTest/**', '**/*-androidTest.apk'],
  }).filter((candidate) => {
    const parts = candidate.split(/[\\/]/);
    return !parts.includes('androidTest') && !/-androidTest\.apk$/i.test(candidate);
  }).sort();
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

/** Locate aapt2 (PATH, then newest build-tools under ANDROID_HOME). */
export function resolveAapt2(): string {
  if (tryExec('aapt2', ['version']) !== undefined) return 'aapt2';
  // execFile resolves .exe on PATH, but existsSync needs the explicit suffix.
  const binName = process.platform === 'win32' ? 'aapt2.exe' : 'aapt2';
  const androidHome = process.env['ANDROID_HOME'] || process.env['ANDROID_SDK_ROOT'];
  if (androidHome) {
    const buildTools = path.join(androidHome, 'build-tools');
    try {
      if (fs.existsSync(buildTools) && fs.statSync(buildTools).isDirectory()) {
        const versions = fs.readdirSync(buildTools).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const v of versions) {
          const candidate = path.join(buildTools, v, binName);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    } catch {
      // Fall through when the SDK directory is unreadable.
    }
  }
  return 'aapt2';
}

export function detectAndroidPackage(apkPath: string): string | undefined {
  const output = tryExec(resolveAapt2(), ['dump', 'badging', apkPath]);
  return output ? parseAapt2Badging(output) : undefined;
}

// ─── iOS ───

function findIosBuilds(cwd: string, sdk: 'iphonesimulator' | 'iphoneos'): string[] {
  return globSync(`ios/**/*-${sdk}/*.app`, {
    cwd,
    ignore: ['**/node_modules/**'],
  }).sort();
}

/** Returns project-relative simulator .app bundle paths. */
export function findIosAppCandidates(cwd: string): string[] {
  return findIosBuilds(cwd, 'iphonesimulator');
}

/** Returns project-relative device (iphoneos) .app bundle paths. */
export function findIosDeviceAppCandidates(cwd: string): string[] {
  return findIosBuilds(cwd, 'iphoneos');
}

export function detectIosBundleId(appPath: string): string | undefined {
  const plistPath = path.join(appPath, 'Info.plist');
  if (!fs.existsSync(plistPath)) return undefined;
  return tryExec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plistPath]);
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
