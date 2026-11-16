/**
 * Probe whether the Tapsmith XCUITest runner is trusted on a physical iOS
 * device. Used by `tapsmith test` to fail fast (and by future interactive
 * wizards to poll) when the developer certificate has been revoked,
 * re-issued, or was never trusted in the first place.
 *
 * Why this matters: without this probe, a `tapsmith test` run against a
 * device with an untrusted dev cert silently proceeds through set_device
 * + start_agent, then hangs for 60+ seconds inside xcodebuild before
 * surfacing a cryptic "Developer App Certificate is not trusted" failure.
 * Users blame flakiness. In reality, the fix is a two-tap Settings
 * dance — we just need to catch it before launching the suite.
 *
 * Implementation: `xcrun devicectl device process launch <bundle-id>`
 * against the runner's bundle ID. This is ~1s end-to-end and pattern-
 * matches cleanly on trust failures. Notably this is NOT `xcodebuild
 * test-without-building`, which is 60s+ minimum and would double the
 * startup of every `tapsmith test` run. The devicectl path was already
 * proven reliable during the OCSP-debugging work.
 *
 * First-run caveat: the probe only helps when the runner is already
 * installed on the device. On a fresh setup the flow is still
 * ios build-agent → first `tapsmith test` (which installs the runner via
 * xcodebuild) → iOS trust prompt → user trusts → second `tapsmith test`.
 * The probe's value is on that second-and-subsequent runs — the common
 * steady-state case with free Apple accounts rolling profiles weekly.
 *
 * Stale-runner caveat: the probe launches whatever runner is on the phone,
 * which may be an older build than the one this run will install — signed
 * with a profile that has since gone (a free account's 7-day expiry), or by
 * another team. Such a runner fails exactly like an untrusted one, and
 * nothing in Settings can fix it. {@link checkRunnerTrust} therefore
 * replaces the runner with the local build before it believes an
 * `untrusted` verdict.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { profileExpiryInfoAt, readProfileExpiryDate, type ProfileExpiryInfo } from './ios-profile-expiry.js';

const execFileP = promisify(execFile);

export type TrustState =
  /** Runner launched successfully — cert is trusted. */
  | 'trusted'
  /** Runner failed to launch because the dev cert isn't trusted on the device. */
  | 'untrusted'
  /** Runner isn't installed yet (fresh setup — first `tapsmith test` will install it). */
  | 'runner-not-installed'
  /** Probe couldn't determine state (devicectl unavailable, unknown error, etc.). */
  | 'unknown';

export interface TrustProbeResult {
  state: TrustState
  /** Raw devicectl output for debugging when state !== 'trusted'. */
  raw?: string
}

/** Bundle ID of the Tapsmith XCUITest runner app. */
export const TAPSMITH_RUNNER_BUNDLE_ID = 'dev.tapsmith.agent.xctrunner';

// Per-session cache. Invalidated by `clearTrustProbeCache()` (used by
// interactive wizards that poll after asking the user to go trust the
// cert). `tapsmith test` calls `probeCertTrust` at most once per invocation
// so caching is effectively free for the common case but essential for
// the polling case.
const sessionCache = new Map<string, TrustProbeResult>();

/** Clear the session cache — call after the user has acted on an untrusted result. */
export function clearTrustProbeCache(udid?: string): void {
  if (udid) sessionCache.delete(udid);
  else sessionCache.clear();
}

/**
 * Recognise `xcrun devicectl device process launch` success output.
 * Observed on Xcode 26 / iOS 18+ / iOS 26+:
 *
 *     Launched application with dev.tapsmith.agent.xctrunner bundle identifier.
 *
 * The "Launched application" line is specifically what we want — devicectl
 * will also print `Launched process with PID …` for some other commands,
 * so the broader pattern catches both. Kept separate from the error
 * classifier so a `classify` fall-through can never accidentally be read
 * as success.
 */
export function isSuccessfulLaunch(raw: string): boolean {
  return /launched application with|launched process with pid/i.test(raw);
}

/**
 * Pattern-match devicectl's error output for known trust failure signals.
 *
 * devicectl doesn't expose a structured error code for "dev cert not
 * trusted" vs "runner missing" vs "device locked", so we fall back to
 * substring matching on the human-readable message. Multiple patterns
 * kept for defensive coverage across iOS versions — Apple re-words these
 * strings between major releases and the probe should degrade to
 * 'unknown' rather than falsely reporting 'trusted'.
 */
export function classifyDevicectlError(raw: string): TrustState {
  const s = raw.toLowerCase();
  // Untrusted developer cert signatures. Observed across iOS 16–18 and
  // devicectl versions shipped with Xcode 15/16/26. All of these point
  // at the same root cause (Settings → VPN & Device Management → Trust).
  if (
    s.includes('not trusted') ||
    s.includes('untrusted developer') ||
    s.includes('untrusteddeveloper') ||
    s.includes('developer app certificate') ||
    s.includes('unable to launch') && s.includes('trust') ||
    s.includes('verify the developer') ||
    s.includes('could not be verified')
  ) {
    return 'untrusted';
  }
  // Runner missing — normal on a fresh device before the first xcodebuild
  // install.
  if (
    s.includes('no such app') ||
    s.includes('application not found') ||
    s.includes('could not find') && s.includes(TAPSMITH_RUNNER_BUNDLE_ID.toLowerCase()) ||
    s.includes('application bundle') && s.includes('not found')
  ) {
    return 'runner-not-installed';
  }
  return 'unknown';
}

/**
 * Launch the Tapsmith runner via devicectl and classify the outcome.
 *
 * Success → 'trusted'. Failure → classify the stderr. This is intentionally
 * a "launch and discard" — we don't care that the process stays alive; we
 * just need iOS to either honour the launch request (trusted) or reject
 * it (untrusted). devicectl returns as soon as the launch request has
 * been accepted or rejected, which is ~1s.
 *
 * Timeout is generous (10s) to handle devicectl's own occasional warm-up
 * latency on Xcode 26, but the common-case latency is well under 2s.
 */
export async function probeCertTrust(udid: string): Promise<TrustProbeResult> {
  const cached = sessionCache.get(udid);
  if (cached) return cached;

  let result: TrustProbeResult;
  try {
    const { stdout, stderr } = await execFileP(
      'xcrun',
      ['devicectl', 'device', 'process', 'launch', '--device', udid, TAPSMITH_RUNNER_BUNDLE_ID],
      { timeout: 10_000 },
    );
    // devicectl can exit 0 and still report a launch failure in stdout.
    // Be strict: only treat an explicit success as 'trusted'. Everything
    // else routes through the error classifier.
    const combined = `${stdout}\n${stderr}`;
    if (isSuccessfulLaunch(combined)) {
      result = { state: 'trusted' };
    } else {
      const state = classifyDevicectlError(combined);
      result = { state, raw: combined };
    }
  } catch (err) {
    // execFile throws on non-zero exit, which is the typical "launch
    // refused" path — the error object's stderr has the message we need.
    const errWithOutput = err as { stdout?: string; stderr?: string; message?: string };
    const raw = `${errWithOutput.stdout ?? ''}\n${errWithOutput.stderr ?? ''}\n${errWithOutput.message ?? ''}`;
    const state = classifyDevicectlError(raw);
    result = { state, raw };
  }

  sessionCache.set(udid, result);
  return result;
}

// ─── Stale runner replacement ───

/**
 * The signed XCUITest runner app (`<Target>-Runner.app`) that the device
 * build beside `xctestrunPath` produced — the app `xcodebuild` would install
 * for this run. It lives under `<Products>/<config>-iphoneos/`, next to the
 * xctestrun. Returns `undefined` when the build has no runner app.
 */
export function findRunnerApp(xctestrunPath: string): string | undefined {
  const productsDir = path.dirname(xctestrunPath);
  let configs: string[];
  try {
    configs = fs.readdirSync(productsDir).filter((entry) => entry.endsWith('-iphoneos')).sort();
  } catch {
    return undefined;
  }
  for (const config of configs) {
    let apps: string[];
    try {
      apps = fs.readdirSync(path.join(productsDir, config));
    } catch {
      continue;
    }
    const runner = apps.filter((app) => app.endsWith('-Runner.app')).sort()[0];
    if (runner) return path.join(productsDir, config, runner);
  }
  return undefined;
}

/** The device operations {@link checkRunnerTrust} uses; injectable for tests. */
export interface RunnerTrustOps {
  probe(udid: string): Promise<TrustProbeResult>
  /** Remove the Tapsmith runner from the device. Must not throw when it is not installed. */
  uninstallRunner(udid: string): Promise<void>
  installApp(udid: string, appPath: string): Promise<void>
  /** Expiry of the provisioning profile embedded in `appPath`, when readable. */
  profileExpiry(appPath: string): ProfileExpiryInfo | undefined
}

export type RunnerTrustCheck =
  /** Nothing blocks the run. `replaced` when a runner that could not launch was swapped for the local build. */
  | { outcome: 'ok', state: Exclude<TrustState, 'untrusted'>, replaced: boolean }
  /** The runner on the phone cannot launch and the local build has no runner app to replace it with. */
  | { outcome: 'no-runner-app', xctestrunPath: string, raw?: string }
  /** The local build's provisioning profile has expired: installing it would fail too. */
  | { outcome: 'profile-expired', runnerApp: string, expiry: ProfileExpiryInfo }
  /** Installing the local build's runner failed. */
  | { outcome: 'install-failed', runnerApp: string, detail: string }
  /** The local build's runner is installed and still refused: the user must trust its developer. */
  | { outcome: 'untrusted', runnerApp: string, raw?: string };

/**
 * Probe the runner on `udid`; when it is refused as untrusted, replace it
 * with the runner from `xctestrunPath`'s build and probe again, so the
 * verdict is about the build this run uses — not a stale runner left over
 * from an older build, profile or team.
 *
 * `resolveXctestrun` is called only on that path. It may throw (no local
 * build), and the error propagates: the fix is then to build the agent.
 * Only the Tapsmith runner's bundle ID is ever uninstalled.
 */
export async function checkRunnerTrust(
  udid: string,
  resolveXctestrun: () => Promise<string>,
  ops: RunnerTrustOps = defaultRunnerTrustOps,
  onProgress?: (message: string) => void,
): Promise<RunnerTrustCheck> {
  const first = await ops.probe(udid);
  if (first.state !== 'untrusted') return { outcome: 'ok', state: first.state, replaced: false };

  const xctestrunPath = await resolveXctestrun();
  const runnerApp = findRunnerApp(xctestrunPath);
  if (!runnerApp) return { outcome: 'no-runner-app', xctestrunPath, raw: first.raw };
  const expiry = ops.profileExpiry(runnerApp);
  if (expiry?.expired) return { outcome: 'profile-expired', runnerApp, expiry };

  // Uninstall first: iOS refuses to install over an app with the same
  // bundle ID signed by another team, which is one way a runner goes stale.
  onProgress?.('the Tapsmith runner on the device cannot launch; reinstalling it from the local build');
  await ops.uninstallRunner(udid);
  try {
    await ops.installApp(udid, runnerApp);
  } catch (err) {
    return { outcome: 'install-failed', runnerApp, detail: err instanceof Error ? err.message : String(err) };
  }
  clearTrustProbeCache(udid);
  const second = await ops.probe(udid);
  if (second.state === 'untrusted') return { outcome: 'untrusted', runnerApp, raw: second.raw };
  return { outcome: 'ok', state: second.state, replaced: true };
}

/**
 * The lines to print when {@link checkRunnerTrust} blocks the run, and the
 * error to throw. Undefined for `ok`.
 */
export function describeRunnerTrustFailure(check: RunnerTrustCheck): { lines: string[], error: string } | undefined {
  switch (check.outcome) {
    case 'ok':
      return undefined;
    case 'no-runner-app':
      return {
        lines: [
          'The Tapsmith runner on the device cannot launch, and the local agent build has no runner app to replace it with',
          `(looked beside ${check.xctestrunPath}).`,
          'Re-run `tapsmith ios build-agent`.',
        ],
        error: 'iOS agent build has no runner app',
      };
    case 'profile-expired':
      return {
        lines: [
          `The provisioning profile of the local agent build expired on ${check.expiry.expiresAt.slice(0, 10)}, so the device refuses its runner.`,
          'Re-run `tapsmith ios build-agent` to sign it with a current profile.',
        ],
        error: 'iOS agent provisioning profile expired',
      };
    case 'install-failed':
      return {
        lines: [
          'The Tapsmith runner on the device cannot launch, and installing the local build in its place failed:',
          ...check.detail.split('\n').map((line) => `  ${line}`),
          'Re-run `tapsmith ios build-agent`, and check the device is registered to your team',
          '(Xcode → Window → Devices and Simulators).',
        ],
        error: 'Could not install the Tapsmith runner on the device',
      };
    case 'untrusted':
      return {
        lines: [
          'The device does not trust the developer that signed the Tapsmith runner.',
          'On the phone, open Settings → General → VPN & Device Management,',
          'tap the Apple Development entry for your Apple ID, and tap Trust.',
          'Tapsmith has just installed the runner from your local build, so the entry is there now.',
        ],
        error: 'iOS developer certificate not trusted on device',
      };
  }
}

const RUNNER_UNINSTALL_TIMEOUT_MS = 60_000;

const defaultRunnerTrustOps: RunnerTrustOps = {
  probe: probeCertTrust,
  async uninstallRunner(udid) {
    try {
      await execFileP(
        'xcrun',
        ['devicectl', 'device', 'uninstall', 'app', '--device', udid, TAPSMITH_RUNNER_BUNDLE_ID],
        { timeout: RUNNER_UNINSTALL_TIMEOUT_MS },
      );
    } catch {
      // Not installed, or the uninstall failed: the install that follows
      // either replaces the runner or reports why it cannot.
    }
  },
  async installApp(udid, appPath) {
    const { installAppOnDevice } = await import('./ios-devicectl.js');
    await installAppOnDevice(udid, appPath);
  },
  profileExpiry(appPath) {
    const profilePath = path.join(appPath, 'embedded.mobileprovision');
    const expiresAt = readProfileExpiryDate(profilePath);
    if (!expiresAt) return undefined;
    const date = new Date(expiresAt);
    return Number.isNaN(date.getTime()) ? undefined : profileExpiryInfoAt(date, profilePath);
  },
};
