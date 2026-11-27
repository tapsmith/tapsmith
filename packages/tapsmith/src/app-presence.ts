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
  /** "run `…`, then … init again (or set …)." */
  action: string;
  /** "You don't have a build yet: " and the action. */
  sentence: string;
}

/**
 * The one recommended way to get a first build, as a single sentence: for
 * an Expo project the release build getting-started documents (it runs
 * without Metro), otherwise the build docs. Then init again, which finds
 * the build, or the config key to set by hand.
 */
export function buildFirstStep(
  platform: AppPlatform,
  rootDir: string,
  cli = 'npx tapsmith',
  detect: (dir: string) => ExpoProject | undefined = detectExpoProject,
): BuildFirstStep {
  const key = platform === 'android' ? 'apk' : 'app';
  const then = `then \`${cli} init\` again (or set \`${key}\` in tapsmith.config.ts).`;
  let expo: ExpoProject | undefined;
  try {
    expo = detect(rootDir);
  } catch {
    expo = undefined;
  }
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
