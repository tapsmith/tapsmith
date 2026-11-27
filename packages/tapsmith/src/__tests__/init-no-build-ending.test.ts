import { describe, expect, it } from 'vitest';
import { missingBuilds, wizardClosing, type AndroidConfig, type IosConfig } from '../init.js';
import type { ConnectedAndroidDevice, SimulatorInfo } from '../env-scan.js';
import type { ExpoProject } from '../init-detect.js';

// PILOT-1533: a wizard that wrote a config with no apk, for an app on no
// device, closed with "Happy testing!", and nothing said a build was needed.

const emulator = (serial: string): ConnectedAndroidDevice => ({ serial, held: false });
const booted = (udid: string): SimulatorInfo => ({ name: udid, udid, state: 'Booted', runtime: 'iOS 26.0' });
const androidPackageOnly: AndroidConfig = { packageName: 'com.lqh.alexshop', useEmulators: false, usePhysicalDevices: false, device: 'emulator-5554' };
const env = (androidDevices: ConnectedAndroidDevice[] = [], simulators: SimulatorInfo[] = []) => ({ androidDevices, simulators });

describe('missingBuilds()', () => {
  it('names Android when the config has no apk and every connected device lacks the app', () => {
    const asked: string[] = [];
    const missing = missingBuilds(['android'], { ...androidPackageOnly, device: undefined }, undefined, env([emulator('emulator-5554'), emulator('emulator-5558')]), {
      android: (serial) => { asked.push(serial); return false; },
    });
    expect(missing).toEqual([{ platform: 'android', known: true }]);
    expect(asked).toEqual(['emulator-5554', 'emulator-5558']);
  });

  it('asks only the pinned device', () => {
    const asked: string[] = [];
    missingBuilds(['android'], androidPackageOnly, undefined, env([emulator('emulator-5554'), emulator('emulator-5558')]), {
      android: (serial) => { asked.push(serial); return false; },
    });
    expect(asked).toEqual(['emulator-5554']);
  });

  it('names nothing when the config has an apk, or a device has the app', () => {
    expect(missingBuilds(['android'], { ...androidPackageOnly, apkPath: 'app.apk' }, undefined, env([emulator('emulator-5554')]), { android: () => false })).toEqual([]);
    expect(missingBuilds(['android'], androidPackageOnly, undefined, env([emulator('emulator-5554')]), { android: () => true })).toEqual([]);
  });

  it('names a platform it could not check, marked unknown: no device, or one that could not say', () => {
    expect(missingBuilds(['android'], { ...androidPackageOnly, device: undefined }, undefined, env(), { android: () => false }))
      .toEqual([{ platform: 'android', known: false }]);
    expect(missingBuilds(['android'], androidPackageOnly, undefined, env([emulator('emulator-5554')]), { android: () => undefined }))
      .toEqual([{ platform: 'android', known: false }]);
  });

  it('checks an iOS simulator config with no app against the booted simulators only', () => {
    const ios: IosConfig = { bundleId: 'com.lqh.alexshop', simulator: 'iPhone 17', usePhysicalDevice: false };
    const asked: string[] = [];
    const missing = missingBuilds(['ios'], undefined, ios, env([], [booted('SIM-1'), { ...booted('SIM-2'), state: 'Shutdown' }]), {
      ios: (udid) => { asked.push(udid); return false; },
    });
    expect(missing).toEqual([{ platform: 'ios', known: true }]);
    expect(asked).toEqual(['SIM-1']);
    // A device build stands in for the simulator one: physical devices are not checked.
    expect(missingBuilds(['ios'], undefined, { ...ios, usePhysicalDevice: true, deviceAppPath: 'App.ipa' }, env([], [booted('SIM-1')]), { ios: () => false })).toEqual([]);
  });

  it('ignores a platform that was not selected', () => {
    expect(missingBuilds(['ios'], androidPackageOnly, { bundleId: 'x', appPath: 'A.app', usePhysicalDevice: false }, env([emulator('emulator-5554')]), { android: () => false })).toEqual([]);
  });
});

describe('wizardClosing()', () => {
  const expo = (overrides: Partial<ExpoProject> = {}): ExpoProject => ({
    hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: false, usesDevClient: false, ...overrides,
  });

  it('closes with the one build step instead of "Happy testing!" when the app is on no device', () => {
    expect(wizardClosing([{ platform: 'android', known: true }], '/proj', 'npx tapsmith', expo())).toEqual([
      "You don't have a build yet: run `npx expo prebuild -p android && cd android && ./gradlew assembleRelease`, then `npx tapsmith init` again (or set `apk` in tapsmith.config.ts).",
    ]);
  });

  it('hedges when it could not check, and names each platform when both lack a build', () => {
    expect(wizardClosing([{ platform: 'android', known: false }, { platform: 'ios', known: true }], '/proj', 'npx tapsmith', expo())).toEqual([
      "Android: if you don't have a build yet, run `npx expo prebuild -p android && cd android && ./gradlew assembleRelease`, then `npx tapsmith init` again (or set `apk` in tapsmith.config.ts).",
      "iOS: you don't have a build yet, so run `npx expo prebuild -p ios && cd ios && xcodebuild -workspace <App>.xcworkspace -scheme <App> -configuration Release -sdk iphonesimulator -derivedDataPath build build`, then `npx tapsmith init` again (or set `app` in tapsmith.config.ts).",
    ]);
  });

  it('says "Happy testing!" with a build, and gives an Expo project without the hooks the warm-reset pointer then', () => {
    expect(wizardClosing([], '/proj', 'npx tapsmith', undefined)).toEqual(['Happy testing!']);
    expect(wizardClosing([], '/proj', 'npx tapsmith', expo({ usesTapsmithHooks: true }))).toEqual(['Happy testing!']);
    expect(wizardClosing([], '/proj', 'npx tapsmith', expo())).toEqual([
      'For sub-second resets between tests, add @tapsmith/react-native\'s <TapsmithTestHooks>: https://tapsmith.dev/guides/warm-reset/',
      'Happy testing!',
    ]);
  });
});
