import { describe, expect, it } from 'vitest';
import { appPresence, buildFirstStep } from '../app-presence.js';
import type { ExpoProject } from '../init-detect.js';

// PILOT-1533: init and doctor ask the same question, "does any device have
// the app?", and give the same one-line fix when none does.

describe('appPresence', () => {
  const states: Record<string, boolean | undefined> = { 'emulator-5554': false, 'emulator-5556': true, 'emulator-5558': undefined };
  const android = (serial: string) => states[serial];

  it('sorts the devices by what each said, asking the platform\'s own lookup', () => {
    expect(appPresence('android', 'com.x', ['emulator-5554', 'emulator-5556', 'emulator-5558'], { android })).toEqual({
      installedOn: ['emulator-5556'], absentFrom: ['emulator-5554'], unknown: ['emulator-5558'],
    });
    const asked: string[] = [];
    appPresence('ios', 'com.x', ['SIM-1'], { android, ios: (udid, id) => { asked.push(`${udid} ${id}`); return false; } });
    expect(asked).toEqual(['SIM-1 com.x']);
  });

  it('asks nothing with no devices', () => {
    expect(appPresence('android', 'com.x', [], { android: () => { throw new Error('asked'); } }))
      .toEqual({ installedOn: [], absentFrom: [], unknown: [] });
  });
});

describe('buildFirstStep', () => {
  const expo = (overrides: Partial<ExpoProject> = {}): ExpoProject => ({
    hasAndroidDir: false, hasIosDir: false, usesTapsmithHooks: false, usesDevClient: false, ...overrides,
  });

  it('gives an Expo project without android/ the prebuild and the release build, then init again', () => {
    const step = buildFirstStep('android', '/proj', 'npx tapsmith', () => expo());
    expect(step.command).toBe('npx expo prebuild -p android && cd android && ./gradlew assembleRelease');
    expect(step.sentence).toBe("You don't have a build yet: run `npx expo prebuild -p android && cd android && ./gradlew assembleRelease`, "
      + 'then `npx tapsmith init` again (or set `apk` in tapsmith.config.ts).');
  });

  it('skips the prebuild once android/ exists, and keeps the hooks flag on for a project that uses them', () => {
    expect(buildFirstStep('android', '/proj', 'npx tapsmith', () => expo({ hasAndroidDir: true, usesTapsmithHooks: true })).command)
      .toBe('cd android && EXPO_PUBLIC_TAPSMITH_HOOKS=1 ./gradlew assembleRelease');
  });

  it('gives an Expo iOS project the simulator release build and names `app`', () => {
    const step = buildFirstStep('ios', '/proj', 'npx tapsmith', () => expo());
    expect(step.command).toBe('npx expo prebuild -p ios && cd ios && xcodebuild -workspace <App>.xcworkspace -scheme <App> '
      + '-configuration Release -sdk iphonesimulator -derivedDataPath build build');
    expect(step.sentence).toMatch(/\(or set `app` in tapsmith\.config\.ts\)\.$/);
  });

  it('points any other project at the build docs, with the project\'s own CLI', () => {
    const step = buildFirstStep('android', '/proj', 'pnpm exec tapsmith', () => undefined);
    expect(step.command).toBeUndefined();
    expect(step.sentence).toBe("You don't have a build yet: build your app (https://tapsmith.dev/getting-started/#build-the-app-under-test), "
      + 'then `pnpm exec tapsmith init` again (or set `apk` in tapsmith.config.ts).');
  });
});
