import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXAMPLE_TEST_PATH, GENERATED_TEST_MATCH, androidEmulatorCaptureLine, avdPickerChoices, normalizeTypedPath, typedBuildPath, validateBuildPath, generateConfig, generatedProjects, generateExampleTest, iosSimulatorCaptureLine, networkCaptureDefault, platformPrompt, runInit, wizardNextSteps } from '../init.js';
import type { EnvScan } from '../env-scan.js';
import type { AndroidConfig, IosConfig, Platform } from '../init.js';
import { platformlessIosFields } from '../doctor.js';
import { _internal } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import type { InitCommandOptions } from '../cli-program.js';
import type { AvdImageInfo } from '../avd-images.js';
import { stripAnsi } from '../cli-json.js';
import { minimatch } from 'minimatch';

interface GeneratedScope {
  platform?: Platform;
  package?: string;
  app?: string;
  apk?: string;
  avd?: string;
  simulator?: string;
}
interface GeneratedConfig extends GeneratedScope {
  testMatch?: string[];
  projects?: Array<{ name: string; testMatch?: string[]; workers?: number; use?: GeneratedScope }>;
}

/** Evaluate the generated config text the way a loader would, with `defineConfig` as identity. */
function evaluateConfig(text: string): GeneratedConfig {
  const body = text
    .replace("import { defineConfig } from 'tapsmith'", '')
    .replace('export default defineConfig(', 'return (');
  return new Function(body)() as GeneratedConfig;
}

describe('generateConfig()', () => {
  it('generates single-platform Android config', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: true, usePhysicalDevices: false, avd: 'Pixel_7' },
      undefined,
      false,
    );

    expect(config).toContain("import { defineConfig } from 'tapsmith'");
    expect(config).toContain("package: 'com.example.app',");
    expect(config).toContain("apk: './app.apk',");
    expect(config).toContain("avd: 'Pixel_7',");
    expect(config).not.toContain('launchEmulators');
    expect(config).not.toContain('projects');
    expect(config).not.toContain('trace');
  });

  it('generates single-platform iOS config', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { appPath: './MyApp.app', bundleId: 'com.example.app', simulator: 'iPhone 17', usePhysicalDevice: false },
      false,
    );

    expect(config).toContain("app: './MyApp.app',");
    expect(config).toContain("simulator: 'iPhone 17',");
    expect(config).not.toContain('projects');
  });

  it('generates dual-platform config with projects', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.app', useEmulators: false, usePhysicalDevices: true },
      { appPath: './MyApp.app', bundleId: 'com.example.app', simulator: 'iPhone 17', usePhysicalDevice: false },
      true,
    );

    expect(config).toContain('projects: [');
    expect(config).toContain("name: 'android',");
    expect(config).toContain("name: 'ios',");
    expect(config).toContain("platform: 'android',");
    expect(config).toContain("platform: 'ios',");
    expect(config).toContain("trace: { mode: 'retain-on-failure' },");
  });

  it('puts package name per-project in dual-platform config', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: false, usePhysicalDevices: true },
      { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: false },
      false,
    );

    expect(config).not.toMatch(/^  package:/m);
    expect(config).toContain("package: 'com.example.android',");
    expect(config).toContain("package: 'com.example.ios',");
  });

  it('includes iOS device project when physical device configured', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', useEmulators: false, usePhysicalDevices: true },
      {
        appPath: './MyApp.app',
        simulator: 'iPhone 17',
        usePhysicalDevice: true,
        deviceAppPath: './MyApp-device.app',
      },
      false,
    );

    expect(config).toContain("name: 'ios-device',");
    expect(config).toContain('workers: 1,');
    expect(config).toContain("app: './MyApp-device.app',");
  });

  it('sets platform: ios on a single-platform simulator config (PILOT-251)', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { appPath: './MyApp.app', bundleId: 'com.example.app', simulator: 'iPhone 17', usePhysicalDevice: false },
      false,
    );

    expect(config).toContain("platform: 'ios',");
  });

  it('targets the device build for single-platform iOS on physical devices only (PILOT-251)', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { bundleId: 'com.example.app', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
      false,
    );
    const parsed = evaluateConfig(config);

    expect(parsed).toEqual({ testMatch: GENERATED_TEST_MATCH, platform: 'ios', package: 'com.example.app', app: './MyApp-device.app' });
  });

  it('emits simulator and device projects for single-platform iOS on both (PILOT-251)', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      {
        appPath: './MyApp.app',
        bundleId: 'com.example.app',
        simulator: 'iPhone 17',
        usePhysicalDevice: true,
        deviceAppPath: './MyApp-device.app',
      },
      false,
    );
    const parsed = evaluateConfig(config);

    expect(parsed.app).toBeUndefined();
    expect(parsed.simulator).toBeUndefined();
    expect(parsed.package).toBeUndefined();
    expect(parsed.projects).toEqual([
      {
        name: 'ios',
        use: { platform: 'ios', package: 'com.example.app', app: './MyApp.app', simulator: 'iPhone 17' },
      },
      {
        name: 'ios-device',
        workers: 1,
        use: { platform: 'ios', package: 'com.example.app', app: './MyApp-device.app' },
      },
    ]);
  });

  it('gives the multi-platform ios-device project the bundle id (PILOT-251)', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: false, usePhysicalDevices: true },
      {
        appPath: './MyApp.app',
        bundleId: 'com.example.ios',
        simulator: 'iPhone 17',
        usePhysicalDevice: true,
        deviceAppPath: './MyApp-device.app',
      },
      false,
    );
    const device = evaluateConfig(config).projects?.find((p) => p.name === 'ios-device');

    expect(device?.use).toEqual({ platform: 'ios', package: 'com.example.ios', app: './MyApp-device.app' });
  });

  it('omits the simulator project for multi-platform iOS on physical devices only (PILOT-251)', () => {
    const config = generateConfig(
      ['android', 'ios'],
      { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: false, usePhysicalDevices: true },
      { bundleId: 'com.example.ios', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
      false,
    );

    expect(evaluateConfig(config).projects?.map((p) => p.name)).toEqual(['android', 'ios-device']);
  });

  it('gives the device target the device build\'s own bundle id when it differs', () => {
    const both = evaluateConfig(generateConfig(
      ['ios'],
      undefined,
      {
        appPath: './MyApp.app',
        bundleId: 'com.example.app.dev',
        deviceBundleId: 'com.example.app',
        simulator: 'iPhone 17',
        usePhysicalDevice: true,
        deviceAppPath: './MyApp-device.app',
      },
      false,
    ));
    expect(both.projects?.map((p) => [p.name, p.use?.package])).toEqual([
      ['ios', 'com.example.app.dev'],
      ['ios-device', 'com.example.app'],
    ]);

    const physical = evaluateConfig(generateConfig(
      ['ios'],
      undefined,
      { bundleId: 'com.example.app.dev', deviceBundleId: 'com.example.app', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
      false,
    ));
    expect(physical.package).toBe('com.example.app');
  });

  it('omits package when no bundle id is known', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
      false,
    );

    expect(config).not.toContain('package');
    expect(config).not.toContain('undefined');
  });

  it('escapes single quotes in the device app path', () => {
    const config = generateConfig(
      ['ios'],
      undefined,
      { bundleId: 'com.x', usePhysicalDevice: true, deviceAppPath: "./it's/MyApp.app" },
      false,
    );

    expect(evaluateConfig(config).app).toBe("./it's/MyApp.app");
  });

  describe('every iOS wizard choice yields a config tapsmith test and doctor accept (PILOT-251)', () => {
    const android: AndroidConfig = { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: true, usePhysicalDevices: false, avd: 'Pixel_7' };
    const iosChoices: Record<string, IosConfig> = {
      simulators: { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: false },
      physical: { bundleId: 'com.example.ios', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
      both: { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' },
    };
    const cases = Object.entries(iosChoices).flatMap(([choice, ios]) => [
      { label: `ios only, ${choice}`, platforms: ['ios'] as Platform[], android: undefined, ios },
      { label: `android + ios, ${choice}`, platforms: ['android', 'ios'] as Platform[], android, ios },
    ]);

    it.each(cases)('$label', ({ platforms, android: a, ios }) => {
      const parsed = evaluateConfig(generateConfig(platforms, a, ios, false));
      expect(platformlessIosFields(parsed)).toEqual([]);

      const scopes = parsed.projects
        ? parsed.projects.map((p) => ({ ...parsed, projects: undefined, ...p.use }))
        : [parsed];
      const iosScopes = scopes.filter((s) => _internal.resolvePlatformFixture(s as TapsmithConfig) === 'ios');
      // The simulator scope runs the simulator build on the chosen simulator;
      // the physical scope (no `simulator`) runs the device build.
      const sim = iosScopes.filter((s) => s.simulator);
      const phys = iosScopes.filter((s) => !s.simulator);
      expect(sim.map((s) => s.app)).toEqual(ios.simulator ? ['./MyApp.app'] : []);
      expect(phys.map((s) => s.app)).toEqual(ios.usePhysicalDevice ? ['./MyApp-device.app'] : []);
      for (const s of iosScopes) expect(s.package).toBe('com.example.ios');
    });

    it.each(cases)('$label: the next-steps --project names match the generated projects', ({ platforms, android: a, ios }) => {
      const parsed = evaluateConfig(generateConfig(platforms, a, ios, false));
      expect(generatedProjects(platforms, ios).map((p) => p.name)).toEqual((parsed.projects ?? []).map((p) => p.name));
    });
  });

  it('includes network tracing when enabled', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: './app.apk', useEmulators: false, usePhysicalDevices: true },
      undefined,
      true,
    );

    expect(config).toContain("trace: { mode: 'retain-on-failure' },");
  });

  it('escapes single quotes in paths', () => {
    const config = generateConfig(
      ['android'],
      { apkPath: "./path with 'quotes'/app.apk", packageName: 'com.example', useEmulators: false, usePhysicalDevices: true },
      undefined,
      false,
    );

    expect(config).toContain("apk: './path with \\'quotes\\'/app.apk',");
    expect(config).not.toContain("apk: './path with 'quotes'/app.apk',");
  });
});

// ─── Wizard AVD picker and capture line (PILOT-403) ───

const studioAvds: AvdImageInfo[] = [
  { name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 },
  { name: 'Tapsmith_Phone_API_36', tagId: 'google_apis', apiLevel: 36 },
];

describe('generateConfig() with a custom-named simulator (PILOT-721)', () => {
  const ios: IosConfig = { appPath: 'ios/App.app', bundleId: 'com.example', simulator: "Sam's iPhone", simulatorDeviceType: 'iPhone 17', usePhysicalDevice: false };

  it('comments that the name is machine-local, naming a stock alternative', () => {
    const text = generateConfig(['ios'], undefined, ios, false);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.includes("simulator: 'Sam\\'s iPhone'"));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at - 2, at).join(' ')).toMatch(/only on this Mac.*'iPhone 17'/);
    expect(evaluateConfig(text).simulator).toBe("Sam's iPhone");
  });

  it('comments it inside the ios project of a multi-platform config too', () => {
    const android: AndroidConfig = { apkPath: 'a.apk', packageName: 'com.a', useEmulators: true, usePhysicalDevices: false, avd: 'X' };
    const text = generateConfig(['android', 'ios'], android, ios, false);
    expect(text).toMatch(/only on this Mac[\s\S]*simulator: 'Sam\\'s iPhone'/);
    expect(evaluateConfig(text).projects?.find((p) => p.name === 'ios')?.use?.simulator).toBe("Sam's iPhone");
  });

  it('adds no comment for a stock name', () => {
    expect(generateConfig(['ios'], undefined, { ...ios, simulator: 'iPhone 17', simulatorDeviceType: undefined }, false)).not.toContain('only on this Mac');
  });
});

describe('avdPickerChoices()', () => {
  it('marks Play images and pre-selects the first capture-capable AVD, keeping list order', () => {
    const { choices, initial } = avdPickerChoices(['Medium_Phone_API_36', 'Tapsmith_Phone_API_36'], studioAvds);
    expect(choices.map((c) => c.name)).toEqual(['Medium_Phone_API_36', 'Tapsmith_Phone_API_36']);
    expect(choices[0].hint).toBe('no HTTPS capture');
    expect(choices[1].hint).toBeUndefined();
    expect(initial).toBe(1);
  });

  it('falls back to the first AVD when none is capture-capable', () => {
    const { choices, initial } = avdPickerChoices(['Medium_Phone_API_36'], studioAvds);
    expect(choices[0].hint).toBe('no HTTPS capture');
    expect(initial).toBe(0);
  });

  it('does not mark an AVD whose image could not be read as Play', () => {
    const { choices, initial } = avdPickerChoices(['Mystery'], [{ name: 'Mystery' }]);
    expect(choices[0].hint).toBeUndefined();
    expect(initial).toBe(0);
  });

  it('pre-selects an AVD whose image could not be read over an earlier Play image (PILOT-721)', () => {
    const { initial } = avdPickerChoices(['Medium_Phone_API_36', 'Mystery'], [...studioAvds, { name: 'Mystery' }]);
    expect(initial).toBe(1);
  });
});

// ─── Platform prompt (PILOT-721) ───

describe('platformPrompt() (PILOT-721)', () => {
  const env = (over: Partial<EnvScan> = {}): EnvScan => ({
    nodeVersion: '22.0.0', rosettaWarning: undefined, daemonBin: '/bin/tapsmith-core', agentApk: true, agentTestApk: true,
    adbVersion: '35.0.1', androidHome: '/sdk', xcodeVersion: '26.0',
    simulators: [{ name: 'iPhone 17', udid: 'A', state: 'Shutdown', runtime: 'iOS 26.0' }],
    avds: [], avdImages: [], isMacOS: true, ...over,
  });
  const none = { hasAndroidDir: false, hasIosDir: false };
  const selected = (p: ReturnType<typeof platformPrompt>): string => p.choices[p.initial].name;

  it('defaults to iOS when adb is missing and Xcode is ready, hinting why Android is not', () => {
    const p = platformPrompt(env({ adbVersion: undefined }), none);
    expect(selected(p)).toBe('ios');
    expect(p.choices.find((c) => c.name === 'android')?.hint).toBe('ADB not found');
  });

  it('defaults to iOS in a project with only ios/', () => {
    expect(selected(platformPrompt(env(), { hasAndroidDir: false, hasIosDir: true }))).toBe('ios');
  });

  it('defaults to Android in a project with only android/', () => {
    expect(selected(platformPrompt(env(), { hasAndroidDir: true, hasIosDir: false }))).toBe('android');
  });

  it('defaults to both when the project has android/ and ios/ and both toolchains are ready', () => {
    expect(selected(platformPrompt(env(), { hasAndroidDir: true, hasIosDir: true }))).toBe('both');
  });

  it('defaults to the usable one of a two-platform project', () => {
    expect(selected(platformPrompt(env({ adbVersion: undefined }), { hasAndroidDir: true, hasIosDir: true }))).toBe('ios');
    expect(selected(platformPrompt(env({ xcodeVersion: undefined }), { hasAndroidDir: true, hasIosDir: true }))).toBe('android');
  });

  it('keeps Android first when both toolchains are ready and the layout says nothing', () => {
    const p = platformPrompt(env(), none);
    expect(selected(p)).toBe('android');
    expect(p.choices.every((c) => c.hint === undefined)).toBe(true);
  });

  it('hints an iOS without Xcode, and an iOS with no simulators', () => {
    expect(platformPrompt(env({ xcodeVersion: undefined }), none).choices.find((c) => c.name === 'ios')?.hint).toBe('Xcode not found');
    expect(platformPrompt(env({ simulators: [] }), none).choices.find((c) => c.name === 'ios')?.hint).toBe('no iOS simulators found');
  });

  it('offers only Android off macOS', () => {
    const p = platformPrompt(env({ isMacOS: false, xcodeVersion: undefined, simulators: [], adbVersion: undefined }), { hasAndroidDir: false, hasIosDir: true });
    expect(p.choices.map((c) => c.name)).toEqual(['android']);
    expect(p.initial).toBe(0);
  });
});

describe('androidEmulatorCaptureLine()', () => {
  it('says capture works automatically only for a capture-capable AVD', () => {
    expect(stripAnsi(androidEmulatorCaptureLine('Tapsmith_Phone_API_36', studioAvds, true)))
      .toBe('  ✓ Android emulator (Tapsmith_Phone_API_36) — works automatically');
  });

  it('warns for a Play image, with the non-destructive fix', () => {
    const line = stripAnsi(androidEmulatorCaptureLine('Medium_Phone_API_36', studioAvds, true));
    expect(line).toMatch(/^ {2}⚠ Android emulator — AVD Medium_Phone_API_36 uses a Google Play system image/);
    expect(line).not.toContain('works automatically');
    expect(line).toContain("set avd: 'Tapsmith_Phone_API_36'");
    expect(line).not.toContain('--force');
  });

  it('warns when the AVD image could not be read', () => {
    expect(stripAnsi(androidEmulatorCaptureLine('Mystery', [{ name: 'Mystery' }], true))).toContain('Could not read the system image of AVD Mystery');
  });

  it('warns, without repeating the AVD warning already printed, when no AVD was chosen', () => {
    const line = stripAnsi(androidEmulatorCaptureLine(undefined, studioAvds, true));
    expect(line).toBe('  ⚠ Android emulator — no AVD selected (see the AVD warning above)');
    expect(line).not.toContain('works automatically');
  });

  it('never says capture works automatically when ADB is missing (PILOT-513)', () => {
    const line = stripAnsi(androidEmulatorCaptureLine('Tapsmith_Phone_API_36', studioAvds, false));
    expect(line).not.toContain('works automatically');
    expect(line).toMatch(/^ {2}⚠ Android emulator — ADB not found/);
  });

  it('still names a Play image when ADB is missing: capture would record nothing once adb is fixed', () => {
    const lines = stripAnsi(androidEmulatorCaptureLine('Medium_Phone_API_36', studioAvds, false)).split('\n');
    expect(lines[0]).toMatch(/ADB not found/);
    expect(lines[1]).toMatch(/^ {2}⚠ Android emulator — AVD Medium_Phone_API_36 uses a Google Play system image/);
  });
});

describe('iosSimulatorCaptureLine() (PILOT-721)', () => {
  const line = (...args: Parameters<typeof iosSimulatorCaptureLine>): string => stripAnsi(iosSimulatorCaptureLine(...args));

  it('asks for mitmproxy only when doctor would not find it', () => {
    expect(line(undefined, 'not-registered', 'npx tapsmith')).toBe('  ⚠ iOS simulator — run `brew install mitmproxy`, then `npx tapsmith ios network setup-simulator`');
    expect(line('/Applications', 'not-registered', 'npx tapsmith')).not.toContain('brew install');
  });

  it('says it is ready when mitmproxy and its Network Extension are', () => {
    expect(line('/Applications', 'enabled', 'npx tapsmith')).toBe('  ✓ iOS simulator — ready (mitmproxy and its Network Extension)');
  });

  it('on a fresh machine, says the extension asks for approval on the first run, with nothing to run now', () => {
    const l = line('Homebrew cask', 'not-registered', 'npx tapsmith');
    expect(l).toMatch(/^ {2}✓ iOS simulator — mitmproxy installed/);
    expect(l).toContain('first iOS simulator test run');
    expect(l).not.toContain('setup-simulator');
  });

  it('points at setup-simulator only for an extension waiting for approval or in an unknown state, in the project\'s runner', () => {
    expect(line('/Applications', 'waiting-for-user', 'pnpm exec tapsmith')).toBe('  ⚠ iOS simulator — approve mitmproxy\'s Network Extension: run `pnpm exec tapsmith ios network setup-simulator`');
    expect(line('/Applications', 'unknown', 'npx tapsmith')).toContain('`npx tapsmith ios network setup-simulator`');
  });
});

describe('networkCaptureDefault() (PILOT-711)', () => {
  const android = (avd: string | undefined, over: Partial<{ useEmulators: boolean }> = {}) => ({
    apkPath: './app.apk', packageName: 'com.example', useEmulators: true, usePhysicalDevices: false, avd, ...over,
  });

  it('defaults to yes on a capture-capable AVD', () => {
    expect(networkCaptureDefault(['android'], android('Tapsmith_Phone_API_36'), studioAvds)).toEqual({ initial: true });
  });

  it('defaults to no on a Play-image AVD, saying why', () => {
    const d = networkCaptureDefault(['android'], android('Medium_Phone_API_36'), studioAvds);
    expect(d.initial).toBe(false);
    expect(d.reason).toBe("AVD Medium_Phone_API_36 can't capture HTTPS: it uses a Google Play system image");
  });

  it('keeps yes when iOS is also set up, where capture works', () => {
    expect(networkCaptureDefault(['android', 'ios'], android('Medium_Phone_API_36'), studioAvds).initial).toBe(true);
  });

  it('keeps yes for physical-only Android and for an AVD whose image could not be read', () => {
    expect(networkCaptureDefault(['android'], android('Medium_Phone_API_36', { useEmulators: false }), studioAvds).initial).toBe(true);
    expect(networkCaptureDefault(['android'], android('Mystery'), [{ name: 'Mystery' }]).initial).toBe(true);
  });
});

describe('validateBuildPath() (PILOT-513)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-path-'));
    fs.mkdirSync(path.join(tmp, 'out', 'Debug-iphonesimulator', 'My App.app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'out', 'Release-iphoneos', 'MyApp.app'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'out', 'app.apk'), '');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('accepts an existing APK file, relative to the project or absolute, ignoring surrounding spaces', () => {
    expect(validateBuildPath('./out/app.apk', 'apk', tmp)).toBe(true);
    expect(validateBuildPath(`  ${path.join(tmp, 'out', 'app.apk')} `, 'apk', tmp)).toBe(true);
  });

  it('refuses an empty path', () => {
    expect(validateBuildPath('  ', 'apk', tmp)).toBe('APK path is required');
    expect(validateBuildPath('', 'simulator-app', tmp)).toBe('.app path is required');
    expect(validateBuildPath('', 'device-app', tmp)).toBe('Device app path is required');
  });

  it('refuses a path that does not exist, naming it', () => {
    const msg = validateBuildPath('./android/app-debug.apk', 'apk', tmp);
    expect(msg).not.toBe(true);
    expect(msg).toContain('./android/app-debug.apk');
    expect(msg).toMatch(/does not exist/);
  });

  it('refuses a directory for an APK and a file for an .app bundle', () => {
    expect(validateBuildPath('./out', 'apk', tmp)).toMatch(/is a directory/);
    expect(validateBuildPath('./out/app.apk', 'simulator-app', tmp)).toMatch(/not an \.app bundle/);
    // The Products folder above the bundle is a directory but not an .app.
    expect(validateBuildPath('./out/Debug-iphonesimulator', 'simulator-app', tmp)).toMatch(/not an \.app bundle/);
    expect(validateBuildPath('./out/Release-iphoneos/MyApp.app/', 'device-app', tmp)).toBe(true);
  });

  it('accepts .app bundle directories, including paths with spaces', () => {
    expect(validateBuildPath('./out/Debug-iphonesimulator/My App.app', 'simulator-app', tmp)).toBe(true);
    expect(validateBuildPath('./out/Release-iphoneos/MyApp.app', 'device-app', tmp)).toBe(true);
  });

  it('accepts a path the way a shell reads it: quoted, backslash-escaped or under ~', () => {
    const app = path.join(tmp, 'out', 'Debug-iphonesimulator', 'My App.app');
    expect(validateBuildPath(`'${app}'`, 'simulator-app', tmp)).toBe(true);
    expect(validateBuildPath(`"${app}"`, 'simulator-app', tmp)).toBe(true);
    if (process.platform !== 'win32') {
      expect(validateBuildPath(app.replace(/ /g, '\\ '), 'simulator-app', tmp)).toBe(true);
    }
    expect(validateBuildPath('~/definitely-not-here-pilot-513.apk', 'apk', tmp)).toMatch(/^.*definitely-not-here-pilot-513\.apk does not exist/);
  });

  it('still refuses a simulator build for a physical device', () => {
    expect(validateBuildPath('./out/Debug-iphonesimulator/My App.app', 'device-app', tmp))
      .toBe('This looks like a simulator build — physical devices need an iphoneos build');
  });
});

describe('normalizeTypedPath() (PILOT-513)', () => {
  it('expands a leading ~ to the home directory', () => {
    expect(normalizeTypedPath(' ~/builds/app.apk ')).toBe(path.join(os.homedir(), 'builds', 'app.apk'));
    expect(normalizeTypedPath('~')).toBe(os.homedir());
    expect(normalizeTypedPath('./~/app.apk')).toBe('./~/app.apk');
  });

  it('drops one pair of surrounding quotes, keeping what is inside as typed', () => {
    expect(normalizeTypedPath('"/a/My App.app"')).toBe('/a/My App.app');
    expect(normalizeTypedPath("'/a/My App.app'")).toBe('/a/My App.app');
  });

  it.skipIf(process.platform === 'win32')('unescapes a path dragged into a terminal', () => {
    expect(normalizeTypedPath('/a/My\\ App\\ \\(1\\).app')).toBe('/a/My App (1).app');
  });
});

describe('typedBuildPath() (PILOT-513)', () => {
  const project = path.join(os.tmpdir(), 'proj');

  it('makes a path inside the project relative, like the detected builds', () => {
    expect(typedBuildPath(`  ${path.join(project, 'android', 'app.apk')} `, project)).toBe(path.join('android', 'app.apk'));
    // A first segment that merely starts with two dots is still inside the project.
    expect(typedBuildPath(path.join(project, '..cache', 'app.apk'), project)).toBe(path.join('..cache', 'app.apk'));
  });

  it('keeps a relative path as typed, and a path outside the project absolute', () => {
    expect(typedBuildPath('./build/app.apk', project)).toBe('./build/app.apk');
    const outside = path.join(os.tmpdir(), 'elsewhere', 'app.apk');
    expect(typedBuildPath(outside, project)).toBe(outside);
    expect(typedBuildPath(path.join(os.tmpdir(), 'proj-sibling', 'a.apk'), project)).toBe(path.join(os.tmpdir(), 'proj-sibling', 'a.apk'));
  });
});

// ─── The scaffold stays out of the project's own unit-test runner (PILOT-554) ───

describe('example test location vs Jest and Vitest (PILOT-554)', () => {
  // Their published defaults: Jest's `testMatch` and Vitest's `include`.
  const JEST_TEST_MATCH = ['**/__tests__/**/*.?([mc])[jt]s?(x)', '**/?(*.)+(spec|test).?([mc])[jt]s?(x)'];
  const VITEST_INCLUDE = ['**/*.{test,spec}.?(c|m)[jt]s?(x)'];
  const matches = (globs: string[], file: string): boolean => globs.some((g) => minimatch(file, g, { dot: true }));

  it('these globs do catch the old scaffold, so the checks below can fail', () => {
    expect(matches(JEST_TEST_MATCH, 'tests/example.test.ts')).toBe(true);
    expect(matches(VITEST_INCLUDE, 'tests/example.test.ts')).toBe(true);
  });

  it('scaffolds a file neither Jest nor Vitest runs by default', () => {
    expect(matches(JEST_TEST_MATCH, EXAMPLE_TEST_PATH)).toBe(false);
    expect(matches(VITEST_INCLUDE, EXAMPLE_TEST_PATH)).toBe(false);
  });

  it("the generated testMatch finds the scaffold but not the project's own unit tests", () => {
    expect(matches(GENERATED_TEST_MATCH, EXAMPLE_TEST_PATH)).toBe(true);
    expect(matches(GENERATED_TEST_MATCH, 'tests/login/sign-in.tapsmith.ts')).toBe(true);
    for (const unit of ['src/utils.test.ts', '__tests__/App.test.tsx', 'tests/example.test.ts', 'src/api.spec.ts']) {
      expect(matches(GENERATED_TEST_MATCH, unit)).toBe(false);
    }
  });

  const android: AndroidConfig = { apkPath: './app.apk', packageName: 'com.example.android', useEmulators: true, usePhysicalDevices: false, avd: 'Pixel_7' };
  const shapes: Array<{ label: string; platforms: Platform[]; android?: AndroidConfig; ios?: IosConfig }> = [
    { label: 'android', platforms: ['android'], android },
    { label: 'ios simulator', platforms: ['ios'], ios: { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: false } },
    { label: 'ios device', platforms: ['ios'], ios: { bundleId: 'com.example.ios', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' } },
    { label: 'ios simulator + device', platforms: ['ios'], ios: { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: true, deviceAppPath: './MyApp-device.app' } },
    { label: 'android + ios', platforms: ['android', 'ios'], android, ios: { appPath: './MyApp.app', bundleId: 'com.example.ios', simulator: 'iPhone 17', usePhysicalDevice: false } },
  ];

  it.each(shapes)('$label: the config matches the scaffold at the root, and no project narrows it', ({ platforms, android: a, ios }) => {
    const parsed = evaluateConfig(generateConfig(platforms, a, ios, false));
    expect(parsed.testMatch).toEqual(GENERATED_TEST_MATCH);
    for (const project of parsed.projects ?? []) expect(project.testMatch).toBeUndefined();
  });
});

describe('generateExampleTest()', () => {
  it('generates valid test file', () => {
    const test = generateExampleTest();

    expect(test).toContain("import { test, expect } from 'tapsmith'");
    expect(test).toContain('test(');
    expect(test).toContain('async ({ device })');
    expect(test).toContain('toBeVisible');
    // Must use a real role — 'any' is not a known role and throws at runtime,
    // which would make every scaffolded project / `tapsmith verify` fail.
    expect(test).not.toContain("getByRole('any')");
    expect(test).toContain("getByRole('text')");
  });
});

// ─── --json never runs the wizard (PILOT-270, PILOT-266 item 1) ───

describe('runInit() --json without --yes', () => {
  const opts = (over: Partial<InitCommandOptions> = {}): InitCommandOptions => ({
    yes: false, json: true, force: false, networkCapture: false, exampleTest: true, agentsMd: true, ...over,
  });
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  async function run(isTTY: boolean, over: Partial<InitCommandOptions> = {}): Promise<{ out: string; exit: unknown }> {
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const exit = await runInit(opts(over)).then(() => undefined, (err: unknown) => (err as Error).message);
    return { out, exit };
  }

  it('in a terminal, refuses with JSON_REQUIRES_YES instead of starting the interactive wizard', async () => {
    const { out, exit } = await run(true);
    expect(exit).toBe('exit 1');
    expect(JSON.parse(out)).toEqual({
      error: { code: 'JSON_REQUIRES_YES', message: expect.stringContaining('--json'), fix: expect.stringContaining('npx tapsmith init --yes --json') },
    });
  });

  it('in a terminal, a setup flag without --yes runs non-interactively instead of refusing', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-tty-')));
    const cwd = process.cwd();
    try {
      process.chdir(dir);
      const { out, exit } = await run(true, { platform: 'android', apk: path.join(dir, 'missing.apk') });
      expect(exit).toBe('exit 1');
      const code = (JSON.parse(out) as { error: { code: string } }).error.code;
      expect(code).not.toBe('JSON_REQUIRES_YES');
      expect(code).not.toBe('NON_INTERACTIVE_TTY');
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without a terminal, keeps reporting NON_INTERACTIVE_TTY', async () => {
    const { out, exit } = await run(false);
    expect(exit).toBe('exit 1');
    expect((JSON.parse(out) as { error: { code: string } }).error.code).toBe('NON_INTERACTIVE_TTY');
  });
});

// ─── init --yes --json when a file cannot be written (PILOT-623) ───

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('runInit() --yes --json with an unwritable tests/', () => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  afterEach(() => {
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
  });

  it('exits 1 with WRITE_FAILED naming the file, and writes no config', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-init-ro-')));
    const cwd = process.cwd();
    try {
      fs.mkdirSync(path.join(dir, 'tests'));
      fs.chmodSync(path.join(dir, 'tests'), 0o555);
      process.chdir(dir);
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out += String(chunk); return true; });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
      const exit = await runInit({
        yes: true, json: true, force: false, networkCapture: false, exampleTest: true, agentsMd: true,
        platform: 'android', apk: 'app.apk', package: 'com.acme.app', avd: 'Pixel_9',
      }).then(() => undefined, (err: unknown) => (err as Error).message);
      expect(exit).toBe('exit 1');
      const { error } = JSON.parse(out) as { error: { code: string; message: string; fix?: string } };
      expect(error.code).toBe('WRITE_FAILED');
      expect(error.message).toContain('tests/example.tapsmith.ts');
      expect(error.fix).toContain('--no-example-test');
      expect(fs.existsSync(path.join(dir, 'tapsmith.config.ts'))).toBe(false);
    } finally {
      process.chdir(cwd);
      fs.chmodSync(path.join(dir, 'tests'), 0o755);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wizardNextSteps() (PILOT-562)', () => {
  it('leads with `tapsmith verify`, as getting-started does, and never shows a person --json', () => {
    const steps = wizardNextSteps('npx tapsmith', undefined);
    expect(steps[0]).toEqual(['Verify your setup', 'npx tapsmith verify']);
    expect(steps.map(([, cmd]) => cmd)).toEqual(['npx tapsmith verify', 'npx tapsmith test', 'npx tapsmith list-devices', 'npx tapsmith doctor']);
  });

  it('puts a declined install first (PILOT-551)', () => {
    const steps = wizardNextSteps('npx tapsmith', 'npm i -D tapsmith');
    expect(steps[0]).toEqual(['Install Tapsmith', 'npm i -D tapsmith']);
    expect(steps[1][1]).toBe('npx tapsmith verify');
  });

  it('points a Play-image AVD at HTTPS-capable one before verify when capture is on (PILOT-711)', () => {
    const steps = wizardNextSteps('npx tapsmith', 'npm i -D tapsmith', { label: 'Capture HTTPS', action: 'npx tapsmith create-avd', optional: false });
    expect(steps[0][0]).toBe('Install Tapsmith');
    expect(steps[1]).toEqual(['Capture HTTPS', 'npx tapsmith create-avd']);
    expect(steps[2][1]).toBe('npx tapsmith verify');
  });

  it('names the project\'s own runner, in the capture step too (PILOT-721)', () => {
    const steps = wizardNextSteps('pnpm exec tapsmith', 'pnpm add -D tapsmith', { label: 'Capture HTTPS', action: 'npx tapsmith create-avd, then change avd', optional: false });
    expect(steps.map(([, cmd]) => cmd)).toEqual([
      'pnpm add -D tapsmith',
      'pnpm exec tapsmith create-avd, then change avd',
      'pnpm exec tapsmith verify',
      'pnpm exec tapsmith test',
      'pnpm exec tapsmith list-devices',
      'pnpm exec tapsmith doctor',
    ]);
  });

  it('lists it last, as an option, when capture is off', () => {
    const steps = wizardNextSteps('npx tapsmith', undefined, { label: 'Optional, to capture HTTPS', action: 'npx tapsmith create-avd', optional: true });
    expect(steps[0][1]).toBe('npx tapsmith verify');
    expect(steps[steps.length - 1]).toEqual(['Optional, to capture HTTPS', 'npx tapsmith create-avd']);
  });
});
