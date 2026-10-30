import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import Enquirer from 'enquirer';
import figlet from 'figlet';
import { isCustomSimulatorName, scanEnvironment, simulatorChoices, type EnvScan } from './env-scan.js';
import type { SeStatus } from './setup-ios.js';
import {
  detectAndroidPackage,
  detectExpoProject,
  detectGradleApplicationId,
  detectIosBundleId,
  derivedDataBuildWarning,
  detectProjectLayout,
  expoBuildHint,
  findApkCandidates,
  findDerivedDataApps,
  findIosAppCandidates,
  findIosDeviceAppCandidates,
  hasAndroidProject,
  apkSearchedIn,
  FLUTTER_DEVICE_BUILD_HINT,
  hasIosProject,
  isReactNativeProject,
  nativeBuildHint,
  preferDebugApk,
  type ExpoProject,
} from './init-detect.js';
import { adbMissingFix } from './toolchain.js';
import type { InitCommandOptions } from './cli-program.js';
import { formatJson, jsonError } from './cli-json.js';
import { avdCaptureSupport, avdCaptureWarning, captureAvdNextStep, noAvdsListedMessage, preferredAvd, type AvdImageInfo } from './avd-images.js';
import { isTapsmithResolvableFrom, tapsmithExecCommand, tapsmithInstallCommand, type InstallCommand } from './config.js';
import { androidAgentInstalledFor, missingAndroidAgentAdvice } from './agent-resolve.js';
import { globSync } from 'glob';
import { minimatch } from 'minimatch';
import { DEFAULT_TEST_IGNORE } from './test-file-discovery.js';
import { confirmQuestion } from './confirm-prompt.js';
import { isPromptCancel, tolerateClosedReadline } from './prompt-cancel.js';
import { ignoreNodeModulesOrWarn, ignoreTestResultsOrWarn } from './init-gitignore.js';
import { writeTsconfigOrWarn } from './init-tsconfig.js';
import { projectUsesYarnPnp, YARN_PNP_INIT_STEP, YARN_PNP_INIT_WARNING } from './yarn-pnp.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;

const enquirer = new Enquirer();

// ─── Helpers ───

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'),
    );
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function displayEnvironment(env: EnvScan, expo: ExpoProject | undefined): void {
  const ok = (msg: string): string => `  ${green('✓')} ${msg}`;
  const warn = (msg: string): string => `  ${YELLOW}⚠${RESET} ${msg}`;
  const fail = (msg: string): string => `  ${RED}✗${RESET} ${msg}`;
  const lines: string[] = [];

  const major = parseInt(env.nodeVersion.split('.')[0], 10);
  lines.push(major >= 22 ? ok(`Node.js ${env.nodeVersion}`) : fail(`Node.js ${env.nodeVersion} (requires >= 22)`));
  if (env.rosettaWarning) lines.push(warn(env.rosettaWarning));
  lines.push(env.daemonBin ? ok('Tapsmith daemon') : fail('Tapsmith daemon not found'));

  if (env.agentApk && env.agentTestApk) lines.push(ok('Android agent (bundled)'));
  else if (env.agentApk || env.agentTestApk) lines.push(warn('Android agent (incomplete)'));

  // An SDK that has adb off PATH is said here; the Android questions give the fix (PILOT-832).
  lines.push(env.adbVersion ? ok(`ADB ${env.adbVersion}`) : warn(env.adbOffPath ? `ADB not on PATH (found in ${env.adbOffPath})` : 'ADB not found'));
  if (env.androidHome) lines.push(ok('ANDROID_HOME'));

  if (env.isMacOS) {
    lines.push(env.xcodeVersion ? ok(`Xcode ${env.xcodeVersion}`) : warn('Xcode not found'));
    // The count the simulator picker offers (PILOT-562), not every simctl entry.
    const sims = simulatorChoices(env.simulators).length;
    if (sims > 0) lines.push(ok(`${sims} iOS simulator${sims === 1 ? '' : 's'} available`));
  }

  if (env.avds.length > 0) lines.push(ok(`${env.avds.length} Android AVDs available`));
  if (expo) {
    const native = expo.hasAndroidDir || expo.hasIosDir ? '' : ' (no android/ or ios/ yet)';
    lines.push(ok(`Expo project${native}`));
  }

  console.log();
  console.log(`  ${bold('Environment')}`);
  console.log(lines.join('\n'));
  console.log();
}

// ─── Prompt helpers ───

async function ask<T>(question: Record<string, unknown>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- enquirer's PromptOptions union is too narrow for dynamic question objects
  const result = await enquirer.prompt({ ...question, name: '_', onRun: tolerateClosedReadline } as any) as Record<string, T>;
  return result['_'];
}

// ─── Build paths (PILOT-513) ───

/** Which build a path prompt asks for. */
export type BuildKind = 'apk' | 'simulator-app' | 'device-app';

/**
 * A typed path as the shell would read it: trimmed, one pair of surrounding
 * quotes dropped, backslash-escaped characters unescaped (a path dragged into
 * a macOS terminal arrives as `/a/My\\ App.app`) and a leading `~` expanded.
 */
export function normalizeTypedPath(val: string): string {
  let p = val.trim();
  if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0]) p = p.slice(1, -1);
  else if (process.platform !== 'win32') p = p.replace(/\\(.)/g, '$1');
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Validate a typed build path at the prompt: it must exist, an APK as a
 * file and an `.app` bundle as a directory, relative paths resolved against
 * the project. A device build must not be a simulator build.
 */
export function validateBuildPath(val: string, kind: BuildKind, cwd: string = process.cwd()): true | string {
  const p = normalizeTypedPath(val);
  if (p.length === 0) {
    return kind === 'apk' ? 'APK path is required' : kind === 'simulator-app' ? '.app path is required' : 'Device app path is required';
  }
  if (kind === 'device-app' && p.includes('iphonesimulator')) {
    return 'This looks like a simulator build — physical devices need an iphoneos build';
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.resolve(cwd, p));
  } catch {
    return `${p} does not exist — check the path, or build your app first`;
  }
  if (kind === 'apk' && stat.isDirectory()) return `${p} is a directory, not an APK file`;
  if (kind !== 'apk' && (!stat.isDirectory() || path.extname(p).toLowerCase() !== '.app')) {
    return `${p} is not an .app bundle (a directory named <App>.app)`;
  }
  return true;
}

// The names are what enquirer echoes once chosen, so they are the labels themselves.
const OTHER_PATH = 'Enter another path…';
const SKIP_BUILD = 'Skip for now';

/**
 * The path to write into the config for a typed build path: read as a shell
 * would ({@link normalizeTypedPath}) and, when it is inside the project (an
 * absolute path dragged in, or `~/…`), made project-relative like the
 * detected builds, so the config works on other machines.
 */
export function typedBuildPath(val: string, cwd: string = process.cwd()): string {
  const p = normalizeTypedPath(val);
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return rel && !outside ? rel : p;
}

/**
 * Ask for a build: the builds detection found, as a select (with a way out to
 * type another path, and one to skip), or a validated path prompt with no
 * placeholder default when it found none, after a hint on how to build one.
 * Undefined when the user skips it — Enter at a path prompt, or "Skip for
 * now" — so a project with no build yet never dead-ends here (PILOT-778).
 */
async function askBuildPath(opts: {
  kind: BuildKind;
  message: string;
  candidates: string[];
  /** A hint beside each candidate that has one (a DerivedData build: this Mac only). */
  hints?: ReadonlyMap<string, string>;
  noneFound: string;
  typeMessage: string;
}): Promise<string | undefined> {
  const validate = (val: string): true | string => normalizeTypedPath(val).length === 0 || validateBuildPath(val, opts.kind);
  const typed = async (message: string): Promise<string | undefined> => {
    const val = await ask<string>({ type: 'input', message: `${message} ${dim('(Enter to skip)')}`, validate });
    return normalizeTypedPath(val).length === 0 ? undefined : typedBuildPath(val);
  };
  if (opts.candidates.length === 0) {
    console.log(dim(`  ${opts.noneFound}`));
    return typed(opts.message);
  }
  const picked = await ask<string>({
    type: 'select',
    message: opts.message,
    choices: [
      ...opts.candidates.map((c) => {
        const hint = opts.hints?.get(c);
        return { name: c, message: c, ...(hint ? { hint } : {}) };
      }),
      { name: OTHER_PATH, message: OTHER_PATH },
      { name: SKIP_BUILD, message: SKIP_BUILD, hint: 'set it in tapsmith.config.ts later' },
    ],
  });
  if (picked === SKIP_BUILD) return undefined;
  if (picked !== OTHER_PATH) return picked;
  return typed(opts.typeMessage);
}

const OTHER_ID = 'Enter another…';

/**
 * Ask for an app id (a package name or bundle identifier), which the user may
 * leave for later (PILOT-778). A known id (`suggested`, with where it came
 * from) is offered as a select, first and pre-selected, beside a way to type
 * another and "Skip for now": an input's `initial` would make Enter take the
 * id, so it could never be skipped the way its prompt says. With nothing to
 * suggest it is an input, where Enter with nothing typed skips it.
 */
async function askAppId(message: string, suggested?: { id: string; source: string }): Promise<string | undefined> {
  const typed = async (): Promise<string | undefined> => (await ask<string>({
    type: 'input',
    message: `${message} ${dim('(Enter to skip)')}`,
  })).trim() || undefined;
  if (!suggested) return typed();
  const picked = await ask<string>({
    type: 'select',
    message,
    choices: [
      { name: suggested.id, message: suggested.id, hint: suggested.source },
      { name: OTHER_ID, message: OTHER_ID },
      { name: SKIP_BUILD, message: SKIP_BUILD, hint: 'set it in tapsmith.config.ts later' },
    ],
  });
  if (picked === SKIP_BUILD) return undefined;
  return picked === OTHER_ID ? typed() : picked;
}

/**
 * The simulator or device builds to offer: the project's own, else this
 * project's in Xcode's DerivedData (a build from the Xcode UI), hinted as
 * this Mac's only (PILOT-832), as `init --yes` takes them.
 */
function iosBuildCandidates(sdk: 'iphonesimulator' | 'iphoneos'): { candidates: string[]; hints: Map<string, string> } {
  const cwd = process.cwd();
  const own = sdk === 'iphonesimulator' ? findIosAppCandidates(cwd) : findIosDeviceAppCandidates(cwd);
  if (own.length > 0) return { candidates: own, hints: new Map() };
  const derived = findDerivedDataApps(cwd, detectProjectLayout(cwd).iosProjects, sdk);
  return { candidates: derived, hints: new Map(derived.map((d) => [d, 'Xcode DerivedData: this Mac only'])) };
}

/** Debug APKs first (the build `init --yes` prefers), then the rest. */
function orderApkCandidates(candidates: string[]): string[] {
  const debug = preferDebugApk(candidates);
  return debug.length === candidates.length ? candidates : [...debug, ...candidates.filter((c) => !debug.includes(c))];
}

// ─── Platform-specific questions ───

export type Platform = 'android' | 'ios';

export interface AndroidConfig {
  /** Unset for a package-only config: the app is installed already. */
  apkPath?: string;
  packageName?: string;
  useEmulators: boolean;
  usePhysicalDevices: boolean;
  avd?: string;
}

export interface IosConfig {
  /** Simulator build. Unset only when the user runs on physical devices alone. */
  appPath?: string;
  bundleId?: string;
  /**
   * The device build's bundle id, when it differs from `bundleId` (per-configuration
   * ids); `null` when the user skipped it beside a simulator id, so
   * the simulator's never stands in for it.
   */
  deviceBundleId?: string | null;
  simulator?: string;
  /**
   * Set when `simulator` is a custom name, only on this Mac: the
   * simulator's device type, which the config's comment offers instead.
   */
  simulatorDeviceType?: string;
  usePhysicalDevice: boolean;
  /** Device-signed (iphoneos) build; set whenever `usePhysicalDevice` is. */
  deviceAppPath?: string;
}

// ─── AVD choice and HTTPS capture (PILOT-403) ───

/**
 * The wizard's AVD picker: list order kept, Google Play images marked (HTTPS
 * is never captured on them), and the AVD `init --yes` would choose
 * pre-selected ({@link preferredAvd}: a capture-capable one first). The
 * capture question comes later and defaults to yes on a capable AVD.
 */
export function avdPickerChoices(
  avds: string[],
  avdImages: AvdImageInfo[],
): { choices: Array<{ name: string; message: string; hint?: string }>; initial: number } {
  const support = avds.map((name) => avdCaptureSupport(avdImages.find((a) => a.name === name)));
  const choices = avds.map((name, i) => (support[i] === 'play-image'
    ? { name, message: name, hint: 'no HTTPS capture' }
    : { name, message: name }));
  const preferred = preferredAvd(avds, avdImages);
  return { choices, initial: preferred === undefined ? 0 : avds.indexOf(preferred) };
}

/**
 * The capture question's default: no when the only thing set up
 * is an Android emulator on a Google Play image, where HTTPS cannot be
 * captured, with the reason for the prompt. iOS capture works, so a mixed
 * setup keeps yes (and the Android warning still prints).
 */
export function networkCaptureDefault(
  platforms: Platform[],
  androidConfig: AndroidConfig | undefined,
  avdImages: AvdImageInfo[],
): { initial: boolean; reason?: string } {
  const avd = androidConfig?.useEmulators ? androidConfig.avd : undefined;
  if (platforms.includes('ios') || avd === undefined) return { initial: true };
  if (avdCaptureSupport(avdImages.find((a) => a.name === avd)) !== 'play-image') return { initial: true };
  return { initial: false, reason: `AVD ${avd} can't capture HTTPS: it uses a Google Play system image` };
}

/** The wizard's network-capture summary line for the Android emulator. */
export function androidEmulatorCaptureLine(avd: string | undefined, avdImages: AvdImageInfo[], adbFound: boolean): string {
  if (!adbFound) {
    // configureAndroid has already printed the fix. A Play image still needs
    // saying: it is why capture will record nothing once adb is fixed.
    const playWarning = avd ? avdCaptureWarning(avd, avdImages) : undefined;
    const line = `  ${YELLOW}⚠${RESET} Android emulator — ADB not found, so Tapsmith cannot reach it yet (see the ADB warning above)`;
    return playWarning ? `${line}\n  ${YELLOW}⚠${RESET} Android emulator — ${playWarning}` : line;
  }
  // The picker always returns an AVD, so no AVD means `emulator -list-avds`
  // listed none — configureAndroid has already printed why.
  if (!avd) return `  ${YELLOW}⚠${RESET} Android emulator — no AVD selected (see the AVD warning above)`;
  const warning = avdCaptureWarning(avd, avdImages);
  return warning
    ? `  ${YELLOW}⚠${RESET} Android emulator — ${warning}`
    : `  ${green('✓')} Android emulator (${avd}) — works automatically`;
}

// ─── Platform choice (PILOT-721) ───

/**
 * The platform prompt: Android, and on macOS iOS and Both, each that cannot
 * run here hinted with why, and a default that can. The project's layout
 * narrows it (an iOS-only project means iOS, both mean Both, as `init --yes`
 * infers from `android/`, `ios/`, a root `settings.gradle` or an Xcode
 * project), then the toolchains: Android needs adb, iOS needs
 * Xcode and a simulator. A project with neither gets Android when adb is
 * there, else iOS when it can run. Both narrows to the one platform with a
 * build (`builds`): the other has nothing to test yet.
 */
export function platformPrompt(
  env: EnvScan,
  layout: { hasAndroidProject: boolean; hasIosProject: boolean },
  builds: { android: boolean; ios: boolean } = { android: false, ios: false },
): { choices: Array<{ name: string; message: string; hint?: string }>; initial: number } {
  const androidHint = env.adbVersion ? undefined : env.adbOffPath ? 'adb not on PATH' : 'ADB not found';
  if (!env.isMacOS) return { choices: [{ name: 'android', message: 'Android', ...(androidHint ? { hint: androidHint } : {}) }], initial: 0 };
  const iosHint = !env.xcodeVersion
    ? 'Xcode not found'
    : simulatorChoices(env.simulators).length === 0 ? 'no iOS simulators found' : undefined;
  const choices = [
    { name: 'android', message: 'Android', ...(androidHint ? { hint: androidHint } : {}) },
    { name: 'ios', message: 'iOS', ...(iosHint ? { hint: iosHint } : {}) },
    { name: 'both', message: 'Both' },
  ];
  const androidOk = !androidHint;
  const iosOk = !iosHint;
  const { hasAndroidProject, hasIosProject } = layout;
  let pick: 'android' | 'ios' | 'both';
  if (hasAndroidProject || hasIosProject) {
    const android = hasAndroidProject && androidOk;
    const ios = hasIosProject && iosOk;
    if (android && ios) pick = 'both';
    else if (android) pick = 'android';
    else if (ios) pick = 'ios';
    // Nothing the layout names can run yet: the layout still says what the project is.
    else pick = hasAndroidProject && hasIosProject ? 'both' : hasIosProject ? 'ios' : 'android';
  } else {
    pick = !androidOk && iosOk ? 'ios' : 'android';
  }
  if (pick === 'both' && builds.android !== builds.ios) pick = builds.android ? 'android' : 'ios';
  return { choices, initial: choices.findIndex((c) => c.name === pick) };
}

/**
 * The Android questions. `expo` swaps the build hint for the Expo
 * one and prefills the package prompt from the app config.
 */
export async function configureAndroid(env: EnvScan, expo?: ExpoProject, cli = 'npx tapsmith'): Promise<AndroidConfig> {
  console.log(`  ${bold('Android')}`);
  if (!env.adbVersion) {
    console.log(`  ${YELLOW}⚠${RESET} ${env.adbOffPath ? 'ADB is not on PATH' : 'ADB not found'} — Tapsmith cannot reach Android devices or emulators until it is on PATH`);
    console.log(dim(`    ${adbMissingFix()}`));
  }

  const cwd = process.cwd();
  const layout = detectProjectLayout(cwd);
  const apkPath = await askBuildPath({
    kind: 'apk',
    message: 'Where is your Android APK?',
    candidates: orderApkCandidates(findApkCandidates(cwd)),
    noneFound: expo
      ? `No APK found in the project's build outputs (${apkSearchedIn(layout)}). ${expoBuildHint(['android'], expo, 'Or enter its path.')}`
      : `No APK found in the project's build outputs (${apkSearchedIn(layout)}). ${nativeBuildHint('android', layout, isReactNativeProject(cwd))}, or enter its path.`,
    typeMessage: 'Path to your Android APK:',
  });

  let packageName = apkPath ? detectAndroidPackage(apkPath) : undefined;
  if (packageName) {
    console.log(dim(`  Detected package: ${packageName}`));
  } else {
    console.log(dim(apkPath
      ? `  Could not read the package name from ${apkPath} (needs aapt2 from the Android SDK build-tools).`
      : '  No APK yet. If the app is installed on the device already, give its package name: Tapsmith launches it by that.'));
    // The app config's id, else the Gradle module's (PILOT-778): either is
    // what a build of this project carries.
    const gradleId = expo?.androidPackage ? undefined : detectGradleApplicationId(cwd, layout);
    const suggested = expo?.androidPackage
      ? { id: expo.androidPackage, source: 'from the Expo app config' }
      : gradleId ? { id: gradleId, source: "the app module's applicationId" } : undefined;
    packageName = await askAppId('What is your app\'s package name?', suggested);
  }
  if (!apkPath && packageName) {
    // As `init --yes --package` says it (PILOT-721).
    console.log(`  ${YELLOW}⚠${RESET} No APK, so the config has no apk: Tapsmith will launch and reset ${packageName} but cannot install it — install the app on the device yourself, or add apk: '<path>' to tapsmith.config.ts`);
  }

  const deviceType = await ask<string>({
    type: 'select',
    message: 'How will you run Android tests?',
    choices: [
      { name: 'emulators', message: 'Emulators', hint: 'Tapsmith auto-launches emulators' },
      { name: 'physical', message: 'Physical devices', hint: 'USB-connected devices' },
      { name: 'both', message: 'Both' },
    ],
  });

  const useEmulators = deviceType === 'emulators' || deviceType === 'both';
  let avd: string | undefined;

  if (useEmulators && env.avds.length > 0) {
    const { choices, initial } = avdPickerChoices(env.avds, env.avdImages);
    avd = await ask<string>({
      type: 'select',
      message: 'Which AVD should Tapsmith auto-launch?',
      choices,
      initial,
    });
  } else if (useEmulators) {
    console.log(`  ${YELLOW}⚠${RESET} ${withTapsmithCommand(noAvdsListedMessage(env.avdImages), cli)}`);
  }

  if (deviceType === 'physical' || deviceType === 'both') {
    console.log(dim('  Make sure USB debugging is enabled on your device.'));
  }

  const usePhysicalDevices = deviceType === 'physical' || deviceType === 'both';
  return { apkPath, packageName, useEmulators, usePhysicalDevices, avd };
}

/** How many simulators the picker shows at once; the rest scroll into view. */
const SIMULATOR_PICKER_ROWS = 12;

/**
 * The iOS questions. `expo` swaps the simulator build hint for
 * the Expo one and is the last fallback for the bundle id prompt's prefill.
 */
export async function configureIos(env: EnvScan, expo?: ExpoProject, cli = 'npx tapsmith'): Promise<IosConfig> {
  console.log(`  ${bold('iOS')}`);

  // Device type first: a physical-only user has no use for a simulator
  // build, and the device build is what their config must point at.
  const deviceType = await ask<string>({
    type: 'select',
    message: 'How will you run iOS tests?',
    choices: [
      { name: 'simulators', message: 'Simulators' },
      { name: 'physical', message: 'Physical devices', hint: 'requires code signing' },
      { name: 'both', message: 'Both' },
    ],
  });
  const useSimulators = deviceType === 'simulators' || deviceType === 'both';

  let appPath: string | undefined;
  let simBundleId: string | undefined;
  if (useSimulators) {
    const cwd = process.cwd();
    const builds = iosBuildCandidates('iphonesimulator');
    appPath = await askBuildPath({
      kind: 'simulator-app',
      message: 'Where is your iOS .app bundle? (simulator build)',
      ...builds,
      noneFound: expo
        ? `No simulator build (.app) found in the project or Xcode's DerivedData. ${expoBuildHint(['ios'], expo, 'Or enter its path.')}`
        : `No simulator build (.app) found in the project or Xcode's DerivedData. ${nativeBuildHint('ios', detectProjectLayout(cwd), isReactNativeProject(cwd))}, or enter its path.`,
      typeMessage: 'Path to your simulator build (.app):',
    });
    if (appPath && builds.hints.has(appPath)) console.log(`  ${YELLOW}⚠${RESET} ${derivedDataBuildWarning(appPath, detectProjectLayout(cwd), 'iphonesimulator', isReactNativeProject(cwd))}`);
    simBundleId = appPath ? detectBundleId(appPath) : undefined;
  }

  let simulator: string | undefined;
  let simulatorDeviceType: string | undefined;
  if (useSimulators) {
    // Every simulator, stock names first, then a booted one, the first
    // selected (PILOT-562, PILOT-721).
    const choices = simulatorChoices(env.simulators);
    if (choices.length > 0) {
      simulator = await ask<string>({
        type: 'select',
        message: choices.length > SIMULATOR_PICKER_ROWS
          ? `Which simulator? (${choices.length} available, ↑/↓ to scroll)`
          : 'Which simulator?',
        choices: choices.map((s) => ({
          name: s.name,
          message: s.name,
          hint: [s.runtime, ...(s.state === 'Booted' ? ['booted'] : []), ...(isCustomSimulatorName(s) ? ['custom name: this Mac only'] : [])].join(', '),
        })),
        initial: 0,
        limit: SIMULATOR_PICKER_ROWS,
      });
      simulatorDeviceType = customSimulatorDeviceType(simulator, env);
    } else {
      console.log(`  ${YELLOW}⚠${RESET} No iOS simulators found. Install one via Xcode.`);
      simulator = 'iPhone 17';
    }
  }

  const usePhysicalDevice = deviceType === 'physical' || deviceType === 'both';
  let deviceAppPath: string | undefined;
  let deviceBundleIdRead: string | undefined;

  if (usePhysicalDevice) {
    console.log(`\n  ${bold('Physical iOS device preflight')}`);

    try {
      const {
        checkXcodeCommandLineTools,
        checkDevicectl,
        checkIproxy,
        checkSigningIdentities,
        checkDeviceConnection,
      } = await import('./setup-ios-device.js');

      const results = [
        checkXcodeCommandLineTools(),
        checkDevicectl(),
        checkIproxy(),
        checkSigningIdentities(),
        checkDeviceConnection(),
      ];

      let failures = 0;
      for (const r of results) {
        if (r.ok) {
          console.log(`  ${green('✓')} ${r.label}`);
        } else {
          failures++;
          console.log(`  ${RED}✗${RESET} ${r.label}${r.fix ? '\n    ' + r.fix.join('\n    ') : ''}`);
        }
      }
      if (failures > 0) {
        console.log(`\n  ${YELLOW}⚠${RESET} ${failures} preflight check(s) failed. Fix these before testing on physical devices.`);
      }
    } catch (err) {
      console.log(`  ${YELLOW}⚠${RESET} Could not run preflight: ${err instanceof Error ? err.message : String(err)}`);
    }

    const buildAgent = await ask<boolean>(confirmQuestion('Build the iOS agent for physical devices? (requires Xcode, ~30s)', true));

    if (buildAgent) {
      console.log(dim('  Building iOS agent...'));
      try {
        const { buildIosAgent } = await import('./build-ios-agent.js');
        await buildIosAgent({ quiet: true });
        console.log(`  ${green('✓')} iOS agent built`);
      } catch (err) {
        console.log(`  ${YELLOW}⚠${RESET} iOS agent build failed: ${err instanceof Error ? err.message : String(err)}`);
        console.log(dim(`  You can run \`${cli} ios build-agent\` later.`));
      }
    }

    const deviceBuilds = iosBuildCandidates('iphoneos');
    deviceAppPath = await askBuildPath({
      kind: 'device-app',
      message: 'Where is your device build .app? (must be an iphoneos build, not simulator)',
      ...deviceBuilds,
      noneFound: expo && !expo.hasIosDir
        ? 'No device build (.app) found: this Expo project has no ios/ yet. Generate it with `npx expo prebuild --platform ios`, then build it for iphoneos (see https://tapsmith.dev/platform/ios-physical-devices/), or enter its path.'
        : detectProjectLayout(process.cwd()).flutter
        ? `No device build (.app) found in the project or Xcode's DerivedData — ${FLUTTER_DEVICE_BUILD_HINT} (see https://tapsmith.dev/platform/ios-physical-devices/), or enter its path.`
        : 'No device build (.app) found in the project or Xcode\'s DerivedData — build one for iphoneos first (see https://tapsmith.dev/platform/ios-physical-devices/), or enter its path.',
      typeMessage: 'Path to your device build (iphoneos .app):',
    });
    if (deviceAppPath && deviceBuilds.hints.has(deviceAppPath)) {
      console.log(`  ${YELLOW}⚠${RESET} ${derivedDataBuildWarning(deviceAppPath, detectProjectLayout(process.cwd()), 'iphoneos')}`);
    }
    deviceBundleIdRead = deviceAppPath ? detectBundleId(deviceAppPath) : undefined;
  }

  // Each build's id is read from its Info.plist, else asked for. Simulator
  // and device builds can carry different ids (Debug vs Release), so one
  // never silently stands in for the other: the unread one's prompt only
  // suggests the other's. Either can be left for later (PILOT-778).
  const both = useSimulators && usePhysicalDevice;
  const suggest = (other: string | undefined, otherSource: string): { id: string; source: string } | undefined => (other
    ? { id: other, source: otherSource }
    : expo?.iosBundleId ? { id: expo.iosBundleId, source: 'from the Expo app config' } : undefined);
  if (useSimulators && !simBundleId) {
    simBundleId = await askAppId(
      both ? 'What is your simulator build\'s bundle identifier?' : 'What is your app\'s bundle identifier?',
      suggest(deviceBundleIdRead, "the device build's id"),
    );
  }
  if (usePhysicalDevice && !deviceBundleIdRead) {
    deviceBundleIdRead = await askAppId(
      both ? 'What is your device build\'s bundle identifier?' : 'What is your app\'s bundle identifier?',
      suggest(simBundleId, "the simulator build's id"),
    );
  }
  // Of simulators and devices, a target with neither build nor id is left
  // out beside one set up, as a platform is (PILOT-778): its placeholder-only
  // project would fail the first run of every project.
  let keepSim = useSimulators;
  let keepDevice = usePhysicalDevice;
  if (both) {
    const simEmpty = !appPath && simBundleId === undefined;
    const deviceEmpty = !deviceAppPath && deviceBundleIdRead === undefined;
    if (simEmpty !== deviceEmpty) {
      if (simEmpty) keepSim = false;
      else keepDevice = false;
      const left = simEmpty ? 'simulators' : 'physical devices';
      console.log(`  ${YELLOW}⚠${RESET} iOS ${left} left out of the config: no ${simEmpty ? 'simulator' : 'device'} build or bundle identifier yet. Once you have one, run \`${cli} init\` again to add ${simEmpty ? 'them' : 'it'}.`);
    }
  }
  const bothKept = keepSim && keepDevice;
  // With both, each target keeps its own id, a skipped one too (PILOT-778).
  const bundleId = keepSim ? simBundleId : deviceBundleIdRead;
  const deviceBundleId = !bothKept ? undefined
    : deviceBundleIdRead === undefined ? (simBundleId === undefined ? undefined : null)
    : deviceBundleIdRead !== simBundleId ? deviceBundleIdRead : undefined;

  return {
    ...(keepSim ? { appPath, simulator, ...(simulatorDeviceType ? { simulatorDeviceType } : {}) } : {}),
    bundleId,
    deviceBundleId,
    usePhysicalDevice: keepDevice,
    ...(keepDevice ? { deviceAppPath } : {}),
  };
}

/**
 * The device type of the simulator named `name`, when that name is a custom
 * one only this Mac has; undefined for a stock name, a UDID or a
 * name init does not know.
 */
export function customSimulatorDeviceType(name: string, env: EnvScan): string | undefined {
  const sim = simulatorChoices(env.simulators).find((s) => s.name === name);
  return sim && isCustomSimulatorName(sim) ? sim.deviceTypeName : undefined;
}

function detectBundleId(appPath: string): string | undefined {
  const detected = detectIosBundleId(appPath);
  if (detected) console.log(dim(`  Detected bundle ID: ${detected}`));
  return detected;
}

// ─── Network capture setup ───

/**
 * The network capture summary line for iOS simulators: what
 * still needs doing, judged as `doctor` judges it — mitmproxy's redirector
 * (`source`, from `mitmproxyRedirectorSource`) and then its Network
 * Extension. `cli` is how the project runs Tapsmith (`npx tapsmith`).
 */
export function iosSimulatorCaptureLine(source: string | undefined, seStatus: SeStatus, cli: string): string {
  const setup = `\`${cli} ios network setup-simulator\``;
  if (!source) return `  ${YELLOW}⚠${RESET} iOS simulator — run \`brew install mitmproxy\`, then ${setup}`;
  switch (seStatus) {
    case 'enabled':
      return `  ${green('✓')} iOS simulator — ready (mitmproxy and its Network Extension)`;
    case 'not-registered':
      // A fresh machine: nothing to do until the first run, which asks.
      return `  ${green('✓')} iOS simulator — mitmproxy installed; macOS asks you to allow its Network Extension on your first iOS simulator test run`;
    case 'waiting-for-user':
      return `  ${YELLOW}⚠${RESET} iOS simulator — approve mitmproxy's Network Extension: run ${setup}`;
    default:
      return `  ${YELLOW}⚠${RESET} iOS simulator — mitmproxy installed, but its Network Extension's state is unclear: run ${setup}`;
  }
}

async function setupNetworkCapture(
  platforms: Platform[],
  env: EnvScan,
  androidConfig: AndroidConfig | undefined,
  iosConfig: IosConfig | undefined,
  cli: string,
): Promise<boolean> {
  const { initial, reason } = networkCaptureDefault(platforms, androidConfig, env.avdImages);
  const why = reason ? ` — ${reason}` : '';
  const enableNetwork = await ask<boolean>(confirmQuestion(`Enable network trace capture? (records HTTP/HTTPS traffic during tests${why})`, initial));

  if (!enableNetwork) return false;

  const lines: string[] = [];

  if (platforms.includes('android') && androidConfig) {
    if (androidConfig.useEmulators) {
      lines.push(androidEmulatorCaptureLine(androidConfig.avd, env.avdImages, !!env.adbVersion));
    }
    if (androidConfig.usePhysicalDevices) {
      lines.push(`  ${YELLOW}⚠${RESET} Android physical — add the Tapsmith CA to your app's res/xml/network_security_config.xml:`);
      lines.push(dim('    <network-security-config>'));
      lines.push(dim('      <debug-overrides><trust-anchors>'));
      lines.push(dim('        <certificates src="user" />'));
      lines.push(dim('      </trust-anchors></debug-overrides>'));
      lines.push(dim('    </network-security-config>'));
    }
  }

  if (iosConfig?.simulator && env.isMacOS) {
    // doctor's detection (PILOT-721), and only the step still missing.
    const { checkSeStatus, mitmproxyRedirectorSource } = await import('./setup-ios.js');
    const source = mitmproxyRedirectorSource();
    lines.push(iosSimulatorCaptureLine(source, source ? checkSeStatus() : 'not-registered', cli));
  }

  if (iosConfig?.usePhysicalDevice) {
    lines.push(`  ${YELLOW}⚠${RESET} iOS physical — run \`${cli} ios network configure <udid>\` per device`);
  }

  if (lines.length > 0) {
    console.log(`\n  ${bold('Network capture')}`);
    console.log(withTapsmithCommand(lines.join('\n'), cli));
  }

  return true;
}

// ─── iOS simulator agent ───

/** init's bound on the simulator agent build (the first test run has none). */
const INIT_AGENT_BUILD_TIMEOUT_MS = 300_000;

/**
 * Make sure the iOS simulator agent is built, using the same builder (and so
 * the same SDK-matched cache) the first test run uses. Its progress lines are
 * suppressed so `init --json` keeps a clean stdout; its output goes to a
 * build log the error names.
 */
export async function initSimulatorAgent(): Promise<{ status: 'present' | 'built' | 'failed'; error?: string }> {
  try {
    const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
    const existing = findSimulatorXctestrun();
    const { ensureSimulatorAgent } = await import('./ios-simulator-build.js');
    const xctestrun = await ensureSimulatorAgent({ quiet: true, timeoutMs: INIT_AGENT_BUILD_TIMEOUT_MS });
    return { status: xctestrun === existing ? 'present' : 'built' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Installing Tapsmith in the project (PILOT-551) ───

/** Runs an install with the user's terminal attached: true, or why it failed. */
function runInstallCommand(install: InstallCommand, cwd: string): true | string {
  const result = spawnSync(install.command, install.args, {
    cwd,
    stdio: 'inherit',
    // npm, yarn and pnpm are .cmd shims on Windows, which only a shell runs.
    shell: process.platform === 'win32',
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? `${install.command} was not found on PATH` : result.error.message;
  }
  if (result.status !== 0) {
    return result.signal ? `${install.command} was killed by ${result.signal}` : `${install.command} exited with code ${result.status}`;
  }
  return true;
}

/** The user cancelled the wizard at a point where "Setup cancelled." alone would mislead; the message says what was done. */
class SetupCancelled extends Error {}

/**
 * `npx tapsmith init` and a global install run from outside the project, but
 * the config and example test import `tapsmith`. When the project cannot
 * resolve it, offer the project's package manager's install and run it.
 * Returns the command still to run (declined, failed, or not offered because
 * there is no package.json here — npm would install into whichever ancestor
 * has one, so the command creates one first and a warning says why),
 * or undefined when Tapsmith is in place. Cancelling the prompt
 * throws SetupCancelled.
 */
export async function offerTapsmithInstall(
  cwd: string,
  run: (install: InstallCommand, cwd: string) => true | string = runInstallCommand,
): Promise<string | undefined> {
  if (isTapsmithResolvableFrom(cwd)) return undefined;
  const install = await tapsmithInstallCommand(cwd);
  if (!fs.existsSync(path.join(cwd, 'package.json'))) {
    if (install.note) console.log(`  ${YELLOW}⚠${RESET} ${install.note}`);
    return install.display;
  }

  let go: boolean;
  try {
    go = await ask<boolean>(confirmQuestion(`Tapsmith isn't installed in this project, and the config imports it. Install it now (${install.display})?`, true));
  } catch (err) {
    // Cancelled after the files are written: a bare "Setup cancelled." would
    // read as if nothing was (PILOT-518).
    if (isPromptCancel(err)) throw new SetupCancelled(`Setup cancelled. The files above are written, but Tapsmith is not installed: run ${install.display}`);
    throw err;
  }
  if (!go) return install.display;

  console.log(dim(`  Running ${install.display}...`));
  const result = run(install, cwd);
  if (result === true) {
    console.log(`  ${green('✓')} Tapsmith installed`);
    return undefined;
  }
  // A failed exit is not always a failed install: pnpm 11 and later install
  // everything, then exit 1 over the dependency build scripts they skipped.
  // What the config needs is an importable `tapsmith`.
  if (!isTapsmithResolvableFrom(cwd)) {
    console.log(`  ${YELLOW}⚠${RESET} Could not install Tapsmith: ${result}`);
    return install.display;
  }
  console.log(`  ${green('✓')} Tapsmith installed ${dim(`(${result})`)}`);
  if (install.command === 'pnpm') console.log(dim(PNPM_IGNORED_BUILDS_HINT));
  return undefined;
}

/**
 * Warn when the project's own tapsmith cannot find the Android agent package
 * (pnpm 11+ skipped it as an optional dependency). The check reads
 * the project's install, not the copy of Tapsmith running init, which may be
 * npx's. Silent when the project has no tapsmith: the install step said so.
 */
export async function warnIfAndroidAgentMissing(cwd: string): Promise<void> {
  if (androidAgentInstalledFor(cwd) !== false) return;
  const advice = await missingAndroidAgentAdvice(cwd);
  console.log(`  ${YELLOW}⚠${RESET} Android agent not found — ${advice.why}`);
  console.log(dim(`    Run: ${advice.install}${advice.where ? ` (in ${advice.where})` : ''}`));
}

/**
 * pnpm 11+ fails an install with ERR_PNPM_IGNORED_BUILDS when a dependency has
 * a build script nobody approved: here esbuild (through tsx) and protobufjs
 * (through gRPC). Tapsmith does not need either script (PILOT-560), and a
 * dependency cannot approve or deny them for the project, so say how.
 */
const PNPM_IGNORED_BUILDS_HINT = [
  '  pnpm stopped over the build scripts it skipped (esbuild, protobufjs). Tapsmith does not need them.',
  '  To record that and silence the error, set them to false in the pnpm-workspace.yaml beside pnpm-lock.yaml',
  '  (in a monorepo, the one at the workspace root), replacing any "set this to true or false" pnpm wrote there:',
  '    allowBuilds:',
  '      esbuild: false',
  '      protobufjs: false',
].join('\n');

// ─── Config generation ───

/**
 * The iOS targets the user picked. A scope with no `simulator` is a
 * physical-device run (the runner auto-detects the paired device), so a
 * simulator target is one with a simulator (set only when the user chose
 * simulators), and the device target must not inherit it. Either target's
 * build may be missing: the user skipped it (PILOT-778), and the config gets
 * a placeholder for it.
 */
function iosTargets(ios: IosConfig | undefined): {
  sim?: { app?: string; pkg?: string; simulator: string };
  device?: { app?: string; pkg?: string };
} {
  return {
    sim: ios?.simulator ? { app: ios.appPath, pkg: ios.bundleId, simulator: ios.simulator } : undefined,
    device: ios?.usePhysicalDevice
      ? { app: ios.deviceAppPath, pkg: ios.deviceBundleId === null ? undefined : ios.deviceBundleId ?? ios.bundleId }
      : undefined,
  };
}

/**
 * A platform the user set up with neither a build nor an app id: they skipped
 * both, so its config scope can only hold placeholders.
 */
export function isUnconfigured(platform: Platform, android: AndroidConfig | undefined, ios: IosConfig | undefined): boolean {
  if (platform === 'android') return !android?.apkPath && !android?.packageName;
  return !ios?.appPath && !ios?.deviceAppPath && !ios?.bundleId && !ios?.deviceBundleId;
}

/**
 * The platforms the config keeps: of two, one with nothing set up
 * is left out — a placeholder scope there would fail the first `verify` or
 * `test` that runs every project. A lone platform, or both when neither is set
 * up, stays, with placeholders the next steps point at.
 */
export function platformsToWrite(
  platforms: Platform[],
  android: AndroidConfig | undefined,
  ios: IosConfig | undefined,
): { platforms: Platform[]; dropped: Platform[] } {
  const dropped = platforms.filter((p) => isUnconfigured(p, android, ios));
  if (dropped.length === 0 || dropped.length === platforms.length) return { platforms, dropped: [] };
  return { platforms: platforms.filter((p) => !dropped.includes(p)), dropped };
}

/**
 * The config keys the generated config leaves as placeholders, for the next
 * step that says to fill them in; empty when nothing is missing.
 * A package-only Android setup is complete.
 */
export function placeholderKeys(platforms: Platform[], android: AndroidConfig | undefined, ios: IosConfig | undefined): string[] {
  const keys = new Set<string>();
  if (platforms.includes('android') && android) {
    if (!android.apkPath && !android.packageName) keys.add('apk');
    if (!android.packageName) keys.add('package');
  }
  if (platforms.includes('ios') && ios) {
    const { sim, device } = iosTargets(ios);
    if ((sim && !sim.app) || (device && !device.app)) keys.add('app');
    if ((sim && !sim.pkg) || (device && !device.pkg)) keys.add('package');
  }
  return [...keys];
}

/**
 * Whether init should build the iOS simulator agent: only for a plan with a
 * simulator target (the one generateConfig() writes). A physical-only plan
 * needs the signed device build (`tapsmith ios build-agent`) instead.
 */
export function needsSimulatorAgent(ios: IosConfig | undefined): boolean {
  return iosTargets(ios).sim !== undefined;
}

/**
 * The `--project` names generateConfig() writes, with a label for the
 * wizard's next steps. Empty when the config has no projects.
 */
export function generatedProjects(
  platforms: Platform[],
  ios: IosConfig | undefined,
): Array<{ name: string; label: string }> {
  const { sim, device: deviceTarget } = iosTargets(ios);
  const device = !!deviceTarget;
  const multi = platforms.length > 1;
  if (!multi && !(platforms[0] === 'ios' && sim && device)) return [];
  const out: Array<{ name: string; label: string }> = [];
  if (multi) out.push({ name: 'android', label: 'Run Android only' });
  if (sim) out.push({ name: 'ios', label: device ? 'Run iOS simulator only' : 'Run iOS only' });
  if (device) out.push({ name: 'ios-device', label: sim ? 'Run iOS device only' : 'Run iOS only' });
  return out;
}

/**
 * Where init scaffolds its example test, and the `testMatch` the generated
 * config uses. Jest and Vitest run every `*.test.ts` / `*.spec.ts`
 * file by default, so a scaffold with that suffix breaks the project's own
 * unit-test run, and Tapsmith's default `testMatch` would in turn pick up the
 * project's unit tests. The distinct suffix keeps the two suites apart without
 * touching the project's Jest or Vitest config (Cypress's `*.cy.ts` precedent).
 */
export const EXAMPLE_TEST_PATH = 'tests/example.tapsmith.ts';
export const GENERATED_TEST_MATCH = ['**/*.tapsmith.ts'];

const GENERATED_TEST_MATCH_LINES = [
  '  // Tapsmith tests end in .tapsmith.ts: Jest and Vitest run every *.test.ts',
  "  // file, so this suffix keeps each suite out of the other's way.",
  `  testMatch: [${GENERATED_TEST_MATCH.map((g) => `'${g}'`).join(', ')}],`,
];

export function generateConfig(
  platforms: Platform[],
  android: AndroidConfig | undefined,
  ios: IosConfig | undefined,
  enableNetwork: boolean,
): string {
  const lines: string[] = [];
  lines.push("import { defineConfig } from 'tapsmith'");
  lines.push('');
  lines.push('export default defineConfig({');

  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  // A custom simulator name resolves only on this Mac (PILOT-721).
  const simulatorLines = (indent: string, iosCfg: IosConfig, simulator: string): string[] => [
    ...(iosCfg.simulatorDeviceType
      ? [
        `${indent}// A custom simulator name, only on this Mac: teammates and CI need a simulator`,
        `${indent}// with this exact name. A stock one such as '${esc(iosCfg.simulatorDeviceType).replace(/[\r\n]+/g, ' ')}' works anywhere it is installed.`,
      ]
      : []),
    `${indent}simulator: '${esc(simulator)}',`,
  ];

  // What the user skipped (PILOT-778), commented out under one line saying
  // what to do; the wizard's next steps point here.
  const placeholders = (indent: string, keys: Array<[string, string]>): string[] => (keys.length === 0 ? [] : [
    `${indent}// Not set up yet: build your app, then uncomment and fill in.`,
    ...keys.map(([key, value]) => `${indent}// ${key}: '${value}',`),
  ]);
  const APP_ID = (platform: Platform): [string, string] => ['package', platform === 'android' ? '<applicationId>' : '<bundle identifier>'];

  lines.push(...GENERATED_TEST_MATCH_LINES);
  if (enableNetwork) lines.push("  trace: { mode: 'retain-on-failure' },");

  const { sim: iosSim, device: iosDevice } = iosTargets(ios);

  /** An Android scope's keys; a package-only scope is complete (PILOT-721). */
  const androidLines = (indent: string, a: AndroidConfig): string[] => [
    ...(a.packageName ? [`${indent}package: '${esc(a.packageName)}',`] : []),
    ...(a.apkPath ? [`${indent}apk: '${esc(a.apkPath)}',`] : []),
    ...placeholders(indent, [
      ...(!a.apkPath && !a.packageName ? [['apk', '<path to your .apk>'] as [string, string]] : []),
      ...(!a.packageName ? [APP_ID('android')] : []),
    ]),
    ...(a.useEmulators && a.avd ? [`${indent}avd: '${esc(a.avd)}',`] : []),
  ];
  /** An iOS scope's `package` and `app`, or placeholders for the missing ones. */
  const iosAppLines = (indent: string, pkg: string | undefined, app: string | undefined, appPlaceholder: string): string[] => [
    ...(pkg ? [`${indent}package: '${esc(pkg)}',`] : []),
    ...(app ? [`${indent}app: '${esc(app)}',`] : []),
    ...placeholders(indent, [...(!pkg ? [APP_ID('ios')] : []), ...(!app ? [['app', appPlaceholder] as [string, string]] : [])]),
  ];
  const SIM_APP_PLACEHOLDER = '<path to your simulator build>.app';
  const DEVICE_APP_PLACEHOLDER = '<path to your iphoneos build>.app';

  const iosProjects = (out: string[], iosCfg: IosConfig): void => {
    if (iosSim) {
      out.push('    {');
      out.push("      name: 'ios',");
      out.push('      use: {');
      out.push("        platform: 'ios',");
      out.push(...iosAppLines('        ', iosSim.pkg, iosSim.app, SIM_APP_PLACEHOLDER));
      out.push(...simulatorLines('        ', iosCfg, iosSim.simulator));
      out.push('      },');
      out.push('    },');
    }
    if (iosDevice) {
      out.push('    {');
      out.push("      name: 'ios-device',");
      out.push('      workers: 1,');
      out.push('      use: {');
      out.push("        platform: 'ios',");
      out.push(...iosAppLines('        ', iosDevice.pkg, iosDevice.app, DEVICE_APP_PLACEHOLDER));
      out.push('      },');
      out.push('    },');
    }
  };

  if (platforms.length === 1 && platforms[0] === 'android' && android) {
    lines.push(...androidLines('  ', android));
  }

  if (platforms.length === 1 && platforms[0] === 'ios' && ios) {
    if (iosSim && iosDevice) {
      // Simulator and device: one project each, as in the multi-platform
      // config and docs/ios-physical-devices.md.
      lines.push('  projects: [');
      iosProjects(lines, ios);
      lines.push('  ],');
    } else {
      lines.push("  platform: 'ios',");
      if (iosDevice) {
        lines.push(...iosAppLines('  ', iosDevice.pkg, iosDevice.app, DEVICE_APP_PLACEHOLDER));
      } else if (iosSim) {
        lines.push(...iosAppLines('  ', iosSim.pkg, iosSim.app, SIM_APP_PLACEHOLDER));
        lines.push(...simulatorLines('  ', ios, iosSim.simulator));
      }
    }
  }

  if (platforms.length > 1 && android && ios) {
    lines.push('  projects: [');

    lines.push('    {');
    lines.push("      name: 'android',");
    lines.push('      use: {');
    lines.push("        platform: 'android',");
    lines.push(...androidLines('        ', android));
    lines.push('      },');
    lines.push('    },');

    iosProjects(lines, ios);

    lines.push('  ],');
  }

  lines.push('})');
  lines.push('');
  return lines.join('\n');
}

export function generateExampleTest(): string {
  return `import { test, expect } from 'tapsmith'

test('app launches successfully', async ({ device }) => {
  // Smoke check: the app from your config is running in the foreground.
  await expect.poll(() => device.getAppState()).toBe('foreground')

  // Next, assert on your app's first screen. Pick an element in
  // UI mode (npx tapsmith test --ui) to get a locator for it, for example:
  // await expect(device.getByRole('button', { name: 'Sign in' })).toBeVisible()
})
`;
}

/**
 * Writes the example test at EXAMPLE_TEST_PATH, unless a file is already
 * there: `'exists'` leaves it untouched.
 */
export function writeExampleTest(cwd: string): 'created' | 'exists' {
  const testPath = path.join(cwd, EXAMPLE_TEST_PATH);
  if (fs.existsSync(testPath)) return 'exists';
  fs.mkdirSync(path.dirname(testPath), { recursive: true });
  fs.writeFileSync(testPath, generateExampleTest());
  return 'created';
}

const IMPORT_PREFIX = String.raw`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)`;
const TAPSMITH_IMPORT = new RegExp(`${IMPORT_PREFIX}['"]tapsmith(?:/[^'"]*)?['"]`);
const RELATIVE_IMPORT = new RegExp(`${IMPORT_PREFIX}['"](\\.{1,2}/[^'"]+)['"]`, 'g');

/**
 * A test or hook body that destructures Tapsmith's `device` fixture
 * (`async ({ device }) =>`, `async ({ device }, testInfo) =>`) and drives it through Tapsmith's device API
 * (`device.getByRole(`, `device.tap(`, …). Both together mark a Tapsmith test
 * whatever module path (an alias, a chain of fixture modules) brings
 * `tapsmith` in; a Jest table test or factory that destructures a `device`
 * key does not call those methods on it.
 */
const DEVICE_FIXTURE = /\(\s*\{[^}]*\bdevice\b[^}]*\}\s*(?:,[^)]*)?\)\s*=>/;
const DEVICE_API = /\bdevice\.(?:getBy\w+|locator|element|tap|swipe|pressKey|launchApp|restartApp|resetApp|terminateApp|openDeepLink|route|waitFor\w*|takeScreenshot|unlock|hideKeyboard)\s*\(/;

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** The file a relative TypeScript import names: `./fixtures`, `./fixtures.js` or a directory's index. */
function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), specifier).replace(/\.[cm]?js$/, '');
  return [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
    .find((candidate) => /\.tsx?$/.test(candidate) && isFile(candidate));
}

/** Whether `file` is a file; a path that can't be probed (EACCES, ELOOP) is not one. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

/**
 * Whether a test file is a Tapsmith test: it imports `tapsmith`, directly or
 * through a local module one import away (the fixtures module AGENTS.md
 * recommends), or it drives the `device` fixture.
 */
function importsTapsmith(file: string): boolean {
  const source = readText(file);
  if (source === undefined) return false;
  if (TAPSMITH_IMPORT.test(source) || (DEVICE_FIXTURE.test(source) && DEVICE_API.test(source))) return true;
  for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
    const target = resolveRelativeImport(file, specifier);
    const imported = target ? readText(target) : undefined;
    if (imported !== undefined && TAPSMITH_IMPORT.test(imported)) return true;
  }
  return false;
}

/**
 * Tapsmith tests already in the project under the old `*.test.ts` /
 * `*.spec.ts` names (an earlier init's scaffold, say), which the generated
 * config's GENERATED_TEST_MATCH no longer runs. A file counts when
 * it looks like a Tapsmith test (see importsTapsmith()), so the project's own Jest or
 * Vitest tests don't. Paths are relative to `cwd`, with `/` separators, sorted.
 */
export function tapsmithTestsOutsideGeneratedMatch(cwd: string): string[] {
  let candidates: string[];
  try {
    candidates = globSync(['**/*.test.ts', '**/*.spec.ts'], {
      cwd,
      // Bounded, so init in a huge directory doesn't crawl it: tests live near the top.
      ignore: [...DEFAULT_TEST_IGNORE, '**/build/**'],
      maxDepth: 10,
      posix: true,
    });
  } catch {
    // Advisory, and init has already written the config: never fail init over it.
    return [];
  }
  return candidates
    .filter((file) => !GENERATED_TEST_MATCH.some((glob) => minimatch(file, glob)))
    .filter((file) => importsTapsmith(path.join(cwd, file)))
    .sort();
}

/** The warning for tapsmithTestsOutsideGeneratedMatch()'s files, or undefined when there are none. */
export function testsOutsideGeneratedMatchWarning(files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  const shown = files.slice(0, 5).join(', ');
  const more = files.length > 5 ? ` and ${files.length - 5} more` : '';
  return `The new tapsmith.config.ts runs only *.tapsmith.ts test files, so these existing Tapsmith tests won't run: ${shown}${more}. `
    + 'Rename each to end in .tapsmith.ts (Jest and Vitest also run *.test.ts and *.spec.ts files), or add its pattern to testMatch in tapsmith.config.ts';
}

// ─── Main wizard ───

/** The next step for a config with placeholders, or undefined when it has none. */
export function placeholderNextStep(keys: string[]): string | undefined {
  if (keys.length === 0) return undefined;
  const named = keys.length === 1 ? keys[0] : `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
  return `build your app, then set ${named} in tapsmith.config.ts`;
}

/**
 * The wizard's Next steps as `[label, command]`: a declined install first,
 * then what the config still needs (a build the user skipped),
 * then `tapsmith verify`, which getting-started has a new user
 * run before writing tests. Plain commands: `--json` is for agents.
 */
export function wizardNextSteps(
  cli: string,
  steps: {
    /** The install command, when Tapsmith is not installed. */
    install?: string;
    /** A Play-image AVD's step. */
    capture?: { label: string; action: string; optional: boolean };
    /** What the config still needs: {@link placeholderNextStep}. */
    app?: string;
    /** A Yarn Plug'n'Play project, which must switch linker before running tests. */
    yarnPnp?: boolean;
  } = {},
): Array<[string, string]> {
  const { install: installStep, capture: captureStep, app: appStep, yarnPnp } = steps;
  // A Play-image AVD (PILOT-711): the AVD to switch to — before the first
  // run when capture is on, else last, as an option.
  const capture = captureStep ? [[captureStep.label, withTapsmithCommand(captureStep.action, cli)] as [string, string]] : [];
  return [
    // Before the install, so that installs into node_modules.
    ...(yarnPnp ? [['Switch Yarn to node_modules', YARN_PNP_INIT_STEP] as [string, string]] : []),
    ...(installStep ? [['Install Tapsmith', installStep] as [string, string]] : []),
    ...(appStep ? [['Point it at your app', appStep] as [string, string]] : []),
    ...(captureStep?.optional ? [] : capture),
    ['Verify your setup', `${cli} verify`],
    ['Run your tests', `${cli} test`],
    ['List devices', `${cli} list-devices`],
    ['Health check', `${cli} doctor`],
    ...(captureStep?.optional ? capture : []),
  ];
}

/**
 * `text` with each `npx tapsmith` made `cli`, the project's own way to run
 * Tapsmith (`tapsmithExecCommand`), for messages built elsewhere.
 */
export function withTapsmithCommand(text: string, cli: string): string {
  return cli === 'npx tapsmith' ? text : text.replace(/\bnpx tapsmith\b/g, cli);
}

/** The fix for an unexpected init error: `--json` only for an agent that asked for JSON. */
const unexpectedFix = (json: boolean): string => `Run: npx tapsmith doctor${json ? ' --json' : ''} to check the environment`;

export async function runInit(opts: InitCommandOptions): Promise<void> {
  const { initArgsFromOptions, resolveInitPlan, executeInitPlan, InitError } = await import('./init-noninteractive.js');

  let parsed;
  try {
    parsed = initArgsFromOptions(opts);
  } catch (err) {
    const initErr = err instanceof InitError
      ? err
      : new InitError('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err), { fix: unexpectedFix(opts.json) });
    emitInitError(initErr, opts.json);
    process.exit(1);
    return;
  }

  const nonInteractive = parsed.yes || parsed.anySetupFlag;

  if (!nonInteractive && parsed.json && process.stdin.isTTY) {
    // The wizard's prompts cannot be JSON, and --json promises nothing else on stdout.
    const err = new InitError(
      'JSON_REQUIRES_YES',
      '--json needs a non-interactive run: the interactive wizard has no JSON output',
      { fix: 'Run: npx tapsmith init --yes --json (or pass a setup flag such as --platform)' },
    );
    emitInitError(err, true);
    process.exit(1);
  }

  if (!nonInteractive && !process.stdin.isTTY) {
    const err = new InitError(
      'NON_INTERACTIVE_TTY',
      'tapsmith init is an interactive wizard and stdin is not a TTY',
      { fix: 'Run non-interactively: npx tapsmith init --yes (see npx tapsmith init --help for all flags)' },
    );
    emitInitError(err, parsed.json);
    process.exit(1);
  }

  if (nonInteractive) {
    try {
      const env = scanEnvironment();
      const plan = resolveInitPlan(parsed, env);

      // Guard BEFORE the iOS agent build so a 5-minute xcodebuild is never
      // launched against a project that already has a config (unless --force).
      const { assertConfigWritable, assertProjectWritable } = await import('./init-noninteractive.js');
      assertConfigWritable(parsed.force);
      assertProjectWritable();

      if (needsSimulatorAgent(plan.ios)) {
        const agentResult = await initSimulatorAgent();
        if (agentResult.status === 'failed') {
          plan.warnings.push(`iOS simulator agent build failed (it will be retried on the first test run): ${agentResult.error ?? 'unknown error'}`);
        }
      }

      const cwd = process.cwd();
      const missingTapsmith = isTapsmithResolvableFrom(cwd) ? undefined : await tapsmithInstallCommand(cwd);
      const result = executeInitPlan(plan, parsed, cwd, missingTapsmith, await tapsmithExecCommand(cwd));

      if (parsed.json) {
        process.stdout.write(formatJson(result));
      } else {
        for (const f of result.filesCreated) console.log(`  ${green('✓')} ${f}`);
        // A warning may span lines (a build failure's excerpt and log path).
        for (const w of result.warnings) console.log(`  ${YELLOW}⚠${RESET} ${w.replace(/\n/g, '\n    ')}`);
        console.log();
        console.log(`  ${bold('Next steps')}`);
        for (const s of result.nextSteps) console.log(`  - ${s}`);
      }
      return;
    } catch (err) {
      const initErr = err instanceof InitError
        ? err
        : new InitError('UNEXPECTED_ERROR', err instanceof Error ? err.message : String(err), { fix: unexpectedFix(parsed.json) });
      emitInitError(initErr, parsed.json);
      process.exit(1);
    }
  }

  // Interactive wizard (unchanged path)
  try {
    await runInitInner();
  } catch (err) {
    console.log();
    if (err instanceof InitError) {
      emitInitError(err, false);
    } else if (err instanceof SetupCancelled || isPromptCancel(err)) {
      // Ctrl-C or Esc at a prompt: 130, as for SIGINT (PILOT-518).
      console.log(dim(`  ${err instanceof SetupCancelled ? err.message : 'Setup cancelled.'}`));
      console.log();
      process.exit(130);
      return;
    } else {
      console.error(`  ${RED}✗${RESET} ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
    process.exit(1);
  }
}

function emitInitError(err: { code: string; message: string; fix?: string; candidates?: string[] }, json: boolean): void {
  if (json) {
    process.stdout.write(formatJson(jsonError(err.code, err.message, { fix: err.fix, candidates: err.candidates })));
  } else {
    console.error(`  ${RED}✗${RESET} ${err.message}`);
    if (err.candidates) for (const c of err.candidates) console.error(`      - ${c}`);
    if (err.fix) console.error(`  ${YELLOW}→${RESET} ${err.fix}`);
  }
}

async function runInitInner(): Promise<void> {
  console.log();
  const banner = figlet.textSync('Tapsmith', { font: 'Three Point' });
  console.log(banner.split('\n').map((l) => `${GREEN}${l}${RESET}`).join('\n'));
  console.log(dim(`v${getVersion()}`));

  // Check for existing config
  const configNames = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js'];
  const cwd = process.cwd();
  // How this project runs Tapsmith, for every command printed (PILOT-721).
  const cli = await tapsmithExecCommand(cwd);
  const existingConfig = configNames.find((name) => fs.existsSync(path.resolve(cwd, name)));
  if (existingConfig) {
    const overwrite = await ask<boolean>(confirmQuestion(`Found existing ${existingConfig}. Overwrite it?`, false));
    if (!overwrite) {
      console.log(dim(`  Keeping existing config. Run \`${cli} verify\` to check your setup.`));
      return;
    }
  }

  // A project that cannot take the config fails now, not after every question
  // (PILOT-624). Declining the overwrite above needs no write access.
  const { assertProjectWritable } = await import('./init-noninteractive.js');
  assertProjectWritable();

  // Step 1: Environment scan
  const env = scanEnvironment();
  const expo = detectExpoProject(process.cwd());
  displayEnvironment(env, expo);
  // Said before the questions: `verify`, the first next step, refuses there (PILOT-778).
  const yarnPnp = projectUsesYarnPnp({ versions: process.versions, cwd });
  if (yarnPnp) {
    console.log(`  ${YELLOW}⚠${RESET} ${YARN_PNP_INIT_WARNING}`);
    console.log();
  }

  // Step 2: Platform selection, defaulting to one that can run (PILOT-721)
  const layout = detectProjectLayout(cwd);
  const platforms = platformPrompt(
    env,
    { hasAndroidProject: hasAndroidProject(layout), hasIosProject: hasIosProject(layout) },
    // Any build the questions would offer (PILOT-778).
    {
      android: findApkCandidates(cwd).length > 0,
      ios: env.isMacOS && (iosBuildCandidates('iphonesimulator').candidates.length > 0 || iosBuildCandidates('iphoneos').candidates.length > 0),
    },
  );
  const platformChoice = await ask<string>({
    type: 'select',
    message: 'Which platform(s) will you test?',
    choices: platforms.choices,
    initial: platforms.initial,
  });

  const chosenPlatforms: Platform[] = platformChoice === 'both'
    ? ['android', 'ios']
    : [platformChoice as Platform];

  // Step 3 & 4: Platform configuration
  let androidConfig: AndroidConfig | undefined;
  let iosConfig: IosConfig | undefined;

  if (chosenPlatforms.includes('android')) {
    androidConfig = await configureAndroid(env, expo, cli);
  }
  if (chosenPlatforms.includes('ios')) {
    iosConfig = await configureIos(env, expo, cli);
  }

  // A platform with nothing set up, beside one that is, is left out (PILOT-778).
  const { platforms: selectedPlatforms, dropped } = platformsToWrite(chosenPlatforms, androidConfig, iosConfig);
  for (const p of dropped) {
    const name = p === 'android' ? 'Android' : 'iOS';
    console.log(`  ${YELLOW}⚠${RESET} ${name} left out of the config: it has no build or ${p === 'android' ? 'package name' : 'bundle identifier'} yet. Once you have built it, run \`${cli} init\` again to add it.`);
    if (p === 'android') androidConfig = undefined;
    else iosConfig = undefined;
  }
  // Said only for what the config keeps (PILOT-778); the next steps repeat it.
  const placeholders = placeholderKeys(selectedPlatforms, androidConfig, iosConfig);
  if (placeholders.length > 0) {
    console.log(dim(`  tapsmith.config.ts gets placeholders for ${placeholders.join(', ')}: set ${placeholders.length === 1 ? 'it' : 'them'} once you have built the app.`));
  }

  // Step 5: Network capture
  const enableNetwork = await setupNetworkCapture(selectedPlatforms, env, androidConfig, iosConfig, cli);

  // Step 6: iOS simulator agent check
  if (needsSimulatorAgent(iosConfig)) {
    try {
      const { findSimulatorXctestrun } = await import('./ios-device-resolve.js');
      const xctestrun = findSimulatorXctestrun();
      if (!xctestrun) {
        const buildSim = await ask<boolean>(confirmQuestion('No iOS simulator agent found. Build it now? (~30s, requires Xcode)', true));

        if (buildSim) {
          console.log(dim('  Building iOS simulator agent...'));
          const result = await initSimulatorAgent();
          if (result.status === 'built' || result.status === 'present') {
            console.log(`  ${green('✓')} iOS simulator agent built`);
          } else if (result.error) {
            console.log(`  ${YELLOW}⚠${RESET} Build failed: ${result.error.replace(/\n/g, '\n    ')}`);
          } else {
            console.log(`  ${YELLOW}⚠${RESET} Build failed`);
          }
        }
      }
    } catch (err) {
      // A cancel at the build prompt ends the wizard like any other (PILOT-518).
      if (isPromptCancel(err)) throw err;
      // ios-device-resolve import failed — skip
    }
  }

  // Step 7: Example test and AGENTS.md. Asked before anything is written, so
  // a file that cannot be written stops init before it writes any (PILOT-624).
  const createTest = await ask<boolean>(confirmQuestion('Generate example test file?', true));
  const writeAgents = await ask<boolean>(confirmQuestion('Add a Tapsmith section to AGENTS.md? (helps AI coding agents use Tapsmith correctly)', true));

  // Step 8: Write the files; a failure throws WRITE_FAILED, which ends init.
  const { writeInitFiles } = await import('./init-noninteractive.js');
  const { written, exampleTestExisted } = writeInitFiles({
    config: generateConfig(selectedPlatforms, androidConfig, iosConfig, enableNetwork),
    exampleTest: createTest,
    agentsMd: writeAgents,
    replaceConfig: existingConfig !== undefined,
    interactive: true,
  });
  console.log(`  ${green('✓')} tapsmith.config.ts created`);
  const unmatched = testsOutsideGeneratedMatchWarning(tapsmithTestsOutsideGeneratedMatch(process.cwd()));
  if (unmatched) console.log(`  ${YELLOW}⚠${RESET} ${unmatched}`);

  // Keep test output out of git (PILOT-562)
  const ignored = ignoreTestResultsOrWarn(process.cwd());
  if (ignored === 'created') console.log(`  ${green('✓')} .gitignore created (ignores Tapsmith's test output)`);
  else if (ignored === 'added') console.log(`  ${green('✓')} Tapsmith's test output folders added to .gitignore`);
  else if (typeof ignored === 'object') console.log(`  ${YELLOW}⚠${RESET} ${ignored.warning}`);
  // A native project's .gitignore lacks node_modules/ (PILOT-832).
  const depsIgnored = typeof ignored === 'object' ? 'present' : ignoreNodeModulesOrWarn(process.cwd());
  if (depsIgnored === 'created' || depsIgnored === 'added') console.log(`  ${green('✓')} node_modules/ added to .gitignore`);
  else if (typeof depsIgnored === 'object') console.log(`  ${YELLOW}⚠${RESET} ${depsIgnored.warning}`);

  if (exampleTestExisted) console.log(`  ${YELLOW}⚠${RESET} ${EXAMPLE_TEST_PATH} already exists, skipping.`);
  else if (written.includes(EXAMPLE_TEST_PATH)) console.log(`  ${green('✓')} ${EXAMPLE_TEST_PATH} created`);
  if (written.includes('AGENTS.md')) console.log(`  ${green('✓')} AGENTS.md updated`);
  // For the documented ESLint setup's type information (PILOT-838).
  const tsconfig = writeTsconfigOrWarn(process.cwd());
  if (tsconfig === 'created') console.log(`  ${green('✓')} tsconfig.json created (so editors and typescript-eslint type-check your tests)`);
  else if (typeof tsconfig === 'object') console.log(`  ${YELLOW}⚠${RESET} ${tsconfig.warning}`);

  // Step 8.6: Tapsmith itself, which the config and test import (PILOT-551)
  const installStep = await offerTapsmithInstall(process.cwd());
  if (selectedPlatforms.includes('android')) await warnIfAndroidAgentMissing(process.cwd());

  // Step 9: Next steps
  console.log();
  console.log(`  ${bold('Next steps')}`);
  const projects = generatedProjects(selectedPlatforms, iosConfig);
  const captureStep = androidConfig?.useEmulators ? captureAvdNextStep(androidConfig.avd, env.avdImages, enableNetwork) : undefined;
  const steps = wizardNextSteps(cli, {
    install: installStep,
    capture: captureStep,
    app: placeholderNextStep(placeholders),
    yarnPnp,
  });
  const width = Math.max(...[...steps.map(([l]) => l), ...projects.map((p) => p.label)].map((l) => l.length)) + 3;
  const step = (label: string, cmd: string): void => console.log(`  ${`${label}:`.padEnd(width)}${green(cmd)}`);
  for (const [label, cmd] of steps) step(label, cmd);
  if (projects.length > 0) {
    console.log();
    for (const { name, label } of projects) step(label, `${cli} test --project ${name}`);
  }

  console.log();
  console.log(dim('  Happy testing!'));
  console.log();
}
