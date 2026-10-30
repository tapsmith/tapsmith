/**
 * doctor's full report against a faked machine (PILOT-263): which sections
 * run for which config, what a missing toolchain costs, and the fixes it
 * prints. Every external command goes through a mocked `execFileSync`, HOME
 * is a temp dir, and `process.platform` is set per test, so nothing here
 * depends on the host running the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const exec = vi.hoisted(() => ({
  table: new Map<string, string>(),
  calls: [] as string[],
  timeouts: new Map<string, number | undefined>(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn((cmd: string, args: readonly string[] = [], opts?: { timeout?: number }) => {
      const key = [cmd, ...args].join(' ');
      exec.calls.push(key);
      exec.timeouts.set(key, opts?.timeout);
      const out = exec.table.get(key);
      if (out === undefined) {
        const err = new Error(`spawn ${cmd} ENOENT`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return out;
    }),
  };
});

vi.mock('../daemon-bin.js', () => ({ findDaemonBin: () => '/opt/tapsmith-core' }));
const agentApks = vi.hoisted(() => ({ app: '/n/@tapsmith/agent-android/app.apk' as string | undefined, test: '/n/@tapsmith/agent-android/test.apk' as string | undefined }));
vi.mock('../agent-resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-resolve.js')>()),
  findAgentApk: () => agentApks.app,
  findAgentTestApk: () => agentApks.test,
}));
const xctestrun = vi.hoisted(() => ({
  found: undefined as string | undefined,
  cache: undefined as { xctestrun: string; builtBy?: string; stale?: string } | undefined,
}));
vi.mock('../ios-device-resolve.js', () => ({
  findSimulatorXctestrun: () => xctestrun.found,
  extractSdkVersion: () => '26.0',
  getInstalledSimulatorSdkVersion: () => '26.0',
  inspectSimulatorAgentCache: () => xctestrun.cache,
  describeStaleSimulatorAgentCache: (c: { builtBy?: string }) => `the cached iOS simulator agent in ~/.tapsmith/ios-simulator-agent was built by Tapsmith ${c.builtBy} (this is 0.7.1)`,
}));

// Node under Rosetta (PILOT-559): an x64 Node that sysctl says is translated.
const rosetta = vi.hoisted(() => ({ on: false }));
vi.mock('../host-arch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-arch.js')>();
  type Deps = Partial<import('../host-arch.js').HostArchDeps>;
  const faked = (overrides: Deps = {}): Deps => ({
    ...(rosetta.on ? { platform: 'darwin', arch: 'x64' } : {}),
    translated: () => rosetta.on,
    ...overrides,
  });
  return {
    ...actual,
    nodeUnderRosetta: (o?: Deps) => actual.nodeUnderRosetta(faked(o)),
    hostArch: (o?: Deps) => actual.hostArch(faked(o)),
  };
});

import { stripAnsi } from '../cli-json.js';
import { runDoctor, type DoctorJson } from '../doctor.js';
import { findMitmRedirector } from '../setup-ios.js';

// ─── Fake machine ───

const ADB_VERSION = 'Android Debug Bridge version 1.0.41\nVersion 37.0.0-1\n';
const XCODE_VERSION = 'Xcode 26.0\nBuild version 17A324\n';
const SIMCTL_JSON = JSON.stringify({
  devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown' }] },
});

function withAdb(devices = 'List of devices attached\nemulator-5554\tdevice\n'): void {
  exec.table.set('adb --version', ADB_VERSION);
  exec.table.set('adb devices', devices);
}

function withXcode(): void {
  exec.table.set('xcodebuild -version', XCODE_VERSION);
  exec.table.set('xcrun simctl list devices available -j', SIMCTL_JSON);
}

let dir: string;
let home: string;
const savedCwd = process.cwd();
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const savedEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...savedPlatform, value: platform });
}

function writeConfig(body: string, name = 'tapsmith.config.mjs', where = dir): string {
  fs.mkdirSync(where, { recursive: true });
  const file = path.join(where, name);
  fs.writeFileSync(file, body);
  return file;
}

async function doctorJson(opts: { config?: string } = {}): Promise<{ code: number; json: DoctorJson }> {
  let out = '';
  const code = await runDoctor({ json: true, ...opts }, { stdout: (t) => { out += t; } });
  return { code, json: JSON.parse(out) as DoctorJson };
}

async function doctorText(opts: { config?: string } = {}): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  try {
    const code = await runDoctor({ json: false, ...opts });
    return { code, text: stripAnsi(lines.join('\n')) };
  } finally {
    spy.mockRestore();
  }
}

const ids = (json: DoctorJson): string[] => json.checks.map((c) => c.id);
const check = (json: DoctorJson, id: string) => json.checks.find((c) => c.id === id);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-doctor-report-')));
  home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  process.chdir(project);
  dir = project;
  process.env.HOME = home;
  delete process.env.ANDROID_HOME;
  delete process.env.ANDROID_SDK_ROOT;
  delete process.env.ANDROID_AVD_HOME;
  delete process.env.TAPSMITH_REDIRECTOR_APP;
  // The emulator lookup scans PATH itself: keep the host's emulator out of it.
  process.env.PATH = path.join(home, 'empty-bin');
  exec.table.clear();
  exec.calls.length = 0;
  exec.timeouts.clear();
  xctestrun.found = '/h/.tapsmith/ios-simulator-agent/x_iphonesimulator26.0.xctestrun';
  xctestrun.cache = undefined;
  rosetta.on = false;
  setPlatform('darwin');
});

afterEach(() => {
  process.chdir(savedCwd);
  Object.defineProperty(process, 'platform', savedPlatform);
  // Restore key by key: replacing process.env with a plain object would stop
  // later writes reaching the real environment (os.homedir() reads that).
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

// ─── Item 6: platform gating ───

describe('doctor platform gating (PILOT-263 item 6)', () => {
  it('an Android-only config on a Mac without Xcode passes and says why iOS was skipped', async () => {
    withAdb();
    writeConfig("export default { apk: 'app.apk' }\n");
    fs.writeFileSync(path.join(dir, 'app.apk'), '');
    const { code, json } = await doctorJson();
    expect(ids(json)).not.toContain('xcode');
    expect(ids(json)).not.toContain('simctl');
    expect(ids(json)).not.toContain('ios-sim-agent');
    expect(ids(json)).not.toContain('mitmproxy');
    expect(ids(json)).not.toContain('network-extension');
    expect(json.ok).toBe(true);
    expect(code).toBe(0);
    expect(exec.calls).not.toContain('xcodebuild -version');

    const { text } = await doctorText();
    expect(text).toMatch(/iOS\n\s+– skipped: the config targets Android only/);
  });

  it('an iOS-only config without adb skips Android, and says so', async () => {
    withXcode();
    writeConfig("export default { platform: 'ios', app: 'x.app' }\n");
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('adb');
    expect(ids(json)).not.toContain('android-agent');
    expect(ids(json)).toContain('xcode');
    const { text } = await doctorText();
    expect(text).toMatch(/Android\n\s+– skipped: the config targets iOS only/);
  });

  it('an Android-only config fails on a missing app APK', async () => {
    withAdb();
    writeConfig("export default { apk: 'missing.apk' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'app-apk')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('a config that targets Android fails when adb is missing', async () => {
    writeConfig('export default {}\n');
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('a config that targets iOS fails when Xcode is missing, and does not re-run the Xcode tools', async () => {
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail', fix: expect.stringContaining('Xcode') });
    expect(ids(json)).not.toContain('simctl');
    expect(code).toBe(1);
  });

  it('a config that targets only iOS fails on Linux: iOS needs macOS', async () => {
    setPlatform('linux');
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail', label: expect.stringContaining('macOS') });
    expect(code).toBe(1);
  });

  it('a mixed Android + iOS config on Linux warns about the iOS projects but passes (Android CI)', async () => {
    setPlatform('linux');
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn', label: expect.stringContaining('macOS'), fix: expect.stringContaining('--project') });
    expect(check(json, 'adb')).toMatchObject({ status: 'pass' });
    expect(code).toBe(0);
  });

  it('a mixed config on a Mac without Xcode warns that iOS was skipped, and still checks Android', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn', label: expect.stringContaining('iOS projects cannot run on this machine'), fix: expect.stringContaining('--project') });
    expect(ids(json)).toContain('android-devices');
    expect(code).toBe(0);
  });

  it('a mixed config without adb warns, and still checks its Android APK and AVD', async () => {
    withXcode();
    writeConfig("export default { apk: 'missing.apk', projects: [{ name: 'a', use: { avd: 'Pixel_9' } }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'warn', label: expect.stringContaining('Android projects cannot run on this machine'), fix: expect.stringContaining('--project') });
    expect(check(json, 'avd-images')).toMatchObject({ status: 'warn', label: expect.stringContaining('Pixel_9 not found') });
    // Still reported, but not an error: this machine may run only the iOS projects.
    expect(check(json, 'app-apk')).toMatchObject({ status: 'warn', label: expect.stringContaining('missing.apk') });
    expect(ids(json)).toContain('android-agent');
    expect(code).toBe(0);
  });

  it('a mixed config on a machine with both toolchains fails a missing APK and a failing simctl', async () => {
    withAdb();
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    writeConfig("export default { apk: 'missing.apk', projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'app-apk')).toMatchObject({ status: 'fail' });
    expect(check(json, 'simctl')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  // PILOT-709: pnpm 11+ skipped the agent package, and doctor said `npm install` regardless.
  describe('a missing Android agent package', () => {
    afterEach(() => {
      agentApks.app = '/n/@tapsmith/agent-android/app.apk';
      agentApks.test = '/n/@tapsmith/agent-android/test.apk';
    });

    it('says why, with the project\'s own install command', async () => {
      withAdb();
      agentApks.app = undefined;
      agentApks.test = undefined;
      fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      writeConfig("export default { platform: 'android' }\n");
      const { json } = await doctorJson();
      expect(check(json, 'android-agent')).toMatchObject({
        status: 'warn',
        label: expect.stringMatching(/^Android agent not found — @tapsmith\/agent-android, which ships the agent APKs, is not installed\. .*pnpm 11/),
        fix: 'pnpm add -D @tapsmith/agent-android',
      });
    });

    it('names the project\'s package manager for an incomplete install', async () => {
      withAdb();
      agentApks.test = undefined;
      fs.writeFileSync(path.join(dir, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
      writeConfig("export default { platform: 'android' }\n");
      const { json } = await doctorJson();
      expect(check(json, 'android-agent')).toMatchObject({
        status: 'warn',
        label: expect.stringContaining('one APK found but not both'),
        fix: 'yarn add -D @tapsmith/agent-android',
      });
    });
  });

  it('checks each Android project\'s own apk, not only the root one', async () => {
    withAdb();
    withXcode();
    fs.writeFileSync(path.join(dir, 'ok.apk'), '');
    writeConfig("export default { projects: [{ name: 'a', use: { platform: 'android', apk: 'missing.apk' } }, { name: 'b', use: { apk: 'ok.apk' } }, { name: 'i', use: { platform: 'ios', app: 'x.app' } }] }\n");
    const { code, json } = await doctorJson();
    // One row per id: a consumer matching on `app-apk` must read the failure.
    const rows = json.checks.filter((c) => c.id === 'app-apk');
    expect(rows).toEqual([expect.objectContaining({ status: 'fail', label: expect.stringContaining('missing.apk') })]);
    expect(rows[0]!.label).not.toContain('ok.apk');
    expect(code).toBe(1);

    fs.writeFileSync(path.join(dir, 'missing.apk'), '');
    const again = (await doctorJson()).json.checks.filter((c) => c.id === 'app-apk');
    expect(again).toEqual([expect.objectContaining({ status: 'pass', label: 'App APKs exist', detail: 'missing.apk, ok.apk' })]);
  });

  it('a mixed config on Linux without adb fails: none of its platforms can run', async () => {
    setPlatform('linux');
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'fail' });
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('a mixed config on a Mac with neither adb nor Xcode fails', async () => {
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({ status: 'fail' });
    expect(check(json, 'xcode')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  it('with no config, a failing simctl beside a working Xcode is a warning, not exit 1', async () => {
    withAdb();
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    const { code, json } = await doctorJson();
    expect(check(json, 'simctl')).toMatchObject({ status: 'warn', fix: expect.stringContaining('xcrun simctl list devices') });
    expect(code).toBe(0);
  });

  it('a config that targets iOS fails on a failing simctl', async () => {
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'simctl')).toMatchObject({ status: 'fail' });
    expect(code).toBe(1);
  });

  // PILOT-777: simctl exiting 0 said "iOS simulators available" with none listed.
  describe('the simulator count', () => {
    const SIMCTL_KEY = 'xcrun simctl list devices available -j';
    function withSimulators(devices: Record<string, unknown[]>): void {
      exec.table.set('xcodebuild -version', XCODE_VERSION);
      exec.table.set(SIMCTL_KEY, JSON.stringify({ devices }));
    }
    const NO_SIM_FIX = /Xcode → Settings → Components.*xcodebuild -downloadPlatform iOS/;

    it('passes with the number of iOS simulators', async () => {
      withSimulators({
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
          { name: 'iPhone 17', udid: 'A', state: 'Shutdown' },
          { name: 'iPhone 17 Pro', udid: 'B', state: 'Booted' },
        ],
      });
      const { json } = await doctorJson();
      expect(check(json, 'simctl')).toEqual({ id: 'simctl', status: 'pass', label: 'iOS simulators available', detail: '2 iOS simulators' });
    });

    it('with no config, none is a warning with the runtime install fix, not exit 1', async () => {
      withAdb();
      withSimulators({});
      const { code, json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'warn', label: 'No iOS simulators available', fix: expect.stringMatching(NO_SIM_FIX) });
      expect(code).toBe(0);
    });

    it('prints the warning and its fix in the text report', async () => {
      withAdb();
      withSimulators({});
      const { text } = await doctorText();
      expect(text).not.toContain('✓ iOS simulators available');
      expect(text).toContain('No iOS simulators available');
      expect(text).toMatch(NO_SIM_FIX);
    });

    it('does not count watchOS, tvOS or visionOS simulators, nor Tapsmith worker clones', async () => {
      withAdb();
      withSimulators({
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ name: 'Apple Watch Series 10', udid: 'W', state: 'Shutdown' }],
        'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [{ name: 'Apple TV', udid: 'T', state: 'Shutdown' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17 (Tapsmith Worker 1)', udid: 'C', state: 'Shutdown' }],
      });
      const { json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'warn', label: 'No iOS simulators available' });
    });

    it('fails when the config names a simulator to run on', async () => {
      withSimulators({ 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [] });
      writeConfig("export default { platform: 'ios', simulator: 'iPhone 17' }\n");
      const { code, json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'fail', label: 'No iOS simulators available', fix: expect.stringMatching(NO_SIM_FIX) });
      expect(code).toBe(1);
    });

    const MIXED = "export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios', simulator: 'iPhone 17' } }] }\n";

    it('only warns in a mixed config whose Android projects can run here, as for a missing Xcode', async () => {
      withAdb();
      withSimulators({});
      writeConfig(MIXED);
      const { code, json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({
        status: 'warn',
        label: expect.stringContaining('No iOS simulators available'),
        fix: expect.stringMatching(/xcodebuild -downloadPlatform iOS.*--project/),
      });
      expect(code).toBe(0);
    });

    it('fails in a mixed config when the Android projects cannot run here either', async () => {
      withSimulators({});
      writeConfig(MIXED);
      const { code, json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'fail', label: 'No iOS simulators available' });
      expect(code).toBe(1);
    });

    it('only warns for an iOS config that names no simulator, which may run on a physical device', async () => {
      withSimulators({});
      writeConfig("export default { platform: 'ios' }\n");
      const { json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'warn', label: 'No iOS simulators available' });
    });

    it('warns that it could not read the list, rather than claiming none, when simctl prints something unexpected', async () => {
      withAdb();
      exec.table.set('xcodebuild -version', XCODE_VERSION);
      exec.table.set(SIMCTL_KEY, 'not json');
      const { json } = await doctorJson();
      expect(check(json, 'simctl')).toMatchObject({ status: 'warn', label: expect.stringContaining('Could not read') });
    });
  });

  // The config's `simulator` is looked up as the runner looks it up: an exact
  // UDID, else an exact name, among the available simulators.
  describe('the configured simulator', () => {
    const SIMCTL_KEY = 'xcrun simctl list devices available -j';
    const IOS_26 = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
    const IOS_18 = 'com.apple.CoreSimulator.SimRuntime.iOS-18-5';
    function withSimulators(devices: Record<string, unknown[]>): void {
      exec.table.set('xcodebuild -version', XCODE_VERSION);
      exec.table.set(SIMCTL_KEY, JSON.stringify({ devices }));
    }
    const rows = (json: DoctorJson) => json.checks.filter((c) => c.id === 'simulator');
    const ios = (simulator: string, extra = '') => `export default { platform: 'ios', simulator: '${simulator}'${extra} }\n`;
    const STOCK = {
      [IOS_26]: [
        { name: 'iPhone 17', udid: 'AAAA-1111', state: 'Shutdown' },
        { name: 'iPhone 17 Pro', udid: 'BBBB-2222', state: 'Shutdown' },
        { name: 'iPhone 17 (Tapsmith Worker 1)', udid: 'CCCC-3333', state: 'Shutdown' },
      ],
    };

    it('passes when a simulator has that name', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 17'));
      const { code, json } = await doctorJson();
      expect(rows(json)).toEqual([{ id: 'simulator', status: 'pass', label: 'Simulator "iPhone 17" found', detail: 'iOS 26.0, AAAA-1111' }]);
      expect(code).toBe(0);
    });

    it('passes when a simulator has that UDID', async () => {
      withSimulators(STOCK);
      writeConfig(ios('BBBB-2222'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([{ id: 'simulator', status: 'pass', label: 'Simulator "BBBB-2222" found', detail: 'iPhone 17 Pro, iOS 26.0' }]);
    });

    it('fails a name no simulator has, listing the iOS simulators there are', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 71'));
      const { code, json } = await doctorJson();
      expect(rows(json)).toEqual([{
        id: 'simulator',
        status: 'fail',
        label: 'Simulator "iPhone 71" not found — tapsmith test cannot boot it',
        fix: 'Set simulator to the name or UDID of one of this Mac\'s iOS simulators: iPhone 17, iPhone 17 Pro — or create it in Xcode → Window → Devices and Simulators',
      }]);
      expect(code).toBe(1);
    });

    it('lists at most 12 simulators, saying how many more there are', async () => {
      withSimulators({ [IOS_26]: Array.from({ length: 15 }, (_, i) => ({ name: `iPad ${i + 1}`, udid: `PAD-${i}`, state: 'Shutdown' })) });
      writeConfig(ios('iPhone 71'));
      const { json } = await doctorJson();
      const fix = rows(json)[0]?.fix ?? '';
      expect(fix).toContain('iPad 12 and 3 more (xcrun simctl list devices available)');
      expect(fix).not.toContain('iPad 13');
    });

    it('prints the failure and its fix in the text report', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 71'));
      const { text } = await doctorText();
      expect(text).toContain('Simulator "iPhone 71" not found');
      expect(text).toContain('iPhone 17, iPhone 17 Pro');
    });

    it('matches case-sensitively, as the runner does, and suggests the name that differs only in case', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iphone 17 pro'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({ status: 'fail', fix: expect.stringMatching(/^Did you mean "iPhone 17 Pro"\? Simulator names and UDIDs match case-sensitively\. /) })]);
    });

    it('matches a UDID as typed, suggesting the one that differs only in case', async () => {
      withSimulators(STOCK);
      writeConfig(ios('aaaa-1111'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({ status: 'fail', fix: expect.stringMatching(/^Did you mean "AAAA-1111"\?/) })]);
    });

    it('warns when several simulators share the name, saying which one a run takes and how to pin one', async () => {
      withSimulators({
        [IOS_18]: [{ name: 'iPhone 16 Pro', udid: 'OLD-1', state: 'Shutdown' }],
        [IOS_26]: [{ name: 'iPhone 16 Pro', udid: 'NEW-2', state: 'Shutdown' }],
      });
      writeConfig(ios('iPhone 16 Pro'));
      const { code, json } = await doctorJson();
      expect(rows(json)).toEqual([{
        id: 'simulator',
        status: 'warn',
        label: '2 simulators are named "iPhone 16 Pro" (iOS 18.5, iOS 26.0)',
        fix: 'tapsmith test uses a booted one, else the first in xcrun simctl list devices -j (iOS 18.5, OLD-1), so a run may not get the iOS version you expect. '
          + 'To pin one, set simulator to its UDID: OLD-1 (iOS 18.5), NEW-2 (iOS 26.0)',
      }]);
      expect(code).toBe(0);
    });

    it('names the booted one of several, which is the one a run takes', async () => {
      withSimulators({
        [IOS_18]: [{ name: 'iPhone 16 Pro', udid: 'OLD-1', state: 'Shutdown' }],
        [IOS_26]: [{ name: 'iPhone 16 Pro', udid: 'NEW-2', state: 'Booted' }],
      });
      writeConfig(ios('iPhone 16 Pro'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({
        status: 'warn',
        fix: expect.stringMatching(/^tapsmith test uses the booted one \(iOS 26\.0, NEW-2\); with none booted, the first in xcrun simctl list devices -j \(iOS 18\.5, OLD-1\), /),
      })]);
    });

    it('says it once when the booted one is also the first listed, and sorts the iOS versions', async () => {
      withSimulators({
        'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [{ name: 'iPhone 17 Pro', udid: 'MID', state: 'Booted' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-10': [{ name: 'iPhone 17 Pro', udid: 'NEW', state: 'Shutdown' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ name: 'iPhone 17 Pro', udid: 'OLD', state: 'Shutdown' }],
      });
      writeConfig(ios('iPhone 17 Pro'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({
        label: '3 simulators are named "iPhone 17 Pro" (iOS 26.1, iOS 26.4, iOS 26.10)',
        fix: expect.stringMatching(/^tapsmith test uses the booted one \(iOS 26\.4, MID\), which is also the first in xcrun simctl list devices -j, so /),
      })]);
    });

    it('a UDID is never ambiguous', async () => {
      withSimulators({
        [IOS_18]: [{ name: 'iPhone 16 Pro', udid: 'OLD-1', state: 'Shutdown' }],
        [IOS_26]: [{ name: 'iPhone 16 Pro', udid: 'NEW-2', state: 'Shutdown' }],
      });
      writeConfig(ios('NEW-2'));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({ status: 'pass', detail: 'iPhone 16 Pro, iOS 26.0' })]);
    });

    it('checks every iOS project\'s simulator, one row each, naming the projects', async () => {
      withSimulators(STOCK);
      writeConfig(`export default { platform: 'ios', simulator: 'iPhone 17', projects: [
        { name: 'phone' },
        { name: 'phone-2' },
        { name: 'pro', use: { simulator: 'iPhone 17 Pro' } },
        { name: 'typo', use: { simulator: 'iPhone 71' } },
      ] }\n`);
      const { code, json } = await doctorJson();
      expect(rows(json)).toEqual([
        expect.objectContaining({ status: 'pass', label: 'Simulator "iPhone 17" found (projects phone, phone-2)' }),
        expect.objectContaining({ status: 'pass', label: 'Simulator "iPhone 17 Pro" found (project pro)' }),
        expect.objectContaining({ status: 'fail', label: 'Simulator "iPhone 71" (project typo) not found — tapsmith test cannot boot it' }),
      ]);
      expect(code).toBe(1);
    });

    it('in a mixed config whose Android projects can run here, a missing simulator only warns', async () => {
      withAdb();
      withSimulators(STOCK);
      writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios', simulator: 'iPhone 71' } }] }\n");
      const { code, json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({
        status: 'warn',
        label: 'Simulator "iPhone 71" (project i) not found — tapsmith test cannot boot it',
        fix: expect.stringMatching(/iPhone 17, iPhone 17 Pro.*Meanwhile, select the other projects with --project$/),
      })]);
      expect(code).toBe(0);
    });

    it('skips a scope whose every device is pinned: the run never looks the simulator up', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 71', ", device: 'AAAA-1111'"));
      expect(rows((await doctorJson()).json)).toEqual([]);
      writeConfig(ios('iPhone 71', ", devices: [{ name: 'a', device: 'AAAA-1111' }, { name: 'b', device: 'BBBB-2222' }]"));
      expect(rows((await doctorJson()).json)).toEqual([]);
    });

    it('checks a device group with an unpinned member, which is booted from the simulator', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 71', ", devices: [{ name: 'a', device: 'AAAA-1111' }, { name: 'b' }]"));
      const { json } = await doctorJson();
      expect(rows(json)).toEqual([expect.objectContaining({ status: 'fail' })]);
    });

    it('adds no row when simctl fails or lists no iOS simulator — the simctl row already says so', async () => {
      withSimulators({});
      writeConfig(ios('iPhone 17'));
      expect(rows((await doctorJson()).json)).toEqual([]);
      exec.table.delete(SIMCTL_KEY);
      expect(rows((await doctorJson()).json)).toEqual([]);
    });

    it('adds no row without Xcode or off a Mac', async () => {
      writeConfig(ios('iPhone 71'));
      expect(rows((await doctorJson()).json)).toEqual([]);
      withSimulators(STOCK);
      setPlatform('linux');
      expect(rows((await doctorJson()).json)).toEqual([]);
    });

    it('reads simctl once for the count, the simulator lookup and the inventory', async () => {
      withSimulators(STOCK);
      writeConfig(ios('iPhone 17'));
      await doctorJson();
      expect(exec.calls.filter((c) => c === SIMCTL_KEY)).toHaveLength(1);
    });
  });

  it('iOS-only fields without platform fail, as tapsmith test does', async () => {
    withXcode();
    writeConfig("export default { app: 'x.app', simulator: 'iPhone 16' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'config-platform')).toMatchObject({
      status: 'fail',
      label: expect.stringContaining('app, simulator'),
      fix: "Add platform: 'ios' to the config",
    });
    expect(code).toBe(1);
  });

  it('names the project that sets iOS-only fields without platform', async () => {
    withAdb();
    withXcode();
    writeConfig("export default { projects: [{ name: 'droid' }, { name: 'phone', use: { app: 'x.app' } }, { name: 'ok', use: { platform: 'ios', app: 'y.app' } }] }\n");
    const { json } = await doctorJson();
    const rows = json.checks.filter((c) => c.id === 'config-platform');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: expect.stringContaining('project phone sets app'), fix: "Add platform: 'ios' to project phone's use" });
  });

  it('blames an iOS-only field inherited from the root on the root, once', async () => {
    withAdb();
    withXcode();
    writeConfig("export default { app: 'x.app', projects: [{ name: 'a' }, { name: 'b' }] }\n");
    const { json } = await doctorJson();
    const rows = json.checks.filter((c) => c.id === 'config-platform');
    expect(rows).toEqual([expect.objectContaining({ label: expect.stringContaining('the config sets app'), fix: "Add platform: 'ios' to the config" })]);
    expect(rows[0]!.label).not.toMatch(/project a|project b/);
  });

  it('with no config, a missing adb is a warning that Android was skipped, not a silent skip', async () => {
    withXcode();
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('Android checks skipped'),
      fix: expect.stringContaining('platform-tools'),
    });
    expect(ids(json)).not.toContain('android-agent');
    expect(code).toBe(0);
  });

  it('with no config, a missing Xcode is a warning, never exit 1', async () => {
    withAdb();
    const { code, json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('iOS checks skipped'),
      fix: expect.stringContaining('Xcode'),
    });
    expect(ids(json)).not.toContain('simctl');
    expect(ids(json)).not.toContain('mitmproxy');
    expect(json.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(code).toBe(0);
  });

  // A machine that cannot run a single test must not pass (PILOT-558).
  it('with no config, a Mac with neither adb nor Xcode fails, and the summary says why', async () => {
    const { code, json } = await doctorJson();
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(check(json, 'no-platform')).toMatchObject({
      status: 'fail',
      label: expect.stringContaining('Neither Android nor iOS tests can run on this machine'),
      fix: expect.stringMatching(/Install Android Studio[\s\S]*Install Xcode/),
    });
    // The per-platform rows keep their install fixes: no SDK means install one.
    expect(check(json, 'adb')).toMatchObject({ status: 'warn', fix: expect.stringContaining('Install Android Studio') });
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn', fix: expect.stringContaining('xcode-select -s') });
    const { code: textCode, text } = await doctorText();
    expect(textCode).toBe(1);
    expect(text).toMatch(/checks? passed, \d+ warnings, 1 error — no platform can run tests on this machine/);
  });

  it('with no config, Linux without adb fails: iOS cannot run there either', async () => {
    setPlatform('linux');
    const { code, json } = await doctorJson();
    expect(code).toBe(1);
    expect(check(json, 'no-platform')).toMatchObject({
      status: 'fail',
      label: expect.stringContaining('Android tests cannot run on this machine, and iOS testing needs macOS'),
      fix: expect.stringContaining('Install Android Studio'),
    });
    expect(check(json, 'no-platform')?.fix).not.toContain('Xcode');
  });

  it('names the platform-tools directory when the SDK has adb but PATH does not', async () => {
    const sdk = path.join(home, 'Library', 'Android', 'sdk');
    fs.mkdirSync(path.join(sdk, 'platform-tools'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'platform-tools', 'adb'), '');
    withXcode();
    const { code, json } = await doctorJson();
    expect(check(json, 'adb')?.fix).toContain(`adb is in ${path.join(sdk, 'platform-tools')} but not on PATH`);
    expect(ids(json)).not.toContain('no-platform');
    expect(code).toBe(0);
  });

  it('with no config on Linux, iOS is skipped with a note', async () => {
    setPlatform('linux');
    withAdb();
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('xcode');
    const { text } = await doctorText();
    expect(text).toMatch(/iOS\n\s+– skipped: iOS testing needs macOS/);
  });

  it('judges the AVDs Android projects boot, not a root avd every project overrides', async () => {
    withAdb();
    writeConfig("export default { avd: 'Old', projects: [{ name: 'a', use: { avd: 'New' } }, { name: 'i', use: { platform: 'ios', avd: 'Ios_Scoped' } }] }\n");
    const { json } = await doctorJson();
    const avd = check(json, 'avd-images');
    expect(avd?.label).toContain('New');
    expect(avd?.label).not.toContain('Old');
    expect(avd?.label).not.toContain('Ios_Scoped');
  });

  it('reports every broken project in one config-load row', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a', use: { emulatorLaunchOptions: {} } }, { name: 'b', use: { emulatorLaunchOptions: {} } }] }\n");
    const { json } = await doctorJson();
    const rows = json.checks.filter((c) => c.id === 'config-load');
    expect(rows).toHaveLength(1);
    // Caught at load since PILOT-552, every problem listed in the one error.
    expect(rows[0]!.label).toMatch(/projects\[0\]\.use\.emulatorLaunchOptions[\s\S]*projects\[1\]\.use\.emulatorLaunchOptions/);
  });

  it('a malformed apk value is a config-load failure, not a crash', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a', use: { apk: 123 } }] }\n");
    const { json } = await doctorJson();
    // Refused at load since PILOT-552.
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail', label: expect.stringContaining('projects[0].use.apk must be a string (got 123)') });
  });

  it('a project option the per-project merge rejects is a config-load failure, not a crash', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a', use: { platform: 'android', emulatorLaunchOptions: { headless: true } } }] }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail', label: expect.stringContaining('projects[0].use.emulatorLaunchOptions') });
    expect(ids(json)).toContain('adb');
    expect(code).toBe(1);
  });

  it('a mixed config on a Mac without Xcode still gets the iOS capture checks', async () => {
    withAdb();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    expect(check(json, 'xcode')).toMatchObject({ status: 'warn' });
    expect(ids(json)).toContain('mitmproxy');
    expect(ids(json)).toContain('network-extension');
  });

  it('a config that cannot be loaded is judged like no config: by the tools found', async () => {
    withAdb();
    withXcode();
    writeConfig('export default {\n');
    const { json } = await doctorJson();
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail' });
    expect(ids(json)).toContain('adb');
    expect(ids(json)).toContain('xcode');
  });
});

// ─── Item 1: config discovery ───

describe('doctor config check (PILOT-263 item 1)', () => {
  it('recognises tapsmith.config.js', async () => {
    withAdb();
    writeConfig('export default {}\n', 'tapsmith.config.js');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    const { json } = await doctorJson();
    expect(check(json, 'config')).toEqual({ id: 'config', status: 'pass', label: 'Config file found', detail: 'tapsmith.config.js' });
  });

  it('follows -c from another directory', async () => {
    withAdb();
    const file = writeConfig('export default {}\n', 'ci.config.mjs', path.join(dir, 'configs'));
    const { json } = await doctorJson({ config: path.relative(dir, file) });
    expect(check(json, 'config')).toMatchObject({ status: 'pass', detail: path.join('configs', 'ci.config.mjs') });
  });

  it('a -c path that does not exist is reported once, by config-load', async () => {
    withAdb();
    const { json } = await doctorJson({ config: 'missing.config.ts' });
    expect(check(json, 'config-load')).toMatchObject({ status: 'fail' });
    expect(ids(json)).not.toContain('config');
  });

  it('a config that exists but fails to load is still found', async () => {
    withAdb();
    writeConfig('export default {\n');
    const { json } = await doctorJson();
    expect(check(json, 'config')).toMatchObject({ status: 'pass', detail: 'tapsmith.config.mjs' });
  });
});

// ─── Item 4: device states ───

describe('doctor Android devices (PILOT-263 item 4)', () => {
  beforeEach(() => { writeConfig('export default {}\n'); });

  it('an attached but unauthorized device is named, with the fix, not "no devices"', async () => {
    withAdb('List of devices attached\nR58N123\tunauthorized\n');
    const { json } = await doctorJson();
    const c = check(json, 'android-devices');
    expect(c).toMatchObject({ status: 'warn', detail: 'R58N123 (unauthorized)' });
    expect(c?.label).not.toMatch(/No Android devices connected/);
    expect(c?.fix).toMatch(/USB debugging prompt/);
    expect(json.inventory.connectedDevices).toEqual([{ serial: 'R58N123', state: 'unauthorized' }]);
  });

  it('an offline phone gets the reconnect fix', async () => {
    withAdb('List of devices attached\nR58N123\toffline\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({ status: 'warn', fix: expect.stringContaining('adb kill-server') });
  });

  it('a usable device with an unusable one beside it warns, with the unusable one\'s fix', async () => {
    withAdb('List of devices attached\nemulator-5554\tdevice\nR58N123\tunauthorized\n');
    const { code, json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({
      status: 'warn',
      label: '1 device connected, 1 not usable',
      detail: 'emulator-5554; not usable: R58N123 (unauthorized)',
      fix: expect.stringContaining('USB debugging prompt'),
    });
    expect(code).toBe(0);
  });

  it('only usable devices pass', async () => {
    withAdb('List of devices attached\nemulator-5554\tdevice\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toEqual({ id: 'android-devices', status: 'pass', label: '1 device connected', detail: 'emulator-5554' });
  });

  it('an offline emulator is told to wait for boot, and "no permissions" gets the udev fix', async () => {
    withAdb('List of devices attached\nemulator-5556\toffline\n0123ABC\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]\n');
    const { json } = await doctorJson();
    const fix = check(json, 'android-devices')?.fix ?? '';
    expect(fix).toMatch(/Wait for the emulator to finish booting/);
    expect(fix).not.toMatch(/Reconnect cable/);
    expect(fix).toMatch(/udev rule/);
  });

  it('nothing attached is still "No Android devices connected"', async () => {
    withAdb('List of devices attached\n\n');
    const { json } = await doctorJson();
    expect(check(json, 'android-devices')).toMatchObject({ status: 'warn', label: 'No Android devices connected' });
  });

  it('the inventory reuses the adb and simctl output the checks read', async () => {
    withAdb();
    withXcode();
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    expect(json.inventory.connectedDevices).toEqual([{ serial: 'emulator-5554', state: 'device' }]);
    expect(json.inventory.simulators).toEqual([{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26.0' }]);
    expect(exec.calls.filter((c) => c === 'adb devices')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'adb --version')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'xcrun simctl list devices available -j')).toHaveLength(1);
    expect(exec.calls.filter((c) => c === 'xcodebuild -version')).toHaveLength(1);
  });

  it('lists a skipped platform\'s devices in the inventory too, with a bounded command', async () => {
    withAdb();
    withXcode();
    writeConfig('export default {}\n');
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('simctl');
    expect(json.inventory.simulators).toEqual([{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown', runtime: 'iOS 26.0' }]);
    // A wedged CoreSimulator or adb server must not hang doctor.
    for (const key of ['xcrun simctl list devices available -j', 'adb devices', 'adb --version']) {
      expect(exec.timeouts.get(key), key).toBeGreaterThan(0);
    }
  });
});

// ─── Items 2, 3, minor: fixes that work ───

describe('doctor fixes (PILOT-263 items 2, 3)', () => {
  it('a missing MITM CA is not a warning and never points at an iOS command', async () => {
    withAdb();
    writeConfig('export default {}\n');
    const { json } = await doctorJson();
    const c = check(json, 'mitm-ca');
    expect(c?.status).toBe('pass');
    expect(JSON.stringify(c)).not.toMatch(/ios|setup/i);
  });

  it('a missing simulator agent is fixed without init, and names this machine\'s package', async () => {
    withXcode();
    xctestrun.found = undefined;
    writeConfig("export default { platform: 'ios' }\n");
    const { json } = await doctorJson();
    const c = check(json, 'ios-sim-agent');
    expect(c?.status).toBe('warn');
    expect(c?.fix).not.toMatch(/init/);
    expect(c?.fix).toContain(`@tapsmith/agent-ios-simulator-${process.arch}`);
    expect(c?.fix).toMatch(/first iOS simulator test run/);
  });

  // PILOT-485: a cache another Tapsmith version built is skipped, never run.
  it('says a stale auto-build cache will be rebuilt, and who built it', async () => {
    withXcode();
    xctestrun.found = undefined;
    xctestrun.cache = { xctestrun: '/h/.tapsmith/ios-simulator-agent/x_iphonesimulator26.0.xctestrun', builtBy: '0.7.0', stale: 'version' };
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'ios-sim-agent')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('out of date: the cached iOS simulator agent in ~/.tapsmith/ios-simulator-agent was built by Tapsmith 0.7.0'),
      fix: expect.stringContaining('next iOS simulator test run rebuilds it'),
    });
    expect(code).toBe(0);
  });

  it('names the version that built the cache in use, and a stale cache another build stands in for', async () => {
    withXcode();
    const cached = '/h/.tapsmith/ios-simulator-agent/x_iphonesimulator26.0.xctestrun';
    xctestrun.found = cached;
    xctestrun.cache = { xctestrun: cached, builtBy: '0.7.1' };
    writeConfig("export default { platform: 'ios' }\n");
    expect(check((await doctorJson()).json, 'ios-sim-agent')).toMatchObject({
      status: 'pass', detail: 'auto-build cache, SDK 26.0, built by Tapsmith 0.7.1',
    });

    xctestrun.found = '/n/@tapsmith/agent-ios-simulator-arm64/sdk-26.0/x_iphonesimulator26.0.xctestrun';
    xctestrun.cache = { xctestrun: cached, builtBy: '0.7.0', stale: 'version' };
    const row = check((await doctorJson()).json, 'ios-sim-agent');
    expect(row).toMatchObject({ status: 'pass', detail: expect.stringMatching(/^@tapsmith\/agent-ios-simulator, SDK 26\.0 \(not the auto-build cache: .*Tapsmith 0\.7\.0/) });
  });

  it('under Rosetta, warns about the x64 Node and does not suggest an npm install that cannot work', async () => {
    withXcode();
    rosetta.on = true;
    xctestrun.found = undefined;
    writeConfig("export default { platform: 'ios' }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'node-arch')).toMatchObject({
      status: 'warn',
      label: expect.stringContaining('running under Rosetta'),
      fix: expect.stringContaining('Install an arm64 Node'),
    });
    const agent = check(json, 'ios-sim-agent');
    expect(agent?.fix).not.toMatch(/npm install @tapsmith/);
    expect(agent?.fix).toMatch(/arm64 Node/);
    // A warning: tests still run, translated.
    expect(code).toBe(0);
  });

  it('a native Node gets no node-arch row', async () => {
    withXcode();
    writeConfig("export default { platform: 'ios' }\n");
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('node-arch');
  });

  // PILOT-560: `yarn tapsmith doctor` in a Plug'n'Play project, where `test` refuses.
  it("under Yarn Plug'n'Play, fails with the node-modules linker fix", async () => {
    withAdb();
    writeConfig("export default { platform: 'android' }\n");
    (process.versions as Record<string, string>).pnp = '3';
    try {
      const { code, json } = await doctorJson();
      expect(check(json, 'yarn-pnp')).toMatchObject({
        status: 'fail',
        label: expect.stringContaining("Plug'n'Play"),
        fix: expect.stringContaining('nodeLinker: node-modules'),
      });
      expect(code).toBe(1);
    } finally {
      delete (process.versions as Record<string, string>).pnp;
    }
  });

  it('a node_modules install gets no yarn-pnp row', async () => {
    withAdb();
    writeConfig("export default { platform: 'android' }\n");
    const { json } = await doctorJson();
    expect(ids(json)).not.toContain('yarn-pnp');
  });

  it('finds the mitmproxy redirector the way the daemon does, without Homebrew', async () => {
    withXcode();
    writeConfig("export default { platform: 'ios' }\n");
    const app = path.join(home, 'Redirector');
    fs.writeFileSync(app, '');
    process.env.TAPSMITH_REDIRECTOR_APP = app;
    const { json } = await doctorJson();
    expect(check(json, 'mitmproxy')).toMatchObject({ status: 'pass', detail: 'TAPSMITH_REDIRECTOR_APP' });
  });
});

describe('findMitmRedirector()', () => {
  const bin = path.join('Mitmproxy Redirector.app', 'Contents', 'MacOS', 'Mitmproxy Redirector');
  const tar = path.join('mitmproxy.app', 'Contents', 'Resources', 'mitmproxy_macos', 'Mitmproxy Redirector.app.tar');
  const caskTar = path.join('/opt/homebrew/Caskroom/mitmproxy', '11.0.2', tar);
  const find = (present: string[], env: NodeJS.ProcessEnv = {}, caskVersions: string[] = []) =>
    findMitmRedirector(env, '/h', (p) => present.includes(p), (dir) => (dir === '/opt/homebrew/Caskroom/mitmproxy' ? caskVersions : []));

  it('checks the daemon\'s locations in the daemon\'s order', () => {
    expect(find(['/x', caskTar], { TAPSMITH_REDIRECTOR_APP: '/x' }, ['11.0.2'])).toBe('TAPSMITH_REDIRECTOR_APP');
    expect(find([path.join('/Applications', bin), caskTar], { TAPSMITH_REDIRECTOR_APP: '/gone' }, ['11.0.2'])).toBe('/Applications');
    expect(find([path.join('/h', '.tapsmith', 'redirector', bin), caskTar], {}, ['11.0.2'])).toBe('~/.tapsmith/redirector');
    expect(find([caskTar], {}, ['11.0.2'])).toBe('Homebrew cask');
    expect(find([])).toBeUndefined();
  });

  it('does not count a Homebrew install without the cask\'s redirector tarball', () => {
    // A cask whose layout changed has no tarball where the daemon looks, so it cannot extract one.
    expect(find([], {}, ['11.0.2'])).toBeUndefined();
  });
});

// ─── PILOT-417: the emulator binary ───

describe('doctor android-emulator check (PILOT-417)', () => {
  function sdkWithEmulator(): string {
    const sdk = path.join(home, 'sdk');
    fs.mkdirSync(path.join(sdk, 'emulator'), { recursive: true });
    fs.writeFileSync(path.join(sdk, 'emulator', 'emulator'), '');
    return sdk;
  }

  it('passes with the binary it found under ANDROID_HOME', async () => {
    withAdb();
    process.env.ANDROID_HOME = sdkWithEmulator();
    writeConfig("export default { avd: 'Pixel_9' }\n");
    const { json } = await doctorJson();
    expect(check(json, 'android-emulator')).toEqual({
      id: 'android-emulator', status: 'pass', label: 'Android emulator found',
      detail: path.join(home, 'sdk', 'emulator', 'emulator'),
    });
  });

  it('fails when an AVD is to be launched and no emulator binary exists, naming every path tried', async () => {
    withAdb();
    process.env.ANDROID_HOME = path.join(home, 'no-sdk');
    writeConfig("export default { avd: 'Pixel_9' }\n");
    const { code, json } = await doctorJson();
    const c = check(json, 'android-emulator');
    expect(c).toMatchObject({ status: 'fail', label: expect.stringContaining('Pixel_9') });
    expect(c?.detail).toContain(path.join(home, 'no-sdk', 'emulator', 'emulator'));
    expect(c?.detail).toContain(path.join(home, 'Library', 'Android', 'sdk', 'emulator', 'emulator'));
    expect(c?.detail).toContain('on PATH');
    expect(c?.fix).toMatch(/Android Emulator/);
    expect(c?.fix).toMatch(/ANDROID_HOME/);
    expect(code).toBe(1);

    const { text } = await doctorText();
    expect(text).toMatch(/✗ Android emulator not found[^\n]*\(tried: /);
  });

  it('only warns when Tapsmith will not launch emulators (launchEmulators: false)', async () => {
    withAdb();
    writeConfig("export default { avd: 'Pixel_9', launchEmulators: false }\n");
    const { code, json } = await doctorJson();
    expect(check(json, 'android-emulator')).toMatchObject({ status: 'warn', label: expect.stringContaining('launchEmulators') });
    expect(code).toBe(0);
  });

  it('checks an AVD set on a project, and finds the emulator on PATH', async () => {
    withAdb();
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'emulator'), '');
    process.env.PATH = bin;
    writeConfig("export default { projects: [{ name: 'a', use: { avd: 'Pixel_9' } }] }\n");
    const { json } = await doctorJson();
    expect(check(json, 'android-emulator')).toMatchObject({ status: 'pass', detail: 'emulator (on PATH)' });
  });

  it('is not run without an AVD, nor for iOS-only configs', async () => {
    withAdb();
    withXcode();
    writeConfig('export default {}\n');
    expect(ids((await doctorJson()).json)).not.toContain('android-emulator');
    // A fresh directory: the native import() cache would otherwise hand back the first config.
    const iosDir = path.join(dir, 'ios-project');
    writeConfig("export default { platform: 'ios', avd: 'Pixel_9', projects: [{ name: 'i' }] }\n", 'tapsmith.config.mjs', iosDir);
    process.chdir(iosDir);
    const { json } = await doctorJson();
    expect(ids(json)).toContain('xcode');
    expect(ids(json)).not.toContain('adb');
    expect(ids(json)).not.toContain('android-emulator');
  });

  it('only warns in a mixed config on a machine that can run just the iOS projects', async () => {
    withXcode();
    writeConfig("export default { projects: [{ name: 'a', use: { avd: 'Pixel_9' } }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    expect(check(json, 'android-emulator')).toMatchObject({ status: 'warn' });
  });
});

// ─── iOS app under test (PILOT-918) ───

describe('doctor ios-app check (PILOT-918)', () => {
  const STOCK_SIMS = JSON.stringify({
    devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [{ name: 'iPhone 17', udid: 'SIM-1', state: 'Shutdown' }] },
  });
  const PHONE = '00008140-00096C9014F3001C';
  const SIM_UDID = '1B2C3D4E-0000-4000-8000-123456789ABC';

  function withMac(): void {
    exec.table.set('xcodebuild -version', XCODE_VERSION);
    exec.table.set('xcrun simctl list devices available -j', STOCK_SIMS);
  }

  /** A built .app at `rel` (under the project) whose Info.plist plutil reads as given. */
  function appBundle(rel: string, info: { id?: string; platforms?: string[] } = {}): string {
    const app = path.join(dir, rel);
    fs.mkdirSync(app, { recursive: true });
    const plist = path.join(app, 'Info.plist');
    fs.writeFileSync(plist, '<plist/>');
    if (info.id !== undefined) exec.table.set(`plutil -extract CFBundleIdentifier raw -o - ${plist}`, `${info.id}\n`);
    if (info.platforms !== undefined) exec.table.set(`plutil -extract CFBundleSupportedPlatforms json -o - ${plist}`, `${JSON.stringify(info.platforms)}\n`);
    return app;
  }
  const simApp = (rel = 'build/My.app', id = 'com.example.my') => appBundle(rel, { id, platforms: ['iPhoneSimulator'] });
  const deviceApp = (rel = 'build/My-Device.app', id = 'com.example.my') => appBundle(rel, { id, platforms: ['iPhoneOS'] });
  const iosConfig = (fields: string) => `export default { platform: 'ios', simulator: 'iPhone 17', ${fields} }\n`;
  const rows = (json: DoctorJson) => json.checks.filter((c) => c.id === 'ios-app');

  it('passes a simulator build whose bundle id is the package', async () => {
    withMac();
    simApp();
    writeConfig(iosConfig("app: 'build/My.app', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([{ id: 'ios-app', status: 'pass', label: 'iOS app found', detail: 'My.app (com.example.my, simulator build)' }]);
    expect(code).toBe(0);
  });

  it('fails an app path that does not exist (the ticket\'s second config)', async () => {
    withMac();
    writeConfig(iosConfig("app: './does/not/exist.app', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({
      status: 'fail',
      label: `iOS app not found at ${path.join(dir, 'does/not/exist.app')}`,
      fix: expect.stringContaining('fix the app path'),
    })]);
    expect(code).toBe(1);

    const { text } = await doctorText();
    expect(text).toMatch(/✗ iOS app not found at [^\n]*exist\.app\n\s+↳ /);
  });

  it('resolves a relative app against the config\'s rootDir', async () => {
    withMac();
    simApp('sub/build/My.app');
    writeConfig(iosConfig("rootDir: 'sub', app: 'build/My.app', package: 'com.example.my'"));
    const { json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({ status: 'pass' })]);
  });

  it('fails a path that is not an .app bundle', async () => {
    withMac();
    fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'build/My.ipa'), 'zip');
    writeConfig(iosConfig("app: 'build/My.ipa', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({
      status: 'fail',
      label: expect.stringContaining('is not an .app bundle'),
    })]);
    expect(code).toBe(1);
  });

  it('fails a directory without an Info.plist', async () => {
    withMac();
    fs.mkdirSync(path.join(dir, 'build/Empty.app'), { recursive: true });
    writeConfig(iosConfig("app: 'build/Empty.app', package: 'com.example.my'"));
    const { json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({ status: 'fail', label: expect.stringContaining('no Info.plist') })]);
  });

  it('warns, without failing, when the Info.plist cannot be read', async () => {
    withMac();
    appBundle('build/My.app');
    writeConfig(iosConfig("app: 'build/My.app', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({ status: 'warn', label: expect.stringContaining('Could not read') })]);
    expect(code).toBe(0);
  });

  it('fails a device (iphoneos) build on a simulator', async () => {
    withMac();
    deviceApp('build/My.app');
    writeConfig(iosConfig("app: 'build/My.app', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({
      status: 'fail',
      label: expect.stringContaining('My.app is a device (iphoneos) build, but it runs on an iOS simulator'),
      fix: expect.stringContaining('iphonesimulator'),
    })]);
    expect(code).toBe(1);
  });

  it('fails a simulator build on a physical device: pinned, or auto-detected when no simulator is set', async () => {
    withMac();
    simApp();
    writeConfig(`export default { platform: 'ios', device: '${PHONE}', app: 'build/My.app', package: 'com.example.my' }\n`);
    const pinned = await doctorJson();
    expect(rows(pinned.json)).toEqual([expect.objectContaining({
      status: 'fail',
      label: expect.stringContaining('My.app is a simulator build, but it runs on a physical iOS device'),
      fix: expect.stringContaining('iphoneos'),
    })]);
    expect(pinned.code).toBe(1);

    writeConfig("export default { platform: 'ios', app: 'build/My.app', package: 'com.example.my' }\n");
    expect(rows((await doctorJson()).json)).toEqual([expect.objectContaining({ status: 'fail' })]);
  });

  it('passes a device build on a physical device, and a simulator build pinned to a simulator UDID', async () => {
    withMac();
    deviceApp();
    simApp();
    writeConfig(`export default { projects: [
      { name: 'phone', use: { platform: 'ios', device: '${PHONE}', app: 'build/My-Device.app', package: 'com.example.my' } },
      { name: 'sim', use: { platform: 'ios', device: '${SIM_UDID}', app: 'build/My.app', package: 'com.example.my' } },
    ] }\n`);
    const { json } = await doctorJson();
    expect(rows(json)).toEqual([{
      id: 'ios-app',
      status: 'pass',
      label: 'iOS apps found',
      detail: 'My-Device.app (com.example.my, device build), My.app (com.example.my, simulator build)',
    }]);
  });

  it('does not judge the build\'s platform when its Info.plist does not list one', async () => {
    withMac();
    appBundle('build/My.app', { id: 'com.example.my' });
    writeConfig(iosConfig("app: 'build/My.app', package: 'com.example.my'"));
    const { json } = await doctorJson();
    expect(rows(json)).toEqual([{ id: 'ios-app', status: 'pass', label: 'iOS app found', detail: 'My.app (com.example.my)' }]);
  });

  it('fails a bundle id that is not the package, naming both', async () => {
    withMac();
    simApp('build/My.app', 'com.example.other');
    writeConfig(iosConfig("app: 'build/My.app', package: 'com.example.my'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({
      status: 'fail',
      label: 'My.app\'s bundle identifier is com.example.other, but package is com.example.my — Tapsmith would install one app and launch another',
      fix: expect.stringContaining("package: 'com.example.other'"),
    })]);
    expect(code).toBe(1);
  });

  it('warns about an unset package, suggesting the id the build carries', async () => {
    withMac();
    simApp();
    writeConfig(iosConfig("app: 'build/My.app'"));
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({
      status: 'warn',
      label: expect.stringContaining('No package (bundle identifier) set — Tapsmith never launches the app'),
      fix: expect.stringContaining("package: 'com.example.my'"),
    })]);
    expect(code).toBe(0);
  });

  it('warns about the init placeholders: no app and no package (the ticket\'s first config)', async () => {
    withMac();
    writeConfig(iosConfig(''));
    const { code, json } = await doctorJson();
    const row = rows(json)[0];
    expect(rows(json)).toHaveLength(1);
    expect(row).toMatchObject({ status: 'warn' });
    expect(row?.label).toContain('No app set — Tapsmith does not install the app');
    expect(row?.label).toContain('No package (bundle identifier) set');
    expect(code).toBe(0);

    const { text } = await doctorText();
    expect(text).toMatch(/⚠ No app set[^\n]*\n\s+↳ /);
  });

  it('judges each iOS project once, naming the projects in one row', async () => {
    withMac();
    simApp('build/My.app', 'com.example.my');
    writeConfig(`export default { projects: [
      { name: 'a', use: { platform: 'ios', simulator: 'iPhone 17', app: 'build/My.app', package: 'com.example.my' } },
      { name: 'b', use: { platform: 'ios', simulator: 'iPhone 17', app: 'build/My.app', package: 'com.example.b' } },
      { name: 'c', use: { platform: 'ios', simulator: 'iPhone 17', app: 'build/Gone.app', package: 'com.example.my' } },
    ] }\n`);
    const { code, json } = await doctorJson();
    const row = rows(json);
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ status: 'fail' });
    expect(row[0]!.label).toContain('(project b)');
    expect(row[0]!.label).toContain('(project c)');
    expect(row[0]!.label).not.toContain('(project a)');
    expect(code).toBe(1);
  });

  it('only warns in a mixed config whose Android projects can run here when Xcode is missing', async () => {
    withAdb();
    writeConfig("export default { apk: 'a.apk', projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios', simulator: 'iPhone 17', app: 'gone.app', package: 'com.x' } }] }\n");
    fs.writeFileSync(path.join(dir, 'a.apk'), '');
    const { code, json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({ status: 'warn', label: expect.stringContaining('iOS app not found') })]);
    expect(code).toBe(0);
  });

  it('still fails a missing app in an iOS-only config without Xcode', async () => {
    writeConfig(iosConfig("app: 'gone.app', package: 'com.x'"));
    const { json } = await doctorJson();
    expect(rows(json)).toEqual([expect.objectContaining({ status: 'fail' })]);
  });

  it('has no row for an Android-only config or without a config file', async () => {
    withAdb();
    withMac();
    expect(rows((await doctorJson()).json)).toEqual([]);
    writeConfig("export default { apk: 'a.apk' }\n");
    expect(rows((await doctorJson()).json)).toEqual([]);
  });
});

// ─── Item 5: human output ───

describe('doctor text output (PILOT-263 item 5)', () => {
  it('prints the fix line under an error', async () => {
    writeConfig("export default { platform: 'ios' }\n");
    const { text } = await doctorText();
    expect(text).toMatch(/✗ Xcode not installed[^\n]*\n\s+↳ Install Xcode/);
  });

  it('prints every JSON fix in the text output', async () => {
    withAdb('List of devices attached\nR58N123\tunauthorized\n');
    writeConfig("export default { projects: [{ name: 'a' }, { name: 'i', use: { platform: 'ios' } }] }\n");
    const { json } = await doctorJson();
    const { text } = await doctorText();
    const fixes = json.checks.filter((c) => c.fix).map((c) => c.fix!);
    expect(fixes.length).toBeGreaterThan(2);
    for (const fix of fixes) expect(text).toContain(`↳ ${fix.split('\n')[0]}`);
  });
});
