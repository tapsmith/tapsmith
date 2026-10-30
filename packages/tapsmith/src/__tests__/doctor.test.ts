import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assessSystemProxy,
  buildDoctorJson,
  androidSdkVariable,
  checkLine,
  configAndroidApks,
  configPlatformTargets,
  planPlatform,
  runDoctor,
  configLoadFailure,
  parseNetworksetupProxy,
  summarizeAvdImages,
  countSpringBoardTeardownCrashes,
  summarizeSpringBoardCrashes,
  SPRINGBOARD_CRASH_WINDOW_DAYS,
  type CheckEntry,
  type ServiceProxySetting,
} from '../doctor.js';
import { stripAnsi } from '../cli-json.js';
import { TapsmithNotInstalledError } from '../config.js';
import type { AvdImageInfo } from '../avd-images.js';

describe('buildDoctorJson()', () => {
  const checks: CheckEntry[] = [
    { id: 'node', status: 'pass', label: 'Node.js 22.1.0' },
    { id: 'adb', status: 'fail', label: 'ADB not found on PATH', fix: 'Install Android platform-tools and ensure adb is on PATH' },
    { id: 'android-home', status: 'warn', label: 'ANDROID_HOME not set', fix: 'Set ANDROID_HOME to your Android SDK location' },
  ];
  const inventory = {
    avds: ['Pixel_7'],
    simulators: [{ name: 'iPhone 16', udid: 'ABC', state: 'Shutdown', runtime: 'iOS 18.2' }],
    connectedDevices: [{ serial: 'emulator-5554', state: 'device' }],
  };

  it('sets ok=false when any check fails', () => {
    const json = buildDoctorJson(checks, inventory);
    expect(json.ok).toBe(false);
    expect(json.checks).toHaveLength(3);
    expect(json.inventory.avds).toEqual(['Pixel_7']);
  });

  it('sets ok=true when only warnings remain', () => {
    const json = buildDoctorJson(checks.filter((c) => c.status !== 'fail'), inventory);
    expect(json.ok).toBe(true);
  });

  it('preserves fix strings on non-pass checks', () => {
    const json = buildDoctorJson(checks, inventory);
    expect(json.checks.find((c) => c.id === 'adb')?.fix).toContain('platform-tools');
  });

  it('strips ANSI formatting from machine-readable check fields', () => {
    const json = buildDoctorJson([{
      id: 'daemon',
      status: 'pass',
      label: 'Tapsmith daemon found \x1b[2m(/tmp/bin)\x1b[0m',
      detail: '\x1b[31mdetail\x1b[0m',
      fix: '\x1b[33mfix\x1b[0m',
    }], inventory);

    expect(json.checks[0]).toMatchObject({
      label: 'Tapsmith daemon found (/tmp/bin)',
      detail: 'detail',
      fix: 'fix',
    });
  });
});

/** A check as the text output prints it: the label, then the detail in parentheses. */
const shown = (c: { label: string; detail?: string }): string => stripAnsi(c.detail ? `${c.label} (${c.detail})` : c.label);

describe('doctor --json schema (PILOT-270)', () => {
  // A public contract (docs/api-reference.md, CLI → JSON output): a change here
  // must be deliberate.
  it('has exactly ok, checks and inventory, with the documented check and inventory keys', () => {
    const json = buildDoctorJson([
      { id: 'daemon', status: 'pass', label: 'Tapsmith daemon found', detail: '/tmp/bin' },
      { id: 'adb', status: 'fail', label: 'ADB not found on PATH', fix: 'Install Android platform-tools' },
    ], {
      avds: ['Pixel_7'],
      simulators: [{ name: 'iPhone 16', udid: 'ABC', state: 'Shutdown', runtime: 'iOS 18.2' }],
      connectedDevices: [{ serial: 'emulator-5554', state: 'device' }],
    });
    expect(Object.keys(json)).toEqual(['ok', 'checks', 'inventory']);
    expect(Object.keys(json.checks[0]!)).toEqual(['id', 'status', 'label', 'detail']);
    expect(Object.keys(json.checks[1]!)).toEqual(['id', 'status', 'label', 'fix']);
    expect(Object.keys(json.inventory)).toEqual(['avds', 'simulators', 'connectedDevices']);
    expect(Object.keys(json.inventory.simulators[0]!)).toEqual(['name', 'udid', 'state', 'runtime']);
    expect(Object.keys(json.inventory.connectedDevices[0]!)).toEqual(['serial', 'state']);
  });
});

describe('androidSdkVariable()', () => {
  it('names the variable it read: ANDROID_HOME first, then ANDROID_SDK_ROOT', () => {
    expect(androidSdkVariable({ ANDROID_HOME: '/a', ANDROID_SDK_ROOT: '/b' })).toEqual({ name: 'ANDROID_HOME', path: '/a' });
    expect(androidSdkVariable({ ANDROID_SDK_ROOT: '/b' })).toEqual({ name: 'ANDROID_SDK_ROOT', path: '/b' });
    expect(androidSdkVariable({})).toBeUndefined();
  });
});

describe('checkLine()', () => {
  it('prints the detail dimmed in parentheses after the label, as doctor always has', () => {
    expect(checkLine('Tapsmith daemon found', '/usr/local/bin/tapsmith-core')).toBe('Tapsmith daemon found \x1b[2m(/usr/local/bin/tapsmith-core)\x1b[0m');
    expect(checkLine('Node.js 22.1.0', undefined)).toBe('Node.js 22.1.0');
  });
});

describe('runDoctor()', () => {
  const report = { ok: true, checks: [{ id: 'node', status: 'pass' as const, label: 'Node.js 22.1.0' }], inventory: { avds: [], simulators: [], connectedDevices: [] } };

  it('--json prints the report and exits 0 when nothing fails', async () => {
    let out = '';
    const code = await runDoctor({ json: true }, { report: async () => report, stdout: (t) => { out += t; } });
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(report);
  });

  it('--json exits 1 with the report (not an error envelope) when a check fails', async () => {
    let out = '';
    const failing = { ...report, ok: false, checks: [{ id: 'adb', status: 'fail' as const, label: 'ADB not found on PATH' }] };
    const code = await runDoctor({ json: true }, { report: async () => failing, stdout: (t) => { out += t; } });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual(failing);
  });

  it('--json reports doctor itself breaking as the shared error envelope instead of an empty stdout', async () => {
    let out = '';
    const code = await runDoctor({ json: true }, { report: async () => { throw new Error('boom'); }, stdout: (t) => { out += t; } });
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual({
      error: { code: 'UNEXPECTED_ERROR', message: 'doctor could not finish: boom', fix: expect.stringContaining('without --json') },
    });
  });

  it('text mode lets the error reach the CLI\'s fatal-error handler', async () => {
    await expect(runDoctor({ json: false }, { report: async () => { throw new Error('boom'); } })).rejects.toThrow('boom');
  });
});

describe('runDoctor() --json with the real checks', () => {
  it('splits label and detail at the call sites and leaves no undefined keys', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-doctor-json-')));
    const cwd = process.cwd();
    let out = '';
    try {
      fs.writeFileSync(path.join(dir, 'tapsmith.config.mjs'), 'export default {}\n');
      process.chdir(dir);
      await runDoctor({ json: true }, { stdout: (t) => { out += t; } });
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const json = JSON.parse(out) as { checks: Array<Record<string, unknown>> };
    expect(json.checks.find((c) => c.id === 'config')).toEqual({
      id: 'config', status: 'pass', label: 'Config file found', detail: 'tapsmith.config.mjs',
    });
    for (const check of json.checks) {
      // The documented key order, from the real call sites.
      expect(Object.keys(check).slice(0, 3), JSON.stringify(check)).toEqual(['id', 'status', 'label']);
      expect(Object.keys(check).every((k) => ['id', 'status', 'label', 'detail', 'fix'].includes(k)), JSON.stringify(check)).toBe(true);
      expect(Object.values(check).every((v) => typeof v === 'string' && v.length > 0 && !v.includes('\x1b')), JSON.stringify(check)).toBe(true);
      // formatJson strips ANSI, so a call site that put a dimmed "(detail)"
      // back into its label would still pass the check above: look for it.
      // Only the checks whose parenthetical moved to detail: other labels can
      // hold host names with parentheses (a network service "Ethernet (en4)").
      const split = ['daemon', 'config', 'android-home', 'android-devices', 'android-agent', 'app-apk', 'ios-sim-agent', 'mitm-ca', 'avd-images'];
      if (check.status === 'pass' && split.includes(check.id as string)) expect(check.label, JSON.stringify(check)).not.toMatch(/\(/);
    }
  }, 120_000);
});

describe('summarizeAvdImages()', () => {
  const goodAvd: AvdImageInfo = { name: 'Tapsmith_Phone_API_36', tagId: 'google_apis', apiLevel: 36 };
  const playAvd: AvdImageInfo = { name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 };
  const brokenAvd: AvdImageInfo = { name: 'Broken', tagId: undefined };

  it('returns undefined when there are no AVDs and none configured', () => {
    expect(summarizeAvdImages([])).toBeUndefined();
  });

  it('still reports a configured AVD as missing when the machine has no AVDs at all', () => {
    const summary = summarizeAvdImages([], 'X');
    expect(summary?.status).toBe('warn');
    expect(summary?.label).toContain('X not found');
  });

  describe('with a configured AVD', () => {
    it('passes when the configured AVD is capture-capable, mentioning other Play AVDs as context', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd], 'Tapsmith_Phone_API_36');
      expect(summary?.status).toBe('pass');
      expect(shown(summary!)).toContain('Tapsmith_Phone_API_36 supports HTTPS capture');
      expect(shown(summary!)).toContain('Medium_Phone_API_36');
      // The variable context is the detail, not part of the label.
      expect(summary!.label).toBe('Configured AVD Tapsmith_Phone_API_36 supports HTTPS capture');
      expect(summary!.detail).toContain('Medium_Phone_API_36');
    });

    it('passes without context when no Play AVDs exist', () => {
      const summary = summarizeAvdImages([goodAvd], 'Tapsmith_Phone_API_36');
      expect(summary?.status).toBe('pass');
      expect(shown(summary!)).not.toContain('other AVD');
    });

    it('warns when the configured AVD uses a Play image, pointing at a capture-capable AVD that already exists', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd], 'Medium_Phone_API_36');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Medium_Phone_API_36 uses a Google Play system image');
      // PILOT-711: what happens to the app's HTTPS, not just "not captured".
      expect(summary?.label).toContain("the app's HTTPS requests still reach their servers, but they are not captured");
      expect(summary?.fix).toBe("Use Tapsmith_Phone_API_36, which supports HTTPS capture: set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config in place of 'Medium_Phone_API_36'");
    });

    it('suggests creating a NEW AVD, never --force over the configured one, when none is capture-capable (PILOT-404)', () => {
      const summary = summarizeAvdImages([playAvd], 'Medium_Phone_API_36');
      expect(summary?.status).toBe('warn');
      expect(summary?.fix).toBe(
        "Create a capture-capable AVD (your existing AVDs are left untouched) — run: npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config in place of 'Medium_Phone_API_36'",
      );
    });

    it('keeps the replacement on the Play AVD\'s API level', () => {
      const play34: AvdImageInfo = { name: 'Pixel_API_34', tagId: 'google_apis_playstore', apiLevel: 34 };
      const summary = summarizeAvdImages([play34], 'Pixel_API_34');
      expect(summary?.fix).toContain('run: npx tapsmith create-avd --api 34, then set avd: \'Tapsmith_Phone_API_34\'');
    });

    it('prefers a capture-capable AVD on the same API level', () => {
      const good34: AvdImageInfo = { name: 'Good_34', tagId: 'google_apis', apiLevel: 34 };
      const play34: AvdImageInfo = { name: 'Play_34', tagId: 'google_apis_playstore', apiLevel: 34 };
      const summary = summarizeAvdImages([goodAvd, good34, play34], 'Play_34');
      expect(summary?.fix).toContain("set avd: 'Good_34'");
    });

    it('warns when the configured AVD does not exist', () => {
      const summary = summarizeAvdImages([goodAvd], 'Missing_AVD');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Missing_AVD not found');
      expect(summary?.fix).toContain('--name Missing_AVD');
    });

    it('warns when the configured AVD tag is unreadable, without recreating it', () => {
      const summary = summarizeAvdImages([brokenAvd], 'Broken');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Could not read');
      expect(summary?.fix).toContain('run: npx tapsmith create-avd,');
      expect(summary?.fix).not.toContain('--name Broken');
    });

    it('handles multiple configured AVDs (e.g. per-project use.avd), reporting every issue', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd], ['Tapsmith_Phone_API_36', 'Medium_Phone_API_36', 'Gone']);
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Gone not found');
      expect(summary?.label).toContain('Medium_Phone_API_36 uses a Google Play system image');
      expect(summary?.label).not.toContain('Tapsmith_Phone_API_36 uses');
      expect(summary?.fix).toBe("Run: npx tapsmith create-avd --name Gone; Use Tapsmith_Phone_API_36, which supports HTTPS capture: set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config in place of 'Medium_Phone_API_36'");
    });

    it('names every bad configured AVD the fix replaces (per-project use.avd)', () => {
      const play2: AvdImageInfo = { name: 'Other_Play', tagId: 'google_apis_playstore', apiLevel: 36 };
      const summary = summarizeAvdImages([goodAvd, playAvd, play2], ['Medium_Phone_API_36', 'Other_Play']);
      expect(summary?.fix).toContain("set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config in place of 'Medium_Phone_API_36', 'Other_Play'");
    });

    it('never suggests creating the same name as a missing configured AVD', () => {
      // Tapsmith_Phone_API_36 is configured but missing, so `create-avd --name Tapsmith_Phone_API_36`
      // is already suggested; the replacement for the Play AVD needs a different name.
      const summary = summarizeAvdImages([playAvd], ['Tapsmith_Phone_API_36', 'Medium_Phone_API_36']);
      expect(summary?.fix).toContain('Run: npx tapsmith create-avd --name Tapsmith_Phone_API_36;');
      expect(summary?.fix).toContain("run: npx tapsmith create-avd --name Tapsmith_Phone_API_36_2, then set avd: 'Tapsmith_Phone_API_36_2'");
    });

    it('passes when all configured AVDs are capture-capable', () => {
      const second: AvdImageInfo = { name: 'Other_Good', tagId: 'google_apis' };
      const summary = summarizeAvdImages([goodAvd, second, playAvd], ['Tapsmith_Phone_API_36', 'Other_Good']);
      expect(summary?.status).toBe('pass');
      expect(shown(summary!)).toContain('Tapsmith_Phone_API_36, Other_Good support HTTPS capture');
      expect(shown(summary!)).toContain('Medium_Phone_API_36');
    });
  });

  describe('without a configured AVD', () => {
    it('warns on any Play-image AVD, counting capture-capable ones', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd]);
      expect(summary?.status).toBe('warn');
      expect(shown(summary!)).toContain('1 of 2 AVDs uses a Google Play system image');
      expect(shown(summary!)).toContain("the app's HTTPS requests still reach their servers, but they are not captured");
      expect(shown(summary!)).toContain('1 other AVD is capture-capable');
      expect(summary?.fix).toBe("Use Tapsmith_Phone_API_36, which supports HTTPS capture: set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config");
    });

    it('suggests a new AVD under a free name when only Play images exist', () => {
      // The default name is taken by a (Play-image) AVD, so the suggestion must not collide with it.
      const takenDefault: AvdImageInfo = { name: 'Tapsmith_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 };
      const summary = summarizeAvdImages([playAvd, takenDefault]);
      expect(summary?.status).toBe('warn');
      expect(summary?.fix).toContain("run: npx tapsmith create-avd --name Tapsmith_Phone_API_36_2, then set avd: 'Tapsmith_Phone_API_36_2'");
    });

    it('passes when all AVDs are capture-capable', () => {
      const summary = summarizeAvdImages([goodAvd]);
      expect(summary?.status).toBe('pass');
      expect(shown(summary!)).toContain('1 AVD checked');
    });

    it('discloses unreadable AVDs in the pass label', () => {
      const summary = summarizeAvdImages([goodAvd, brokenAvd]);
      expect(summary?.status).toBe('pass');
      expect(shown(summary!)).toContain('could not read: Broken');
    });
  });
});

describe('summarizeAvdImages() fixes are never destructive (PILOT-404)', () => {
  const good: AvdImageInfo = { name: 'Good', tagId: 'google_apis', apiLevel: 36 };
  const play: AvdImageInfo = { name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 };
  const broken: AvdImageInfo = { name: 'Broken' };
  const machines: AvdImageInfo[][] = [[play], [play, good], [play, broken], [broken], [play, good, broken]];
  const configs: Array<string | string[] | undefined> = [undefined, 'Medium_Phone_API_36', 'Broken', 'Gone', ['Medium_Phone_API_36', 'Gone', 'Broken']];

  it('never suggests --force, for any machine and config', () => {
    for (const avds of machines) {
      for (const configured of configs) {
        const fix = summarizeAvdImages(avds, configured)?.fix ?? '';
        expect(fix, `${JSON.stringify(avds)} / ${JSON.stringify(configured)}`).not.toContain('--force');
        // Never re-create an AVD that exists under its own name.
        for (const avd of avds) expect(fix).not.toContain(`--name ${avd.name}`);
      }
    }
  });
});

describe('parseNetworksetupProxy()', () => {
  it('reads an enabled proxy', () => {
    expect(parseNetworksetupProxy('Enabled: Yes\nServer: 127.0.0.1\nPort: 52429\nAuthenticated Proxy Enabled: 0\n'))
      .toEqual({ enabled: true, server: '127.0.0.1', port: 52429 });
  });

  it('reads a disabled, empty proxy', () => {
    expect(parseNetworksetupProxy('Enabled: No\nServer: \nPort: 0\nAuthenticated Proxy Enabled: 0\n'))
      .toEqual({ enabled: false, server: '', port: 0 });
  });
});

describe('assessSystemProxy()', () => {
  const setting = (over: Partial<ServiceProxySetting>): ServiceProxySetting => ({
    service: 'Wi-Fi', kind: 'HTTP', enabled: true, server: '127.0.0.1', port: 52429, ...over,
  });
  const record = { pid: 4242, port: 52429, service: 'Wi-Fi' };

  it('passes when no proxy is set', () => {
    expect(assessSystemProxy([setting({ enabled: false }), setting({ kind: 'HTTPS', enabled: false })], undefined, false).status)
      .toBe('pass');
  });

  it('passes a proxy that is not on loopback (not Tapsmith)', () => {
    const r = assessSystemProxy([setting({ server: 'proxy.corp', port: 3128 })], undefined, false);
    expect(r.status).toBe('pass');
    expect(shown(r)).toContain('not set by Tapsmith');
  });

  it('passes while the owning daemon is running', () => {
    const r = assessSystemProxy([setting({}), setting({ kind: 'HTTPS' })], record, true);
    expect(r.status).toBe('pass');
    expect(shown(r)).toContain('pid 4242');
  });

  it('warns about a proxy left by an exited daemon, with the reset command', () => {
    const r = assessSystemProxy([setting({}), setting({ kind: 'HTTPS' })], record, false);
    expect(r.status).toBe('warn');
    expect(r.label).toContain('left behind by an exited Tapsmith daemon');
    expect(r.status === 'warn' && r.fix).toBe(
      'Run: networksetup -setwebproxystate "Wi-Fi" off && networksetup -setsecurewebproxystate "Wi-Fi" off',
    );
  });

  it('never offers to switch off a live daemon\'s proxy when another loopback proxy is also set', () => {
    const r = assessSystemProxy(
      [setting({}), setting({ kind: 'HTTPS' }), setting({ service: 'Ethernet', port: 8888 })],
      record,
      true,
    );
    expect(r.status).toBe('warn');
    expect(r.label).toContain('HTTP 127.0.0.1:8888 on Ethernet');
    expect(r.label).not.toContain('52429');
    expect(r.status === 'warn' && r.fix).not.toContain('"Wi-Fi"');
  });

  it('never offers to switch off a live daemon\'s entry on the same service', () => {
    // The daemon owns Wi-Fi HTTP; another tool moved only Wi-Fi HTTPS.
    const r = assessSystemProxy(
      [setting({}), setting({ kind: 'HTTPS', port: 8888 })],
      record,
      true,
    );
    expect(r.status === 'warn' && r.fix).toBe('Run: networksetup -setsecurewebproxystate "Wi-Fi" off');
  });

  it('reports a localhost proxy as localhost and never as Tapsmith\'s', () => {
    const r = assessSystemProxy([setting({ server: 'localhost' })], record, true);
    expect(r.status).toBe('warn');
    expect(r.label).toContain('HTTP localhost:52429');
    expect(r.label).toContain('which Tapsmith does not own');
  });

  it('warns about an unowned loopback proxy (pre-record leftover or another local proxy)', () => {
    const r = assessSystemProxy([setting({ port: 8888 })], record, true);
    expect(r.status).toBe('warn');
    expect(r.label).toContain('which Tapsmith does not own');
  });
});

// A config that exists but cannot be imported now stops `tapsmith test`
// (PILOT-262), so doctor must fail on it too — including when the import
// error happens to mention ENOENT, which doctor used to read as "no config".
describe('configLoadFailure', () => {
  it('reports an unloadable config as a config error, naming the file', () => {
    const failure = configLoadFailure(
      "Failed to load config file /p/tapsmith.config.ts: ENOENT: no such file or directory, open '/p/.env'",
    );
    expect(failure.message).toContain('/p/tapsmith.config.ts');
    expect(failure.message).toContain('ENOENT');
    expect(failure.hint).not.toContain('tapsmith.config.ts');
  });

  it('does not point at a named file for a validation error that names none', () => {
    const failure = configLoadFailure('config: telemetry must be a boolean (got "no")');
    expect(failure.message).toContain('telemetry must be a boolean');
    expect(failure.hint).not.toMatch(/named above/);
  });

  // A config written by `npx tapsmith init` in a project without tapsmith
  // (PILOT-551): the fix is the install, not the config.
  it('gives the install command when tapsmith is not installed', () => {
    const err = new TapsmithNotInstalledError(
      '/p/tapsmith.config.ts',
      { command: 'pnpm', args: ['add', '-D', 'tapsmith'], display: 'pnpm add -D tapsmith' },
      new Error("Cannot find module 'tapsmith'"),
    );
    const failure = configLoadFailure(err);
    expect(failure.message).toBe("Tapsmith isn't installed in this project (/p/tapsmith.config.ts imports it)");
    expect(failure.hint).toBe('Run: pnpm add -D tapsmith');
  });

  // PILOT-631: no package.json beside the config.
  it('says why the install command creates a package.json first', () => {
    const note = "There's no package.json in /p: on its own, `npm i -D tapsmith` would add Tapsmith to / instead. If that is this project's root, run it there; otherwise create a package.json here first.";
    const err = new TapsmithNotInstalledError(
      '/p/tapsmith.config.ts',
      { command: 'npm', args: ['i', '-D', 'tapsmith'], display: 'npm init -y && npm i -D tapsmith', note },
      new Error("Cannot find module 'tapsmith'"),
    );
    const failure = configLoadFailure(err);
    expect(failure.message).toBe(`Tapsmith isn't installed in this project (/p/tapsmith.config.ts imports it). ${note}`);
    expect(failure.hint).toBe('Run: npm init -y && npm i -D tapsmith');
    expect(err.message).toBe(`Failed to load config file /p/tapsmith.config.ts: Tapsmith isn't installed in this project. Run \`npm init -y && npm i -D tapsmith\`. ${note}`);
  });

  it('points a missing --config file at the flag', () => {
    expect(configLoadFailure('Config file not found: /p/ci.config.ts').hint).toBe('Check the -c/--config path');
  });
});

describe('configPlatformTargets() (PILOT-263)', () => {
  const t = (c: Parameters<typeof configPlatformTargets>[0]) => [...configPlatformTargets(c)].sort();

  it('defaults to Android, like the runner', () => {
    expect(t({})).toEqual(['android']);
  });

  it('reads the root platform, or an iOS-only field when platform is unset', () => {
    expect(t({ platform: 'ios' })).toEqual(['ios']);
    expect(t({ app: 'x.app' })).toEqual(['ios']);
    expect(t({ simulator: 'iPhone 16' })).toEqual(['ios']);
  });

  it('with projects, reads each project over the root, and ignores the root itself', () => {
    expect(t({ platform: 'ios', projects: [{ use: { platform: 'android' } }] })).toEqual(['android']);
    expect(t({ platform: 'ios', projects: [{}, { use: { platform: 'android' } }] })).toEqual(['android', 'ios']);
    expect(t({ projects: [{ use: { app: 'x.app' } }, {}] })).toEqual(['android', 'ios']);
  });
});

describe('planPlatform() (PILOT-263)', () => {
  it('the only platform a config targets runs and its toolchain is required, on any host', () => {
    expect(planPlatform('ios', new Set(['ios']), 'linux')).toEqual({ run: true, required: true });
    expect(planPlatform('android', new Set(['android']), 'darwin')).toEqual({ run: true, required: true });
  });

  it('with several targeted platforms, one is only required when the other cannot run here', () => {
    expect(planPlatform('android', new Set(['android', 'ios']), 'darwin', true)).toEqual({ run: true, required: false });
    expect(planPlatform('ios', new Set(['android', 'ios']), 'linux', true)).toEqual({ run: true, required: false });
    expect(planPlatform('ios', new Set(['android', 'ios']), 'linux', false)).toEqual({ run: true, required: true });
  });

  it('a platform the config does not target is skipped with the reason', () => {
    expect(planPlatform('ios', new Set(['android']), 'darwin')).toEqual({ run: false, note: 'skipped: the config targets Android only' });
    expect(planPlatform('android', new Set(['ios']), 'darwin')).toEqual({ run: false, note: 'skipped: the config targets iOS only' });
  });

  it('without a config, the machine decides and nothing is required', () => {
    expect(planPlatform('android', undefined, 'linux')).toEqual({ run: true, required: false });
    expect(planPlatform('ios', undefined, 'darwin')).toEqual({ run: true, required: false });
    expect(planPlatform('ios', undefined, 'linux')).toEqual({ run: false, note: 'skipped: iOS testing needs macOS' });
  });
});

describe('configAndroidApks() (PILOT-263)', () => {
  it('lists the root apk without projects, and each Android project\'s apk (inherited or its own) once', () => {
    expect(configAndroidApks({ apk: 'a.apk' })).toEqual(['a.apk']);
    expect(configAndroidApks({ platform: 'ios', apk: 'a.apk' })).toEqual([]);
    expect(configAndroidApks({
      apk: 'root.apk',
      projects: [{ use: {} }, { use: { apk: 'b.apk' } }, { use: { apk: 'b.apk' } }, { use: { platform: 'ios' } }],
    })).toEqual(['root.apk', 'b.apk']);
  });
});

describe('SpringBoard teardown crash reports (PILOT-947)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 9, 30, 12);
  const TEARDOWN = '__66-[XCTAutomationSession initWithAccessibilityFramework:dataSource:]_block_invoke';

  /** An `.ips` report as macOS writes it: a JSON header line, then the JSON body. */
  function ips(opts: { crashMs: number; faulting: string[]; other?: string[] }): string {
    const stamp = new Date(opts.crashMs).toISOString().replace('T', ' ').replace(/\.(\d\d)\dZ$/, '.$1 +0000');
    const header = { app_name: 'SpringBoard', timestamp: stamp, bug_type: '309' };
    const thread = (symbols: string[]) => ({ frames: symbols.map((symbol) => ({ imageOffset: 1, symbol })) });
    const body = {
      faultingThread: 1,
      threads: [thread(['mach_msg2_trap']), thread(opts.faulting), thread(opts.other ?? [])],
    };
    return `${JSON.stringify(header)}\n${JSON.stringify(body, null, 2)}`;
  }

  /** Files whose mtime is `ageDays` before `now`, and whose report says it crashed `crashAgeDays` before (default: the same). */
  function reportsDir(files: Array<{ name: string; body?: string; ageDays: number; crashAgeDays?: number; faulting?: string[]; other?: string[] }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-diag-'));
    for (const f of files) {
      const file = path.join(dir, f.name);
      const crashMs = now - (f.crashAgeDays ?? f.ageDays) * DAY;
      fs.writeFileSync(file, f.body ?? ips({ crashMs, faulting: f.faulting ?? ['objc_msgSend', TEARDOWN], other: f.other }));
      const t = (now - f.ageDays * DAY) / 1000;
      fs.utimesSync(file, t, t);
    }
    return dir;
  }

  function count(files: Parameters<typeof reportsDir>[0]): number {
    const dir = reportsDir(files);
    try {
      return countSpringBoardTeardownCrashes(dir, now);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('counts recent SpringBoard reports with the XCTest teardown frame, and nothing else', () => {
    expect(count([
      { name: 'SpringBoard-2026-10-29-204543.ips', ageDays: 1 },
      { name: 'SpringBoard-2026-10-30-070317.ips', ageDays: 0.2 },
      // Another SpringBoard crash: not this bug.
      { name: 'SpringBoard-2026-10-28-100000.ips', ageDays: 2, faulting: ['-[SBSomethingElse crash]'] },
      // Older than the window.
      { name: 'SpringBoard-2026-10-01-100000.ips', ageDays: SPRINGBOARD_CRASH_WINDOW_DAYS + 1 },
      // Another process with the same frame.
      { name: 'TapsmithAgentUITests-Runner-2026-10-29-100000.ips', ageDays: 1 },
    ])).toBe(2);
  });

  it('counts only a crash on the teardown frame, not another crash while a second thread was tearing down', () => {
    // Real reports often show the teardown frame on two threads; only the faulting one says what crashed.
    expect(count([
      { name: 'SpringBoard-a.ips', ageDays: 1, faulting: ['objc_msgSend', TEARDOWN], other: [TEARDOWN] },
      { name: 'SpringBoard-b.ips', ageDays: 1, faulting: ['-[SBSomethingElse crash]'], other: [TEARDOWN] },
    ])).toBe(1);
  });

  it('dates a report by the crash time it records, not by when the file was last written', () => {
    expect(count([
      // Copied or touched recently, but the crash is three weeks old.
      { name: 'SpringBoard-copied.ips', ageDays: 0.1, crashAgeDays: 21 },
      // Dated after now (a clock change): not a crash from the last 7 days.
      { name: 'SpringBoard-future.ips', ageDays: 0.1, crashAgeDays: -2 },
      { name: 'SpringBoard-recent.ips', ageDays: 0.1, crashAgeDays: 0.5 },
    ])).toBe(1);
  });

  it('falls back to the file time and a plain text search for a report it cannot parse', () => {
    expect(count([
      { name: 'SpringBoard-legacy.ips', ageDays: 1, body: `Process: SpringBoard\nThread 7 Crashed:\n0 XCTAutomationSupport -[XCTAutomationSession initWithAccessibilityFramework:dataSource:]` },
      { name: 'SpringBoard-legacy-old.ips', ageDays: SPRINGBOARD_CRASH_WINDOW_DAYS + 1, body: `-[XCTAutomationSession initWithAccessibilityFramework:dataSource:]` },
      { name: 'SpringBoard-legacy-other.ips', ageDays: 1, body: 'Thread 7 Crashed:\n0 SpringBoard -[SBSomethingElse crash]' },
    ])).toBe(1);
  });

  it('is 0 when the reports directory does not exist', () => {
    expect(countSpringBoardTeardownCrashes(path.join(os.tmpdir(), 'tapsmith-no-such-dir-947'), now)).toBe(0);
  });

  it('reports nothing without crashes', () => {
    expect(summarizeSpringBoardCrashes(0)).toBeUndefined();
  });

  it('warns with the count, says nothing needs fixing, and gives the notification setting without applying it', () => {
    expect(summarizeSpringBoardCrashes(1)?.label).toContain('crashed in an iOS simulator once in the last 7 days');
    const summary = summarizeSpringBoardCrashes(3);
    expect(summary?.status).toBe('warn');
    expect(summary?.label).toContain('3 times');
    expect(summary?.fix).toContain('Nothing to fix in your setup');
    expect(summary?.fix).toContain('defaults write com.apple.CrashReporter UseUNC 1');
  });
});
