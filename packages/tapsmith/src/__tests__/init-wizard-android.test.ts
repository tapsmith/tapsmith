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
    expect(q?.choices?.at(-2)).toEqual({ name: 'Enter another path…', message: 'Enter another path…' });
    expect(q?.choices?.at(-1)?.name).toBe('Skip for now');
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
      // The next-to-last choice is "Enter another path…".
      [/Where is your Android APK/, (q: Question) => q.choices?.at(-2)?.name],
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

  it('in a Flutter project with no APK, says to run flutter build apk, and prefills the app module\'s id (PILOT-868)', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-flutter-'));
    fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: app\nflutter:\n  uses-material-design: true\n');
    fs.mkdirSync(path.join(project, 'android', 'app'), { recursive: true });
    fs.writeFileSync(path.join(project, 'android', 'settings.gradle.kts'), '');
    fs.writeFileSync(path.join(project, 'android', 'app', 'build.gradle.kts'), 'android { defaultConfig { applicationId = "dev.acme.flutter" } }\n');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    script([
      [/Where is your Android APK/, ''],
      [/package name/, (q: Question) => q.choices?.[0]?.name],
    ]);
    let android;
    try {
      android = await configureAndroid(env);
    } finally {
      vi.mocked(process.cwd).mockRestore();
      fs.rmSync(project, { recursive: true, force: true });
    }
    const out = logged.join('\n');
    expect(out).toContain('No APK found in the project\'s build outputs (build/app/outputs/flutter-apk/ or **/build/outputs/apk/)');
    expect(out).toContain('`flutter build apk --debug`, which writes build/app/outputs/flutter-apk/app-debug.apk');
    expect(out).not.toContain('gradlew');
    expect(android.packageName).toBe('dev.acme.flutter');
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
      await configureAndroid({ ...env, adbVersion: undefined, adbOffPath: platformTools, androidHome: sdk });
    } finally {
      fs.rmSync(sdk, { recursive: true, force: true });
    }

    const out = logged.join('\n');
    // Says adb is off PATH, as the environment block does, not missing (PILOT-832).
    expect(out).toContain('ADB is not on PATH — Tapsmith cannot reach');
    expect(out).not.toContain('ADB not found');
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
      [/package name/, (q: Question) => q.choices?.[0].name],
    ]);

    const android = await configureAndroid(env, expo);

    // A select, the id first: an input's initial would make Enter take it, so it could not be skipped (PILOT-778).
    expect(question(/package name/)?.type).toBe('select');
    expect(question(/package name/)?.choices?.map((c) => c.name)).toEqual(['com.acme.expo', 'Enter another…', 'Skip for now']);
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

describe('configureAndroid() with no build yet (PILOT-778)', () => {
  beforeEach(() => {
    answers.clear();
    questions.length = 0;
    packages.clear();
    apkCandidates = [];
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(stripAnsi(args.join(' '))); });
  });

  it('Enter at the APK prompt skips it, and an empty package name skips that too', async () => {
    script([
      [/Where is your Android APK/, ''],
      [/package name/, '   '],
    ]);

    const android = await configureAndroid(env);

    const apk = question(/Where is your Android APK/);
    expect(apk?.message).toMatch(/Enter to skip/);
    expect(apk?.validate?.('')).toBe(true);
    expect(apk?.validate?.('   ')).toBe(true);
    expect(question(/package name/)?.message).toMatch(/Enter to skip/);
    // Nothing to validate: any answer, empty included, moves on.
    expect(question(/package name/)?.validate).toBeUndefined();
    expect(android.apkPath).toBeUndefined();
    expect(android.packageName).toBeUndefined();
  });

  it('a suggested package can still be skipped, by "Skip for now" (PILOT-778)', async () => {
    const expo: ExpoProject = { androidPackage: 'com.acme.expo', hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: false };
    script([
      [/Where is your Android APK/, ''],
      [/package name/, 'Skip for now'],
    ]);

    const android = await configureAndroid(env, expo);

    expect(android.packageName).toBeUndefined();
  });

  it('"Enter another…" beside a suggested package types one, and an empty one skips', async () => {
    const expo: ExpoProject = { androidPackage: 'com.acme.expo', hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: false };
    script([
      [/Where is your Android APK/, ''],
      [/package name\? \S*\(Enter to skip/, ' com.acme.typed '],
      [/package name/, 'Enter another…'],
    ]);

    expect((await configureAndroid(env, expo)).packageName).toBe('com.acme.typed');
  });

  it('a skipped APK with a package name is a package-only setup, said as --yes says it (PILOT-721)', async () => {
    script([
      [/Where is your Android APK/, ''],
      [/package name/, 'com.acme.installed'],
    ]);

    const android = await configureAndroid(env);

    expect(android.apkPath).toBeUndefined();
    expect(android.packageName).toBe('com.acme.installed');
    expect(logged.join('\n')).toContain('cannot install it');
  });

  it('offers "Skip for now" beside the APKs it found', async () => {
    apkCandidates = [DEBUG_APK];
    script([
      [/Where is your Android APK/, (q: Question) => q.choices?.find((c) => /Skip/.test(c.name))?.name],
      [/package name/, ''],
    ]);

    const android = await configureAndroid(env);

    expect(question(/Where is your Android APK/)?.choices?.at(-1)?.name).toMatch(/^Skip for now/);
    expect(android.apkPath).toBeUndefined();
  });

  it('an empty typed path after "Enter another path…" skips too', async () => {
    apkCandidates = [DEBUG_APK];
    script([
      [/Where is your Android APK/, 'Enter another path…'],
      [/Path to your Android APK/, ''],
      [/package name/, ''],
    ]);

    const android = await configureAndroid(env);

    expect(question(/Path to your Android APK/)?.validate?.('')).toBe(true);
    expect(android.apkPath).toBeUndefined();
  });

  it('an APK whose package cannot be read may leave the package for later', async () => {
    apkCandidates = [DEBUG_APK];
    script([
      [/Where is your Android APK/, DEBUG_APK],
      [/package name/, ''],
    ]);

    const android = await configureAndroid(env);

    expect(android.apkPath).toBe(DEBUG_APK);
    expect(android.packageName).toBeUndefined();
  });

  it('prefills the package from app/build.gradle\'s applicationId (PILOT-778)', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-native-'));
    fs.writeFileSync(path.join(project, 'settings.gradle.kts'), '');
    fs.mkdirSync(path.join(project, 'app'));
    fs.writeFileSync(path.join(project, 'app', 'build.gradle.kts'), 'android {\n  defaultConfig {\n    applicationId = "com.acme.gradle"\n  }\n}\n');
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    script([
      [/Where is your Android APK/, ''],
      [/package name/, (q: Question) => q.choices?.[0].name],
    ]);
    let android;
    try {
      android = await configureAndroid(env);
    } finally {
      vi.mocked(process.cwd).mockRestore();
      fs.rmSync(project, { recursive: true, force: true });
    }
    expect(question(/package name/)?.choices?.[0]).toMatchObject({ name: 'com.acme.gradle', hint: "the app module's applicationId" });
    expect(android.packageName).toBe('com.acme.gradle');
  });
});
