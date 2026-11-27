/**
 * Whether the app under test is on any of the devices that can be asked,
 * and the one step to take when there is no build at all (PILOT-1533).
 *
 * `tapsmith init` and `tapsmith doctor` ask the same question of a config
 * with a `package` but no `apk`/`app`: is that app installed anywhere it
 * could run? A package-only config is legitimate when it is (an app
 * installed by hand or by another tool); when it is nowhere, nothing can
 * run until the user builds the app, and both say so with the same step.
 */

import { packageInstallState } from './emulator.js';
import { simulatorAppInstallState } from './ios-simulator.js';
import { BUILD_DOCS, detectExpoProject, type ExpoProject } from './init-detect.js';

export type AppPlatform = 'android' | 'ios';

/** What each device asked said about the app. */
export interface AppPresence {
  installedOn: string[];
  absentFrom: string[];
  /** Devices that could not say (adb or simctl failed or timed out). */
  unknown: string[];
}

/** The per-platform lookups: true, false, or undefined when the device cannot say. */
export interface AppPresenceDeps {
  android?: (serial: string, pkg: string) => boolean | undefined;
  ios?: (udid: string, bundleId: string) => boolean | undefined;
}

/** Ask each of `targets` (adb serials, or booted simulators' UDIDs) whether it has `pkg`. */
export function appPresence(platform: AppPlatform, pkg: string, targets: readonly string[], deps: AppPresenceDeps = {}): AppPresence {
  const lookup = platform === 'android' ? (deps.android ?? packageInstallState) : (deps.ios ?? simulatorAppInstallState);
  const presence: AppPresence = { installedOn: [], absentFrom: [], unknown: [] };
  for (const target of targets) {
    const state = lookup(target, pkg);
    if (state === true) presence.installedOn.push(target);
    else if (state === false) presence.absentFrom.push(target);
    else presence.unknown.push(target);
  }
  return presence;
}

/** The one build step for a project with no build: the command (Expo only), the step, and the sentence that gives it. */
export interface BuildFirstStep {
  command?: string;
  /** "run `…`, then set `apk` in … (or run … init --force)." */
  action: string;
  /** "You don't have a build yet: " and the action. */
  sentence: string;
}

/** Where {@link buildFirstStep} is said: the project, and how to name its CLI and config. */
export interface BuildFirstStepOptions {
  rootDir: string;
  /** The project's own way to run Tapsmith. */
  cli?: string;
  /** The config's file name, as the user sees it. */
  configFile?: string;
  detect?: (dir: string) => ExpoProject | undefined;
}

/** Where the Expo release build of each platform lands. */
const EXPO_RELEASE_BUILD = {
  android: 'android/app/build/outputs/apk/release/app-release.apk',
  ios: 'the .app under ios/build/Build/Products/Release-iphonesimulator/',
} as const;

/**
 * The one recommended way to get a first build, as a single sentence: for
 * an Expo project the release build getting-started documents (it runs
 * without Metro), otherwise the build docs. Then the config key to point at
 * the build, or `init --force`, which finds it: the config exists by then,
 * so a plain `init` would refuse (`--yes`) or keep it (the wizard's default).
 */
export function buildFirstStep(platform: AppPlatform, options: BuildFirstStepOptions): BuildFirstStep {
  const { rootDir, cli = 'npx tapsmith', configFile = 'tapsmith.config.ts', detect = detectExpoProject } = options;
  const key = platform === 'android' ? 'apk' : 'app';
  let expo: ExpoProject | undefined;
  try {
    expo = detect(rootDir);
  } catch {
    expo = undefined;
  }
  const where = expo ? ` (${EXPO_RELEASE_BUILD[platform]})` : '';
  const then = `then set \`${key}\` in ${configFile} to the build${where}, or run \`${cli} init --force\`, which finds it.`;
  const lead = "You don't have a build yet: ";
  if (!expo) {
    const action = `build your app (${BUILD_DOCS}), ${then}`;
    return { action, sentence: `${lead}${action}` };
  }
  const env = expo.usesTapsmithHooks ? 'EXPO_PUBLIC_TAPSMITH_HOOKS=1 ' : '';
  // The build in a subshell, so the shell stays in the project root for the
  // init that follows, as getting-started writes it.
  const command = platform === 'android'
    ? `${expo.hasAndroidDir ? '' : 'npx expo prebuild -p android && '}(cd android && ${env}./gradlew assembleRelease)`
    : `${expo.hasIosDir ? '' : 'npx expo prebuild -p ios && '}(cd ios && ${env}xcodebuild -workspace <App>.xcworkspace -scheme <App> `
      + '-configuration Release -sdk iphonesimulator -derivedDataPath build build)';
  const action = `run \`${command}\`, ${then}`;
  return { command, action, sentence: `${lead}${action}` };
}
