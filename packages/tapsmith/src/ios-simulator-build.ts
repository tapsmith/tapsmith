/**
 * Auto-build logic for the iOS simulator agent.
 *
 * When the prebuilt xctestrun's SDK version doesn't match the user's
 * installed Xcode SDK, we rebuild the agent from source and cache the
 * result in `~/.tapsmith/ios-simulator-agent/`. Subsequent runs skip
 * the build as long as the cached SDK version still matches and this
 * Tapsmith version built it (PILOT-485: an upgrade brings new agent source).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { appleArch } from './host-arch.js';
import { resolveIosAgentDir, stripDstRootPath } from './build-ios-agent.js';
import { tapsmithPackageVersion } from './ios-agent-paths.js';
import {
  SIMULATOR_CACHE_SDK_MARKER,
  SIMULATOR_CACHE_VERSION_MARKER,
  describeStaleSimulatorAgentCache,
  extractSdkVersion,
  findSimulatorXctestrun,
  getInstalledSimulatorSdkVersion,
  inspectSimulatorAgentCache,
  simulatorAgentCacheDir,
} from './ios-device-resolve.js';

// ─── Build ──────────────────────────────────────────────────────────────

const CACHE_DIR = simulatorAgentCacheDir();

// ─── xcodebuild runner ──────────────────────────────────────────────────

/** `error:` lines kept for the failure message; the full output is in the log. */
const MAX_ERROR_LINES = 10;
/** Lines kept from the end of the output, shown when it has no `error:` lines. */
const TAIL_LINES = 15;
/** Longest line kept in memory, so one runaway line cannot grow the excerpt. */
const MAX_LINE_LENGTH = 1000;
/** How long a timed-out xcodebuild gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;
/**
 * How long after xcodebuild exits its output pipes may stay open. A
 * descendant that inherited them (a script phase, a helper) would otherwise
 * hold the run open past its exit — and past a timeout's kill.
 */
const STDIO_DRAIN_MS = 2000;

interface XcodebuildOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: Error;
}

/** A failed build's log is kept at least this long, so the next run cannot remove the one an error just named. */
const STALE_LOG_AGE_MS = 24 * 60 * 60 * 1000;

/** Remove day-old build logs left by processes that have exited (failed builds). */
function pruneStaleBuildLogs(): void {
  let entries: string[];
  try { entries = fs.readdirSync(CACHE_DIR); } catch { return; }
  for (const entry of entries) {
    const pid = Number(/^xcodebuild-(\d+)\.log$/.exec(entry)?.[1]);
    if (!pid || pid === process.pid || processAlive(pid)) continue;
    const file = path.join(CACHE_DIR, entry);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < STALE_LOG_AGE_MS) continue;
      fs.rmSync(file, { force: true });
    } catch { /* best effort */ }
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run `xcodebuild` with its output streamed to `logPath` instead of
 * buffered. A from-scratch build can print megabytes, and a child whose
 * output is buffered is killed at the buffer cap (ENOBUFS) mid-build
 * (PILOT-393). Only a bounded excerpt stays in memory for the error.
 *
 * Rejects with a message naming the exit code, signal, timeout or spawn
 * failure, followed by the excerpt and the log path. The log is per process
 * (two sessions may build at once); buildSimulatorAgent removes it once the
 * build is cached, so only failed builds leave one behind; a later build
 * removes those of exited processes once they are a day old. The messages never say
 * "xcodebuild exited with": that is the daemon's agent-launch failure text,
 * which worker-protocol.ts retries as an infrastructure error.
 */
async function runXcodebuild(args: string[], logPath: string, timeoutMs: number | undefined): Promise<void> {
  const log = fs.createWriteStream(logPath);
  let logWritable = true;
  let exited = false;
  const sources: NodeJS.ReadableStream[] = [];
  // A log that cannot be written (disk full, unwritable path) must not stall
  // the build: stop writing to it and keep reading the pipes, or xcodebuild
  // blocks on a full pipe and never exits.
  log.on('error', () => {
    logWritable = false;
    for (const source of sources) source.resume();
  });

  const errorLines: string[] = [];
  const tail: string[] = [];
  const keep = (raw: string): void => {
    const line = raw.length > MAX_LINE_LENGTH ? `${raw.slice(0, MAX_LINE_LENGTH)}…` : raw;
    if (/\berror:/.test(line) && errorLines.length < MAX_ERROR_LINES && !errorLines.includes(line)) {
      errorLines.push(line);
    }
    if (line.trim() === '') return;
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  };
  const collectLines = (stream: NodeJS.ReadableStream): void => {
    // A decoder per stream: a pipe chunk can end inside a multibyte character.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    stream.on('data', (chunk: Buffer) => {
      partial += decoder.write(chunk);
      let idx = partial.indexOf('\n');
      while (idx !== -1) {
        keep(partial.slice(0, idx));
        partial = partial.slice(idx + 1);
        idx = partial.indexOf('\n');
      }
      // A line with no newline in sight: keep its head, drop the rest.
      if (partial.length > MAX_LINE_LENGTH * 4) {
        keep(partial);
        partial = '';
      }
    });
    // 'end' on a normal finish; only 'close' when the drain destroyed it.
    let flushed = false;
    const flush = (): void => {
      if (flushed) return;
      flushed = true;
      partial += decoder.end();
      if (partial) keep(partial);
    };
    stream.on('end', flush);
    stream.on('close', flush);
  };

  const outcome = await new Promise<XcodebuildOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('xcodebuild', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: err instanceof Error ? err : new Error(String(err)) });
      return;
    }
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      // Only a failed spawn ends the run here; any other error (a failed
      // kill) is followed by 'close'.
      if (child.pid !== undefined) return;
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut: false, spawnError: err });
    });
    child.on('exit', () => {
      // Exited in time: the drain below must not turn it into a timeout.
      if (timer) clearTimeout(timer);
      exited = true;
      for (const source of sources) source.resume();
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, STDIO_DRAIN_MS).unref();
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
    // Both are null when the spawn failed early (EMFILE); 'error' reports it.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      sources.push(stream);
      // Written by hand rather than pipe(): pipe() pauses the source for good
      // when the log errors.
      stream.on('data', (chunk: Buffer) => {
        // After exit, read the pipes dry within the drain window rather
        // than wait on the log: what is left is the end of the output.
        if (logWritable && !log.write(chunk) && !exited) {
          stream.pause();
          log.once('drain', () => stream.resume());
        }
      });
      collectLines(stream);
    }
  });
  await new Promise<void>((resolve) => log.end(resolve));

  if (outcome.spawnError) {
    try { fs.rmSync(logPath, { force: true }); } catch { /* best effort */ }
    throw new Error(`could not start xcodebuild: ${outcome.spawnError.message}`);
  }
  if (!outcome.timedOut && outcome.code === 0) return;

  const what = 'xcodebuild build-for-testing';
  const reason = outcome.timedOut
    ? `${what} timed out after ${(timeoutMs ?? 0) / 1000}s and was stopped`
    : outcome.signal
      ? `${what} was killed by ${outcome.signal}`
      : `${what} failed (exit code ${outcome.code})`;
  const excerpt = errorLines.length > 0 ? errorLines : tail;
  const lines = [reason, ...excerpt.map((l) => `  ${l}`)];
  if (logWritable) lines.push(`Full build log: ${logPath}`);
  throw new Error(lines.join('\n'));
}

/**
 * Build the iOS simulator agent via `xcodebuild build-for-testing` and
 * cache the products under `~/.tapsmith/ios-simulator-agent/`.
 *
 * Returns the absolute path to the cached `.xctestrun` file.
 */
export async function buildSimulatorAgent(
  sdkVersion: string,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const agentDir = resolveIosAgentDir();
  const xcodeproj = path.join(agentDir, 'TapsmithAgent.xcodeproj');

  if (!fs.existsSync(xcodeproj)) {
    throw new Error(
      `TapsmithAgent.xcodeproj not found at ${xcodeproj}.\n` +
        '  Ensure the ios-agent source is available (monorepo checkout or npm package with bundled source).',
    );
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  pruneStaleBuildLogs();
  // Both markers go before the build starts and come back only once it is
  // complete, so an interrupted build is never taken for a current one.
  const sdkMarker = path.join(CACHE_DIR, SIMULATOR_CACHE_SDK_MARKER);
  const versionMarker = path.join(CACHE_DIR, SIMULATOR_CACHE_VERSION_MARKER);
  fs.rmSync(sdkMarker, { force: true });
  fs.rmSync(versionMarker, { force: true });
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-build-'));

  try {
    const args = [
      'build-for-testing',
      '-project', xcodeproj,
      '-scheme', 'TapsmithAgentUITests',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', buildDir,
      // The machine's arch, not Node's: under Rosetta both Node and
      // os.machine() say x86_64, which arm64 simulators cannot run.
      'ARCHS=' + appleArch(),
      'ONLY_ACTIVE_ARCH=NO',
      'CODE_SIGNING_ALLOWED=NO',
    ];

    const logPath = path.join(CACHE_DIR, `xcodebuild-${process.pid}.log`);
    const logHint = (): string => (fs.existsSync(logPath) ? `\nFull build log: ${logPath}` : '');
    await runXcodebuild(args, logPath, options.timeoutMs);

    // Copy products to the cache directory.
    const productsDir = path.join(buildDir, 'Build', 'Products');

    // Copy the Debug-iphonesimulator/ directory.
    const simDir = path.join(productsDir, 'Debug-iphonesimulator');
    if (!fs.existsSync(simDir)) {
      throw new Error(`Build succeeded but products directory not found at ${simDir}${logHint()}`);
    }
    const cachedSimDir = path.join(CACHE_DIR, 'Debug-iphonesimulator');
    if (fs.existsSync(cachedSimDir)) {
      fs.rmSync(cachedSimDir, { recursive: true, force: true });
    }
    fs.cpSync(simDir, cachedSimDir, { recursive: true });

    // Clean up old xctestrun files before copying new ones.
    for (const old of fs.readdirSync(CACHE_DIR)) {
      if (old.endsWith('.xctestrun')) fs.rmSync(path.join(CACHE_DIR, old), { force: true });
    }

    // Copy the xctestrun file(s).
    const entries = fs.readdirSync(productsDir);
    let xctestrunDest: string | undefined;
    for (const entry of entries) {
      if (entry.endsWith('.xctestrun') && !entry.endsWith('.patched.xctestrun')) {
        const src = path.join(productsDir, entry);
        const dest = path.join(CACHE_DIR, entry);
        fs.copyFileSync(src, dest);
        if (!xctestrunDest) xctestrunDest = dest;
      }
    }

    if (!xctestrunDest) {
      throw new Error(
        'xcodebuild succeeded but no .xctestrun file was found in Build/Products. ' +
          `This is unexpected — please file a bug.${logHint()}`,
      );
    }

    // Strip DSTROOTPath — Xcode 26+ treats it as a "Root install style" request
    // which fails on public devices/simulators.
    stripDstRootPath(xctestrunDest);

    // Record what this build is, so future runs can skip it. The SDK marker
    // is written last: findSimulatorXctestrun treats a cache without it as
    // an unfinished build.
    fs.writeFileSync(versionMarker, tapsmithPackageVersion());
    fs.writeFileSync(sdkMarker, sdkVersion);
    try { fs.rmSync(logPath, { force: true }); } catch { /* best effort */ }

    return xctestrunDest;
  } finally {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────

/**
 * Ensure a simulator-compatible xctestrun is available, rebuilding the
 * agent from source when the SDK version doesn't match.
 *
 * This is the main entry point for the session-preflight / daemon startup
 * path. It never throws for "soft" problems (missing xcrun, unknown SDK)
 * — those fall back to the existing xctestrun as-is.
 *
 * `quiet` drops the progress lines it prints to stdout (for callers whose
 * stdout is machine-readable, like `init --json`); `timeoutMs` bounds the
 * build (none by default).
 */
export async function ensureSimulatorAgent(
  options: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const progress = (message: string): void => { if (!options.quiet) console.log(message); };
  const buildOptions = { timeoutMs: options.timeoutMs };
  const found = findSimulatorXctestrun();
  const installedSdk = getInstalledSimulatorSdkVersion();
  // A cache another Tapsmith version built is never used (PILOT-485); when
  // nothing else is current either, say that is why this run rebuilds.
  const staleCache = inspectSimulatorAgentCache(installedSdk);
  const rebuildReason = staleCache?.stale === 'version'
    ? `${capitalize(describeStaleSimulatorAgentCache(staleCache))}. `
    : '';

  if (!found) {
    if (installedSdk) {
      try {
        progress(rebuildReason
          ? `${rebuildReason}Rebuilding it for SDK ${installedSdk}... (cached for future runs)`
          : `No prebuilt iOS agent found. Building from source for SDK ${installedSdk}...`);
        return await buildSimulatorAgent(installedSdk, buildOptions);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to build iOS simulator agent from source: ${detail}`);
      }
    }
    if (process.platform !== 'darwin') {
      throw new Error('No iOS simulator agent build was found. iOS simulator testing needs macOS with Xcode.');
    }
    throw new Error(
      'No iOS simulator agent build was found, and it cannot be built here: the iOS Simulator SDK ' +
        'could not be detected. Run `xcrun --sdk iphonesimulator --show-sdk-version` to see why — usually ' +
        'Xcode is not installed or not selected (sudo xcode-select -s /Applications/Xcode.app), ' +
        'or its license has not been accepted (sudo xcodebuild -license accept).',
    );
  }

  if (!installedSdk) {
    // Can't detect SDK — return whatever we found.
    return found;
  }

  const foundSdk = extractSdkVersion(found);
  if (!foundSdk || foundSdk === installedSdk) {
    // Either we can't parse the SDK from the filename, or it already matches.
    return found;
  }

  // SDK mismatch — rebuild.
  progress(`${rebuildReason}Building iOS agent for SDK ${installedSdk}... (cached for future runs)`);
  try {
    return await buildSimulatorAgent(installedSdk, buildOptions);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to rebuild the iOS simulator agent for SDK ${installedSdk}: ${detail}`);
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
