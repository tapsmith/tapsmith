import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const AGENT_APK = 'app-debug.apk';
const AGENT_TEST_APK = 'app-debug-androidTest.apk';

const MONOREPO_RELATIVE_PATHS = [
  '../../agent/app/build/outputs/apk/debug',
  '../../../agent/app/build/outputs/apk/debug',
  '../../../../agent/app/build/outputs/apk/debug',
];

const MONOREPO_RELATIVE_TEST_PATHS = [
  '../../agent/app/build/outputs/apk/androidTest/debug',
  '../../../agent/app/build/outputs/apk/androidTest/debug',
  '../../../../agent/app/build/outputs/apk/androidTest/debug',
];

const NPM_PKG = '@tapsmith/agent-android';

function findFirst(filename: string, relativePaths: string[]): string | undefined {
  // 1. npm-installed package (e.g. @tapsmith/agent-android)
  try {
    const pkgJsonPath = require.resolve(`${NPM_PKG}/package.json`);
    const candidate = path.resolve(path.dirname(pkgJsonPath), filename);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Package not installed — fall through.
  }

  // 2. Monorepo build output
  for (const rel of relativePaths) {
    const candidate = path.resolve(import.meta.dirname, rel, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findAgentApk(): string | undefined {
  return findFirst(AGENT_APK, MONOREPO_RELATIVE_PATHS);
}

export function findAgentTestApk(): string | undefined {
  return findFirst(AGENT_TEST_APK, MONOREPO_RELATIVE_TEST_PATHS);
}

// ─── When the APKs are missing (PILOT-709) ───

/** Why the agent APKs are missing, and the project's command that installs them. */
export interface AndroidAgentAdvice {
  why: string;
  /** e.g. `pnpm add -D @tapsmith/agent-android`. */
  install: string;
  /**
   * Where to run `install`, when that is not the directory asked about: the
   * nearest project above a config folder that has no package.json.
   */
  where?: string;
}

/** `install`, and where to run it when that is somewhere else. */
function formatAgentInstall(advice: AndroidAgentAdvice): string {
  return advice.where ? `\`${advice.install}\` in ${advice.where}` : `\`${advice.install}\``;
}

/** `dir`, or the nearest directory above it with a package.json; `dir` when there is none. */
function nearestPackageDir(dir: string): string {
  for (let current = dir; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    if (path.dirname(current) === current) return dir;
  }
}

/**
 * Advice for a project at `dir` whose install has no `@tapsmith/agent-android`.
 * It is an optional dependency of tapsmith, so an install that omits optional
 * dependencies leaves it out; pnpm 11 and later also skipped it for releases
 * whose package declared no `os`, reading its `-android` name as Android-only.
 */
export async function missingAndroidAgentAdvice(dir: string): Promise<AndroidAgentAdvice> {
  // Loaded only when needed: config.ts pulls in the package-manager detector lazily too.
  const { devDependencyInstallCommand, projectPackageManager } = await import('./config.js');
  // A config folder without its own package.json (e2e/) belongs to the
  // project above it: that is where tapsmith, and so the agent, is installed.
  const project = nearestPackageDir(dir);
  const [manager, install] = await Promise.all([
    projectPackageManager(project),
    devDependencyInstallCommand(project, [NPM_PKG], 'the Android agent'),
  ]);
  const why = manager.startsWith('pnpm')
    ? `${NPM_PKG}, which ships the agent APKs, is not installed. It is an optional dependency of Tapsmith, and pnpm 11 and later skip it with Tapsmith 0.6.0 and earlier (reading its name as Android-only), as does any install that omits optional dependencies`
    : `${NPM_PKG}, which ships the agent APKs, is not installed. It is an optional dependency of Tapsmith, so an install that omits optional dependencies (--omit=optional, --no-optional) leaves it out`;
  return { why, install: install.display, ...(project !== dir ? { where: project } : {}) };
}

// The daemon's AGENT_NOT_INSTALLED error (grpc_server.rs): the device has no
// agent and the start request carried no APKs to install.
const AGENT_NOT_INSTALLED = /agent is not installed on the device/i;

/**
 * The error to show in place of an Android agent-start failure `message`
 * when the device has no agent because there were no APKs to install: the
 * daemon's own advice names config keys and `adb install`, while the usual
 * cause is the missing package. Undefined when that is not what happened.
 */
export async function missingAndroidAgentError(
  message: string,
  artifacts: { agentApkPath?: string; agentTestApkPath?: string },
  dir: string,
): Promise<string | undefined> {
  if ((artifacts.agentApkPath && artifacts.agentTestApkPath) || !AGENT_NOT_INSTALLED.test(message)) return undefined;
  const advice = await missingAndroidAgentAdvice(dir);
  return `Tapsmith's Android agent is not installed on the device, and there is no agent APK to install. ${advice.why}. `
    + `Install it with ${formatAgentInstall(advice)}, or set agentApk and agentTestApk in your Tapsmith config to your own build.`;
}

/**
 * Whether the tapsmith the project at `dir` imports can find
 * `@tapsmith/agent-android` — the lookup `findAgentApk` makes from inside
 * that copy. Undefined when the project has no tapsmith. `tapsmith init`
 * runs this against the project rather than the copy running it, which may
 * be npx's.
 */
export function androidAgentInstalledFor(dir: string): boolean | undefined {
  let tapsmithEntry: string;
  try {
    tapsmithEntry = createRequire(path.join(dir, 'noop.js')).resolve('tapsmith');
  } catch {
    return undefined;
  }
  try {
    createRequire(tapsmithEntry).resolve(`${NPM_PKG}/package.json`);
    return true;
  } catch {
    return false;
  }
}
