/**
 * What to do about a project with no Tapsmith config, for `doctor` and
 * `verify`: run `tapsmith init`, after building the app when init would find
 * no build and stop (PILOT-1442).
 */

import {
  BUILD_DOCS, detectExpoProject, detectProjectLayout, expoBuildHint, findApkCandidates, findDerivedDataApps, findIosAppCandidates,
  hasAndroidProject, hasIosProject, isReactNativeProject, nativeBuildHint,
} from './init-detect.js';

/** What init writes, said because an agent that hand-writes the config misses the rest. */
const INIT_WRITES = 'It writes the config, and the AGENTS.md section that tells coding agents how to find locators, run and debug tests';

/**
 * For a build outside the folders init searches (an EAS or CI download), or
 * an installed app: as init's own errors offer. `fromLayout` platforms are in
 * the project, so init wants a build of each unless `--platform` names one.
 */
function existingBuild(platforms: ReadonlyArray<'android' | 'ios'>, fromLayout: boolean): string {
  const flags = [
    ...(platforms.includes('android') ? ['--apk <path> or --package <id> (an Android app already installed on the device)'] : []),
    ...(platforms.includes('ios') ? ['--app <path> (a simulator .app)'] : []),
  ];
  const both = fromLayout && flags.length > 1;
  return `Already built somewhere else? Don't build again: add ${flags.join(both ? ', and ' : ' or ')} to the init command`
    + `${both ? ' (with only one of the two, also add --platform android or --platform ios)' : ''}.`;
}

/**
 * The builds `init --yes` needs and would not find, with how to make them, or
 * undefined when it finds one for each platform the project has. Looks where
 * init looks. Reads no Expo app config, which can run the project's Expo CLI.
 */
function missingBuilds(cwd: string, isMacOS: boolean): { how: string; built: string[] } | undefined {
  const layout = detectProjectLayout(cwd);
  const expo = detectExpoProject(cwd, () => undefined);
  const platforms: Array<'android' | 'ios'> = [];
  if (hasAndroidProject(layout)) platforms.push('android');
  if (isMacOS && hasIosProject(layout)) platforms.push('ios');
  if (platforms.length === 0) {
    const buildable: Array<'android' | 'ios'> = isMacOS ? ['android', 'ios'] : ['android'];
    return {
      how: expo
        ? `This Expo project has no android/ or ios/ yet. ${existingBuild(buildable, false)} ${expoBuildHint(buildable, expo)}`
        : `No Android or iOS project found here: add --apk <path> (Android) or --app <path> (an iOS simulator .app) to say where the build is. See ${BUILD_DOCS}`,
      built: [],
    };
  }
  const hasBuild = (platform: 'android' | 'ios'): boolean => platform === 'android'
    ? findApkCandidates(cwd).length > 0
    : findIosAppCandidates(cwd).length > 0 || findDerivedDataApps(cwd, layout.iosProjects, 'iphonesimulator').length > 0;
  const missing = platforms.filter((p) => !hasBuild(p));
  if (missing.length === 0) return undefined;
  const reactNative = isReactNativeProject(cwd);
  return {
    how: `${existingBuild(missing, true)} ${expo
      ? expoBuildHint(missing, expo)
      : missing.map((p) => `${p === 'android' ? 'Android' : 'iOS'}: ${nativeBuildHint(p, layout, reactNative)}`).join('. ')}`,
    built: platforms.filter((p) => !missing.includes(p)),
  };
}

/**
 * The fix for a missing config in `cwd`; `cli` is how the project runs
 * Tapsmith (`tapsmithExecCommand`). One text for `--json` and plain output.
 */
export function missingConfigFix(cwd: string, cli: string, isMacOS = process.platform === 'darwin'): string {
  const init = `${cli} init --yes --json (or ${cli} init for the wizard)`;
  const builds = missingBuilds(cwd, isMacOS);
  if (!builds) return `Run: ${init}. ${INIT_WRITES}`;
  const now = builds.built.map((p) => `To set up only ${p === 'android' ? 'Android' : 'iOS'}, which is built: ${cli} init --yes --json --platform ${p}. `).join('');
  return `Build the app first, then run: ${init}. ${INIT_WRITES}. ${now}${builds.how}`;
}
