import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assessSystemProxy,
  buildDoctorJson,
  isSupportedNodeVersion,
  parseAvdImageTag,
  parseAvdApiLevel,
  parseDoctorConfigFlag,
  parseNetworksetupProxy,
  scanAvdImageTags,
  stripAnsi,
  summarizeAvdImages,
  type AvdImageInfo,
  type CheckEntry,
  type ServiceProxySetting,
} from '../doctor.js';

describe('buildDoctorJson()', () => {
  const checks: CheckEntry[] = [
    { id: 'node', status: 'pass', label: 'Node.js 22.1.0' },
    { id: 'adb', status: 'fail', label: 'ADB not found on PATH', fix: 'Install Android platform-tools and ensure adb is on PATH' },
    { id: 'android-home', status: 'warn', label: 'ANDROID_HOME not set', fix: 'Set ANDROID_HOME to your Android SDK location' },
  ];
  const inventory = {
    avds: ['Pixel_7'],
    simulators: [{ name: 'iPhone 16', udid: 'ABC', state: 'Shutdown', runtime: 'iOS 18 2' }],
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

describe('isSupportedNodeVersion()', () => {
  it('requires Node.js 22 or newer', () => {
    expect(isSupportedNodeVersion('21.9.0')).toBe(false);
    expect(isSupportedNodeVersion('22.0.0')).toBe(true);
    expect(isSupportedNodeVersion('24.13.0')).toBe(true);
  });
});

describe('parseAvdApiLevel()', () => {
  it('extracts the API level from image.sysdir.1', () => {
    expect(parseAvdApiLevel('image.sysdir.1 = system-images/android-36/google_apis_playstore/arm64-v8a/\n')).toBe(36);
    expect(parseAvdApiLevel('image.sysdir.1=system-images/android-34/google_apis/x86_64/\n')).toBe(34);
  });

  it('returns undefined when absent', () => {
    expect(parseAvdApiLevel('AvdId = X\n')).toBeUndefined();
  });
});

describe('parseAvdImageTag()', () => {
  it('extracts tag.id from config.ini', () => {
    const ini = 'AvdId = Medium_Phone\nPlayStore.enabled = true\ntag.id = google_apis_playstore\ntag.ids = google_apis_playstore\n';
    expect(parseAvdImageTag(ini)).toBe('google_apis_playstore');
  });

  it('handles google_apis images and whitespace variants', () => {
    expect(parseAvdImageTag('tag.id=google_apis\n')).toBe('google_apis');
    expect(parseAvdImageTag('tag.id =  google_apis \n')).toBe('google_apis');
  });

  it('returns undefined when tag.id is absent', () => {
    expect(parseAvdImageTag('AvdId = X\n')).toBeUndefined();
    // tag.ids must not match tag.id
    expect(parseAvdImageTag('tag.ids = google_apis\n')).toBeUndefined();
  });
});

describe('scanAvdImageTags()', () => {
  function makeAvdHome(avds: Array<{ name: string; tagId?: string }>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-avd-test-'));
    for (const avd of avds) {
      const avdDir = path.join(home, `${avd.name}.avd`);
      fs.mkdirSync(avdDir);
      fs.writeFileSync(path.join(home, `${avd.name}.ini`), `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avd.name}.avd\n`);
      const tagLine = avd.tagId ? `tag.id = ${avd.tagId}\n` : '';
      fs.writeFileSync(path.join(avdDir, 'config.ini'), `AvdId = ${avd.name}\n${tagLine}`);
    }
    return home;
  }

  it('returns each AVD with its system image tag', () => {
    const home = makeAvdHome([
      { name: 'Pixel_7', tagId: 'google_apis' },
      { name: 'Medium_Phone', tagId: 'google_apis_playstore' },
    ]);
    const avds = scanAvdImageTags(home).sort((a, b) => a.name.localeCompare(b.name));
    expect(avds).toEqual([
      { name: 'Medium_Phone', tagId: 'google_apis_playstore' },
      { name: 'Pixel_7', tagId: 'google_apis' },
    ]);
  });

  it('keeps AVDs whose config.ini is unreadable, without a tag', () => {
    const home = makeAvdHome([{ name: 'Pixel_7', tagId: 'google_apis' }]);
    fs.writeFileSync(path.join(home, 'Broken.ini'), 'path=/nonexistent/Broken.avd\n');
    const avds = scanAvdImageTags(home).sort((a, b) => a.name.localeCompare(b.name));
    expect(avds).toEqual([
      { name: 'Broken', tagId: undefined },
      { name: 'Pixel_7', tagId: 'google_apis' },
    ]);
  });

  it('returns empty for a missing AVD home', () => {
    expect(scanAvdImageTags('/nonexistent/avd-home')).toEqual([]);
  });
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
      expect(stripAnsi(summary!.label)).toContain('Tapsmith_Phone_API_36 supports HTTPS capture');
      expect(stripAnsi(summary!.label)).toContain('Medium_Phone_API_36');
    });

    it('passes without context when no Play AVDs exist', () => {
      const summary = summarizeAvdImages([goodAvd], 'Tapsmith_Phone_API_36');
      expect(summary?.status).toBe('pass');
      expect(stripAnsi(summary!.label)).not.toContain('other AVD');
    });

    it('warns when the configured AVD uses a Play image, suggesting a runnable replacement command', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd], 'Medium_Phone_API_36');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Medium_Phone_API_36 uses a Google Play system image');
      expect(summary?.fix).toContain('npx tapsmith create-avd --name Medium_Phone_API_36 --api 36 --force');
    });

    it('warns when the configured AVD does not exist', () => {
      const summary = summarizeAvdImages([goodAvd], 'Missing_AVD');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Missing_AVD not found');
      expect(summary?.fix).toContain('--name Missing_AVD');
    });

    it('warns when the configured AVD tag is unreadable', () => {
      const summary = summarizeAvdImages([brokenAvd], 'Broken');
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Could not read');
    });

    it('handles multiple configured AVDs (e.g. per-project use.avd), reporting every issue', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd], ['Tapsmith_Phone_API_36', 'Medium_Phone_API_36', 'Gone']);
      expect(summary?.status).toBe('warn');
      expect(summary?.label).toContain('Gone not found');
      expect(summary?.label).toContain('Medium_Phone_API_36 uses a Google Play system image');
      expect(summary?.label).not.toContain('Tapsmith_Phone_API_36 uses');
      expect(summary?.fix).toBe('Run: npx tapsmith create-avd --name Gone && npx tapsmith create-avd --name Medium_Phone_API_36 --api 36 --force');
    });

    it('passes when all configured AVDs are capture-capable', () => {
      const second: AvdImageInfo = { name: 'Other_Good', tagId: 'google_apis' };
      const summary = summarizeAvdImages([goodAvd, second, playAvd], ['Tapsmith_Phone_API_36', 'Other_Good']);
      expect(summary?.status).toBe('pass');
      expect(stripAnsi(summary!.label)).toContain('Tapsmith_Phone_API_36, Other_Good support HTTPS capture');
      expect(stripAnsi(summary!.label)).toContain('Medium_Phone_API_36');
    });
  });

  describe('without a configured AVD', () => {
    it('warns on any Play-image AVD, counting capture-capable ones', () => {
      const summary = summarizeAvdImages([goodAvd, playAvd]);
      expect(summary?.status).toBe('warn');
      expect(stripAnsi(summary!.label)).toContain('1 of 2 AVDs uses a Google Play system image');
      expect(stripAnsi(summary!.label)).toContain('1 other AVD is capture-capable');
      expect(summary?.fix).toContain('npx tapsmith create-avd --name Medium_Phone_API_36 --api 36 --force');
    });

    it('passes when all AVDs are capture-capable', () => {
      const summary = summarizeAvdImages([goodAvd]);
      expect(summary?.status).toBe('pass');
      expect(stripAnsi(summary!.label)).toContain('1 AVD checked');
    });

    it('discloses unreadable AVDs in the pass label', () => {
      const summary = summarizeAvdImages([goodAvd, brokenAvd]);
      expect(summary?.status).toBe('pass');
      expect(stripAnsi(summary!.label)).toContain('could not read: Broken');
    });
  });
});

describe('parseDoctorConfigFlag()', () => {
  it('parses -c, --config, and --config= forms', () => {
    expect(parseDoctorConfigFlag(['-c', 'a.mjs'])).toBe('a.mjs');
    expect(parseDoctorConfigFlag(['--config', 'b.mjs'])).toBe('b.mjs');
    expect(parseDoctorConfigFlag(['--config=c.mjs'])).toBe('c.mjs');
    expect(parseDoctorConfigFlag(['--json'])).toBeUndefined();
  });

  it('rejects missing or option-like values', () => {
    expect(() => parseDoctorConfigFlag(['-c'])).toThrow(/Missing value for -c/);
    expect(() => parseDoctorConfigFlag(['-c', '--json'])).toThrow(/Missing value for -c/);
    expect(() => parseDoctorConfigFlag(['--config='])).toThrow(/Missing value for --config/);
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
    expect(stripAnsi(r.label)).toContain('not set by Tapsmith');
  });

  it('passes while the owning daemon is running', () => {
    const r = assessSystemProxy([setting({}), setting({ kind: 'HTTPS' })], record, true);
    expect(r.status).toBe('pass');
    expect(stripAnsi(r.label)).toContain('pid 4242');
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
