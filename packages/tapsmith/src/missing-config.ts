/**
 * What to do about a project with no Tapsmith config, for `doctor` and
 * `verify`: run `tapsmith init`, after building the app when init would find
 * no build and stop.
 */

import { detectCodingAgents, pluginNextSteps, runningCodingAgents, type CodingAgent } from './agent-plugins.js';
import { installedDocsDir } from './agents-md.js';
import {
  BUILD_DOCS, detectExpoProject, detectProjectLayout, expoBuildHint, findApkCandidates, findDerivedDataApps, findIosAppCandidates,
  hasAndroidProject, hasIosProject, isReactNativeProject, nativeBuildHint,
} from './init-detect.js';

/** What init writes, said because an agent that hand-writes the config misses the rest. */
const initWrites = (cli: string): string =>
  `It writes the config, and the AGENTS.md section that tells coding agents how to find locators, run and debug tests (${cli} init is the wizard). Edit the config it writes rather than writing one by hand.`;

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

/** The coding agents whose plugin the fix lists, as init would list them. */
export interface FixAgents {
  codingAgents: readonly CodingAgent[];
  /** A coding agent is running the command: `codingAgents` is that agent. */
  agentRunning: boolean;
}

/**
 * The fix for a missing config in `cwd`; `cli` is how the project runs
 * Tapsmith (`tapsmithExecCommand`). One text for `--json` and plain output,
 * in lines: the init command alone first, what init writes, the build steps
 * when init would find no build, then the plugin, which an agent read in a
 * single long line missed.
 */
export function missingConfigFix(
  cwd: string,
  cli: string,
  isMacOS = process.platform === 'darwin',
  agents: FixAgents = { codingAgents: detectCodingAgents(cwd), agentRunning: runningCodingAgents().length > 0 },
): string {
  const builds = missingBuilds(cwd, isMacOS);
  const init = `${cli} init --yes --json`;
  const lines = [builds ? `Run, once the app is built: ${init}` : `Run: ${init}`, initWrites(cli)];
  if (builds) {
    const now = builds.built.map((p) => `To set up only ${p === 'android' ? 'Android' : 'iOS'}, which is built: ${init} --platform ${p}. `).join('');
    lines.push(`Build the app first: init needs a build to point at. ${now}${builds.how}`);
  }
  // After init: the plugin's server runs from the project's Tapsmith (PILOT-1197).
  for (const step of pluginNextSteps(agents.codingAgents, agents.agentRunning, installedDocsDir(cwd))) {
    lines.push(`After init, ${step[0].toLowerCase()}${step.slice(1)}`);
  }
  return lines.map((line) => (cli === 'npx tapsmith' ? line : line.replace(/\bnpx tapsmith\b/g, cli))).join('\n');
}
