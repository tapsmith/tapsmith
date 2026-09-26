/**
 * `tapsmith verify-ios-network <udid>` — sanity-check that a physical iOS
 * device is correctly routed through Tapsmith's MITM proxy.
 *
 * Runs the smallest possible end-to-end check:
 *   1. Spin up an ephemeral tapsmith-core daemon
 *   2. SetDevice → physical iOS UDID
 *   3. StartNetworkCapture
 *   4. Prompt the user to load a known HTTPS URL on the device
 *   5. StopNetworkCapture
 *   6. Inspect the captured entries:
 *      - 0 entries           → device isn't routing through the proxy
 *      - HTTPS entries with empty bodies → proxy sees CONNECT but can't
 *        decrypt; CA isn't trusted on the device for this system-trust check
 *      - HTTPS entries with non-empty bodies → fully working for normal
 *        system-trust clients
 *   7. Print a clear ✓/✗ summary with fix-it hints for each failure mode
 *
 * Why the user has to load the URL manually: there's no host-side way
 * to make Safari fetch a URL in a way that actually goes through the
 * Wi-Fi proxy without booting a full XCUITest agent (which is heavy
 * for a verification step). Asking the user to tap their address bar
 * for one URL is faster than spinning up an agent session.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { findDaemonBin } from './daemon-bin.js';
import { TapsmithGrpcClient } from './grpc-client.js';
import { pickFreePort } from './port-utils.js';
import { readDeviceSidecar } from './ios-host-ip-check.js';

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

/** A known HTTPS endpoint with a small, predictable body. */
const PROBE_URL = 'https://example.com/';

interface VerifyOptions {
  udid: string
}

// ─── Daemon lifecycle ───────────────────────────────────────────────────

async function withDaemon<T>(fn: (client: TapsmithGrpcClient) => Promise<T>): Promise<T> {
  const port = String(await pickFreePort());
  const bin = findDaemonBin();
  // Optional: redirect daemon stdout/stderr to a file when TAPSMITH_DAEMON_LOG
  // is set. Matches the same env var honored by `tapsmith test` for walkthrough
  // observability. Off by default.
  let daemonStdio: 'ignore' | ['ignore', number, number] = 'ignore';
  const daemonLogPath = process.env.TAPSMITH_DAEMON_LOG;
  if (daemonLogPath) {
    const fd = fs.openSync(daemonLogPath, 'a');
    daemonStdio = ['ignore', fd, fd];
  }
  const child = spawn(bin, ['--port', port, '--platform', 'ios'], {
    stdio: daemonStdio,
  });
  child.unref();

  const client = new TapsmithGrpcClient(`127.0.0.1:${port}`);
  const ready = await client.waitForReady(5_000);
  if (!ready) {
    try { child.kill(); } catch {}
    throw new Error(
      'Failed to start tapsmith-core daemon. Is the binary on PATH? ' +
      'Set TAPSMITH_DAEMON_BIN to an explicit path if it lives elsewhere.',
    );
  }
  try {
    return await fn(client);
  } finally {
    try { client.close(); } catch {}
    try { child.kill(); } catch {}
  }
}

// ─── Verification flow ─────────────────────────────────────────────────

async function promptEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question(prompt, () => { rl.close(); resolve(); }));
}

interface VerificationOutcome {
  totalEntries: number
  httpsEntries: number
  decryptedEntries: number
  uniqueHosts: Set<string>
  pacFetch: PacFetchResult
}

/**
 * Result of fetching the daemon's `/tapsmith.pac` from the Mac's LAN-facing
 * proxy listener. A failure here is the most common cause of "silent no
 * traces" on physical iOS — the PAC is what tells iOS *which* hosts go
 * through the proxy in the first place, so we check it independently of
 * the CONNECT/HTTPS capture path.
 */
interface PacFetchResult {
  /** Whether the GET returned a 200 with a non-empty PAC body. */
  ok: boolean
  /** Full URL we attempted to fetch. */
  url?: string
  /** Response body (the PAC script JS) on success. */
  body?: string
  /** HTTP status code when the request completed. */
  status?: number
  /** Failure reason when the request couldn't complete. */
  error?: string
  /** Whether a sidecar metadata file existed for this UDID at all. */
  sidecarPresent: boolean
}

/**
 * Fetch `http://<host_ip>:<port>/tapsmith.pac` from the running daemon using
 * the exact host/port the installed mobileconfig baked in — the same URL
 * iOS would use on Wi-Fi join. A 200 with a non-empty body means the PAC
 * server is reachable from the Mac's LAN interface *and* it's serving
 * the current allowlist; either of those failing upstream of iOS is a
 * concrete answer to "why are my traces empty".
 */
async function fetchLivePac(udid: string): Promise<PacFetchResult> {
  const sidecar = readDeviceSidecar(udid);
  if (!sidecar) {
    return {
      ok: false,
      sidecarPresent: false,
      error: 'No sidecar metadata found — run `tapsmith configure-ios-network <udid>` first.',
    };
  }
  const url = `http://${sidecar.host_ip}:${sidecar.port}/tapsmith.pac`;
  try {
    // 5s timeout: the daemon is on the LAN, so even a cold PAC fetch
    // should round-trip in well under a second. A timeout here is itself
    // useful information about firewall/stealth-mode interference.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const body = await res.text();
    return {
      ok: res.ok && body.length > 0,
      url,
      status: res.status,
      body,
      sidecarPresent: true,
    };
  } catch (err) {
    return {
      ok: false,
      url,
      sidecarPresent: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runVerification(udid: string): Promise<VerificationOutcome> {
  return withDaemon(async (client) => {
    // 1. Switch the daemon to the target device.
    // This command's sole purpose is to verify network capture, so we
    // always want the daemon to pre-arm the Wi-Fi MITM proxy.
    const setRes = await client.setDevice(udid, true);
    if (!setRes.success) {
      throw new Error(`Failed to select device ${udid}: ${setRes.errorMessage}`);
    }
    console.log(dim(`Device ${udid} selected.`));

    // 2. Start the proxy.
    const startRes = await client.startNetworkCapture();
    if (!startRes.success) {
      throw new Error(`Failed to start network capture: ${startRes.errorMessage}`);
    }
    console.log(dim(`Network capture started on host port ${startRes.proxyPort}.`));

    // 2b. Independently probe `/tapsmith.pac` on the LAN-facing proxy port.
    //     Catches cold-boot races, firewall/stealth-mode interference, and
    //     sidecar drift BEFORE we ask the user to wait on Safari. The PAC
    //     is what iOS uses to decide whether a given host routes through
    //     Tapsmith; if we can't fetch it from the Mac itself, neither can iOS.
    const pacFetch = await fetchLivePac(udid);
    if (pacFetch.ok) {
      console.log(dim(`PAC server reachable at ${pacFetch.url} (${pacFetch.body?.length ?? 0} bytes).`));
    } else if (!pacFetch.sidecarPresent) {
      console.log(yellow('⚠ No device sidecar — skipping PAC fetch.'));
    } else {
      console.log(yellow(`⚠ PAC fetch failed: ${pacFetch.error ?? `HTTP ${pacFetch.status}`}`));
    }
    console.log();

    // 3. Hand off to the user.
    console.log(bold('On your iPhone:'));
    console.log(`  1) Open ${bold('Safari')}.`);
    console.log(`  2) Visit ${bold(PROBE_URL)} (or any HTTPS site).`);
    console.log(`  3) Wait for the page to load.`);
    console.log();
    await promptEnter(`  Press ${bold('Enter')} once the page has loaded… `);
    console.log();

    // 4. Stop and inspect.
    const stopRes = await client.stopNetworkCapture();
    if (!stopRes.success) {
      throw new Error(`Failed to stop network capture: ${stopRes.errorMessage}`);
    }

    const httpsEntries = stopRes.entries.filter((e) => e.isHttps);
    const decrypted = httpsEntries.filter((e) => e.responseBody && e.responseBody.length > 0);
    const uniqueHosts = new Set<string>();
    for (const e of httpsEntries) {
      try {
        uniqueHosts.add(new URL(e.url).host);
      } catch {
        // Skip malformed URLs
      }
    }

    return {
      totalEntries: stopRes.entries.length,
      httpsEntries: httpsEntries.length,
      decryptedEntries: decrypted.length,
      uniqueHosts,
      pacFetch,
    };
  });
}

function reportOutcome(outcome: VerificationOutcome): boolean {
  console.log();
  console.log(bold('Result:'));
  console.log(`  ${dim('total HTTP requests captured:')} ${outcome.totalEntries}`);
  console.log(`  ${dim('HTTPS requests:')}              ${outcome.httpsEntries}`);
  console.log(`  ${dim('decrypted (with body):')}       ${outcome.decryptedEntries}`);
  if (outcome.uniqueHosts.size > 0) {
    console.log(`  ${dim('hosts seen:')}                  ${[...outcome.uniqueHosts].slice(0, 5).join(', ')}${
      outcome.uniqueHosts.size > 5 ? ` (+${outcome.uniqueHosts.size - 5} more)` : ''
    }`);
  }
  console.log();

  if (outcome.totalEntries === 0) {
    console.log(red('✗ Tapsmith did not see ANY traffic from the device.'));
    console.log();
    console.log(yellow('  The device is not currently routing through the Tapsmith proxy.'));
    console.log();
    // If the PAC fetch from the Mac itself already failed, that's
    // almost certainly the root cause — no point making the user chase
    // their Wi-Fi/profile settings. Surface the PAC diagnostic first.
    if (!outcome.pacFetch.ok && outcome.pacFetch.sidecarPresent) {
      console.log(red(`  Root cause: the PAC server isn't reachable from this Mac either.`));
      console.log(dim(`  Attempted ${outcome.pacFetch.url}`));
      if (outcome.pacFetch.error) {
        console.log(dim(`  ${outcome.pacFetch.error}`));
      }
      console.log();
      console.log('  If iOS can\'t fetch the PAC, it has nothing to route through.');
      console.log('  Check:');
      console.log(`  ${dim('•')} Firewall / stealth mode — run ${bold('tapsmith configure-ios-network <udid> --fix-firewall')}`);
      console.log(`  ${dim('•')} Host IP drift — rerun ${bold('tapsmith refresh-ios-network <udid>')} and reinstall the profile`);
      console.log();
      return false;
    }
    console.log('  Likely causes:');
    console.log(`  ${dim('•')} The mobileconfig profile isn't installed.`);
    console.log(`  ${dim('•')} The device is on a different Wi-Fi network than when the`);
    console.log(`     profile was generated. Check ${bold('Settings → Wi-Fi')} on the device`);
    console.log(`     and rerun ${bold('tapsmith refresh-ios-network <udid>')} if it changed.`);
    console.log(`  ${dim('•')} The host Mac's Wi-Fi IP changed since the profile was generated.`);
    console.log(`     Rerun ${bold('tapsmith refresh-ios-network <udid>')}.`);
    console.log(`  ${dim('•')} iOS is serving a stale cached PAC. Toggle Wi-Fi off/on on the`);
    console.log(`     device to force re-fetch, then re-run this command.`);
    console.log();
    return false;
  }

  if (outcome.httpsEntries === 0) {
    console.log(yellow('⚠ Tapsmith saw HTTP traffic but no HTTPS — that\'s unusual.'));
    console.log();
    console.log('  Most modern iOS apps and websites use HTTPS exclusively.');
    console.log('  Try loading a known-HTTPS URL like ' + bold(PROBE_URL) + ' and re-run.');
    console.log();
    return false;
  }

  if (outcome.decryptedEntries === 0) {
    console.log(red('✗ HTTPS traffic is reaching the proxy but Tapsmith can\'t decrypt it.'));
    console.log();
    console.log(yellow('  The Tapsmith MITM CA is NOT trusted on the device.'));
    console.log();
    console.log('  Fix:');
    console.log(`  ${dim('1)')} On the iPhone open ${bold('Settings → General → About → Certificate')}`);
    console.log(`     ${bold('Trust Settings')}. ${dim('(This row only appears AFTER you install')}`);
    console.log(`     ${dim('a profile that contains a custom CA, which the mobileconfig does.)')}`);
    console.log(`  ${dim('2)')} Toggle on full trust for ${bold('Tapsmith MITM CA')}.`);
    console.log(`  ${dim('3)')} Re-run ${bold('tapsmith verify-ios-network')}.`);
    console.log();
    return false;
  }

  console.log(green('✓ Network capture is fully working!'));
  console.log();
  console.log(`  Tapsmith saw ${bold(String(outcome.httpsEntries))} HTTPS request(s) and decrypted`);
  console.log(`  ${bold(String(outcome.decryptedEntries))} of them. You're ready to run ${bold('tapsmith test')}`);
  console.log(`  with ${bold("trace: 'on'")} and inspect decrypted HTTPS entries in the trace viewer.`);
  console.log();
  return true;
}

// ─── CLI entry point ────────────────────────────────────────────────────

export async function runVerifyIosNetwork(opts: VerifyOptions): Promise<void> {

  try {
    const outcome = await runVerification(opts.udid);
    const ok = reportOutcome(outcome);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
