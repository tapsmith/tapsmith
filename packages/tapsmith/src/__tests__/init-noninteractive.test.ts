import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initArgsFromOptions, resolveInitPlan, executeInitPlan, assertConfigWritable, assertProjectWritable, InitError, type DetectFns } from '../init-noninteractive.js';
import type { ExpoProject } from '../init-detect.js';
import { needsSimulatorAgent } from '../init.js';
import { simulatorChoices, type EnvScan } from '../env-scan.js';
import type { InitCommandOptions } from '../cli-program.js';

/** `tapsmith init` flags as the CLI hands them over: every boolean present, value flags only when given. */
function initArgs(over: Partial<InitCommandOptions>) {
  return initArgsFromOptions({
    yes: false, json: false, force: false, networkCapture: false, exampleTest: true, agentsMd: true, ...over,
  });
}

const baseEnv: EnvScan = {
  nodeVersion: '22.0.0',
  rosettaWarning: undefined,
  daemonBin: '/bin/tapsmith-core',
  agentApk: true,
  agentTestApk: true,
  adbVersion: '35.0.1',
  androidHome: '/sdk',
  xcodeVersion: '16.0',
  simulators: [
    { name: 'iPhone 16', udid: 'A', state: 'Shutdown', runtime: 'iOS 18.0' },
    { name: 'iPhone 16', udid: 'B', state: 'Shutdown', runtime: 'iOS 18.2' },
  ],
  avds: ['Pixel_7', 'Pixel_8'],
  avdImages: [
    { name: 'Pixel_7', tagId: 'google_apis', apiLevel: 36 },
    { name: 'Pixel_8', tagId: 'google_apis', apiLevel: 36 },
  ],
  isMacOS: true,
};

const detectStubs = {
  findApkCandidates: () => ['android/app/build/outputs/apk/debug/app-debug.apk'],
  detectAndroidPackage: () => 'com.example.app',
  findIosAppCandidates: () => ['ios/build/Build/Products/Debug-iphonesimulator/MyApp.app'],
  detectIosBundleId: () => 'com.example.myapp',
};

/** vitest's toThrow() doesn't support objectContaining — capture and assert. */
function expectInitError(fn: () => unknown, code: string): InitError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InitError);
  expect((caught as InitError).code).toBe(code);
  return caught as InitError;
}

describe('initArgsFromOptions()', () => {
  it('maps every flag', () => {
    expect(initArgs({
      yes: true, json: true, force: true, platform: 'android,ios', apk: './a.apk', package: 'com.x', app: './X.app',
      bundleId: 'com.x.ios', avd: 'Pixel_7', simulator: 'iPhone 16', deviceType: 'both', networkCapture: true,
      exampleTest: false, agentsMd: false,
    })).toMatchObject({
      yes: true, json: true, force: true, platforms: ['android', 'ios'],
      apk: './a.apk', packageName: 'com.x', app: './X.app', bundleId: 'com.x.ios',
      avd: 'Pixel_7', simulator: 'iPhone 16', deviceType: 'both',
      networkCapture: true, exampleTest: false, agentsMd: false, anySetupFlag: true,
    });
  });

  it('throws InitError on invalid platform or device-type', () => {
    expectInitError(() => initArgs({ platform: 'windows' }), 'INVALID_PLATFORM');
    expectInitError(() => initArgs({ platform: '' }), 'INVALID_PLATFORM');
    expectInitError(() => initArgs({ deviceType: 'cloud' }), 'INVALID_DEVICE_TYPE');
  });

  it('detects whether any setup flag was given', () => {
    expect(initArgs({}).anySetupFlag).toBe(false);
    expect(initArgs({ json: true, yes: true }).anySetupFlag).toBe(false);
    expect(initArgs({ apk: './a.apk' }).anySetupFlag).toBe(true);
    expect(initArgs({ force: true }).anySetupFlag).toBe(true);
    expect(initArgs({ exampleTest: false }).anySetupFlag).toBe(true);
    expect(initArgs({ networkCapture: true }).anySetupFlag).toBe(true);
  });
});

describe('resolveInitPlan()', () => {
  it('auto-detects an Android setup with --yes', () => {
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detectStubs);
    expect(plan.android).toMatchObject({
      apkPath: 'android/app/build/outputs/apk/debug/app-debug.apk',
      packageName: 'com.example.app',
      avd: 'Pixel_7',
      useEmulators: true,
      usePhysicalDevices: false,
    });
    expect(plan.ios).toBeUndefined();
  });

  it('resolves APK paths against cwd before package detection', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    let probedApk: string | undefined;
    const detect = {
      ...detectStubs,
      findApkCandidates: () => ['android/app-debug.apk'],
      detectAndroidPackage: (apkPath: string) => {
        probedApk = apkPath;
        return 'com.example.app';
      },
    };
    try {
      resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detect, tmp);
      expect(probedApk).toBe(path.resolve(tmp, 'android/app-debug.apk'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('picks the newest-runtime simulator for iOS', () => {
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'ios' }), baseEnv, detectStubs);
    expect(plan.ios).toMatchObject({
      appPath: 'ios/build/Build/Products/Debug-iphonesimulator/MyApp.app',
      bundleId: 'com.example.myapp',
      simulator: 'iPhone 16',
      usePhysicalDevice: false,
    });
  });

  it('resolves iOS app paths against cwd before bundle id detection', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    let probedApp: string | undefined;
    const detect = {
      ...detectStubs,
      findIosAppCandidates: () => ['ios/MyApp.app'],
      detectIosBundleId: (appPath: string) => {
        probedApp = appPath;
        return 'com.example.myapp';
      },
    };
    try {
      resolveInitPlan(initArgs({ yes: true, platform: 'ios' }), baseEnv, detect, tmp);
      expect(probedApp).toBe(path.resolve(tmp, 'ios/MyApp.app'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('explicit flags beat detection', () => {
    const plan = resolveInitPlan(
      initArgs({ yes: true, platform: 'android', apk: './custom.apk', package: 'com.custom', avd: 'Pixel_8' }),
      baseEnv,
      detectStubs,
    );
    expect(plan.android).toMatchObject({ apkPath: './custom.apk', packageName: 'com.custom', avd: 'Pixel_8' });
  });

  it('errors with candidates when multiple APKs and no --apk', () => {
    const detect = {
      ...detectStubs,
      findApkCandidates: () => ['android/a/app-debug.apk', 'android/b/app-debug.apk'],
    };
    const err = expectInitError(
      () => resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detect),
      'AMBIGUOUS_APK',
    );
    expect(err.candidates).toHaveLength(2);
    expect(err.fix).toContain('--apk');
  });

  it('errors NO_APK when nothing found', () => {
    const detect = { ...detectStubs, findApkCandidates: () => [] };
    expectInitError(
      () => resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detect),
      'NO_APK',
    );
  });

  it('infers platform from project layout when --platform omitted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    fs.mkdirSync(path.join(tmp, 'android'));
    try {
      const plan = resolveInitPlan(initArgs({ yes: true }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  describe('infers the platform from --apk and --app (PILOT-626)', () => {
    /** An empty project (no android/ or ios/), as an Expo managed app is before prebuild. */
    function withEmptyProject(fn: (dir: string) => void): void {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
      try {
        fn(tmp);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    it('--apk alone configures Android', () => withEmptyProject((tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true, apk: 'build/app.apk' }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android']);
      expect(plan.android?.apkPath).toBe('build/app.apk');
      expect(plan.ios).toBeUndefined();
    }));

    it('--app alone configures iOS', () => withEmptyProject((tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true, app: 'build/App.app' }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['ios']);
      expect(plan.ios?.appPath).toBe('build/App.app');
      expect(plan.android).toBeUndefined();
    }));

    it('--apk and --app configure both', () => withEmptyProject((tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true, apk: 'build/app.apk', app: 'build/App.app' }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android', 'ios']);
    }));

    it('still adds a platform its directory implies, so --apk does not drop iOS', () => withEmptyProject((tmp) => {
      fs.mkdirSync(path.join(tmp, 'ios'));
      const plan = resolveInitPlan(initArgs({ yes: true, apk: 'build/app.apk' }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android', 'ios']);
    }));

    it('--app off macOS is refused as iOS, not NO_PLATFORM', () => withEmptyProject((tmp) => {
      expectInitError(
        () => resolveInitPlan(initArgs({ yes: true, app: 'build/App.app' }), { ...baseEnv, isMacOS: false }, detectStubs, tmp),
        'IOS_REQUIRES_MACOS',
      );
    }));

    it('an explicit --platform still wins over --app', () => withEmptyProject((tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android', app: 'build/App.app' }), baseEnv, detectStubs, tmp);
      expect(plan.platforms).toEqual(['android']);
    }));
  });

  describe('says when it leaves iOS out of a React Native project on macOS (PILOT-625)', () => {
    const managedExpo: ExpoProject = { hasAndroidDir: true, hasIosDir: false, usesTapsmithHooks: false };
    /** A project with android/ (unless `androidDir` is false) and the given package.json dependencies. */
    function withProject(deps: Record<string, string> | 'unreadable', fn: (dir: string) => void, androidDir = true): void {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
      try {
        if (androidDir) fs.mkdirSync(path.join(tmp, 'android'));
        fs.writeFileSync(path.join(tmp, 'package.json'), deps === 'unreadable' ? '{not json' : JSON.stringify({ dependencies: deps }));
        fn(tmp);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const iosNote = (warnings: string[]) => warnings.find((w) => w.startsWith('iOS left out'));

    it('notes the missing ios/ and how to add iOS in a bare React Native project', () => withProject({ 'react-native': '0.79.0' }, (tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true }), baseEnv, { ...detectStubs, detectExpoProject: () => undefined }, tmp);
      expect(plan.platforms).toEqual(['android']);
      const note = iosNote(plan.warnings);
      expect(note).toContain('no ios/ directory');
      expect(note).toContain('re-run `npx tapsmith init --force` with any other flags you passed');
      expect(note).toContain('--app <path>');
      expect(note).not.toContain('expo');
    }));

    it('gives the Expo iOS build in an Expo project', () => withProject({ expo: '54.0.0', 'react-native': '0.81.0' }, (tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true }), baseEnv, { ...detectStubs, detectExpoProject: () => managedExpo }, tmp);
      const note = iosNote(plan.warnings);
      expect(note).toContain('npx expo prebuild --platform ios');
      expect(note).toContain('npx tapsmith init --force');
    }));

    it('never reads the app config (which runs the Expo CLI) just for the note', () => withProject({ expo: '54.0.0' }, (tmp) => {
      const readers: Array<((cwd: string) => unknown) | undefined> = [];
      const plan = resolveInitPlan(initArgs({ yes: true }), baseEnv, {
        ...detectStubs,
        detectExpoProject: (_cwd, readConfig) => { readers.push(readConfig); return managedExpo; },
      }, tmp);
      expect(iosNote(plan.warnings)).toContain('npx expo prebuild --platform ios');
      expect(readers).toHaveLength(1);
      expect(readers[0]).toBeDefined();
      expect(readers[0]?.(tmp)).toBeUndefined();
    }));

    it('notes it when --apk alone configured Android in a managed Expo project', () => withProject({ expo: '54.0.0' }, (tmp) => {
      const plan = resolveInitPlan(
        initArgs({ yes: true, apk: 'build/app.apk' }), baseEnv,
        { ...detectStubs, detectExpoProject: () => ({ ...managedExpo, hasAndroidDir: false }) }, tmp,
      );
      expect(plan.platforms).toEqual(['android']);
      const note = iosNote(plan.warnings);
      expect(note).toContain('npx expo prebuild --platform ios');
      // The re-run it gives keeps Android once ios/ exists: without --apk it would come back iOS-only.
      expect(note).toContain('`npx tapsmith init --force --apk build/app.apk`');
      fs.mkdirSync(path.join(tmp, 'ios'));
      const rerun = resolveInitPlan(initArgs({ yes: true, force: true, apk: 'build/app.apk' }), baseEnv, detectStubs, tmp);
      expect(rerun.platforms).toEqual(['android', 'ios']);
    }, false));

    it('quotes an --apk path the shell would split', () => withProject({ 'react-native': '0.79.0' }, (tmp) => {
      const plan = resolveInitPlan(initArgs({ yes: true, apk: "my builds/it's.apk" }), baseEnv, { ...detectStubs, detectExpoProject: () => undefined }, tmp);
      expect(iosNote(plan.warnings)).toContain("`npx tapsmith init --force --apk 'my builds/it'\\''s.apk'`");
    }, false));

    it('carries the note into the --json result', () => withProject({ 'react-native': '0.79.0' }, (tmp) => {
      const args = initArgs({ yes: true, json: true, exampleTest: false, agentsMd: false });
      const plan = resolveInitPlan(args, baseEnv, { ...detectStubs, detectExpoProject: () => undefined }, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(iosNote(result.warnings)).toContain('no ios/ directory');
    }));

    it('says nothing in a native Android project, off macOS, with an explicit --platform, or with an unreadable package.json', () => {
      const noExpo = { ...detectStubs, detectExpoProject: () => undefined };
      withProject({ lodash: '4.0.0' }, (tmp) => {
        expect(iosNote(resolveInitPlan(initArgs({ yes: true }), baseEnv, noExpo, tmp).warnings)).toBeUndefined();
      });
      withProject({ 'react-native': '0.79.0' }, (tmp) => {
        expect(iosNote(resolveInitPlan(initArgs({ yes: true }), { ...baseEnv, isMacOS: false }, noExpo, tmp).warnings)).toBeUndefined();
        expect(iosNote(resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, noExpo, tmp).warnings)).toBeUndefined();
      });
      withProject('unreadable', (tmp) => {
        expect(iosNote(resolveInitPlan(initArgs({ yes: true }), baseEnv, noExpo, tmp).warnings)).toBeUndefined();
      });
    });
  });

  it('errors NO_PLATFORM when nothing inferable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    try {
      expectInitError(() => resolveInitPlan(initArgs({ yes: true }), baseEnv, detectStubs, tmp), 'NO_PLATFORM');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects iOS physical-only as interactive-only', () => {
    expectInitError(() => resolveInitPlan(
      initArgs({ yes: true, platform: 'ios', deviceType: 'physical' }),
      baseEnv,
      detectStubs,
    ), 'IOS_PHYSICAL_INTERACTIVE_ONLY');
  });

  it('rejects iOS setup on non-macOS hosts before probing iOS artifacts', () => {
    const detect = {
      ...detectStubs,
      findIosAppCandidates: () => {
        throw new Error('should not probe iOS artifacts');
      },
    };
    const err = expectInitError(() => resolveInitPlan(
      initArgs({ yes: true, platform: 'ios' }),
      { ...baseEnv, isMacOS: false },
      detect,
    ), 'IOS_REQUIRES_MACOS');
    expect(err.fix).toContain('macOS');
  });

  it('downgrades iOS both to simulators with a warning', () => {
    const plan = resolveInitPlan(
      initArgs({ yes: true, platform: 'ios', deviceType: 'both' }),
      baseEnv,
      detectStubs,
    );
    expect(plan.ios?.usePhysicalDevice).toBe(false);
    expect(plan.warnings.some((w) => w.includes('physical'))).toBe(true);
  });

  it('builds the simulator agent for the simulator plan iOS both resolves to (PILOT-465)', () => {
    const plan = resolveInitPlan(
      initArgs({ yes: true, platform: 'ios', deviceType: 'both' }),
      baseEnv,
      detectStubs,
    );
    expect(needsSimulatorAgent(plan.ios)).toBe(true);
  });

  it('does not build the simulator agent for an Android-only plan (PILOT-465)', () => {
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detectStubs);
    expect(needsSimulatorAgent(plan.ios)).toBe(false);
  });

  it('warns when Node runs under Rosetta (PILOT-559)', () => {
    const rosettaWarning = 'Node.js is running under Rosetta (x64) on this Apple Silicon Mac. Install an arm64 Node';
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android' }), { ...baseEnv, rosettaWarning }, detectStubs);
    expect(plan.warnings).toEqual([rosettaWarning]);
    expect(resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, detectStubs).warnings).toEqual([]);
  });

  it('omits avd with a warning when none available', () => {
    const plan = resolveInitPlan(
      initArgs({ yes: true, platform: 'android' }),
      { ...baseEnv, avds: [], avdImages: [] },
      detectStubs,
    );
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('No Android AVDs found');
  });
});

// ─── Expo projects (PILOT-557) ───

describe('resolveInitPlan() on an Expo project (PILOT-557)', () => {
  const managed: ExpoProject = {
    androidPackage: 'com.example.expo',
    iosBundleId: 'com.example.expo.ios',
    hasAndroidDir: false,
    hasIosDir: false,
    usesTapsmithHooks: false,
  };
  const withExpo = (expo: ExpoProject | undefined, over: Partial<DetectFns> = {}): DetectFns => ({
    ...detectStubs,
    detectExpoProject: () => expo,
    ...over,
  });

  it('NO_PLATFORM on a managed project says to build it first, with Expo commands, not gradlew', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    try {
      const err = expectInitError(() => resolveInitPlan(initArgs({ yes: true }), baseEnv, withExpo(managed), tmp), 'NO_PLATFORM');
      expect(err.message).toContain('Expo project');
      expect(err.fix).toContain('npx expo prebuild --platform android');
      expect(err.fix).toContain('./gradlew assembleRelease');
      expect(err.fix).toContain('npx expo prebuild --platform ios');
      expect(err.fix).toContain('EXPO_PUBLIC_TAPSMITH_HOOKS=1');
      expect(err.fix).toContain('--platform');
      expect(err.fix).not.toContain('assembleDebug');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('NO_PLATFORM off macOS gives only the Android build', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    try {
      const err = expectInitError(
        () => resolveInitPlan(initArgs({ yes: true }), { ...baseEnv, isMacOS: false }, withExpo(managed), tmp),
        'NO_PLATFORM',
      );
      expect(err.fix).toContain('npx expo prebuild --platform android');
      expect(err.fix).not.toContain('xcodebuild');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('NO_APK on an Expo project gives the Expo build, and --apk', () => {
    const err = expectInitError(
      () => resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, withExpo(managed, { findApkCandidates: () => [] })),
      'NO_APK',
    );
    expect(err.fix).toContain('./gradlew assembleRelease');
    expect(err.fix).toContain('--apk');
    expect(err.fix).not.toContain('assembleDebug');
  });

  it('NO_IOS_APP on an Expo project gives the Expo build, and --app', () => {
    const err = expectInitError(
      () => resolveInitPlan(initArgs({ yes: true, platform: 'ios' }), baseEnv, withExpo(managed, { findIosAppCandidates: () => [] })),
      'NO_IOS_APP',
    );
    expect(err.fix).toContain('npx expo prebuild --platform ios');
    expect(err.fix).toContain('--app');
  });

  it('keeps the native-project fixes when the project is not Expo', () => {
    const err = expectInitError(
      () => resolveInitPlan(initArgs({ yes: true, platform: 'android' }), baseEnv, withExpo(undefined, { findApkCandidates: () => [] })),
      'NO_APK',
    );
    expect(err.fix).toContain('./gradlew assembleDebug');
  });

  /** A project holding the stub builds, so they exist on disk. */
  function withBuilds(): string {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-'));
    const apk = path.join(tmp, detectStubs.findApkCandidates()[0]);
    fs.mkdirSync(path.dirname(apk), { recursive: true });
    fs.writeFileSync(apk, '');
    fs.mkdirSync(path.join(tmp, detectStubs.findIosAppCandidates()[0]), { recursive: true });
    return tmp;
  }
  const unreadable = { detectAndroidPackage: () => undefined, detectIosBundleId: () => undefined };

  it('falls back to the app config\'s ids when the builds cannot be read, and says so', () => {
    const tmp = withBuilds();
    try {
      const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android,ios' }), baseEnv, withExpo(managed, unreadable), tmp);
      expect(plan.android?.packageName).toBe('com.example.expo');
      expect(plan.ios?.bundleId).toBe('com.example.expo.ios');
      expect(plan.warnings.find((w) => w.includes('com.example.expo from the Expo app config'))).toContain('--package');
      expect(plan.warnings.find((w) => w.includes('com.example.expo.ios from the Expo app config'))).toContain('--bundle-id');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('never lets the app config\'s id cover for an --apk or --app that does not exist', () => {
    const tmp = withBuilds();
    try {
      expectInitError(() => resolveInitPlan(
        initArgs({ yes: true, platform: 'android', apk: 'android/app-relase.apk' }), baseEnv, withExpo(managed, unreadable), tmp,
      ), 'NO_PACKAGE');
      expectInitError(() => resolveInitPlan(
        initArgs({ yes: true, platform: 'ios', app: 'ios/Missing.app' }), baseEnv, withExpo(managed, unreadable), tmp,
      ), 'NO_BUNDLE_ID');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('prefers the id read from the build over the app config\'s', () => {
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'android,ios' }), baseEnv, withExpo(managed));
    expect(plan.android?.packageName).toBe('com.example.app');
    expect(plan.ios?.bundleId).toBe('com.example.myapp');
  });

  it('does not detect Expo when the build already answers everything', () => {
    let detected = 0;
    resolveInitPlan(initArgs({ yes: true, platform: 'android,ios' }), baseEnv, {
      ...detectStubs,
      detectExpoProject: () => { detected++; return managed; },
    });
    expect(detected).toBe(0);
  });

  it('still errors NO_PACKAGE when neither the APK nor the app config has one', () => {
    const tmp = withBuilds();
    try {
      expectInitError(() => resolveInitPlan(
        initArgs({ yes: true, platform: 'android' }),
        baseEnv,
        withExpo({ ...managed, androidPackage: undefined }, { detectAndroidPackage: () => undefined }),
        tmp,
      ), 'NO_PACKAGE');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── AVD choice and HTTPS capture (PILOT-403) ───

describe('resolveInitPlan() AVD choice with network capture', () => {
  // Android Studio's default AVD (a Google Play image, listed first) beside a create-avd one.
  const studioEnv: EnvScan = {
    ...baseEnv,
    avds: ['Medium_Phone_API_36', 'Tapsmith_Phone_API_36'],
    avdImages: [
      { name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 },
      { name: 'Tapsmith_Phone_API_36', tagId: 'google_apis', apiLevel: 36 },
    ],
  };
  const playOnlyEnv: EnvScan = {
    ...baseEnv,
    avds: ['Medium_Phone_API_36'],
    avdImages: [{ name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 }],
  };
  const android = (over: Partial<InitCommandOptions> = {}) => initArgs({ yes: true, platform: 'android', ...over });

  it('prefers a capture-capable AVD over an earlier Play image when capture is on', () => {
    const plan = resolveInitPlan(android({ networkCapture: true }), studioEnv, detectStubs);
    expect(plan.android?.avd).toBe('Tapsmith_Phone_API_36');
    expect(plan.warnings).toEqual([]);
  });

  it('keeps "first available" when capture is off', () => {
    const plan = resolveInitPlan(android(), studioEnv, detectStubs);
    expect(plan.android?.avd).toBe('Medium_Phone_API_36');
    expect(plan.warnings).toEqual([]);
  });

  it('warns, suggesting a NEW AVD, when only Play images exist', () => {
    const plan = resolveInitPlan(android({ networkCapture: true }), playOnlyEnv, detectStubs);
    expect(plan.android?.avd).toBe('Medium_Phone_API_36');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('Medium_Phone_API_36 uses a Google Play system image');
    expect(plan.warnings[0]).toContain("run: npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36'");
    expect(plan.warnings[0]).not.toContain('--force');
  });

  it('honours an explicit Play-image --avd but warns, pointing at the capable one', () => {
    const plan = resolveInitPlan(android({ networkCapture: true, avd: 'Medium_Phone_API_36' }), studioEnv, detectStubs);
    expect(plan.android?.avd).toBe('Medium_Phone_API_36');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("set avd: 'Tapsmith_Phone_API_36'");
  });

  it('does not vouch for an AVD whose image could not be read', () => {
    const env: EnvScan = { ...baseEnv, avds: ['Mystery'], avdImages: [{ name: 'Mystery' }] };
    const plan = resolveInitPlan(android({ networkCapture: true }), env, detectStubs);
    expect(plan.android?.avd).toBe('Mystery');
    expect(plan.warnings[0]).toContain('Could not read the system image of AVD Mystery');
  });

  it('suggests create-avd, not Android Studio, when there are no AVDs', () => {
    const plan = resolveInitPlan(android({ networkCapture: true }), { ...baseEnv, avds: [], avdImages: [] }, detectStubs);
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('No Android AVDs found');
    expect(plan.warnings[0]).toContain('npx tapsmith create-avd');
    expect(plan.warnings[0]).not.toContain('Android Studio');
  });

  it('says the emulator was not found, writing no avd, when only the AVD home lists AVDs', () => {
    // AVDs exist but the emulator binary was not found, so Tapsmith can't launch them.
    const plan = resolveInitPlan(android({ networkCapture: true }), { ...studioEnv, avds: [] }, detectStubs);
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('the Android emulator is not installed where Tapsmith looks');
  });

  it('warns about the emulator for an explicit --avd too, when emulator lists nothing', () => {
    const plan = resolveInitPlan(android({ avd: 'Tapsmith_Phone_API_36' }), { ...studioEnv, avds: [] }, detectStubs);
    expect(plan.android?.avd).toBe('Tapsmith_Phone_API_36');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('the Android emulator is not installed where Tapsmith looks');
    // The config already names the AVD, so re-running init is not the fix.
    expect(plan.warnings[0]).toContain('so Tapsmith can launch Tapsmith_Phone_API_36');
    expect(plan.warnings[0]).not.toContain('re-run');
  });

  it('adds no AVD warning for physical-device-only Android', () => {
    const plan = resolveInitPlan(android({ networkCapture: true, deviceType: 'physical' }), playOnlyEnv, detectStubs);
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings).toEqual([]);
  });

  it('points a Play-image AVD at create-avd in the next steps: before verify with capture, last and optional without (PILOT-711)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-exec-'));
    try {
      const step = "npx tapsmith create-avd, then change avd: 'Medium_Phone_API_36' to 'Tapsmith_Phone_API_36' in tapsmith.config.ts";
      const on = android({ networkCapture: true, exampleTest: false, agentsMd: false, force: true });
      const withCapture = executeInitPlan(resolveInitPlan(on, playOnlyEnv, detectStubs, tmp), on, tmp).nextSteps;
      // Part of the setup, before verify.
      expect(withCapture[0]).toBe(`Capture HTTPS: ${step}`);
      const off = android({ networkCapture: false, exampleTest: false, agentsMd: false, force: true });
      const without = executeInitPlan(resolveInitPlan(off, playOnlyEnv, detectStubs, tmp), off, tmp).nextSteps;
      // Not requested: an option, listed last, after verify.
      expect(without[0]).toContain('tapsmith verify');
      expect(without[without.length - 1]).toBe(`Optional, to capture HTTPS: ${step}, and add trace: { mode: 'retain-on-failure' }`);
      const args = android({ networkCapture: true, exampleTest: false, agentsMd: false, force: true });
      const capable = executeInitPlan(resolveInitPlan(args, studioEnv, detectStubs, tmp), args, tmp);
      expect(capable.nextSteps.some((s) => s.startsWith('Capture HTTPS'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('puts the warning in the --json result', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-exec-'));
    try {
      const args = android({ networkCapture: true, exampleTest: false, agentsMd: false });
      const plan = resolveInitPlan(args, playOnlyEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(result.warnings.some((w) => w.includes('Google Play system image'))).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('executeInitPlan()', () => {
  function makeTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-exec-'));
  }

  it('writes config, example test, and AGENTS.md', () => {
    const tmp = makeTmp();
    try {
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain("package: 'com.example.app',");
      expect(fs.existsSync(path.join(tmp, 'tests', 'example.tapsmith.ts'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'tests', 'example.test.ts'))).toBe(false);
      expect(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8')).toContain('tapsmith:begin');
      expect(result.filesCreated).toEqual(expect.arrayContaining(['tapsmith.config.ts', 'tests/example.tapsmith.ts', 'AGENTS.md']));
      expect(result.configPath).toBe(path.join(tmp, 'tapsmith.config.ts'));
      expect(result.nextSteps.some((s) => s.includes('tapsmith verify'))).toBe(true);
      // The init --yes --json result, a public contract (docs/api-reference.md, CLI → JSON output).
      expect(Object.keys(result)).toEqual(['configPath', 'filesCreated', 'warnings', 'nextSteps']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // `init --yes` in a project without tapsmith (PILOT-551): never installs
  // (that changes package.json and the lockfile unasked), but the install
  // comes first in Next steps and a warning says why.
  it('puts the tapsmith install first in Next steps when the project lacks it', () => {
    const tmp = makeTmp();
    try {
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const install = { command: 'pnpm', args: ['add', '-D', 'tapsmith'], display: 'pnpm add -D tapsmith' };
      const result = executeInitPlan(plan, args, tmp, install);
      expect(result.nextSteps[0]).toBe('Install Tapsmith in this project: pnpm add -D tapsmith');
      expect(result.nextSteps[1]).toContain('tapsmith verify');
      expect(result.warnings).toContain("Tapsmith isn't installed in this project, and the files init wrote import it: run pnpm add -D tapsmith before anything else");
      expect(Object.keys(result)).toEqual(['configPath', 'filesCreated', 'warnings', 'nextSteps']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // PILOT-631: no package.json in the project directory.
  it('says why the install step creates a package.json first', () => {
    const tmp = makeTmp();
    try {
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const note = `There's no package.json in ${tmp}: on its own, \`npm i -D tapsmith\` would add Tapsmith to /home/u instead. If that is this project's root, run it there; otherwise create a package.json here first.`;
      const install = { command: 'npm', args: ['i', '-D', 'tapsmith'], display: 'npm init -y && npm i -D tapsmith', note };
      const result = executeInitPlan(plan, args, tmp, install);
      expect(result.nextSteps[0]).toBe('Install Tapsmith in this project: npm init -y && npm i -D tapsmith');
      expect(result.warnings).toContain(`Tapsmith isn't installed in this project, and the files init wrote import it: run npm init -y && npm i -D tapsmith before anything else. ${note}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('adds no install step when the project has tapsmith', () => {
    const tmp = makeTmp();
    try {
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp, undefined);
      expect(result.nextSteps[0]).toContain('tapsmith verify');
      expect(result.warnings.join('\n')).not.toContain('install');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Next steps print for a person without --json, and --json is for agents (PILOT-562).
  it('shows a person `tapsmith verify` and an agent `tapsmith verify --json`', () => {
    const tmp = makeTmp();
    try {
      const human = initArgs({ yes: true, platform: 'android' });
      const humanSteps = executeInitPlan(resolveInitPlan(human, baseEnv, detectStubs, tmp), human, tmp).nextSteps;
      expect(humanSteps[0]).toBe('Verify the setup end-to-end: npx tapsmith verify');
      expect(humanSteps.join('\n')).not.toContain('--json');

      const agent = initArgs({ yes: true, json: true, platform: 'android', force: true });
      const agentSteps = executeInitPlan(resolveInitPlan(agent, baseEnv, detectStubs, tmp), agent, tmp).nextSteps;
      expect(agentSteps[0]).toBe('Verify the setup end-to-end: npx tapsmith verify --json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('adds the test output folders to .gitignore and lists it, warning instead of failing when it cannot (PILOT-562)', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules/\n');
      const args = initArgs({ yes: true, platform: 'android' });
      const result = executeInitPlan(resolveInitPlan(args, baseEnv, detectStubs, tmp), args, tmp);
      expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toContain('\ntapsmith-results/\n');
      expect(result.filesCreated).toContain('.gitignore');

      // Already there: not listed again.
      const again = executeInitPlan(resolveInitPlan({ ...args, force: true }, baseEnv, detectStubs, tmp), { ...args, force: true }, tmp);
      expect(again.filesCreated).not.toContain('.gitignore');

      // Unwritable: init still succeeds, with a warning.
      fs.rmSync(path.join(tmp, '.gitignore'));
      fs.mkdirSync(path.join(tmp, '.gitignore'));
      const blocked = executeInitPlan(resolveInitPlan({ ...args, force: true }, baseEnv, detectStubs, tmp), { ...args, force: true }, tmp);
      expect(blocked.filesCreated).not.toContain('.gitignore');
      expect(blocked.warnings.join('\n')).toMatch(/Could not add tapsmith-results\/ and tapsmith-report\/ to \.gitignore/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('respects --no-example-test and --no-agents-md', () => {
    const tmp = makeTmp();
    try {
      const args = initArgs({ yes: true, platform: 'android', exampleTest: false, agentsMd: false });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      executeInitPlan(plan, args, tmp);
      expect(fs.existsSync(path.join(tmp, 'tests'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'AGENTS.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite existing config without --force', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing');
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      expectInitError(() => executeInitPlan(plan, args, tmp), 'CONFIG_EXISTS');
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toBe('// existing');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('overwrites with --force', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing');
      const args = initArgs({ yes: true, force: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain('defineConfig');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes alternate config extensions when force is enabled', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.mjs'), '// existing mjs');
      const args = initArgs({ yes: true, force: true, platform: 'android' });
      executeInitPlan(resolveInitPlan(args, baseEnv, detectStubs, tmp), args, tmp);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.mjs'))).toBe(false);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain('defineConfig');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The early --force guard runs before the iOS agent build and every write:
  // it must not delete the config a failed init would then leave missing (PILOT-623).
  it('assertConfigWritable() only checks: --force leaves the existing configs in place', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing ts');
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.mjs'), '// existing mjs');
      assertConfigWritable(true, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toBe('// existing ts');
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.mjs'))).toBe(true);
      expectInitError(() => assertConfigWritable(false, tmp), 'CONFIG_EXISTS');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('replaces a symlinked config without clobbering the link target on force', () => {
    const tmp = makeTmp();
    try {
      const target = path.join(tmp, 'real-config.ts');
      fs.writeFileSync(target, '// link target');
      fs.symlinkSync(target, path.join(tmp, 'tapsmith.config.ts'));
      const args = initArgs({ yes: true, force: true, platform: 'android' });
      executeInitPlan(resolveInitPlan(args, baseEnv, detectStubs, tmp), args, tmp);
      // The symlink is replaced by a regular file; its target is left untouched.
      expect(fs.lstatSync(path.join(tmp, 'tapsmith.config.ts')).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toContain('defineConfig');
      expect(fs.readFileSync(target, 'utf8')).toBe('// link target');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips existing example test without error', () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'tests', 'example.tapsmith.ts'), '// mine');
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tests', 'example.tapsmith.ts'), 'utf8')).toBe('// mine');
      expect(result.filesCreated).not.toContain('tests/example.tapsmith.ts');
      expect(result.warnings).toContain('tests/example.tapsmith.ts already exists — left untouched');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // PILOT-554: the generated config runs only *.tapsmith.ts files, so a re-init
  // over Tapsmith tests named *.test.ts (an older scaffold) must say they stop running.
  it("warns about existing Tapsmith tests the new config's testMatch would no longer run", () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'tests', 'auth'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'tests', 'example.test.ts'), "import { test, expect } from 'tapsmith'\n");
      fs.writeFileSync(path.join(tmp, 'tests', 'auth', 'login.spec.ts'), 'import { test } from "tapsmith";\n');
      fs.writeFileSync(path.join(tmp, 'tests', 'kept.tapsmith.ts'), "import { test } from 'tapsmith'\n");
      // Jest unit tests, and anything under node_modules, are not Tapsmith's.
      fs.writeFileSync(path.join(tmp, 'src', 'utils.test.ts'), "import { sum } from './utils'\n");
      fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'x.test.ts'), "import { test } from 'tapsmith'\n");
      const args = initArgs({ yes: true, platform: 'android', force: true });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      const warning = result.warnings.find((w) => w.includes('.tapsmith.ts'));
      expect(warning).toBeDefined();
      expect(warning).toContain('tests/auth/login.spec.ts');
      expect(warning).toContain('tests/example.test.ts');
      expect(warning).not.toContain('utils.test.ts');
      expect(warning).not.toContain('node_modules');
      expect(warning).not.toContain('kept.tapsmith.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The AGENTS.md section recommends importing through a fixtures module, so
  // a spec that imports `tapsmith` one module away is a Tapsmith test too.
  it('counts specs that import tapsmith through a local fixtures module, or for side effects', () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'e2e', 'support'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'e2e', 'fixtures'));
      fs.writeFileSync(path.join(tmp, 'e2e', 'fixtures.ts'), "export { test, expect } from 'tapsmith'\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'fixtures', 'index.ts'), "import { test as base } from 'tapsmith'\nexport const test = base\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'support', 'helpers.ts'), 'export const x = 1\n');
      fs.writeFileSync(path.join(tmp, 'e2e', 'login.test.ts'), "import { test, expect } from './fixtures.js'\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'cart.test.ts'), "import { test } from './fixtures/index'\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'setup.spec.ts'), "import 'tapsmith'\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'unit.test.ts'), "import { x } from './support/helpers'\n");
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const warning = executeInitPlan(plan, args, tmp).warnings.find((w) => w.includes('.tapsmith.ts'));
      expect(warning).toContain('e2e/login.test.ts');
      expect(warning).toContain('e2e/cart.test.ts');
      expect(warning).toContain('e2e/setup.spec.ts');
      expect(warning).not.toContain('unit.test.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("counts specs that reach tapsmith through a path alias or a chain of modules, by the device fixture they use", () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'e2e'));
      fs.writeFileSync(path.join(tmp, 'e2e', 'alias.test.ts'),
        "import { test, expect } from '@/e2e/fixtures'\n\ntest('signs in', async ({ device }) => {\n  await device.getByText('Hi').tap()\n})\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'info.test.ts'),
        "import { test } from '@/fixtures'\ntest('x', async ({ device }, testInfo) => {\n  await device.tap()\n})\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'hook.spec.ts'),
        "import { test } from '~/support'\ntest.beforeEach(async ({ device, page }) => {\n  await device.restartApp()\n})\n");
      // A Jest test that merely mentions a device is not one, even one that
      // destructures a `device` key in a table test or a factory.
      fs.writeFileSync(path.join(tmp, 'e2e', 'unit.test.ts'),
        "test('formats a device name', () => { const device = { name: 'x' }; expect(device.name).toBe('x') })\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'table.test.ts'),
        "it.each([{ device: 'ios' }])('labels $device', ({ device }) => { expect(label(device)).toBe(device.toUpperCase()) })\n"
        + "const row = ({ device }) => device.name\n");
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const warning = executeInitPlan(plan, args, tmp).warnings.find((w) => w.includes('.tapsmith.ts'));
      expect(warning).toContain('e2e/alias.test.ts');
      expect(warning).toContain('e2e/hook.spec.ts');
      expect(warning).toContain('e2e/info.test.ts');
      expect(warning).not.toContain('unit.test.ts');
      expect(warning).not.toContain('table.test.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The scan is advisory: it runs after the config is written, so a path it
  // cannot probe must not fail init halfway.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps going when an import resolves into a directory it cannot search', () => {
    const tmp = makeTmp();
    const locked = path.join(tmp, 'e2e', 'locked');
    try {
      fs.mkdirSync(locked, { recursive: true });
      fs.writeFileSync(path.join(tmp, 'e2e', 'a.test.ts'), "import { x } from './locked/helpers'\n");
      fs.writeFileSync(path.join(tmp, 'e2e', 'b.test.ts'), "import { test } from 'tapsmith'\n");
      fs.chmodSync(locked, 0o000);
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(result.filesCreated).toContain('tests/example.tapsmith.ts');
      const warning = result.warnings.find((w) => w.includes('.tapsmith.ts'));
      expect(warning).toContain('e2e/b.test.ts');
      expect(warning).not.toContain('e2e/a.test.ts');
    } finally {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('gives no such warning in a project without Tapsmith tests', () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'src'));
      fs.writeFileSync(path.join(tmp, 'src', 'utils.test.ts'), "import { sum } from './utils'\n");
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(result.warnings.join('\n')).not.toContain('testMatch');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── A file init cannot write (PILOT-623, PILOT-624) ───

// chmod cannot take write access away from root, and Windows ignores it.
const canDenyWrites = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('executeInitPlan() when a file cannot be written', () => {
  let tmp: string;
  const locked: string[] = [];
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-write-')));
  });
  afterEach(() => {
    for (const dir of locked.splice(0)) fs.chmodSync(dir, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const lock = (dir: string): void => {
    fs.chmodSync(dir, 0o555);
    locked.push(dir);
  };
  const run = (over: Partial<InitCommandOptions> = {}) => {
    const args = initArgs({ yes: true, platform: 'android', ...over });
    return () => executeInitPlan(resolveInitPlan(args, baseEnv, detectStubs, tmp), args, tmp);
  };
  const listing = (): string[] => fs.readdirSync(tmp).sort();

  it.skipIf(!canDenyWrites)('stops with WRITE_FAILED before writing anything when tests/ is read-only', () => {
    fs.mkdirSync(path.join(tmp, 'tests'));
    lock(path.join(tmp, 'tests'));
    const err = expectInitError(run(), 'WRITE_FAILED');
    expect(err.message).toContain('tests/example.tapsmith.ts');
    expect(err.message).toContain(path.join(tmp, 'tests'));
    expect(err.message).toContain('Nothing was written');
    expect(err.fix).toMatch(/--no-example-test/);
    expect(listing()).toEqual(['tests']);
  });

  it('stops with WRITE_FAILED when tests is a file', () => {
    fs.writeFileSync(path.join(tmp, 'tests'), 'not a directory');
    const err = expectInitError(run(), 'WRITE_FAILED');
    expect(err.message).toContain('tests/example.tapsmith.ts');
    expect(err.message).toMatch(/not a directory/);
    expect(listing()).toEqual(['tests']);
  });

  it.skipIf(!canDenyWrites)('stops with WRITE_FAILED naming tapsmith.config.ts when the project directory is read-only', () => {
    lock(tmp);
    const err = expectInitError(run({ exampleTest: false, agentsMd: false }), 'WRITE_FAILED');
    expect(err.message).toContain('tapsmith.config.ts');
    expect(err.message).toContain('Nothing was written');
    expect(listing()).toEqual([]);
  });

  it.skipIf(!canDenyWrites)('keeps the existing config when --force cannot write the new one', () => {
    fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing');
    lock(tmp);
    expectInitError(run({ force: true }), 'WRITE_FAILED');
    expect(fs.readFileSync(path.join(tmp, 'tapsmith.config.ts'), 'utf8')).toBe('// existing');
    expect(listing()).toEqual(['tapsmith.config.ts']);
  });

  // Checked again before the questions and the iOS agent build, so a
  // read-only project fails at once rather than after minutes of work.
  it.skipIf(!canDenyWrites)('assertProjectWritable() refuses a read-only project with the same WRITE_FAILED', () => {
    expect(() => assertProjectWritable(tmp)).not.toThrow();
    lock(tmp);
    const err = expectInitError(() => assertProjectWritable(tmp), 'WRITE_FAILED');
    expect(err.message).toBe(`Could not write tapsmith.config.ts: ${tmp} is not writable. Nothing was written.`);
    expect(err.fix).toContain(`Give yourself write access to ${tmp}`);
  });

  it('stops with WRITE_FAILED naming AGENTS.md when it is a directory', () => {
    fs.mkdirSync(path.join(tmp, 'AGENTS.md'));
    const err = expectInitError(run(), 'WRITE_FAILED');
    expect(err.message).toContain('AGENTS.md');
    expect(err.message).toContain('Nothing was written');
    expect(err.fix).toMatch(/--no-agents-md/);
    expect(listing()).toEqual(['AGENTS.md']);
  });

  it.skipIf(!canDenyWrites)('stops with WRITE_FAILED naming a read-only AGENTS.md', () => {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# mine\n');
    fs.chmodSync(path.join(tmp, 'AGENTS.md'), 0o444);
    const err = expectInitError(run(), 'WRITE_FAILED');
    expect(err.message).toContain('AGENTS.md');
    expect(listing()).toEqual(['AGENTS.md']);
  });

  it.skipIf(!canDenyWrites)('checks only the files it was asked to write', () => {
    fs.mkdirSync(path.join(tmp, 'tests'));
    lock(path.join(tmp, 'tests'));
    fs.mkdirSync(path.join(tmp, 'AGENTS.md'));
    const result = run({ exampleTest: false, agentsMd: false })();
    expect(result.filesCreated).toContain('tapsmith.config.ts');
  });

  // A failure the up-front check cannot foresee (a full disk, a directory
  // where the config goes): the config is written last, so none is left
  // behind, and the error lists what was written.
  it('writes the config last, and names the files already written when it fails', () => {
    fs.mkdirSync(path.join(tmp, 'tapsmith.config.ts'));
    fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts', 'keep'), '');
    const err = expectInitError(run({ force: true }), 'WRITE_FAILED');
    expect(err.message).toContain('Could not write tapsmith.config.ts');
    // The reason is Node's, without the temp file or a rename of the config onto itself.
    expect(err.message).toMatch(/Could not write tapsmith\.config\.ts: E[A-Z]+: [^,']+\. Already written/);
    expect(err.message).not.toContain('.tmp');
    expect(err.message).toContain('Already written: tests/example.tapsmith.ts, AGENTS.md');
    expect(listing()).toEqual(['AGENTS.md', 'tapsmith.config.ts', 'tests']);
    expect(fs.statSync(path.join(tmp, 'tapsmith.config.ts')).isDirectory()).toBe(true);
  });
});

describe('simulatorChoices() (PILOT-562)', () => {
  const sim = (name: string, runtime: string, state = 'Shutdown', udid = `${name}-${runtime}`) => ({ name, udid, state, runtime });

  it('lists every iOS simulator once, iPhones first, newest runtime first, keeping simctl order within a runtime', () => {
    const sims = [
      sim('iPhone 15', 'iOS 17.5'),
      sim('iPad Air', 'iOS 26.5'),
      sim('iPhone 17 Pro', 'iOS 26.5'),
      sim('iPhone 17', 'iOS 26.5'),
      sim('iPhone 17', 'iOS 26.0'),
      ...Array.from({ length: 25 }, (_, i) => sim(`iPhone Extra ${i}`, 'iOS 18.0')),
    ];
    const names = simulatorChoices(sims).map((s) => s.name);
    expect(names.slice(0, 3)).toEqual(['iPhone 17 Pro', 'iPhone 17', 'iPhone Extra 0']);
    expect(names.at(-2)).toBe('iPhone 15');
    expect(names.at(-1)).toBe('iPad Air');
    // Never cut short, one entry per name, newest runtime kept.
    expect(names).toHaveLength(29);
    expect(new Set(names).size).toBe(29);
    expect(simulatorChoices(sims).find((s) => s.name === 'iPhone 17')?.runtime).toBe('iOS 26.5');
  });

  it('puts a booted simulator first, even one on an older runtime than its namesake', () => {
    const sims = [
      sim('iPhone 17 Pro', 'iOS 26.5'),
      sim('iPhone 16', 'iOS 26.5'),
      sim('iPhone 16', 'iOS 18.2', 'Booted', 'BOOTED-16'),
    ];
    const ordered = simulatorChoices(sims);
    expect(ordered[0]).toMatchObject({ name: 'iPhone 16', udid: 'BOOTED-16', state: 'Booted' });
    expect(ordered.map((s) => s.name)).toEqual(['iPhone 16', 'iPhone 17 Pro']);
  });

  it('leaves out the clones parallel runs make, even a booted one', () => {
    const sims = [sim('iPhone 17 (Tapsmith Worker 1)', 'iOS 26.5', 'Booted'), sim('iPhone 17', 'iOS 26.5')];
    expect(simulatorChoices(sims).map((s) => s.name)).toEqual(['iPhone 17']);
  });

  it('leaves out watchOS, tvOS and visionOS simulators, which cannot run an iOS app', () => {
    const sims = [sim('Apple Watch Ultra', 'watchOS 11.0', 'Booted'), sim('Apple TV', 'tvOS 18.0'), sim('Apple Vision Pro', 'xrOS 2.0'), sim('iPhone 17', 'iOS 26.0')];
    expect(simulatorChoices(sims).map((s) => s.name)).toEqual(['iPhone 17']);
  });

  it('offers nothing when no iOS runtime is installed, so init warns instead of picking a watch or headset', () => {
    const sims = [sim('Apple Vision Pro', 'xrOS 2.0'), sim('Apple Watch Ultra', 'watchOS 11.0', 'Booted')];
    expect(simulatorChoices(sims)).toEqual([]);
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'ios' }), { ...baseEnv, simulators: sims }, detectStubs);
    expect(plan.ios?.simulator).toBe('iPhone 17');
    expect(plan.warnings.join('\n')).toContain('No iOS simulators found');
  });

  it('init --yes picks the booted simulator over the newest iPhone', () => {
    const env = { ...baseEnv, simulators: [sim('iPhone 17 Pro', 'iOS 26.5'), sim('iPhone 16', 'iOS 18.2', 'Booted')] };
    const plan = resolveInitPlan(initArgs({ yes: true, platform: 'ios' }), env, detectStubs);
    expect(plan.ios?.simulator).toBe('iPhone 16');
  });
});
