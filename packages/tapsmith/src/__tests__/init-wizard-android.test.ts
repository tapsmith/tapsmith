import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EnvScan } from '../env-scan.js';
import type { ExpoProject } from '../init-detect.js';
import { stripAnsi } from '../cli-json.js';

// ─── Mocks ───

// The wizard's prompts, answered by message so the test reads as a script and
// records every question asked (with its choices, initial and validate).
interface Question {
  type: string;
  message: string;
  initial?: unknown;
  choices?: Array<{ name: string; message: string }>;
  validate?: (val: string) => true | string;
}
const answers = new Map<RegExp, unknown>();
const questions: Question[] = [];
vi.mock('enquirer', () => ({
  default: class {
    prompt(question: Question): Promise<Record<string, unknown>> {
      questions.push(question);
      for (const [pattern, answer] of answers) {
        if (pattern.test(question.message)) {
          return Promise.resolve({ _: typeof answer === 'function' ? (answer as (q: Question) => unknown)(question) : answer });
        }
      }
      return Promise.reject(new Error(`unexpected prompt: ${question.message}`));
    }
  },
}));

let apkCandidates: string[] = [];
const packages = new Map<string, string>();
vi.mock('../init-detect.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../init-detect.js')>();
  return {
    ...actual,
    findApkCandidates: () => apkCandidates,
    detectAndroidPackage: (apkPath: string) => packages.get(apkPath),
    findIosAppCandidates: () => [],
    findIosDeviceAppCandidates: () => [],
    detectIosBundleId: () => undefined,
  };
});

const { configureAndroid } = await import('../init.js');

const env: EnvScan = {
  nodeVersion: '22.0.0',
  rosettaWarning: undefined,
  daemonBin: undefined,
  agentApk: false,
  agentTestApk: false,
  adbVersion: '1.0.41',
  androidHome: undefined,
  xcodeVersion: undefined,
  simulators: [],
  avds: ['Pixel_API_36'],
  avdImages: [{ name: 'Pixel_API_36', tagId: 'google_apis' }],
  isMacOS: false,
};

const DEBUG_APK = 'android/app/build/outputs/apk/debug/app-debug.apk';
const RELEASE_APK = 'android/app/build/outputs/apk/release/app-release.apk';

function script(extra: Array<[RegExp, unknown]> = []): void {
  // Extras first: the first matching pattern answers.
  for (const [pattern, answer] of extra) answers.set(pattern, answer);
  answers.set(/How will you run Android tests/, 'emulators');
  answers.set(/Which AVD/, 'Pixel_API_36');
}

const question = (pattern: RegExp): Question | undefined => questions.find((q) => pattern.test(q.message));
let logged: string[] = [];

// ─── Tests ───

describe('configureAndroid() build detection (PILOT-513)', () => {
  beforeEach(() => {
    answers.clear();
    questions.length = 0;
    packages.clear();
    apkCandidates = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(stripAnsi(args.join(' '))); });
    // Keep the machine's own Android SDK out of the adb fix.
    vi.unstubAllEnvs();
    vi.stubEnv('ANDROID_HOME', '');
    vi.stubEnv('ANDROID_SDK_ROOT', '');
    vi.stubEnv('HOME', path.join(os.tmpdir(), 'tapsmith-no-such-home'));
    vi.stubEnv('LOCALAPPDATA', '');
  });

  it('offers the one APK it found, pre-selected, and reads its package', async () => {
    apkCandidates = [RELEASE_APK];
    packages.set(RELEASE_APK, 'com.acme.app');
    script([[/Where is your Android APK/, RELEASE_APK]]);

    const android = await configureAndroid(env);

    const q = question(/Where is your Android APK/);
    expect(q?.type).toBe('select');
    expect(q?.choices?.map((c) => c.name)[0]).toBe(RELEASE_APK);
    // enquirer echoes the chosen choice's name, so "another path" must read as its label.
    expect(q?.choices?.at(-1)).toEqual({ name: 'Enter another path…', message: 'Enter another path…' });
    expect(android.apkPath).toBe(RELEASE_APK);
    expect(android.packageName).toBe('com.acme.app');
    expect(question(/package name/)).toBeUndefined();
  });

  it('lists every APK, debug builds first, when it finds several', async () => {
    apkCandidates = [DEBUG_APK, RELEASE_APK].sort().reverse();
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid(env);

    const names = question(/Where is your Android APK/)?.choices?.map((c) => c.name);
    expect(names?.slice(0, 2)).toEqual([DEBUG_APK, RELEASE_APK]);
  });

  it('asks for a typed path, validated and trimmed, when the user picks another path', async () => {
    apkCandidates = [RELEASE_APK];
    script([
      // The last choice is "Enter another path…".
      [/Where is your Android APK/, (q: Question) => q.choices?.at(-1)?.name],
      [/Path to your Android APK/, '  ./custom/app.apk  '],
      [/package name/, 'com.acme.custom'],
    ]);

    const android = await configureAndroid(env);

    const q = question(/Path to your Android APK/);
    expect(q?.validate?.(os.tmpdir())).toMatch(/is a directory, not an APK file/);
    expect(q?.initial).toBeUndefined();
    expect(android.apkPath).toBe('./custom/app.apk');
    expect(android.packageName).toBe('com.acme.custom');
  });

  it('with no APK found, asks for its path with no placeholder default, and says how to build one', async () => {
    script([
      [/Where is your Android APK/, './built/app.apk'],
      [/package name/, 'com.acme.app'],
    ]);

    const android = await configureAndroid(env);

    const q = question(/Where is your Android APK/);
    expect(q?.type).toBe('input');
    expect(q?.initial).toBeUndefined();
    expect(q?.validate).toBeTypeOf('function');
    expect(logged.join('\n')).toMatch(/No APK found in the project's build outputs/);
    expect(android.apkPath).toBe('./built/app.apk');
  });

  it('in an Android Studio project with no APK, says to run ./gradlew assembleDebug at the root, without Metro (PILOT-832)', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-native-'));
    fs.writeFileSync(path.join(project, 'settings.gradle.kts'), '');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    script([
      [/Where is your Android APK/, './built/app.apk'],
      [/package name/, 'com.acme.app'],
    ]);
    try {
      await configureAndroid(env);
    } finally {
      vi.mocked(process.cwd).mockRestore();
      fs.rmSync(project, { recursive: true, force: true });
    }
    const out = logged.join('\n');
    expect(out).toContain('`./gradlew assembleDebug`, which writes app/build/outputs/apk/debug/app-debug.apk');
    expect(out).not.toContain('cd android');
    expect(out).not.toContain('Metro');
  });

  it('never defaults the package name to a placeholder when it cannot be read', async () => {
    apkCandidates = [DEBUG_APK];
    script([
      [/Where is your Android APK/, DEBUG_APK],
      [/package name/, ' com.acme.typed '],
    ]);

    const android = await configureAndroid(env);

    const q = question(/package name/);
    expect(q?.initial).toBeUndefined();
    expect(q?.validate?.('   ')).not.toBe(true);
    expect(android.packageName).toBe('com.acme.typed');
    expect(JSON.stringify(questions)).not.toContain('com.example');
  });

  it('says to install an Android SDK when ADB is missing and there is none (PILOT-558)', async () => {
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid({ ...env, adbVersion: undefined });

    const out = logged.join('\n');
    expect(out).toMatch(/ADB not found/);
    expect(out).toContain('Install Android Studio');
    expect(out).toContain('https://tapsmith.dev/getting-started/#prerequisites');
  });

  it('names the installed platform-tools directory when adb is under ANDROID_HOME but not on PATH', async () => {
    const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdk-'));
    const platformTools = path.join(sdk, 'platform-tools');
    fs.mkdirSync(platformTools);
    fs.writeFileSync(path.join(platformTools, process.platform === 'win32' ? 'adb.exe' : 'adb'), '');
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);
    try {
      vi.stubEnv('ANDROID_HOME', sdk);
      await configureAndroid({ ...env, adbVersion: undefined, androidHome: sdk });
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true });
    }

    const out = logged.join('\n');
    expect(out).toContain(`adb is in ${platformTools} but not on PATH`);
    expect(out).toContain(`export PATH="${platformTools}:$PATH"`);
    expect(out).not.toMatch(/Install Android platform-tools/);
  });

  // On Windows the default SDK is under LOCALAPPDATA, not HOME.
  it.skipIf(process.platform === 'win32')('finds platform-tools at Android Studio\'s default SDK location when ANDROID_HOME is unset', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-home-'));
    const sdk = process.platform === 'darwin' ? path.join(home, 'Library', 'Android', 'sdk') : path.join(home, 'Android', 'Sdk');
    const platformTools = path.join(sdk, 'platform-tools');
    fs.mkdirSync(platformTools, { recursive: true });
    fs.writeFileSync(path.join(platformTools, 'adb'), '');
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);
    try {
      vi.stubEnv('HOME', home);
      await configureAndroid({ ...env, adbVersion: undefined });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }

    expect(logged.join('\n')).toContain(`adb is in ${platformTools} but not on PATH`);
  });

  it('says nothing about ADB when it is present', async () => {
    apkCandidates = [DEBUG_APK];
    packages.set(DEBUG_APK, 'com.acme.app');
    script([[/Where is your Android APK/, DEBUG_APK]]);

    await configureAndroid(env);

    expect(logged.join('\n')).not.toMatch(/ADB/);
  });
});

describe('configureAndroid() on an Expo project (PILOT-557)', () => {
  const expo: ExpoProject = { androidPackage: 'com.acme.expo', hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: true };

  beforeEach(() => {
    answers.clear();
    questions.length = 0;
    packages.clear();
    apkCandidates = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(stripAnsi(args.join(' '))); });
  });

  it('with no APK found, gives the Expo build (prebuild first, with the hooks flag), not a gradlew in an android/ that does not exist', async () => {
    script([
      [/Where is your Android APK/, './built/app.apk'],
      [/package name/, 'com.acme.expo'],
    ]);

    await configureAndroid(env, expo);

    const out = logged.join('\n');
    expect(out).toContain('`npx expo prebuild --platform android` (this Expo project has no android/ yet), then `cd android && EXPO_PUBLIC_TAPSMITH_HOOKS=1 ./gradlew assembleRelease`');
    expect(out).not.toContain('assembleDebug');
  });

  it('prefills the package prompt from the app config when the APK cannot be read', async () => {
    apkCandidates = [RELEASE_APK];
    script([
      [/Where is your Android APK/, RELEASE_APK],
      [/package name/, (q: Question) => q.initial],
    ]);

    const android = await configureAndroid(env, expo);

    expect(question(/package name/)?.initial).toBe('com.acme.expo');
    expect(android.packageName).toBe('com.acme.expo');
  });

  it('the package read from the APK wins over the app config', async () => {
    apkCandidates = [RELEASE_APK];
    packages.set(RELEASE_APK, 'com.acme.built');
    script([[/Where is your Android APK/, RELEASE_APK]]);

    const android = await configureAndroid(env, expo);

    expect(android.packageName).toBe('com.acme.built');
    expect(question(/package name/)).toBeUndefined();
  });
});
