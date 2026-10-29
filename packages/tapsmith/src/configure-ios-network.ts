/**
 * `tapsmith ios network configure <udid> [--refresh]` — generate /
 * regenerate a per-device mobileconfig for physical iOS network capture
 * (`--refresh` replaced the old `refresh-ios-network` command).
 *
 * Both modes delegate the heavy lifting to the daemon's
 * `GenerateIosNetworkProfile` RPC so the mobileconfig generation logic
 * lives in one place (Rust). The only CLI-side wrapping is:
 *   1. Start a temporary `tapsmith-core` daemon
 *   2. Issue the RPC
 *   3. Tear down the daemon
 *   4. Print a concise walkthrough for installing the profile on the device
 *
 * `--refresh` differs only in its walkthrough (remove the old profile
 * first, update the proxy URL) — both regenerate unconditionally, because
 * the primary need for refresh is a host Wi-Fi IP change that the user has
 * already observed.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { findDaemonBin } from './daemon-bin.js';
import { TapsmithGrpcClient } from './grpc-client.js';
import { pickFreePort } from './port-utils.js';
import type { IosNetworkCommandOptions } from './cli-program.js';

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

/**
 * `fixFirewall` offers to auto-disable macOS Application Firewall stealth
 * mode via sudo. Scoped to the network-capture track: stealth mode only
 * matters when setting up the Wi-Fi proxy, so the flag lives here and NOT on
 * `tapsmith ios setup-device`, keeping the basic track free of firewall /
 * sudo mentions entirely.
 */
type Options = IosNetworkCommandOptions;

/**
 * Best-effort check for macOS Application Firewall stealth mode. Returns
 * `true` when stealth mode is on (and will silently drop the Tapsmith proxy's
 * inbound TCP SYNs), `false` when off or indeterminate. We do NOT treat
 * indeterminate as blocking — the user might have disabled the firewall
 * entirely.
 */
function isStealthModeOn(): boolean {
  try {
    const out = execFileSync(
      '/usr/libexec/ApplicationFirewall/socketfilterfw',
      ['--getstealthmode'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return /stealth mode is on/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Run the sudo command that disables stealth mode. The command itself is
 * a single write to a well-known system property and has no side effects
 * beyond that toggle; still, we only run it when the user explicitly
 * passed `--fix-firewall` so the consent is clear.
 */
function disableStealthMode(): { ok: boolean; error?: string } {
  try {
    execFileSync(
      'sudo',
      ['/usr/libexec/ApplicationFirewall/socketfilterfw', '--setstealthmode', 'off'],
      { stdio: 'inherit' },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Prompt interactively for a Wi-Fi SSID when detection fails or returns a
 * redacted placeholder (common on macOS 14+ without Location Services
 * permission). Returns the entered string or undefined on EOF / non-TTY
 * stdin — the caller falls through to the existing "bail with a clear
 * error" path.
 */
async function promptForSsid(): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | undefined>((resolve) => {
      rl.question(
        bold('Wi-Fi SSID') + dim(' (the network the device will use for tracing): '),
        (answer) => resolve(answer.trim() || undefined),
      );
    });
  } finally {
    rl.close();
  }
}

/**
 * Spin up an ephemeral tapsmith-core daemon, issue the RPC, and tear down.
 *
 * We don't reuse ensureDaemonRunning() because that function has test-flow
 * side effects (freeing agent ports, killing previous daemons) which are
 * overkill for a one-shot setup command. A minimal spawn-connect-shutdown
 * cycle keeps the command fast and isolated.
 */
async function callGenerateProfile(opts: Options): Promise<GeneratedProfile> {
  const port = String(await pickFreePort());
  const address = `127.0.0.1:${port}`;

  const bin = findDaemonBin();
  const child = spawn(bin, ['--port', port, '--platform', 'ios'], {
    stdio: 'ignore',
  });
  child.unref();

  const client = new TapsmithGrpcClient(address);
  const ready = await client.waitForReady(10_000);
  if (!ready) {
    try { child.kill(); } catch {}
    throw new Error('Failed to start tapsmith-core daemon. Is the binary on PATH?');
  }

  try {
    const response = await client.generateIosNetworkProfile({
      udid: opts.udid,
      ssid: opts.ssid,
      deviceName: opts.deviceName,
    });
    if (!response.success) {
      throw new Error(response.errorMessage || 'generateIosNetworkProfile RPC failed');
    }
    return {
      profilePath: response.profilePath,
      hostIp: response.hostIp,
      port: response.port,
      ssid: response.ssid,
    };
  } finally {
    try { client.close(); } catch {}
    try { child.kill(); } catch {}
  }
}

interface GeneratedProfile {
  profilePath: string
  hostIp: string
  port: number
  ssid: string
}

/**
 * The install walkthrough, as lines. A refresh is the same walkthrough with
 * the old profile removed first: the proxy URL is typed into the device's
 * Wi-Fi settings by hand and carries the host IP, so a refresh that skipped
 * it would leave a host-IP change unfixed.
 */
export function walkthroughLines(opts: { udid: string; refresh: boolean }, result: GeneratedProfile): string[] {
  const lines: string[] = [];
  const log = (line = ''): void => { lines.push(line); };
  const pacUrl = `http://${result.hostIp}:${result.port}/tapsmith.pac`;

  log();
  log(green(opts.refresh ? '✓ Regenerated Tapsmith network capture profile' : '✓ Generated Tapsmith network capture profile'));
  log();
  log('  ' + dim('device:   ') + bold(opts.udid));
  log('  ' + dim('profile:  ') + result.profilePath);
  log('  ' + dim('host IP:  ') + result.hostIp);
  log('  ' + dim('port:     ') + result.port);
  log('  ' + dim('SSID:     ') + result.ssid);
  log();

  if (opts.refresh) {
    log(bold('To apply the refreshed profile:'));
    log();
    log(`  ${bold('0)')} ${bold('Remove')} the old profile. On the device, open ${bold('Settings → General → VPN & Device Management')}`);
    log('     and remove the existing "Tapsmith Network Capture" profile.');
    log();
  } else {
    log(bold('To install on the device:'));
    log();
  }
  log(`  ${bold('1)')} ${bold('Send')} the profile to the device.`);
  log(`     ${dim('•')} The Finder window we just opened has it pre-selected —`);
  log(`       right-click → ${bold('Share')} → ${bold('AirDrop')} → pick your iPhone.`);
  log(`     ${dim('•')} Or email / Messages the .mobileconfig as an attachment.`);
  log();
  log(`  ${bold('2)')} ${bold('Install')} the profile on the device.`);
  log(`     Open ${bold('Settings')} on the iPhone — there'll be a "Profile Downloaded"`);
  log(`     banner near the top. Tap it (or open ${bold('General → VPN & Device')}`);
  log(`     ${bold('Management')}) → "Tapsmith Network Capture" → ${bold('Install')} →`);
  log(`     enter passcode → ${bold('Install')}.`);
  log();
  log(`  ${bold('3)')} ${bold('Trust')} the Tapsmith MITM CA.`);
  log(`     ${dim('This menu only appears AFTER step 2 — installing the profile is what')}`);
  log(`     ${dim('makes iOS reveal the Certificate Trust Settings row.')}`);
  log(`     Open ${bold('Settings → General → About → Certificate Trust Settings')}`);
  log(`     and enable the toggle next to ${bold('Tapsmith MITM CA')}.`);
  log();
  if (opts.refresh) {
    log(`  ${bold('4)')} ${bold('Set the new proxy URL')} — it carries the Mac's IP, so it changes when that does.`);
    log(`     Open ${bold('Settings → Wi-Fi')} → tap ${bold('(i)')} next to ${bold(result.ssid)} →`);
    log(`     ${bold('Configure Proxy')} → ${bold('Automatic')} → enter this URL (replacing any old one) → ${bold('Save')}:`);
    log(`     ${green(pacUrl)}`);
    log(`     ${dim('The proxy URL is set per Wi-Fi network: on a network the device has')}`);
    log(`     ${dim('not used with Tapsmith before, there is no old URL to replace.')}`);
  } else {
    log(`  ${bold('4)')} ${bold('Set the proxy URL.')} Open ${bold('Settings → Wi-Fi')} → tap ${bold('(i)')}`);
    log(`     next to ${bold(result.ssid)} → ${bold('Configure Proxy')} → ${bold('Automatic')} →`);
    log(`     enter this URL → ${bold('Save')}:`);
    log(`     ${green(pacUrl)}`);
    log(`     ${dim('One-time step per Wi-Fi network. The profile handles the CA cert')}`);
    log(`     ${dim('(which genuinely requires a mobileconfig); the proxy URL must be')}`);
    log(`     ${dim('set manually because iOS doesn\'t enforce proxy config from profiles')}`);
    log(`     ${dim('on unsupervised devices.')}`);
  }
  log();
  log(`  ${bold('5)')} ${bold('Verify')} HTTPS capture with a normal system-trust client:`);
  log(`     ${green('tapsmith ios network verify ' + opts.udid)}`);
  log();
  log(yellow('  Important: the device must be on Wi-Fi "') + bold(result.ssid) + yellow('" for'));
  log(yellow('  the proxy to route traffic. If the host Mac changes Wi-Fi or IP address,'));
  log(yellow(`  re-run: ${bold('tapsmith ios network configure ' + opts.udid + ' --refresh')}`));
  log();
  return lines;
}

function printWalkthrough(opts: Options, result: GeneratedProfile): void {
  // Reveal the .mobileconfig in Finder so the user can right-click → Share
  // → AirDrop without hunting through the filesystem. Best-effort — we
  // ignore failures (e.g. running over SSH) and the printed instructions
  // still work.
  revealInFinder(result.profilePath);
  for (const line of walkthroughLines(opts, result)) console.log(line);
}

/**
 * Best-effort reveal a file in the macOS Finder. We use `open -R <path>`
 * which highlights the file in its parent folder window. Silent on
 * non-macOS hosts and on failure — the printed instructions still
 * stand if Finder isn't available.
 */
function revealInFinder(filePath: string): void {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('open', ['-R', filePath], { stdio: 'ignore' });
  } catch {
    // Best-effort — instructions still work without Finder revealing.
  }
}

// ─── Entry points ───────────────────────────────────────────────────────

export async function runConfigureIosNetwork(opts: IosNetworkCommandOptions): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(red('tapsmith ios network configure is only supported on macOS.'));
    process.exit(1);
  }

  // Basic sanity check: make sure the UDID looks plausible and the device
  // appears in devicectl. We don't try to parse the exact format because
  // Apple has varied UDID shapes across device generations.
  try {
    execFileSync('xcrun', ['--find', 'devicectl'], { stdio: 'ignore' });
  } catch {
    console.error(red('xcrun devicectl not found. Install Xcode 15 or later.'));
    process.exit(1);
  }

  // Offer to auto-disable stealth mode before we even call the daemon —
  // if the user ran --fix-firewall, they've already consented, and we'd
  // rather surface the sudo prompt up front than at the very end after
  // profile generation.
  if (opts.fixFirewall && isStealthModeOn()) {
    console.log(dim('Disabling macOS Application Firewall stealth mode (sudo)…'));
    const res = disableStealthMode();
    if (!res.ok) {
      console.error(red(`Failed to disable stealth mode: ${res.error ?? 'unknown error'}`));
      console.error(dim('You can also run this yourself:'));
      console.error(dim('  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off'));
      process.exit(1);
    }
    console.log(green('✓ Stealth mode disabled.'));
    console.log();
  } else if (!opts.fixFirewall && isStealthModeOn()) {
    // Stealth mode is on and the user didn't pass --fix-firewall. Warn
    // loudly so they don't get silent zero-entry captures later.
    console.log(yellow('⚠ macOS Application Firewall stealth mode is ON.'));
    console.log(dim('  Inbound TCP SYNs to the Tapsmith proxy will be silently dropped.'));
    console.log(dim('  Fix once: tapsmith ios network configure <udid> --fix-firewall'));
    console.log(dim('  Or run manually: sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off'));
    console.log();
  }

  try {
    console.log(dim(`Starting temporary tapsmith-core daemon…`));
    let result = await callGenerateProfile(opts);

    // Interactive SSID fallback: the daemon returns whatever SSID it
    // could detect, which on macOS 14+ without Location Services comes
    // back as "<redacted>" (or similar placeholder). Prompt the user
    // rather than bailing with a cryptic error — the profile is already
    // generated, but if the SSID baked in is redacted the device won't
    // match it on Wi-Fi join and traces will come back empty.
    if (looksLikeRedactedSsid(result.ssid) && !opts.ssid) {
      console.log();
      console.log(yellow('Could not auto-detect your Wi-Fi SSID (macOS redacted it).'));
      console.log(dim('Enter the SSID you want the profile to target:'));
      const entered = await promptForSsid();
      if (entered) {
        // Re-generate the profile with the explicit SSID so the baked-in
        // name actually matches the phone's Wi-Fi.
        opts.ssid = entered;
        result = await callGenerateProfile(opts);
      }
    }

    printWalkthrough(opts, result);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

/** Detect the redacted-SSID placeholder macOS returns without Location Services. */
function looksLikeRedactedSsid(ssid: string): boolean {
  if (!ssid) return true;
  const s = ssid.toLowerCase();
  return s.includes('redacted') || s.includes('<private>') || s === '--';
}
