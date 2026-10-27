/**
 * Building the macOS agent (`platform: 'macos'`, experimental).
 *
 * The agent is the same XCUITest source as iOS, built as a macOS UI-test
 * bundle by `ios-agent/macos/TapsmithMacAgent.xcodeproj`. It is built on first
 * use and cached in `~/.tapsmith/macos-agent/<source hash>/`, so a change to
 * the agent source builds afresh and an unchanged one never rebuilds. macOS
 * runs only through the sequential CLI, so one process builds at a time.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runXcodebuild } from './ios-simulator-build.js';

/** What the macOS agent is built from, relative to the `ios-agent` directory. */
const SOURCE_DIRS = ['TapsmithAgent', 'macos'];
/** Xcode's per-user and Finder state, which never changes the build. */
const IGNORED_NAMES = new Set(['xcuserdata', '.DS_Store']);

/**
 * The `ios-agent` directory holding the macOS agent project: the checkout the
 * SDK runs from (`packages/tapsmith/{dist,src}` → `ios-agent`, from any
 * working directory), else `ios-agent` in the working directory. The npm
 * package does not include the macOS agent yet.
 */
export function findMacosAgentDir(
  from: { moduleDir: string; cwd: string } = { moduleDir: import.meta.dirname, cwd: process.cwd() },
): string {
  const candidates = [
    path.resolve(from.moduleDir, '..', '..', '..', 'ios-agent'),
    path.resolve(from.cwd, 'ios-agent'),
  ];
  const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'macos', 'TapsmithMacAgent.xcodeproj')));
  if (!found) {
    throw new Error(
      `The macOS agent project was not found (looked in ${candidates.join(' and ')}). macOS testing builds `
        + 'the agent from source, which needs a checkout of the Tapsmith repository: the npm package does '
        + 'not include it yet.',
    );
  }
  return found;
}

export function macosAgentCacheDir(): string {
  return path.join(os.homedir(), '.tapsmith', 'macos-agent');
}

export interface EnsureMacAgentOptions {
  /** The `ios-agent` directory (`resolveIosAgentDir()`). */
  agentDir: string
  /** Where builds are cached, one directory per source hash. */
  cacheDir: string
  onProgress?: (message: string) => void
  /** Bound on the build; none by default. */
  timeoutMs?: number
}

/**
 * The macOS agent's `.xctestrun`, building the agent first when this source
 * has no cached build.
 */
export async function ensureMacAgent(options: EnsureMacAgentOptions): Promise<string> {
  const xcodeproj = path.join(options.agentDir, 'macos', 'TapsmithMacAgent.xcodeproj');
  if (!fs.existsSync(xcodeproj)) {
    throw new Error(
      `TapsmithMacAgent.xcodeproj not found at ${xcodeproj}. macOS testing builds the agent `
        + 'from source, which needs a checkout of the Tapsmith repository.',
    );
  }
  const dir = path.join(options.cacheDir, sourceHash(options.agentDir));
  const cached = findXctestrun(dir);
  if (cached) return cached;

  options.onProgress?.('Building the macOS agent... (cached for future runs)');
  fs.mkdirSync(options.cacheDir, { recursive: true });
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-macos-build-'));
  // Filled while copying and renamed into place once complete, so an
  // interrupted build is never taken for a cached one.
  const staging = `${dir}.partial-${process.pid}`;
  const logPath = path.join(options.cacheDir, `xcodebuild-${process.pid}.log`);
  try {
    await runXcodebuild([
      'build-for-testing',
      '-project', xcodeproj,
      '-scheme', 'TapsmithMacAgentUITests',
      '-destination', 'platform=macOS',
      '-derivedDataPath', buildDir,
    ], logPath, options.timeoutMs);

    const products = path.join(buildDir, 'Build', 'Products');
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(products, staging, { recursive: true });
    if (!findXctestrun(staging)) {
      throw new Error(`xcodebuild succeeded but left no .xctestrun in ${products}. Full build log: ${logPath}`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
    fs.rmSync(logPath, { force: true });
    return findXctestrun(dir)!;
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The build's `.xctestrun` in `dir`, if there is one. The daemon writes its
 * patched copies (`*.patched.xctestrun`) next to it; those are never the build.
 */
function findXctestrun(dir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const found = entries.find((e) => e.endsWith('.xctestrun') && !e.endsWith('.patched.xctestrun'));
  return found && path.join(dir, found);
}

/** A hash of every file the macOS agent is built from: their paths and contents. */
function sourceHash(agentDir: string): string {
  const hash = createHash('sha256');
  const visit = (rel: string): void => {
    const abs = path.join(agentDir, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        if (!IGNORED_NAMES.has(name)) visit(path.join(rel, name));
      }
      return;
    }
    hash.update(rel.split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(abs));
    hash.update('\0');
  };
  for (const dir of SOURCE_DIRS) visit(dir);
  return hash.digest('hex').slice(0, 16);
}
