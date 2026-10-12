/**
 * Non-interactive `tapsmith init` — flag validation, auto-detection resolution,
 * and file writing (writeInitFiles(), which the wizard shares). Pure of process.exit and console; the CLI shell in
 * init.ts owns printing and exit codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { simulatorChoices, type EnvScan } from './env-scan.js';
import type { AndroidConfig, IosConfig, Platform } from './init.js';
import { EXAMPLE_TEST_PATH, generateConfig, tapsmithTestsOutsideGeneratedMatch, testsOutsideGeneratedMatchWarning, writeExampleTest } from './init.js';
import { writeAgentsMd } from './agents-md.js';
import { ignoreTestResultsOrWarn } from './init-gitignore.js';
import { avdCaptureSupport, avdCaptureWarning, captureAvdNextStep, noAvdsListedMessage } from './avd-images.js';
import * as detectDefaults from './init-detect.js';
import type { InitCommandOptions } from './cli-program.js';
import type { InstallCommand } from './config.js';

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
  simulator?: string;
  deviceType?: DeviceType;
  networkCapture: boolean;
  exampleTest: boolean;
  agentsMd: boolean;
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
  /** Next steps entry for a Play-image AVD (PILOT-711), from `captureAvdNextStep`. */
  captureAvdStep?: { label: string; action: string };
}

export interface InitResult {
  configPath: string;
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
  /** Optional so callers that stub the build detectors need not stub this too (PILOT-557). */
  detectExpoProject?: (cwd: string, readConfig?: (cwd: string) => unknown) => detectDefaults.ExpoProject | undefined;
}

// ─── Flag validation ───

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

  const valueFlags = [opts.platform, opts.apk, opts.package, opts.app, opts.bundleId, opts.avd, opts.simulator, opts.deviceType];
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
    simulator: opts.simulator,
    deviceType,
    networkCapture: opts.networkCapture,
    exampleTest: opts.exampleTest,
    agentsMd: opts.agentsMd,
    anySetupFlag: valueFlags.some((v) => v !== undefined)
      || opts.force || opts.networkCapture || !opts.exampleTest || !opts.agentsMd,
  };
}

// ─── Resolution ───

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

  // Platform: explicit flag, else infer from the builds given and the
  // project layout. A given build names its platform (PILOT-626) — an Expo
  // managed project has no android/ or ios/ — and adds to, rather than
  // replaces, what the directories imply, so `--apk` alone in a project with
  // both never drops iOS. `--app` off macOS is an explicit iOS ask, refused below.
  let platforms = args.platforms;
  if (!platforms) {
    const inferred: Platform[] = [];
    if (args.apk || fs.existsSync(path.join(cwd, 'android'))) inferred.push('android');
    if (args.app || (env.isMacOS && fs.existsSync(path.join(cwd, 'ios')))) inferred.push('ios');
    if (inferred.length === 0) {
      const expoProject = expo();
      if (expoProject) {
        const buildable: Array<'android' | 'ios'> = env.isMacOS ? ['android', 'ios'] : ['android'];
        throw new InitError('NO_PLATFORM', 'Could not infer target platform: this Expo project has no android/ or ios/ directory yet, so there is no build to test', {
          fix: `Build the app, then re-run init. ${detectDefaults.expoBuildHint(buildable, expoProject, 'Or pass --platform with --apk/--app pointing at an existing build.')}`,
        });
      }
      throw new InitError('NO_PLATFORM', 'Could not infer target platform (no android/ or ios/ directory found)', {
        fix: 'Pass --platform android, --platform ios, or --platform android,ios',
      });
    }
    platforms = inferred;
    // A React Native app usually targets both, so an inferred Android-only
    // setup on a Mac says why iOS is missing and how to add it (PILOT-625).
    if (env.isMacOS && !inferred.includes('ios') && detectDefaults.isReactNativeProject(cwd)) {
      // The note needs only whether this is Expo, not the app config's ids,
      // so the config is not read: that would run the project's Expo CLI.
      const detectExpo = detect.detectExpoProject ?? detectDefaults.detectExpoProject;
      warnings.push(iosLeftOutNote(detectExpo(cwd, () => undefined), args.apk));
    }
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
      if (candidates.length === 0) {
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
            fix: detectDefaults.expoBuildHint(['android'], expoProject, 'Or pass --apk <path>.'),
          });
        }
        throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
          fix: 'Build your app (e.g. cd android && ./gradlew assembleDebug; a React Native Debug build also needs Metro running, see https://tapsmith.dev/getting-started/#build-the-app-under-test), or pass --apk <path>',
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

    const apkAbs = path.resolve(cwd, apkPath);
    let packageName = args.packageName ?? detect.detectAndroidPackage(apkAbs);
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

    const deviceType = args.deviceType ?? 'emulator';
    const useEmulators = deviceType === 'emulator' || deviceType === 'both';
    let avd = args.avd;
    if (useEmulators && !avd) {
      // With capture on, skip past Play-image AVDs (Android Studio's default,
      // usually listed first): HTTPS is never captured on them (PILOT-403).
      const capable = args.networkCapture
        ? env.avds.find((name) => avdCaptureSupport(env.avdImages.find((a) => a.name === name)) === 'capable')
        : undefined;
      avd = capable ?? env.avds[0];
    }
    // Nothing listed: either there are no AVDs, or `emulator` (which Tapsmith
    // launches AVDs with) was not found — the latter matters for an explicit
    // --avd too.
    if (useEmulators && env.avds.length === 0 && (!avd || env.avdImages.length > 0)) {
      warnings.push(noAvdsListedMessage(env.avdImages, avd));
    }
    if (useEmulators && avd && args.networkCapture) {
      const warning = avdCaptureWarning(avd, env.avdImages);
      if (warning) warnings.push(warning);
    }
    android = { apkPath, packageName, useEmulators, usePhysicalDevices: deviceType === 'physical' || deviceType === 'both', avd };
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
      const candidates = detect.findIosAppCandidates(cwd);
      if (candidates.length === 0) {
        const expoProject = expo();
        if (expoProject) {
          throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
            fix: detectDefaults.expoBuildHint(['ios'], expoProject, 'Or pass --app <path>.'),
          });
        }
        throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
          fix: 'Build your app for the simulator (in ios/: xcodebuild -workspace <App>.xcworkspace -scheme <App> -sdk iphonesimulator -derivedDataPath build; see https://tapsmith.dev/getting-started/#build-the-app-under-test), or pass --app <path>',
        });
      }
      if (candidates.length > 1) {
        throw new InitError('AMBIGUOUS_IOS_APP', `Found ${candidates.length} .app candidates`, {
          fix: 'Pass --app <path> to choose one',
          candidates,
        });
      }
      appPath = candidates[0];
    }

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

    let simulator = args.simulator;
    if (!simulator) {
      simulator = simulatorChoices(env.simulators)[0]?.name;
      if (!simulator) {
        simulator = 'iPhone 17';
        warnings.push('No iOS simulators found — install one via Xcode; defaulting to "iPhone 17"');
      }
    }
    ios = { appPath, bundleId, simulator, usePhysicalDevice: false };
  }

  const captureAvdStep = android?.useEmulators ? captureAvdNextStep(android.avd, env.avdImages) : undefined;
  return { platforms, android, ios, networkCapture: args.networkCapture, warnings, captureAvdStep };
}

/**
 * Why an inferred setup has no iOS, and how to add it. Init has written a
 * config by then, so the re-run needs --force, and it must repeat an --apk:
 * without one, a project whose APK is not under android/ would come back
 * iOS-only, its Android setup deleted by --force.
 */
function iosLeftOutNote(expoProject: detectDefaults.ExpoProject | undefined, apk: string | undefined): string {
  const reason = 'iOS left out of the config: this project has no ios/ directory yet, so there is no iOS app to test.';
  const apkFlag = apk ? ` --apk ${/^[\w./@:+=-]+$/.test(apk) ? apk : `'${apk.replace(/'/g, `'\\''`)}'`}` : '';
  const rerun = `Then re-run \`npx tapsmith init --force${apkFlag}\` with any other flags you passed this time, adding \`--app <path>\` if the iOS build is outside ios/.`;
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
      fix: 'Pass --force to overwrite, or delete the existing config',
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
 * cannot resolve `tapsmith`, which the files written here import (PILOT-551):
 * `--yes` never runs it — a scripted setup should not change package.json and
 * the lockfile unasked — so it becomes the first next step.
 */
export function executeInitPlan(
  plan: InitPlan,
  args: InitArgs,
  cwd: string = process.cwd(),
  missingTapsmith?: InstallCommand,
): InitResult {
  const filesCreated: string[] = [];
  const warnings = [...plan.warnings];

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

  if (exampleTestExisted) warnings.push(`${EXAMPLE_TEST_PATH} already exists — left untouched`);
  filesCreated.push(...written.filter((f) => f !== 'tapsmith.config.ts'));

  if (missingTapsmith) {
    warnings.push(`Tapsmith isn't installed in this project, and the files init wrote import it: run ${missingTapsmith.display} before anything else${missingTapsmith.note ? `. ${missingTapsmith.note}` : ''}`);
  }

  const captureStep = plan.captureAvdStep;
  const nextSteps = [
    ...(missingTapsmith ? [`Install Tapsmith in this project: ${missingTapsmith.display}`] : []),
    // A Play-image AVD: the AVD to switch to before the first run (PILOT-711).
    ...(captureStep ? [`${captureStep.label}: ${captureStep.action}`] : []),
    // --json is for agents: a person reading the plain output gets the plain command (PILOT-562).
    `Verify the setup end-to-end: npx tapsmith verify${args.json ? ' --json' : ''}`,
    'Run tests: npx tapsmith test',
    'Register the MCP server for richer agent tooling: claude mcp add tapsmith -- npx tapsmith mcp-server',
  ];

  return { configPath, filesCreated, warnings, nextSteps };
}
