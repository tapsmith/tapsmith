/**
 * Non-interactive `tapsmith init` — flag validation, auto-detection resolution,
 * and file writing (writeInitFiles(), which the wizard shares). Pure of process.exit and console; the CLI shell in
 * init.ts owns printing and exit codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { bootedSimulatorsNote, preferredSimulator, runningAvds, simulatorChoices, type EnvScan } from './env-scan.js';
import { isAppInstalled } from './ios-simulator.js';
import type { AndroidConfig, IosConfig, Platform } from './init.js';
import { EXAMPLE_TEST_PATH, connectedDeviceTarget, playwrightNeighbourNote, customSimulatorDeviceType, networkCaptureDefault, generateConfig, withTapsmithCommand, tapsmithTestsOutsideGeneratedMatch, testsOutsideGeneratedMatchWarning, writeExampleTest } from './init.js';
import { installedDocsDir, updateAgentsMd, writeAgentsMd } from './agents-md.js';
import { findAgentsSection, pluginNextSteps, type CodingAgent } from './agent-plugins.js';
import { ignoreNodeModulesOrWarn, ignoreTestResultsOrWarn } from './init-gitignore.js';
import { writeTsconfigOrWarn } from './init-tsconfig.js';
import { avdCaptureWarning, captureAvdNextStep, noAvdsListedMessage, preferredAvd } from './avd-images.js';
import * as detectDefaults from './init-detect.js';
import type { InitCommandOptions } from './cli-program.js';
import { findConfigFile, type InstallCommand } from './config.js';
import { projectUsesYarnPnp, YARN_PNP_INIT_STEP, YARN_PNP_INIT_WARNING } from './yarn-pnp.js';
import { appIdWarning } from './app-id.js';
import { adbMissingFix } from './toolchain.js';
import { androidUnusableDeviceFix } from './adb-devices.js';

// ─── Types ───

export type DeviceType = 'emulator' | 'physical' | 'both';

export interface InitArgs {
  yes: boolean;
  json: boolean;
  force: boolean;
  platforms?: Platform[];
  apk?: string;
  packageName?: string;
  app?: string;
  bundleId?: string;
  avd?: string;
  /** `--device <serial>`: the Android device to use. */
  device?: string;
  simulator?: string;
  deviceType?: DeviceType;
  /** `--network-capture` / `--no-network-capture`; unset takes the wizard's default. */
  networkCapture?: boolean;
  exampleTest: boolean;
  agentsMd: boolean;
  /** `--agents-md-only`: write the AGENTS.md section and nothing else. */
  agentsMdOnly: boolean;
  /** True when any setup-shaping flag was passed (implies non-interactive). */
  anySetupFlag: boolean;
}

export class InitError extends Error {
  readonly code: string;
  readonly fix?: string;
  readonly candidates?: string[];

  constructor(code: string, message: string, opts?: { fix?: string; candidates?: string[] }) {
    super(message);
    this.code = code;
    this.fix = opts?.fix;
    this.candidates = opts?.candidates;
  }
}

export interface InitPlan {
  platforms: Platform[];
  android?: AndroidConfig;
  ios?: IosConfig;
  networkCapture: boolean;
  warnings: string[];
  /** Next steps entry for a Play-image AVD, from `captureAvdNextStep`. */
  captureAvdStep?: { label: string; action: string; optional: boolean };
}

export interface InitResult {
  /** Left out by `--agents-md-only` in a project with no config. */
  configPath?: string;
  filesCreated: string[];
  warnings: string[];
  nextSteps: string[];
}

export interface DetectFns {
  findApkCandidates: (cwd: string) => string[];
  preferDebugApk?: (candidates: string[]) => string[];
  detectAndroidPackage: (apkPath: string) => string | undefined;
  findIosAppCandidates: (cwd: string) => string[];
  detectIosBundleId: (appPath: string) => string | undefined;
  /** Optional so callers that stub the build detectors need not stub this too. */
  detectExpoProject?: (cwd: string, readConfig?: (cwd: string) => unknown) => detectDefaults.ExpoProject | undefined;
  /** This project's builds in Xcode's DerivedData; optional like detectExpoProject. */
  findDerivedDataApps?: (cwd: string, xcodeProjects: string[], sdk: 'iphonesimulator' | 'iphoneos') => string[];
  /** Whether the app is installed on a simulator (simctl); optional like detectExpoProject. */
  isAppInstalledOnSimulator?: (udid: string, bundleId: string) => boolean;
}

// ─── Flag validation ───

/** The setup flags that take a value. */
const SETUP_FLAGS = {
  platform: '--platform', apk: '--apk', package: '--package', app: '--app', bundleId: '--bundle-id',
  avd: '--avd', device: '--device', simulator: '--simulator', deviceType: '--device-type',
} as const satisfies Partial<Record<keyof InitCommandOptions, string>>;

/**
 * Validate the parsed `tapsmith init` flags and shape them for the planner.
 * Values the parser cannot check (the platform list, the device type) are
 * rejected here with the InitError codes the `--json` contract promises.
 */
export function initArgsFromOptions(opts: InitCommandOptions): InitArgs {
  let platforms: Platform[] | undefined;
  if (opts.platform !== undefined) {
    platforms = opts.platform.split(',').map((p) => p.trim()) as Platform[];
    for (const p of platforms) {
      if (p !== 'android' && p !== 'ios') {
        throw new InitError('INVALID_PLATFORM', `Unknown platform "${p}"`, { fix: 'Use --platform android, --platform ios, or --platform android,ios' });
      }
    }
  }
  const deviceType = opts.deviceType;
  if (deviceType !== undefined && deviceType !== 'emulator' && deviceType !== 'physical' && deviceType !== 'both') {
    throw new InitError('INVALID_DEVICE_TYPE', `Unknown device type "${deviceType}"`, { fix: 'Use --device-type emulator|physical|both' });
  }

  // --device picks the device, and with it what kind it is (PILOT-1201).
  if (opts.device !== undefined && (opts.avd !== undefined || deviceType !== undefined)) {
    throw new InitError('CONFLICTING_FLAGS', `--device cannot be combined with ${opts.avd !== undefined ? '--avd' : '--device-type'}`, {
      fix: '--device picks the device and its kind: an emulator writes its AVD, a physical device pins `device`. Pass --device alone, or --avd/--device-type without it',
    });
  }

  if (opts.agentsMdOnly) {
    const other = Object.entries(SETUP_FLAGS).find(([key]) => opts[key as keyof InitCommandOptions] !== undefined)?.[1]
      ?? (opts.force ? '--force' : !opts.exampleTest ? '--no-example-test' : !opts.agentsMd ? '--no-agents-md' : undefined)
      ?? (opts.networkCapture === undefined ? undefined : opts.networkCapture ? '--network-capture' : '--no-network-capture');
    if (other) {
      throw new InitError('CONFLICTING_FLAGS', `--agents-md-only cannot be combined with ${other}`, {
        fix: '--agents-md-only writes the AGENTS.md section and nothing else: pass it alone (with --json if you like), or drop it to set up the project',
      });
    }
  }

  const valueFlags = [opts.platform, opts.apk, opts.package, opts.app, opts.bundleId, opts.avd, opts.device, opts.simulator, opts.deviceType];
  return {
    yes: opts.yes,
    json: opts.json,
    force: opts.force,
    platforms,
    apk: opts.apk,
    packageName: opts.package,
    app: opts.app,
    bundleId: opts.bundleId,
    avd: opts.avd,
    device: opts.device,
    simulator: opts.simulator,
    deviceType,
    networkCapture: opts.networkCapture,
    exampleTest: opts.exampleTest,
    agentsMd: opts.agentsMd,
    agentsMdOnly: opts.agentsMdOnly,
    anySetupFlag: valueFlags.some((v) => v !== undefined)
      || opts.force || opts.networkCapture !== undefined || !opts.exampleTest || !opts.agentsMd || opts.agentsMdOnly,
  };
}

// ─── Resolution ───

const noApkMessage = (layout: detectDefaults.ProjectLayout): string => `No Android APK found in the project's build outputs (${detectDefaults.apkSearchedIn(layout)})`;
const noIosAppMessage = (layout: detectDefaults.ProjectLayout): string =>
  `No simulator .app bundle found in the project (${detectDefaults.simulatorAppSearchedIn(layout)}) or in Xcode's DerivedData`;

export function resolveInitPlan(
  args: InitArgs,
  env: EnvScan,
  detect: DetectFns = detectDefaults,
  cwd: string = process.cwd(),
): InitPlan {
  const warnings: string[] = [];
  if (env.rosettaWarning) warnings.push(env.rosettaWarning);

  // Expo (PILOT-557): only needed for a missing build or id, and reading a
  // dynamic app config runs the project's Expo CLI, so detected on demand.
  let expoMemo: { value: detectDefaults.ExpoProject | undefined } | undefined;
  const expo = (): detectDefaults.ExpoProject | undefined => {
    expoMemo ??= { value: (detect.detectExpoProject ?? detectDefaults.detectExpoProject)(cwd) };
    return expoMemo.value;
  };
  // Notes that need only whether this is Expo, not the app config's ids,
  // read no config: that would run the project's Expo CLI.
  let expoShapeMemo: { value: detectDefaults.ExpoProject | undefined } | undefined;
  const expoShape = (): detectDefaults.ExpoProject | undefined => {
    if (expoMemo) return expoMemo.value;
    expoShapeMemo ??= { value: (detect.detectExpoProject ?? detectDefaults.detectExpoProject)(cwd, () => undefined) };
    return expoShapeMemo.value;
  };
  // `--yes` has one channel for such notes: its (documented) `warnings`.
  const debugNote = (build: string, platform: Platform): string | undefined => {
    if (!detectDefaults.isReactNativeProject(cwd)) return undefined;
    return detectDefaults.debugBuildNote(build, platform, detectDefaults.detectProjectLayout(cwd), true, expoShape());
  };

  // Platform: explicit flag, else infer from the builds given and the
  // project layout: android/ and ios/ (React Native), or a root
  // settings.gradle and an Xcode project (native, PILOT-832). A given build
  // names its platform (PILOT-626) — an Expo managed project has no android/
  // or ios/ — and adds to, rather than replaces, what the layout implies, so
  // `--apk` alone in a project with both never drops iOS for want of a
  // layout, only for want of an iOS build (below, PILOT-1510). `--package`, an Android package (installed already
  // when there is no APK, PILOT-721), names Android too, unless something
  // points at iOS (`--app`, an iOS project): the config's `package` key
  // also holds the iOS bundle id, so it may be meant as one. Beside
  // `--bundle-id` it can only be the Android package. `--app` off macOS is
  // an explicit iOS ask, refused below.
  const layout = detectDefaults.detectProjectLayout(cwd);
  const reactNative = detectDefaults.isReactNativeProject(cwd);
  let platforms = args.platforms;
  if (!platforms) {
    const inferred: Platform[] = [];
    const iosProject = env.isMacOS && detectDefaults.hasIosProject(layout);
    const packageNamesAndroid = !!args.packageName && (!!args.bundleId || (!args.app && !iosProject));
    if (args.apk || packageNamesAndroid || detectDefaults.hasAndroidProject(layout)) inferred.push('android');
    if (args.app || iosProject) inferred.push('ios');
    if (inferred.length === 0) {
      const expoProject = expo();
      if (expoProject) {
        const buildable: Array<'android' | 'ios'> = env.isMacOS ? ['android', 'ios'] : ['android'];
        throw new InitError('NO_PLATFORM', 'Could not infer target platform: this Expo project has no android/ or ios/ directory yet, so there is no build to test', {
          fix: `Build the app, then re-run init. ${detectDefaults.expoBuildHint(buildable, expoProject, 'Or pass --platform with --apk/--app pointing at an existing build.')}`,
        });
      }
      throw new InitError('NO_PLATFORM', 'Could not infer target platform (no android/ or ios/ directory, settings.gradle or Xcode project found)', {
        fix: 'Pass --platform android, --platform ios, or --platform android,ios',
      });
    }
    // Both inferred, but only one has a build: that is the platform the user
    // is testing. The other would fail for want of an app (PILOT-1510).
    let narrowed = false;
    if (inferred.length === 2) {
      const androidBuilt = !!args.apk || (detect.preferDebugApk ?? detectDefaults.preferDebugApk)(detect.findApkCandidates(cwd)).length > 0;
      const iosBuilt = !!args.app || (env.isMacOS && (
        detect.findIosAppCandidates(cwd).length > 0
        || (detect.findDerivedDataApps ?? detectDefaults.findDerivedDataApps)(cwd, layout.iosProjects, 'iphonesimulator').length > 0));
      // No call to make when a flag names the platform that would be dropped:
      // a bare --package may be an installed Android app or an iOS id.
      const dropsAndroid = !androidBuilt && (!!args.packageName || !!args.avd || !!args.device);
      const dropsIos = !iosBuilt && (!!args.bundleId || !!args.simulator);
      if (androidBuilt !== iosBuilt && !dropsAndroid && !dropsIos) {
        narrowed = true;
        const [kept, left] = androidBuilt ? ['android', 'iOS'] : ['ios', 'Android'];
        inferred.splice(0, inferred.length, kept as Platform);
        const quote = (v: string) => (/^[\w./@:+=-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
        // Repeat the build the user gave: a path outside the searched folders is not found on the re-run.
        const buildFlag = args.apk ? ` --apk ${quote(args.apk)}` : args.app ? ` --app ${quote(args.app)}` : '';
        warnings.push(`${left} left out of the config: only the ${kept === 'ios' ? 'iOS' : 'Android'} build was found. To test ${left} too, build it, then re-run \`npx tapsmith init --force --platform android,ios${buildFlag}\` with any other flags you passed this time.`);
      }
    }
    platforms = inferred;
    // A React Native app usually targets both, so an inferred Android-only
    // setup on a Mac says why iOS is missing and how to add it (PILOT-625).
    if (env.isMacOS && !inferred.includes('ios') && reactNative && !narrowed) {
      // Once ios/ exists, --package alone no longer names Android, so a
      // re-run it configured must name both platforms.
      const packageOnly = packageNamesAndroid && !args.apk && !detectDefaults.hasAndroidProject(layout);
      warnings.push(iosLeftOutNote(expoShape(), args.apk, packageOnly));
    }
  }

  if (args.packageName && !platforms.includes('android')) {
    const forIos = args.bundleId ? '' : ` For the iOS bundle identifier, pass --bundle-id ${args.packageName}`;
    warnings.push(`--package names an Android package, so ${args.packageName} was not used: this setup has no Android.${forIos}`);
  }
  if (args.bundleId && !platforms.includes('ios')) {
    warnings.push(`--bundle-id names an iOS bundle identifier, so ${args.bundleId} was not used: this setup has no iOS`);
  }

  if (args.device && !platforms.includes('android')) {
    throw new InitError('DEVICE_NEEDS_ANDROID', `--device names an Android device, but this setup has no Android`, {
      fix: 'For an iOS simulator pass --simulator <name or UDID>; for Android add --platform android',
    });
  }

  if (platforms.includes('ios') && !env.isMacOS) {
    throw new InitError('IOS_REQUIRES_MACOS', 'iOS setup is only supported on macOS', {
      fix: 'Run on a macOS machine, or configure only the android platform',
    });
  }

  let android: AndroidConfig | undefined;
  if (platforms.includes('android')) {
    let apkPath = args.apk;
    if (!apkPath) {
      const prefer = detect.preferDebugApk ?? detectDefaults.preferDebugApk;
      const candidates = prefer(detect.findApkCandidates(cwd));
      if (candidates.length === 0 && !args.packageName) {
        const installed = 'or --package <id> if the app is already installed on the device (a dev client, say)';
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_APK', noApkMessage(layout), {
            fix: detectDefaults.expoBuildHint(['android'], expoProject, `Or pass --apk <path>, ${installed}.`),
          });
        }
        throw new InitError('NO_APK', noApkMessage(layout), {
          fix: `${detectDefaults.nativeBuildHint('android', layout, reactNative)}, or pass --apk <path>, ${installed}`,
        });
      }
      if (candidates.length > 1) {
        throw new InitError('AMBIGUOUS_APK', `Found ${candidates.length} APK candidates`, {
          fix: 'Pass --apk <path> to choose one',
          candidates,
        });
      }
      apkPath = candidates[0];
    }

    let packageName = args.packageName;
    if (apkPath === undefined) {
      // `package` alone is a valid config (PILOT-721): Tapsmith launches and
      // resets an app that is already installed, it just cannot install it.
      warnings.push(`No APK found, so the config has no apk: Tapsmith will launch and reset ${packageName} but cannot install it — install the app on the device yourself, or add apk: '<path>' to tapsmith.config.ts`);
    } else {
      const debug = debugNote(apkPath, 'android');
      if (debug) warnings.push(debug);
      const apkAbs = path.resolve(cwd, apkPath);
      packageName ??= detect.detectAndroidPackage(apkAbs);
      // The app config's id stands in only for a build that exists: a missing
      // APK still fails here, and a stand-in is said, since a build variant
      // (applicationIdSuffix) can carry another id (PILOT-557).
      const configPackage = !packageName && fs.existsSync(apkAbs) ? expo()?.androidPackage : undefined;
      if (configPackage) {
        packageName = configPackage;
        warnings.push(`Could not read the package name from ${apkPath} (needs aapt2 from the Android SDK build-tools), so used ${configPackage} from the Expo app config — check it matches this build, or pass --package <id>`);
      }
      if (!packageName) {
        throw new InitError('NO_PACKAGE', `Could not detect package name from ${apkPath} (aapt2 unavailable or APK missing)`, {
          fix: 'Pass --package <id>',
        });
      }
    }

    const deviceType = args.deviceType ?? 'emulator';
    let useEmulators = deviceType === 'emulator' || deviceType === 'both';
    let usePhysicalDevices = deviceType === 'physical' || deviceType === 'both';
    let avd = args.avd;
    let device: string | undefined;
    if (args.device) {
      ({ useEmulators, usePhysicalDevices, avd, device } = deviceFlagTarget(args.device, env, warnings));
    } else if (useEmulators && !avd) {
      // A running emulator first, so the first run boots nothing extra
      // (PILOT-1201); then a capture-capable AVD, skipping Play images
      // (Android Studio's default), capture on or off: HTTPS is never
      // captured or routed on them (PILOT-403, PILOT-721).
      avd = preferredAvd(env.avds, env.avdImages, runningAvds(env.androidDevices));
    }
    // Nothing listed: either there are no AVDs, or `emulator` (which Tapsmith
    // launches AVDs with) was not found — the latter matters for an explicit
    // --avd too.
    if (useEmulators && env.avds.length === 0 && (!avd || env.avdImages.length > 0)) {
      warnings.push(noAvdsListedMessage(env.avdImages, avd));
    }
    const packageWarning = packageName && appIdWarning(packageName, 'android');
    if (packageWarning) warnings.push(packageWarning);
    android = { apkPath, packageName, useEmulators, usePhysicalDevices, avd, ...(device ? { device } : {}) };
  }

  // The wizard's default when no flag says (PILOT-775): on, except for an
  // Android setup whose only emulator is a Google Play image.
  const networkCapture = args.networkCapture ?? networkCaptureDefault(platforms, android, env.avdImages).initial;
  if (android?.useEmulators && android.avd && networkCapture) {
    const warning = avdCaptureWarning(android.avd, env.avdImages);
    if (warning) warnings.push(warning);
  }

  let ios: IosConfig | undefined;
  if (platforms.includes('ios')) {
    const deviceType = args.deviceType ?? 'emulator';
    if (deviceType === 'physical') {
      throw new InitError('IOS_PHYSICAL_INTERACTIVE_ONLY', 'iOS physical-device setup requires the interactive wizard (code signing preflight)', {
        fix: 'Run `npx tapsmith init` in a terminal, or use --device-type emulator for simulators',
      });
    }
    if (deviceType === 'both') {
      warnings.push('iOS physical devices skipped — run `npx tapsmith init` interactively to configure them (code signing preflight)');
    }

    let appPath = args.app;
    if (!appPath) {
      let candidates = detect.findIosAppCandidates(cwd);
      // Xcode's default output (a build from the Xcode UI), only when the
      // project holds no build: that path is this Mac's alone (PILOT-832).
      let fromDerivedData = false;
      if (candidates.length === 0) {
        candidates = (detect.findDerivedDataApps ?? detectDefaults.findDerivedDataApps)(cwd, layout.iosProjects, 'iphonesimulator');
        fromDerivedData = candidates.length > 0;
      }
      if (candidates.length === 0) {
        const androidOnly = !args.platforms && args.packageName && !args.bundleId && platforms.includes('android') ? ' Or pass --platform android to set up Android only.' : '';
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_IOS_APP', noIosAppMessage(layout), {
            fix: detectDefaults.expoBuildHint(['ios'], expoProject, `Or pass --app <path>.${androidOnly}`),
          });
        }
        // iOS was inferred from ios/ while an Android package was given: the
        // user may only mean Android (PILOT-1510).
        throw new InitError('NO_IOS_APP', noIosAppMessage(layout), {
          fix: `${detectDefaults.nativeBuildHint('ios', layout, reactNative)}, or pass --app <path>.${androidOnly}`,
        });
      }
      if (candidates.length > 1) {
        throw new InitError('AMBIGUOUS_IOS_APP', `Found ${candidates.length} .app candidates${fromDerivedData ? ' in Xcode\'s DerivedData' : ''}`, {
          fix: fromDerivedData
            ? `Pass --app <path> to choose one. These paths exist only on this Mac: for a config that works elsewhere, ${detectDefaults.nativeBuildHint('ios', layout, reactNative).replace(/^Build one for the simulator first/, 'build for the simulator')}`
            : 'Pass --app <path> to choose one',
          candidates,
        });
      }
      appPath = candidates[0];
      if (fromDerivedData) warnings.push(detectDefaults.derivedDataBuildWarning(appPath, layout, 'iphonesimulator', reactNative));
    }

    const debug = debugNote(appPath, 'ios');
    if (debug) warnings.push(debug);
    const appAbs = path.resolve(cwd, appPath);
    let bundleId = args.bundleId ?? detect.detectIosBundleId(appAbs);
    const configBundleId = !bundleId && fs.existsSync(appAbs) ? expo()?.iosBundleId : undefined;
    if (configBundleId) {
      bundleId = configBundleId;
      warnings.push(`Could not read the bundle identifier from ${appPath}, so used ${configBundleId} from the Expo app config — check it matches this build, or pass --bundle-id <id>`);
    }
    if (!bundleId) {
      throw new InitError('NO_BUNDLE_ID', `Could not detect bundle identifier from ${appPath}`, {
        fix: 'Pass --bundle-id <id>',
      });
    }

    const bundleIdWarning = appIdWarning(bundleId, 'ios');
    if (bundleIdWarning) warnings.push(bundleIdWarning);

    let simulator = args.simulator;
    if (!simulator) {
      // The default, unless a booted simulator has the app and it does not:
      // that one is the developer's (PILOT-1517). Any other booted simulator
      // is named, as the runner adopts a booted one of the configured name.
      const choices = simulatorChoices(env.simulators);
      const lookup = detect.isAppInstalledOnSimulator ?? (env.isMacOS ? isAppInstalled : () => false);
      const known = new Map<string, boolean>();
      const hasApp = (s: { udid: string }): boolean => {
        if (!known.has(s.udid)) known.set(s.udid, lookup(s.udid, bundleId));
        return known.get(s.udid) === true;
      };
      const picked = preferredSimulator(choices, hasApp);
      simulator = picked?.name;
      if (picked) {
        // Chosen for the app: say on which booted simulators it is, in case
        // it is on more than the pick.
        const appOn = picked !== choices[0] ? choices.filter((s) => s.state === 'Booted' && hasApp(s)) : [];
        const note = bootedSimulatorsNote(choices, picked, {
          ...(appOn.length > 0 ? { appInstalled: { bundleId, on: appOn } } : {}),
          rerun: 'npx tapsmith init --force --simulator <name or UDID>',
        });
        if (note) warnings.push(note);
      }
      if (!simulator) {
        simulator = 'iPhone 17';
        warnings.push('No iOS simulators found — install one via Xcode; defaulting to "iPhone 17"');
      }
    }
    const simulatorDeviceType = customSimulatorDeviceType(simulator, env);
    if (simulatorDeviceType) {
      warnings.push(`Simulator '${simulator}' is a custom name on this Mac, so the config resolves only here: teammates and CI need a simulator with that exact name. For one that works anywhere it is installed, pass --simulator '${simulatorDeviceType}'`);
    }
    ios = { appPath, bundleId, simulator, ...(simulatorDeviceType ? { simulatorDeviceType } : {}), usePhysicalDevice: false };
  }

  const captureAvdStep = android?.useEmulators ? captureAvdNextStep(android.avd, env.avdImages, networkCapture) : undefined;
  return { platforms, android, ios, networkCapture, warnings, captureAvdStep };
}

/** What `--device <serial>` sets up: see {@link connectedDeviceTarget}. */
function deviceFlagTarget(
  serial: string,
  env: EnvScan,
  warnings: string[],
): { useEmulators: boolean; usePhysicalDevices: boolean; avd?: string; device?: string } {
  const connected = env.androidDevices.find((d) => d.serial === serial);
  if (!connected && !env.adbVersion) {
    // Without adb on PATH nothing is listed: say that, not "start the emulator".
    throw new InitError('ADB_NOT_FOUND', `adb is not on PATH, so Tapsmith cannot reach ${serial}`, { fix: adbMissingFix() });
  }
  const unusable = connected ? undefined : env.unusableAndroidDevices.find((d) => d.serial === serial);
  if (unusable) {
    throw new InitError('DEVICE_UNUSABLE', `${serial} is connected, but adb reports it as "${unusable.state}"`, {
      fix: `${androidUnusableDeviceFix(unusable.state, serial)}, then re-run`,
    });
  }
  if (!connected) {
    const listed = env.androidDevices.map((d) => d.serial);
    throw new InitError('DEVICE_NOT_FOUND', `No connected Android device ${serial}`, {
      fix: listed.length > 0
        ? `Pass a serial \`adb devices\` lists (${listed.join(', ')}). For an iOS simulator pass --simulator <name or UDID>`
        : 'Start the emulator or connect the device until `adb devices` lists it, then re-run. For an iOS simulator pass --simulator <name or UDID>',
      candidates: listed,
    });
  }
  if (connected.held) {
    warnings.push(`${serial} is in use by another Tapsmith session right now, so test runs cannot use it until that session ends`);
  }
  const target = connectedDeviceTarget(connected);
  if (target.warning) warnings.push(target.warning);
  return target;
}

/**
 * Why an inferred setup has no iOS, and how to add it. Init has written a
 * config by then, so the re-run needs --force, and it must repeat an --apk:
 * without one, a project whose APK is not under android/ would come back
 * iOS-only, its Android setup deleted by --force.
 */
function iosLeftOutNote(expoProject: detectDefaults.ExpoProject | undefined, apk: string | undefined, packageOnly = false): string {
  const reason = 'iOS left out of the config: this project has no ios/ directory yet, so there is no iOS app to test.';
  const apkFlag = apk ? ` --apk ${/^[\w./@:+=-]+$/.test(apk) ? apk : `'${apk.replace(/'/g, `'\\''`)}'`}` : '';
  const platformFlag = packageOnly ? ' --platform android,ios' : '';
  const rerun = `Then re-run \`npx tapsmith init --force${platformFlag}${apkFlag}\` with any other flags you passed this time, adding \`--app <path>\` if the iOS build is outside ios/.`;
  if (expoProject) return `${reason} To test iOS too: ${detectDefaults.expoBuildHint(['ios'], expoProject, rerun)}`;
  return `${reason} To test iOS too, generate the iOS project and build the app for the simulator. ${rerun}`;
}

// ─── Execution ───

const CONFIG_NAMES = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js'];

/**
 * Throws CONFIG_EXISTS unless force or no config present. Only checks: the
 * configs `--force` replaces are removed by writeInitFiles(), once the new
 * one is written, so a failed init never leaves the project without one.
 */
export function assertConfigWritable(force: boolean, cwd: string = process.cwd()): void {
  const existing = CONFIG_NAMES.find((name) => fs.existsSync(path.join(cwd, name)));
  if (existing && !force) {
    throw new InitError('CONFIG_EXISTS', `Found existing ${existing}`, {
      fix: 'Pass --force to overwrite, or delete the existing config. To add or update only the AGENTS.md section for coding agents, run: npx tapsmith init --agents-md-only',
    });
  }
}

// ─── Writing the files (PILOT-623, PILOT-624) ───

export interface InitFiles {
  /** The generated tapsmith.config.ts. */
  config: string;
  exampleTest: boolean;
  agentsMd: boolean;
  /** Replace an existing config (`--force`, or the wizard's "Overwrite it?"). */
  replaceConfig: boolean;
  /** The wizard, rather than `--yes`: decides how the fix says to skip a file. */
  interactive: boolean;
}

export interface WrittenInitFiles {
  /** Project-relative paths written, config first. */
  written: string[];
  /** EXAMPLE_TEST_PATH was already there and was left untouched. */
  exampleTestExisted: boolean;
}

/** A write failure's message: Node's errno text, which for most calls ends with the call and its path(s). */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Why `file` (absolute) could not be created or overwritten, and what to do
 * about it, or undefined when it can. A new file needs its nearest existing
 * ancestor to be a directory the user can write to (init creates any
 * missing ones); an existing one must be a file the user can write to.
 */
function unwritableReason(file: string): { reason: string; fix: string } | undefined {
  const writable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    // Missing (or behind a non-directory, found below).
  }
  if (stat) {
    if (stat.isDirectory()) return { reason: `${file} is a directory`, fix: `Move or rename the ${file} directory` };
    return writable(file) ? undefined : { reason: `${file} is not writable`, fix: `Give yourself write access to ${file} (check its permissions and owner, or whether the filesystem is read-only)` };
  }
  let dir = path.dirname(file);
  for (;;) {
    let dirStat: fs.Stats | undefined;
    try {
      dirStat = fs.statSync(dir);
    } catch {
      // Missing: init creates it, so its parent must be writable.
    }
    if (dirStat) {
      if (!dirStat.isDirectory()) return { reason: `${dir} is not a directory`, fix: `Move or rename ${dir}, which is a file` };
      // Creating an entry needs write and search permission on the directory.
      try {
        fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
        return undefined;
      } catch {
        return { reason: `${dir} is not writable`, fix: `Give yourself write access to ${dir} (check its permissions and owner, or whether the filesystem is read-only)` };
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The WRITE_FAILED error for `rel`. `fix` comes from the up-front check; a
 * failure it could not foresee (a full disk) gets a general one.
 */
function writeFailed(cwd: string, interactive: boolean, rel: string, reason: string, written: string[], fix?: string): InitError {
  const skipFlag: Record<string, string> = interactive
    ? { [EXAMPLE_TEST_PATH]: ', or answer no to the example test', 'AGENTS.md': ', or answer no to AGENTS.md' }
    : { [EXAMPLE_TEST_PATH]: ', or pass --no-example-test', 'AGENTS.md': ', or pass --no-agents-md' };
  return new InitError(
    'WRITE_FAILED',
    `Could not write ${rel}: ${reason}. ${written.length === 0 ? 'Nothing was written.' : `Already written: ${written.join(', ')}.`}`,
    {
      fix: fix
        ? `${fix}${skipFlag[rel] ?? ''}, then run init again`
        : `Check you can write to ${path.dirname(path.join(cwd, rel))} and the disk has space${skipFlag[rel] ?? ''}, then run init again`,
    },
  );
}

/**
 * `--agents-md-only`: the AGENTS.md section for a project set up without it
 * (a hand-written config, `--no-agents-md`), leaving everything else alone.
 * The result has the shape `init --yes` prints.
 */
export function writeAgentsMdOnly(
  cwd: string,
  opts: AgentSteps & { missingTapsmith?: InstallCommand },
): InitResult {
  const file = path.join(cwd, 'AGENTS.md');
  const blocked = unwritableReason(file);
  const failed = (reason: string, fix: string): InitError => new InitError('WRITE_FAILED', `Could not write AGENTS.md: ${reason}. Nothing was written.`, { fix: `${fix}, then run init again` });
  if (blocked) throw failed(blocked.reason, blocked.fix);
  let outcome: ReturnType<typeof updateAgentsMd>;
  try {
    outcome = updateAgentsMd(cwd);
  } catch (err) {
    throw failed(reasonOf(err), `Check you can read and write ${file} and the disk has space`);
  }
  if (outcome === 'malformed') {
    throw new InitError('AGENTS_MD_MARKERS', `${file} has stray or repeated tapsmith:begin / tapsmith:end markers, so where the Tapsmith section starts and ends is a guess. Nothing was written.`, {
      fix: 'Remove the old Tapsmith section and its <!-- tapsmith:begin --> and <!-- tapsmith:end --> markers, then run init again',
    });
  }
  // No config here doesn't mean none: `-c`, or an e2e/ folder. So no step to run init.
  const config = findConfigFile(cwd);
  const nextSteps = [
    ...(opts.missingTapsmith ? [`Install Tapsmith in this project: ${opts.missingTapsmith.display}`] : []),
    ...agentSteps(cwd, opts),
  ];
  return {
    ...(config ? { configPath: config } : {}),
    filesCreated: outcome === 'written' ? ['AGENTS.md'] : [],
    warnings: [],
    nextSteps: nextSteps.map((text) => withTapsmithCommand(text, opts.cli)),
  };
}

/** Who reads the Next steps, for the ones meant for coding agents. */
export interface AgentSteps {
  json: boolean;
  /** How the project runs Tapsmith (`tapsmithExecCommand`). */
  cli: string;
  /** The agents whose plugin install is listed (`detectCodingAgents`). */
  codingAgents: readonly CodingAgent[];
  /** A coding agent is running init, and `codingAgents` is that agent. */
  agentRunning: boolean;
}

/** The steps for an agent: its plugin, and what to read instead of Tapsmith's compiled source. */
function agentSteps(cwd: string, opts: AgentSteps): string[] {
  const read = opts.json || opts.agentRunning
    ? [`Read ${installedDocsDir(cwd)}/agents.md before writing tests (how to find locators, run and debug tests; the API docs are beside it)`]
    : [];
  const plugin = pluginNextSteps(opts.codingAgents, opts.agentRunning, installedDocsDir(cwd));
  return opts.agentRunning ? [...plugin, ...read] : [...read, ...plugin];
}

/** The temp file the config is written to before it is renamed into place. */
const configTmpPath = (cwd: string): string => path.join(cwd, `.tapsmith.config.ts.${process.pid}.tmp`);

/**
 * Throws WRITE_FAILED when the project directory cannot take the config, so
 * init stops before its questions and the iOS agent build rather than after
 * them. writeInitFiles() checks every file again when it writes.
 */
export function assertProjectWritable(cwd: string = process.cwd()): void {
  const blocked = unwritableReason(configTmpPath(cwd));
  if (blocked) throw writeFailed(cwd, false, 'tapsmith.config.ts', blocked.reason, [], blocked.fix);
}

/**
 * Writes init's files, all or as few as possible: every target is checked
 * before anything is written, and the config, which marks a project as set
 * up (CONFIG_EXISTS), is written last and atomically, so a write that fails
 * anyway (a full disk) leaves no new config behind and never loses the old
 * one. Throws WRITE_FAILED naming the file and what was already written.
 * `.gitignore` is not one of these files: it is optional, and init warns
 * when it cannot update it.
 */
export function writeInitFiles(files: InitFiles, cwd: string = process.cwd()): WrittenInitFiles {
  assertConfigWritable(files.replaceConfig, cwd);

  const failure = (rel: string, reason: string, written: string[], fix?: string): InitError =>
    writeFailed(cwd, files.interactive, rel, reason, written, fix);

  const configPath = path.join(cwd, 'tapsmith.config.ts');
  const tmpPath = configTmpPath(cwd);
  const exampleAbs = path.join(cwd, EXAMPLE_TEST_PATH);
  const exampleTestExisted = files.exampleTest && fs.existsSync(exampleAbs);
  // Checked in the order a reader expects (the config first); written with the config last.
  const targets: Array<[string, string]> = [['tapsmith.config.ts', tmpPath]];
  if (files.exampleTest && !exampleTestExisted) targets.push([EXAMPLE_TEST_PATH, exampleAbs]);
  if (files.agentsMd) targets.push(['AGENTS.md', path.join(cwd, 'AGENTS.md')]);
  for (const [rel, abs] of targets) {
    const blocked = unwritableReason(abs);
    if (blocked) throw failure(rel, blocked.reason, [], blocked.fix);
  }

  const written: string[] = [];
  if (files.exampleTest && !exampleTestExisted) {
    try {
      writeExampleTest(cwd);
    } catch (err) {
      throw failure(EXAMPLE_TEST_PATH, reasonOf(err), written);
    }
    written.push(EXAMPLE_TEST_PATH);
  }
  if (files.agentsMd) {
    try {
      writeAgentsMd(cwd);
    } catch (err) {
      throw failure('AGENTS.md', reasonOf(err), written);
    }
    written.push('AGENTS.md');
  }

  // Written beside the config and renamed over it: the old config (or a
  // symlink, whose target is never touched) survives any failure.
  try {
    fs.writeFileSync(tmpPath, files.config);
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    // The message names the config; drop Node's ", rename '<temp>' -> '<config>'"
    // suffix, which names a temp file the user never asked for.
    throw failure('tapsmith.config.ts', reasonOf(err).replace(/, (?:open|write|rename) '.*$/s, ''), written);
  }
  // A leftover .mjs or .js config would shadow or confuse the new one.
  for (const name of CONFIG_NAMES.slice(1)) {
    try {
      fs.rmSync(path.join(cwd, name), { force: true });
    } catch (err) {
      throw new InitError('WRITE_FAILED', `Wrote tapsmith.config.ts but could not remove the old ${name}: ${reasonOf(err)}`, {
        fix: `Delete ${name} yourself: Tapsmith loads only one config`,
      });
    }
  }
  return { written: ['tapsmith.config.ts', ...written], exampleTestExisted };
}

/**
 * Writes the files. `missingTapsmith` is the install command when the project
 * cannot resolve `tapsmith`, which the files written here import:
 * `--yes` never runs it — a scripted setup should not change package.json and
 * the lockfile unasked — so it becomes the first next step.
 */
export function executeInitPlan(
  plan: InitPlan,
  args: InitArgs,
  cwd: string = process.cwd(),
  missingTapsmith?: InstallCommand,
  cli = 'npx tapsmith',
  /** The coding agents the project uses (`detectCodingAgents`), whose plugin install Next steps lists. */
  codingAgents: readonly CodingAgent[] = [],
  /** A coding agent is running init: `codingAgents` is that agent, and its steps come first. */
  agentRunning = false,
): InitResult {
  const filesCreated: string[] = [];
  // Plug'n'Play first: `verify`, the next step, would refuse there (PILOT-778).
  const yarnPnp = projectUsesYarnPnp({ versions: process.versions, cwd });
  const warnings = [...(yarnPnp ? [YARN_PNP_INIT_WARNING] : []), ...plan.warnings];

  const configPath = path.join(cwd, 'tapsmith.config.ts');
  const { written, exampleTestExisted } = writeInitFiles({
    config: generateConfig(plan.platforms, plan.android, plan.ios, plan.networkCapture),
    exampleTest: args.exampleTest,
    agentsMd: args.agentsMd,
    replaceConfig: args.force,
    interactive: false,
  }, cwd);
  filesCreated.push('tapsmith.config.ts');

  const unmatched = testsOutsideGeneratedMatchWarning(tapsmithTestsOutsideGeneratedMatch(cwd));
  if (unmatched) warnings.push(unmatched);

  const ignored = ignoreTestResultsOrWarn(cwd);
  if (ignored === 'created' || ignored === 'added') filesCreated.push('.gitignore');
  else if (typeof ignored === 'object') warnings.push(ignored.warning);
  // A native project's .gitignore lacks node_modules/ (PILOT-832); one that
  // could not be written above is not tried twice.
  if (typeof ignored !== 'object') {
    const deps = ignoreNodeModulesOrWarn(cwd);
    if ((deps === 'created' || deps === 'added') && !filesCreated.includes('.gitignore')) filesCreated.push('.gitignore');
    else if (typeof deps === 'object') warnings.push(deps.warning);
  }

  if (exampleTestExisted) warnings.push(`${EXAMPLE_TEST_PATH} already exists — left untouched`);
  else if (written.includes(EXAMPLE_TEST_PATH)) {
    const note = playwrightNeighbourNote(cwd);
    if (note) warnings.push(note);
  }
  filesCreated.push(...written.filter((f) => f !== 'tapsmith.config.ts'));

  // For the documented ESLint setup's type information (PILOT-838).
  const tsconfig = writeTsconfigOrWarn(cwd);
  if (tsconfig === 'created') filesCreated.push('tsconfig.json');
  else if (typeof tsconfig === 'object') warnings.push(tsconfig.warning);

  if (!args.agentsMd && !findAgentsSection(cwd)) {
    // The flag is not needed to keep a template's own AGENTS.md (PILOT-1523).
    const kept = fs.existsSync(path.join(cwd, 'AGENTS.md'))
      ? ' The section is added alongside the content already in AGENTS.md, not over it.'
      : '';
    warnings.push(`AGENTS.md section skipped: coding agents in this project won't get Tapsmith's locator/MCP instructions.${kept} Add it later with npx tapsmith init --agents-md-only`);
  }

  if (missingTapsmith) {
    warnings.push(`Tapsmith isn't installed in this project, and the files init wrote import it: run ${missingTapsmith.display} ${yarnPnp ? 'once Yarn is switched to node_modules (above)' : 'before anything else'}${missingTapsmith.note ? `. ${missingTapsmith.note}` : ''}`);
  }

  const captureStep = plan.captureAvdStep;
  const forAgents: AgentSteps = { json: args.json, cli, codingAgents, agentRunning };
  const nextSteps = [
    // Before the install, so that installs into node_modules.
    ...(yarnPnp ? [`Switch Yarn to node_modules: ${YARN_PNP_INIT_STEP}`] : []),
    ...(missingTapsmith ? [`Install Tapsmith in this project: ${missingTapsmith.display}`] : []),
    // An agent reads the top of the list and drops the tail (PILOT-1442).
    ...(agentRunning ? agentSteps(cwd, forAgents) : []),
    // A Play-image AVD: the AVD to switch to before the first run (PILOT-711),
    // or, when capture is off, an option listed last.
    ...(captureStep && !captureStep.optional ? [`${captureStep.label}: ${captureStep.action}`] : []),
    // --json is for agents: a person reading the plain output gets the plain command (PILOT-562).
    `Verify the setup end-to-end: npx tapsmith verify${args.json ? ' --json' : ''}`,
    'Run tests: npx tapsmith test',
    ...(agentRunning ? [] : agentSteps(cwd, forAgents)),
    ...(captureStep?.optional ? [`${captureStep.label}: ${captureStep.action}`] : []),
  ];

  // In the project's own runner (`pnpm exec tapsmith`, PILOT-721).
  const local = (text: string): string => withTapsmithCommand(text, cli);
  return { configPath, filesCreated, warnings: warnings.map(local), nextSteps: nextSteps.map(local) };
}
