/**
 * `tapsmith ios network setup-simulator` — interactive first-run setup for
 * iOS *simulator* network capture (PILOT-182; renamed from `setup-ios` in
 * PILOT-271 so the name says which track it is for). Physical devices use
 * `tapsmith ios setup-device` and `tapsmith ios network configure` instead.
 *
 * Runs the user through the (currently three-step) install flow:
 *   1. mitmproxy present (its redirector where the daemon looks)
 *   2. Mitmproxy Redirector Network Extension registered with macOS
 *   3. Network Extension approved by the user in System Settings
 *
 * At each step the command reports a concise ✓ / ✗ status, tells the user
 * exactly what to do next, and — for the Network Extension approval step —
 * opens System Settings directly to the correct pane and polls
 * `systemextensionsctl list` until the SE flips to `[activated enabled]`.
 *
 * Usage: `npx tapsmith ios network setup-simulator`
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const bold = (s: string): string => `${BOLD}${s}${RESET}`;
const dim = (s: string): string => `${DIM}${s}${RESET}`;
const green = (s: string): string => `${GREEN}${s}${RESET}`;
const yellow = (s: string): string => `${YELLOW}${s}${RESET}`;
const red = (s: string): string => `${RED}${s}${RESET}`;

/** Bundle ID of the System Extension shipped by mitmproxy. */
const REDIRECTOR_SE_BUNDLE_ID = 'org.mitmproxy.macos-redirector.network-extension';

/** Deep link that opens System Settings directly to the Login Items & Extensions pane. */
const SETTINGS_DEEP_LINK = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

/** How long to wait for the user to approve the SE before giving up. */
const APPROVAL_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 2_000;

export type SeStatus = 'enabled' | 'waiting-for-user' | 'not-registered' | 'unknown';

/**
 * Parse `systemextensionsctl list` output for the state of the Mitmproxy
 * Redirector Network Extension. See `tapsmith-core/src/ios_redirect.rs`'s
 * `check_se_status()` for the Rust-side equivalent used at test-run time.
 */
export function checkSeStatus(): SeStatus {
  let out: string;
  try {
    out = execFileSync('systemextensionsctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return 'unknown';
  }
  const line = out.split('\n').find((l) => l.includes(REDIRECTOR_SE_BUNDLE_ID));
  if (!line) return 'not-registered';
  if (line.includes('[activated enabled]')) return 'enabled';
  if (line.includes('waiting for user') || line.includes('user approval pending')) {
    return 'waiting-for-user';
  }
  return 'unknown';
}

/**
 * Where the daemon will find mitmproxy's `Mitmproxy Redirector.app`, checked
 * in the daemon's own order (`resolve_redirector_path` in ios_redirect.rs),
 * so a pip/pipx install that unpacked the redirector is not reported
 * missing. Undefined when none of them has it.
 */
export function findMitmRedirector(
  env: NodeJS.ProcessEnv,
  homedir: string,
  exists: (p: string) => boolean,
  listDir: (dir: string) => string[],
): string | undefined {
  if (env.TAPSMITH_REDIRECTOR_APP && exists(env.TAPSMITH_REDIRECTOR_APP)) return 'TAPSMITH_REDIRECTOR_APP';
  const bin = path.join('Mitmproxy Redirector.app', 'Contents', 'MacOS', 'Mitmproxy Redirector');
  if (exists(path.join('/Applications', bin))) return '/Applications';
  if (exists(path.join(homedir, '.tapsmith', 'redirector', bin))) return '~/.tapsmith/redirector';
  // The daemon extracts the redirector from the tarball inside the Homebrew
  // cask on first use (`find_brew_tarball`), so look for that tarball rather
  // than trusting `brew list`.
  const tarball = path.join('mitmproxy.app', 'Contents', 'Resources', 'mitmproxy_macos', 'Mitmproxy Redirector.app.tar');
  for (const caskroom of ['/opt/homebrew/Caskroom/mitmproxy', '/usr/local/Caskroom/mitmproxy']) {
    if (listDir(caskroom).some((version) => exists(path.join(caskroom, version, tarball)))) return 'Homebrew cask';
  }
  return undefined;
}

/**
 * Where this machine has mitmproxy's redirector ({@link findMitmRedirector}),
 * or undefined. The one check `doctor`, `init` and this command share
 * (PILOT-721): `brew list mitmproxy` misses a pip or /Applications install
 * that the daemon uses happily.
 */
export function mitmproxyRedirectorSource(): string | undefined {
  const listDir = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  };
  return findMitmRedirector(process.env, os.homedir(), fs.existsSync, listDir);
}

/**
 * Open System Settings to the Login Items & Extensions pane so the user
 * can approve the Mitmproxy Redirector Network Extension without hunting
 * for it. Returns true on success, false if even the retry failed.
 *
 * The retry is defensive: when System Settings isn't currently running,
 * Launch Services sometimes returns `-600 procNotFound` on the first
 * `open URL` call because the `x-apple.systempreferences:` URL handler
 * hasn't been re-registered yet. A short sleep and retry reliably
 * unsticks it.
 */
function openLoginItemsExtensions(): boolean {
  const tryOpen = (): boolean => {
    try {
      execFileSync('open', [SETTINGS_DEEP_LINK], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  };
  if (tryOpen()) return true;
  // Give Launch Services a moment to register the URL handler, then retry.
  try {
    execFileSync('sleep', ['0.6'], { stdio: 'ignore' });
  } catch {
    // If even `sleep` is missing we're on a very strange machine —
    // just proceed with the retry.
  }
  return tryOpen();
}

/** Everything the setup touches, injectable so each exit path is unit-tested. */
export interface SetupSimulatorDeps {
  platform: NodeJS.Platform;
  isMitmproxyInstalled(): boolean;
  checkSeStatus(): SeStatus;
  openSettings(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line?: string): void;
  error(line: string): void;
  /** Progress dots, without a newline. */
  write(text: string): void;
}

const defaultDeps: SetupSimulatorDeps = {
  platform: process.platform,
  isMitmproxyInstalled: () => mitmproxyRedirectorSource() !== undefined,
  checkSeStatus,
  openSettings: openLoginItemsExtensions,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line = '') => console.log(line),
  error: (line) => console.error(line),
  write: (text) => { process.stdout.write(text); },
};

const SELF = 'npx tapsmith ios network setup-simulator';

/**
 * The other track, printed on every exit: a physical-device user who ran
 * this first learns where their setup lives.
 */
function printDeviceTrack(log: SetupSimulatorDeps['log']): void {
  log();
  log(dim('   Testing on a physical iPhone or iPad instead? That track is separate:'));
  log(dim(`      ${bold('npx tapsmith ios setup-device')}${DIM}                 (device preflight)`));
  log(dim(`      ${bold('npx tapsmith ios network configure <udid>')}${DIM}     (its network capture)`));
}

/**
 * `tapsmith ios network setup-simulator`. Resolves to the exit code: 0 when
 * capture is ready or will set itself up on the first simulator run (the
 * fresh-machine state, where nothing is wrong), 1 when the user must act.
 */
export async function setupSimulatorNetworkCapture(deps: SetupSimulatorDeps = defaultDeps): Promise<number> {
  const { log } = deps;
  if (deps.platform !== 'darwin') {
    deps.error(red('tapsmith ios network setup-simulator is only supported on macOS.'));
    return 1;
  }

  const fail = (): number => {
    printDeviceTrack(log);
    return 1;
  };
  const ready = (): number => {
    log(green('✓ iOS simulator network capture is ready.'));
    log();
    log('   Run your tests as normal:');
    log(`      ${bold('npx tapsmith test')}`);
    printDeviceTrack(log);
    return 0;
  };

  log(bold('Tapsmith iOS simulator network capture setup'));
  log(dim('Checks what HTTP(S) capture on iOS simulators needs: mitmproxy and its macOS Network Extension.'));
  log();

  // ─── Step 1: mitmproxy ───────────────────────────────────────────────
  log(bold('1. mitmproxy install'));
  if (deps.isMitmproxyInstalled()) {
    log(`   ${green('✓')} mitmproxy is installed`);
  } else {
    log(`   ${red('✗')} mitmproxy is not installed`);
    log();
    log('   Install it with:');
    log(`      ${bold('brew install mitmproxy')}`);
    log();
    log('   Then re-run:');
    log(`      ${bold(SELF)}`);
    return fail();
  }
  log();

  // ─── Step 2: Network Extension state ─────────────────────────────────
  log(bold('2. Mitmproxy Redirector Network Extension'));
  let status = deps.checkSeStatus();

  if (status === 'enabled') {
    log(`   ${green('✓')} Network Extension is activated and enabled`);
    log();
    return ready();
  }

  if (status === 'not-registered') {
    // The expected state on a fresh machine: nothing is wrong, the first
    // simulator run registers the extension. Not a failure.
    log(`   ${dim('○')} Network Extension has not been registered yet — nothing to fix.`);
    log();
    log('   It registers automatically on your first iOS simulator test run with');
    log(`   network capture on. During that ${bold('npx tapsmith test')} run, macOS asks you to allow it.`);
    log();
    log('   If the prompt does not appear, open System Settings manually:');
    log(`      ${bold('System Settings → General → Login Items & Extensions → Network Extensions')}`);
    log();
    log(`   Once approved, re-run ${bold(SELF)} to confirm.`);
    printDeviceTrack(log);
    return 0;
  }

  if (status === 'waiting-for-user') {
    log(`   ${yellow('⚠')} Network Extension is registered but not yet approved`);
    log();
    log('   Approve it in:');
    log(`      ${bold('System Settings → General → Login Items & Extensions → Network Extensions')}`);
    log();
    log(dim('   Opening System Settings to the right pane...'));
    if (!deps.openSettings()) {
      log(dim('   (Could not auto-open — please navigate manually using the path above.)'));
    }
    log();
    log(dim(`   Waiting for approval (up to ${APPROVAL_POLL_TIMEOUT_MS / 1000}s)...`));

    const deadline = deps.now() + APPROVAL_POLL_TIMEOUT_MS;
    deps.write('   ');
    while (deps.now() < deadline) {
      await deps.sleep(APPROVAL_POLL_INTERVAL_MS);
      status = deps.checkSeStatus();
      if (status === 'enabled') {
        log();
        log();
        log(`   ${green('✓')} Network Extension approved`);
        log();
        return ready();
      }
      deps.write(dim('.'));
    }
    log();
    log();
    log(red('✗ Timed out waiting for Network Extension approval.'));
    log();
    log('   When you have approved the extension, re-run:');
    log(`      ${bold(SELF)}`);
    return fail();
  }

  // status === 'unknown' — systemextensionsctl missing, errored, or unparseable
  log(`   ${yellow('⚠')} Could not determine Network Extension status`);
  log();
  log('   Try running manually:');
  log(`      ${bold('systemextensionsctl list')}`);
  log();
  log(`   Look for ${dim(REDIRECTOR_SE_BUNDLE_ID)}`);
  log(`   in state ${dim('[activated enabled]')}.`);
  return fail();
}

/** CLI entry: exits non-zero when the user must act. */
export async function runSetupIos(deps: SetupSimulatorDeps = defaultDeps): Promise<void> {
  const code = await setupSimulatorNetworkCapture(deps);
  if (code !== 0) process.exit(code);
}
