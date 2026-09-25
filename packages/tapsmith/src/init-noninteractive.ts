/**
 * Non-interactive `tapsmith init` — flag validation, auto-detection resolution,
 * and file writing. Pure of process.exit and console; the CLI shell in
 * init.ts owns printing and exit codes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvScan, SimulatorInfo } from './env-scan.js';
import type { AndroidConfig, IosConfig, Platform } from './init.js';
import { generateConfig, generateExampleTest } from './init.js';
import { writeAgentsMd } from './agents-md.js';
import * as detectDefaults from './init-detect.js';
import type { InitCommandOptions } from './cli-program.js';

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

function pickNewestSimulator(simulators: SimulatorInfo[]): string | undefined {
  const seen = new Map<string, SimulatorInfo>();
  for (const sim of simulators) {
    const existing = seen.get(sim.name);
    if (!existing || sim.runtime.localeCompare(existing.runtime, undefined, { numeric: true }) > 0) {
      seen.set(sim.name, sim);
    }
  }
  const sorted = [...seen.values()].sort((a, b) => b.runtime.localeCompare(a.runtime, undefined, { numeric: true }));
  const iphone = sorted.find((s) => s.name.startsWith('iPhone'));
  return (iphone ?? sorted[0])?.name;
}

export function resolveInitPlan(
  args: InitArgs,
  env: EnvScan,
  detect: DetectFns = detectDefaults,
  cwd: string = process.cwd(),
): InitPlan {
  const warnings: string[] = [];

  // Platform: explicit flag, else infer from project layout.
  let platforms = args.platforms;
  if (!platforms) {
    const inferred: Platform[] = [];
    if (fs.existsSync(path.join(cwd, 'android'))) inferred.push('android');
    if (env.isMacOS && fs.existsSync(path.join(cwd, 'ios'))) inferred.push('ios');
    if (inferred.length === 0) {
      throw new InitError('NO_PLATFORM', 'Could not infer target platform (no android/ or ios/ directory found)', {
        fix: 'Pass --platform android, --platform ios, or --platform android,ios',
      });
    }
    platforms = inferred;
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
        throw new InitError('NO_APK', 'No Android APK found under android/**/build/outputs/apk/', {
          fix: 'Build your app (e.g. cd android && ./gradlew assembleDebug), or pass --apk <path>',
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

    const packageName = args.packageName ?? detect.detectAndroidPackage(path.resolve(cwd, apkPath));
    if (!packageName) {
      throw new InitError('NO_PACKAGE', `Could not detect package name from ${apkPath} (aapt2 unavailable or APK missing)`, {
        fix: 'Pass --package <id>',
      });
    }

    const deviceType = args.deviceType ?? 'emulator';
    const useEmulators = deviceType === 'emulator' || deviceType === 'both';
    let avd = args.avd;
    if (useEmulators && !avd) {
      avd = env.avds[0];
      if (!avd) warnings.push('No Android AVDs found — create one in Android Studio, then set `avd` in tapsmith.config.ts');
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
        throw new InitError('NO_IOS_APP', 'No simulator .app bundle found under ios/', {
          fix: 'Build your app for the simulator (xcodebuild -sdk iphonesimulator), or pass --app <path>',
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

    const bundleId = args.bundleId ?? detect.detectIosBundleId(path.resolve(cwd, appPath));
    if (!bundleId) {
      throw new InitError('NO_BUNDLE_ID', `Could not detect bundle identifier from ${appPath}`, {
        fix: 'Pass --bundle-id <id>',
      });
    }

    let simulator = args.simulator;
    if (!simulator) {
      simulator = pickNewestSimulator(env.simulators);
      if (!simulator) {
        simulator = 'iPhone 17';
        warnings.push('No iOS simulators found — install one via Xcode; defaulting to "iPhone 17"');
      }
    }
    ios = { appPath, bundleId, simulator, usePhysicalDevice: false };
  }

  return { platforms, android, ios, networkCapture: args.networkCapture, warnings };
}

// ─── Execution ───

/** Throws CONFIG_EXISTS unless force or no config present. Removes every existing config on force. */
export function assertConfigWritable(force: boolean, cwd: string = process.cwd()): void {
  const existing = ['tapsmith.config.ts', 'tapsmith.config.mjs', 'tapsmith.config.js']
    .filter((name) => fs.existsSync(path.join(cwd, name)));
  if (existing.length === 0) return;
  if (!force) {
    throw new InitError('CONFIG_EXISTS', `Found existing ${existing[0]}`, {
      fix: 'Pass --force to overwrite, or delete the existing config',
    });
  }
  // Remove every existing config, including tapsmith.config.ts itself, so the
  // subsequent write starts from a clean slate — writing over a symlink would
  // otherwise clobber its target, and restricted permissions could fail mid-write.
  for (const name of existing) {
    fs.rmSync(path.join(cwd, name), { force: true });
  }
}

export function executeInitPlan(plan: InitPlan, args: InitArgs, cwd: string = process.cwd()): InitResult {
  const filesCreated: string[] = [];
  const warnings = [...plan.warnings];

  const configPath = path.join(cwd, 'tapsmith.config.ts');
  assertConfigWritable(args.force, cwd);

  fs.writeFileSync(configPath, generateConfig(plan.platforms, plan.android, plan.ios, plan.networkCapture));
  filesCreated.push('tapsmith.config.ts');

  if (args.exampleTest) {
    const testPath = path.join(cwd, 'tests', 'example.test.ts');
    if (fs.existsSync(testPath)) {
      warnings.push('tests/example.test.ts already exists — left untouched');
    } else {
      fs.mkdirSync(path.dirname(testPath), { recursive: true });
      fs.writeFileSync(testPath, generateExampleTest());
      filesCreated.push('tests/example.test.ts');
    }
  }

  if (args.agentsMd) {
    writeAgentsMd(cwd);
    filesCreated.push('AGENTS.md');
  }

  const nextSteps = [
    'Verify the setup end-to-end: npx tapsmith verify --json',
    'Run tests: npx tapsmith test',
    'Register the MCP server for richer agent tooling: claude mcp add tapsmith -- npx tapsmith mcp-server',
  ];

  return { configPath, filesCreated, warnings, nextSteps };
}
