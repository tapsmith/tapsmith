import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  avdCaptureSupport,
  avdCaptureWarning,
  avdHomeDir,
  captureAvdNextStep,
  noAvdsListedMessage,
  captureAvdFix,
  newCaptureAvd,
  parseAvdApiLevel,
  parseAvdImageTag,
  scanAvdImageTags,
  type AvdImageInfo,
} from '../avd-images.js';

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


const good: AvdImageInfo = { name: 'Tapsmith_Phone_API_36', tagId: 'google_apis', apiLevel: 36 };
const play: AvdImageInfo = { name: 'Medium_Phone_API_36', tagId: 'google_apis_playstore', apiLevel: 36 };
const broken: AvdImageInfo = { name: 'Broken' };

describe('avdCaptureSupport()', () => {
  it('classifies by system image tag', () => {
    expect(avdCaptureSupport(good)).toBe('capable');
    expect(avdCaptureSupport({ name: 'Atd', tagId: 'aosp_atd' })).toBe('capable');
    expect(avdCaptureSupport({ name: 'Aosp', tagId: 'default' })).toBe('capable');
    expect(avdCaptureSupport(play)).toBe('play-image');
    // Play variants carry their own tags; none of them is rootable.
    expect(avdCaptureSupport({ name: 'P16k', tagId: 'google_apis_playstore_ps16k' })).toBe('play-image');
    expect(avdCaptureSupport({ name: 'Car', tagId: 'android-automotive-playstore' })).toBe('play-image');
    expect(avdCaptureSupport({ name: 'G16k', tagId: 'google_apis_ps16k' })).toBe('capable');
    expect(avdCaptureSupport(broken)).toBe('unknown');
    expect(avdCaptureSupport(undefined)).toBe('unknown');
  });
});

describe('newCaptureAvd()', () => {
  it('uses the create-avd defaults when the name is free', () => {
    expect(newCaptureAvd([play])).toEqual({ name: 'Tapsmith_Phone_API_36', command: 'npx tapsmith create-avd' });
  });

  it('keeps a non-default API level', () => {
    expect(newCaptureAvd([], 34)).toEqual({ name: 'Tapsmith_Phone_API_34', command: 'npx tapsmith create-avd --api 34' });
  });

  it('picks a free name when the default is taken, so create-avd never needs --force', () => {
    const taken: AvdImageInfo[] = [{ name: 'Tapsmith_Phone_API_36' }, { name: 'Tapsmith_Phone_API_36_2' }];
    expect(newCaptureAvd(taken)).toEqual({
      name: 'Tapsmith_Phone_API_36_3',
      command: 'npx tapsmith create-avd --name Tapsmith_Phone_API_36_3',
    });
  });
});

describe('captureAvdFix()', () => {
  it('points at an existing capture-capable AVD', () => {
    expect(captureAvdFix([play, good])).toBe("Use Tapsmith_Phone_API_36, which supports HTTPS capture: set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config");
  });

  it('otherwise creates a new one beside the existing AVDs', () => {
    expect(captureAvdFix([play])).toBe(
      "Create a capture-capable AVD (your existing AVDs are left untouched) — run: npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config",
    );
  });

  it('drops the "existing AVDs" note when there are none', () => {
    expect(captureAvdFix([])).toBe("Create a capture-capable AVD — run: npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config");
  });
});

describe('avdCaptureWarning()', () => {
  it('is undefined for a capture-capable AVD', () => {
    expect(avdCaptureWarning('Tapsmith_Phone_API_36', [good, play])).toBeUndefined();
  });

  it('explains a Play image and suggests the capable AVD', () => {
    const warning = avdCaptureWarning('Medium_Phone_API_36', [good, play]);
    // PILOT-711: says what happens to the app's HTTPS, not just "not captured".
    expect(warning).toContain(
      "AVD Medium_Phone_API_36 uses a Google Play system image — no adb root, so Tapsmith can't install its CA certificate: "
      + "the app's HTTPS requests still reach their servers, but they are not captured and device.route() can't intercept them",
    );
    expect(warning).toContain("set avd: 'Tapsmith_Phone_API_36'");
  });

  it('does not vouch for an AVD whose image could not be read (or was not found)', () => {
    expect(avdCaptureWarning('Broken', [broken])).toContain('Could not read the system image of AVD Broken');
  });

  it('says an AVD that does not exist was not found (e.g. a typo in --avd)', () => {
    const warning = avdCaptureWarning('Pixle_7', [good]);
    expect(warning).toContain('AVD Pixle_7 was not found on this machine');
    expect(warning).toContain("set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config in place of 'Pixle_7'");
  });
});

describe('captureAvdNextStep() (PILOT-711)', () => {
  it('is undefined for a capture-capable AVD, an unreadable image, or no AVD', () => {
    expect(captureAvdNextStep('Tapsmith_Phone_API_36', [good, play])).toBeUndefined();
    expect(captureAvdNextStep('Broken', [broken])).toBeUndefined();
    expect(captureAvdNextStep(undefined, [play])).toBeUndefined();
  });

  it('points a Play-image AVD at the capable AVD the machine already has', () => {
    expect(captureAvdNextStep('Medium_Phone_API_36', [play, good])).toEqual({
      label: 'Capture HTTPS',
      action: "set avd: 'Tapsmith_Phone_API_36' in tapsmith.config.ts",
    });
  });

  it('otherwise suggests create-avd, then the avd to set', () => {
    expect(captureAvdNextStep('Medium_Phone_API_36', [play])).toEqual({
      label: 'Capture HTTPS',
      action: "npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36' in tapsmith.config.ts",
    });
  });
});

describe('avdHomeDir()', () => {
  it('follows the SDK tools\' resolution order (where avdmanager writes AVDs)', () => {
    const home = '/home/u';
    expect(avdHomeDir({}, home)).toBe(path.join(home, '.android', 'avd'));
    // ANDROID_EMULATOR_HOME is the emulator's config dir, not the AVD home.
    expect(avdHomeDir({ ANDROID_EMULATOR_HOME: '/emu' }, home)).toBe(path.join(home, '.android', 'avd'));
    expect(avdHomeDir({ ANDROID_SDK_HOME: '/sdkhome' }, home)).toBe(path.join('/sdkhome', '.android', 'avd'));
    expect(avdHomeDir({ ANDROID_SDK_HOME: '/sdkhome', ANDROID_PREFS_ROOT: '/prefs' }, home)).toBe(path.join('/prefs', '.android', 'avd'));
    expect(avdHomeDir({ ANDROID_PREFS_ROOT: '/prefs', ANDROID_USER_HOME: '/user' }, home)).toBe(path.join('/user', 'avd'));
    expect(avdHomeDir({ ANDROID_USER_HOME: '/user', ANDROID_AVD_HOME: '/avds' }, home)).toBe('/avds');
  });
});

describe('noAvdsListedMessage()', () => {
  it('suggests create-avd when the machine has no AVDs', () => {
    expect(noAvdsListedMessage([])).toBe("No Android AVDs found. Create a capture-capable AVD — run: npx tapsmith create-avd, then set avd: 'Tapsmith_Phone_API_36' in your Tapsmith config");
  });

  it('blames the emulator install, not the AVDs, when the AVD home has AVDs the emulator did not list', () => {
    const message = noAvdsListedMessage([good, play]);
    expect(message).toContain('Found AVDs (Medium_Phone_API_36, Tapsmith_Phone_API_36)');
    expect(message).toContain('the Android emulator is not installed where Tapsmith looks');
    expect(message).toContain('set ANDROID_HOME');
    expect(message).not.toContain('No Android AVDs found');
    expect(message).not.toContain('create-avd');
  });
});
