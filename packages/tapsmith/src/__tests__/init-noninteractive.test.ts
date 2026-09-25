import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initArgsFromOptions, resolveInitPlan, executeInitPlan, assertConfigWritable, InitError } from '../init-noninteractive.js';
import type { EnvScan } from '../env-scan.js';
import type { InitCommandOptions } from '../cli-program.js';

/** `tapsmith init` flags as the CLI hands them over: every boolean present, value flags only when given. */
function initArgs(over: Partial<InitCommandOptions>) {
  return initArgsFromOptions({
    yes: false, json: false, force: false, networkCapture: false, exampleTest: true, agentsMd: true, ...over,
  });
}

const baseEnv: EnvScan = {
  nodeVersion: '22.0.0',
  daemonBin: '/bin/tapsmith-core',
  agentApk: true,
  agentTestApk: true,
  adbVersion: '35.0.1',
  androidHome: '/sdk',
  xcodeVersion: '16.0',
  simulators: [
    { name: 'iPhone 16', udid: 'A', state: 'Shutdown', runtime: 'iOS 18 0' },
    { name: 'iPhone 16', udid: 'B', state: 'Shutdown', runtime: 'iOS 18 2' },
  ],
  avds: ['Pixel_7', 'Pixel_8'],
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

  it('omits avd with a warning when none available', () => {
    const plan = resolveInitPlan(
      initArgs({ yes: true, platform: 'android' }),
      { ...baseEnv, avds: [] },
      detectStubs,
    );
    expect(plan.android?.avd).toBeUndefined();
    expect(plan.warnings.some((w) => w.includes('AVD'))).toBe(true);
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
      expect(fs.existsSync(path.join(tmp, 'tests', 'example.test.ts'))).toBe(true);
      expect(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8')).toContain('tapsmith:begin');
      expect(result.filesCreated).toEqual(expect.arrayContaining(['tapsmith.config.ts', 'tests/example.test.ts', 'AGENTS.md']));
      expect(result.configPath).toBe(path.join(tmp, 'tapsmith.config.ts'));
      expect(result.nextSteps.some((s) => s.includes('tapsmith verify'))).toBe(true);
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
      assertConfigWritable(true, tmp);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.mjs'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.ts'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('removes an existing tapsmith.config.ts when force is enabled', () => {
    const tmp = makeTmp();
    try {
      fs.writeFileSync(path.join(tmp, 'tapsmith.config.ts'), '// existing ts');
      assertConfigWritable(true, tmp);
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.ts'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('replaces a symlinked config without clobbering the link target on force', () => {
    const tmp = makeTmp();
    try {
      const target = path.join(tmp, 'real-config.ts');
      fs.writeFileSync(target, '// link target');
      fs.symlinkSync(target, path.join(tmp, 'tapsmith.config.ts'));
      assertConfigWritable(true, tmp);
      // The symlink is removed; its target is left untouched.
      expect(fs.existsSync(path.join(tmp, 'tapsmith.config.ts'))).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('// link target');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('skips existing example test without error', () => {
    const tmp = makeTmp();
    try {
      fs.mkdirSync(path.join(tmp, 'tests'));
      fs.writeFileSync(path.join(tmp, 'tests', 'example.test.ts'), '// mine');
      const args = initArgs({ yes: true, platform: 'android' });
      const plan = resolveInitPlan(args, baseEnv, detectStubs, tmp);
      const result = executeInitPlan(plan, args, tmp);
      expect(fs.readFileSync(path.join(tmp, 'tests', 'example.test.ts'), 'utf8')).toBe('// mine');
      expect(result.filesCreated).not.toContain('tests/example.test.ts');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
