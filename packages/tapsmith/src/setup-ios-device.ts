/**
 * `tapsmith ios setup-device` — first-run preflight for physical iOS devices.
 *
 * Runs an idempotent ✓ / ✗ checklist of the tribal knowledge users would
 * otherwise have to pick up from Stack Overflow and Apple's docs. Each
 * failing row prints the exact command / action to fix it.
 *
 * The failure modes this catches:
 *   - Xcode command-line tools not installed
 *   - `xcrun devicectl` not available (Xcode < 15)
 *   - `libimobiledevice` (`iproxy`) not installed
 *   - No code signing identity in the user's keychain
 *   - No physical device connected / paired / trusted
 *   - Developer Mode disabled on the device
 *
 * Non-goals: this command does NOT modify system state — it only reads.
 * The user is the one that runs brew install, opens Xcode to pair the
 * device, or flips the Developer Mode toggle on the phone.
 */

import { execFileSync } from 'node:child_process';
import { listPhysicalDevices, type PhysicalDeviceInfo } from './ios-devicectl.js';
import { findDeviceXctestrun, staleNpmDeviceBuild } from './ios-device-resolve.js';
import { displayPath } from './ios-agent-paths.js';
import { parseCodesignIdentities, readXcodeRegisteredTeams } from './build-ios-agent.js';
import { getProfileExpiryInfo, formatExpiryWarning, EXPIRY_WARNING_DAYS } from './ios-profile-expiry.js';
import { formatJson, jsonError, type JsonCheck } from './cli-json.js';

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

// ─── Individual checks ───────────────────────────────────────────────────

export interface CheckResult {
  label: string
  ok: boolean
  detail?: string
  fix?: string[]
  /**
   * When `true`, this check is advisory only — a failure prints a ⚠ hint
   * but doesn't block the overall preflight. Used for checks (like
   * firewall stealth mode) that matter for a specific Tapsmith feature
   * rather than the basic test-on-device path.
   */
  advisory?: boolean
}

/** Check Xcode command-line tools are installed. */
export function checkXcodeCommandLineTools(): CheckResult {
  try {
    const path = execFileSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'Xcode command-line tools', ok: true, detail: path };
  } catch {
    return {
      label: 'Xcode command-line tools',
      ok: false,
      fix: [
        'Install Xcode and command-line tools:',
        '  1) Install Xcode from the Mac App Store',
        '  2) Run: xcode-select --install',
        '  3) Accept the Xcode license: sudo xcodebuild -license accept',
      ],
    };
  }
}

/** Check `xcrun devicectl` (Xcode 15+) is available. */
export function checkDevicectl(): CheckResult {
  try {
    const path = execFileSync('xcrun', ['--find', 'devicectl'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'xcrun devicectl (Xcode 15+)', ok: true, detail: path };
  } catch {
    return {
      label: 'xcrun devicectl (Xcode 15+)',
      ok: false,
      fix: [
        'devicectl ships with Xcode 15 or later. Update Xcode via the',
        'Mac App Store, or install the latest Xcode command-line tools.',
      ],
    };
  }
}

/** Check `iproxy` from libimobiledevice is on PATH. */
export function checkIproxy(): CheckResult {
  try {
    const path = execFileSync('which', ['iproxy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { label: 'libimobiledevice (iproxy)', ok: true, detail: path };
  } catch {
    return {
      label: 'libimobiledevice (iproxy)',
      ok: false,
      fix: [
        'Tapsmith tunnels the agent socket from the device via iproxy.',
        'Install it with Homebrew:',
        '  brew install libimobiledevice',
      ],
    };
  }
}

/**
 * Check signing identity state. Two gates here:
 *   (1) keychain must contain at least one "Apple Development" / "Apple
 *       Distribution" certificate — this proves there's a usable cert
 *       somewhere on the machine.
 *   (2) Xcode must have at least one Apple ID signed in so
 *       `IDEProvisioningTeams` is populated — `xcodebuild`'s automatic
 *       signing requires this even when the keychain has a valid cert.
 *
 * The common failure mode (old Xcode install, imported cert without account)
 * is (1) OK but (2) missing. That produces the cryptic "No Account for Team
 * 'XYZ'" error at build time. Flagging both gates up front prevents wasted
 * xcodebuild runs.
 */
export function checkSigningIdentities(): CheckResult {
  let raw: string;
  try {
    raw = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return {
      label: 'Code signing identity',
      ok: false,
      fix: [
        '`security find-identity` failed. Make sure Xcode CLT is installed',
        'then try: security find-identity -v -p codesigning',
      ],
    };
  }
  const keychain = parseCodesignIdentities(raw);
  if (keychain.length === 0) {
    return {
      label: 'Code signing identity',
      ok: false,
      fix: [
        'No "Apple Development" / "Apple Distribution" identity found in the keychain.',
        'Sign in to your Apple Developer account via Xcode:',
        '  1) Open Xcode → Settings → Accounts',
        '  2) Click + → Apple ID → sign in',
        '  3) Select your team and Xcode will create a development certificate',
      ],
    };
  }

  const xcodeTeams = readXcodeRegisteredTeams();
  if (xcodeTeams.length === 0) {
    return {
      label: 'Apple Developer team registered with Xcode',
      ok: false,
      fix: [
        `Keychain has ${keychain.length} signing cert(s), but Xcode has no Apple ID`,
        'signed in. `xcodebuild` will fail with "No Account for Team ..." until',
        'you sign in via:',
        '  1) Open Xcode → Settings → Accounts',
        '  2) Click + → Apple ID',
        '  3) Pick the team that owns the keychain cert',
      ],
    };
  }

  // Warn (but don't fail) if keychain teams and Xcode teams don't overlap.
  // This is usually a stale keychain cert from a different team — the Xcode
  // team is what xcodebuild will actually use, so we proceed.
  const xcodeTeamIds = new Set(xcodeTeams.map((t) => t.teamId));
  const overlap = keychain.some((k) => xcodeTeamIds.has(k.teamId));

  const teamsDesc = xcodeTeams.length === 1
    ? xcodeTeams[0]!.teamId
    : `${xcodeTeams.length} teams (${xcodeTeams.map((t) => t.teamId).join(', ')})`;

  return {
    label: 'Apple Developer team registered with Xcode',
    ok: true,
    detail: overlap ? teamsDesc : `${teamsDesc} (keychain has a cert for a different team)`,
  };
}

/**
 * Check whether `sudo /usr/bin/true` runs without a password prompt. Xcode
 * 26's CoreDevice calls `sudo -- /usr/bin/true` to warm the sudo cache
 * before mounting the Developer Disk Image, which pops a "Password:"
 * prompt mid-`tapsmith test` — right after "Starting iOS agent…" — making
 * it look like Tapsmith is asking for credentials when it's actually
 * xcodebuild.
 *
 * `/usr/bin/true` is a literal no-op (exit 0, no side effects), so a
 * narrowly-scoped sudoers NOPASSWD rule on that single binary is safe
 * and removes the prompt permanently across sessions, reboots, and
 * every future `tapsmith test` run.
 *
 * Historical note: earlier versions suggested `DevToolsSecurity -enable`
 * + `dseditgroup … _developer`. That path worked on older Xcode but is
 * a no-op on Xcode 26 — CoreDevice asks for auth regardless of
 * `_developer` membership.
 */
export function checkSudoTruePasswordless(): CheckResult {
  try {
    execFileSync('sudo', ['-n', '/usr/bin/true'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 2_000,
    });
    return {
      label: 'Passwordless xcodebuild DDI mount',
      ok: true,
      detail: 'sudoers rule is in place (no auth prompt during physical-device test runs)',
    };
  } catch {
    return {
      label: 'Passwordless xcodebuild DDI mount',
      ok: false,
      advisory: true,
      fix: [
        'Not configured. The first `xcodebuild` against a physical device per',
        'macOS login session will pop a "Password:" prompt mid-test — Xcode\'s',
        'CoreDevice layer primes the sudo cache via `sudo -- /usr/bin/true`',
        'before mounting the Developer Disk Image. Run this one-time to make',
        'the prompt go away for good:',
        '',
        '  echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/true" | sudo tee /etc/sudoers.d/zz-tapsmith-xcode-ddi',
        '  sudo chmod 440 /etc/sudoers.d/zz-tapsmith-xcode-ddi',
        '',
        '/usr/bin/true has no side effects — xcodebuild only calls it to warm',
        'the sudo cache — so NOPASSWD on that single binary is safe. The',
        '`zz-` prefix ensures our rule sorts after any user-specific file in',
        '/etc/sudoers.d/ that might otherwise override it (sudoers uses',
        'last-match-wins rule resolution).',
      ],
    };
  }
}

/**
 * Check the provisioning-profile expiry for the currently-built iOS agent
 * runner. Free Apple Developer accounts re-roll the profile every 7 days,
 * and a profile that's about to expire is the single most common cause of
 * "it suddenly stopped working" reports. Surfacing it here means users
 * running `tapsmith ios setup-device` before a test session get an immediate
 * "rebuild now" nudge rather than learning mid-test.
 *
 * Returns `ok: true` with no detail when no runner is built yet (that's
 * caught separately by `checkIosAgentBuilt`) or when the profile is
 * outside the warning window.
 */
export function checkProfileExpiry(startDir: string = process.cwd()): CheckResult {
  // The runner `tapsmith test` would pick with this directory as rootDir
  // (PILOT-264).
  const xctestrunPath = findDeviceXctestrun(startDir);
  if (!xctestrunPath) {
    const detail = staleNpmDeviceBuild()
      ? 'not checked: the runner needs a rebuild (above)'
      : 'no signed runner yet (build first)';
    return { label: 'Provisioning profile expiry', ok: true, detail };
  }
  const info = getProfileExpiryInfo(xctestrunPath);
  if (!info) {
    return { label: 'Provisioning profile expiry', ok: true, detail: 'could not determine (non-fatal)' };
  }
  if (info.daysUntilExpiry > EXPIRY_WARNING_DAYS) {
    return {
      label: 'Provisioning profile expiry',
      ok: true,
      detail: `${info.daysUntilExpiry} days remaining`,
    };
  }
  const warning = formatExpiryWarning(info);
  return {
    label: 'Provisioning profile expiry',
    ok: false,
    advisory: true,
    fix: warning ? [warning] : ['Profile near expiry — re-run `tapsmith ios build-agent`.'],
  };
}

/**
 * Check whether the signed TapsmithAgent runner has been built for physical
 * devices. This is a cheap cache lookup (a checkout's `ios-agent/.build-device`,
 * or the npm install's under `~/.tapsmith/ios-agent`)
 * that saves the user from having to remember to run `tapsmith ios build-agent`
 * separately. Advisory because the check isn't strictly required — users
 * can run `tapsmith ios build-agent` any time — but surfacing its state here
 * means one less step in the "next steps" list when it's already done.
 */
export function checkIosAgentBuilt(startDir: string = process.cwd()): CheckResult {
  // The lookup `tapsmith test` uses, from this directory as rootDir: a
  // checkout's ios-agent/.build-device in or above startDir, then the npm
  // install's ~/.tapsmith/ios-agent build (PILOT-264).
  const xctestrun = findDeviceXctestrun(startDir);
  if (xctestrun) {
    return { label: 'Signed iOS agent runner', ok: true, detail: displayPath(xctestrun) };
  }
  const stale = staleNpmDeviceBuild();
  if (stale) {
    return {
      label: 'Signed iOS agent runner',
      ok: false,
      advisory: true,
      fix: [
        `The runner under ~/.tapsmith/ios-agent was built by ${stale.builtBy ? `Tapsmith ${stale.builtBy}` : 'another Tapsmith version'} (this is ${stale.current}).`,
        `Rebuild it with Tapsmith ${stale.current} (run it in your project):`,
        '  npx tapsmith ios build-agent',
      ],
    };
  }
  return {
    label: 'Signed iOS agent runner',
    ok: false,
    advisory: true,
    fix: [
      'Not built yet. Run this once (takes 60–120s first run, <10s incremental):',
      '  tapsmith ios build-agent',
      '(advisory — you can build it at any time before `tapsmith test`)',
    ],
  };
}

const CONNECT_STEPS = [
  '  1) Plug the device into this Mac via USB',
  '  2) On the device, tap "Trust This Computer" when prompted',
  '  3) Enable Developer Mode:',
  '       Settings → Privacy & Security → Developer Mode → On',
  '     (requires a device reboot)',
  '  4) Open Xcode → Window → Devices and Simulators and wait for',
  '     the device to register under your team',
];

/**
 * Check connected physical devices and their pairing / DDI / Developer Mode
 * state. devicectl also lists devices this Mac only remembers (unplugged, or
 * paired with another Mac); those are returned as `notConnected` and never
 * count toward the verdict.
 */
export function checkDeviceConnection(
  listed: PhysicalDeviceInfo[] = listPhysicalDevices(),
): { ok: boolean; devices: PhysicalDeviceInfo[]; notConnected: PhysicalDeviceInfo[]; label: string; fix?: string[] } {
  const devices = listed.filter((d) => d.isConnected);
  const notConnected = listed.filter((d) => !d.isConnected);
  const label = 'Physical iOS device paired';
  if (devices.length === 0) {
    const fix = notConnected.length === 0
      ? ['No physical iOS device found. To connect one:', ...CONNECT_STEPS]
      : [
        `No physical iOS device is connected. This Mac remembers ${deviceNames(notConnected)}, but none is reachable now.`,
        'To connect one:',
        ...CONNECT_STEPS,
      ];
    return { ok: false, devices: [], notConnected, label, fix };
  }
  return { ok: true, devices, notConnected, label };
}

function deviceNames(list: PhysicalDeviceInfo[]): string {
  return list.map((d) => `${d.name} (${d.udid})`).join(', ');
}

// ─── Pretty-printing ─────────────────────────────────────────────────────

function printCheck(result: CheckResult): void {
  if (result.ok) {
    const tail = result.detail ? dim(` — ${result.detail}`) : '';
    console.log(`  ${green('✓')} ${result.label}${tail}`);
    return;
  }
  const advisory = result.advisory === true;
  const marker = advisory ? yellow('⚠') : red('✗');
  console.log(`  ${marker} ${result.label}`);
  if (result.fix) {
    for (const line of result.fix) {
      console.log(`      ${dim(line)}`);
    }
  }
}

function printDeviceStatus(devices: PhysicalDeviceInfo[]): void {
  for (const device of devices) {
    const unpaired = !device.isPaired;
    // Note: we intentionally do NOT inspect `ddiServicesAvailable` here.
    // That field only reflects whether CoreDevice is CURRENTLY holding a
    // Developer Disk Image assertion, not whether one can be mounted on
    // demand. Tapsmith's agent-start path mounts the DDI itself at test time,
    // so flagging DDI-not-mounted in a passive preflight false-alarms on
    // healthy devices (observed: real iPhone that successfully runs
    // 119/119 tests but shows `ddiServicesAvailable: false` when idle).

    const devModeOff = developerModeOff(device);
    const blocked = unpaired || devModeOff;
    const color = blocked ? red : green;
    const marker = blocked ? '✗' : '✓';
    console.log(`  ${color(marker)} ${device.name} ${dim(`(${device.udid})`)}`);
    console.log(`      ${dim(`iOS ${device.osVersion || '?'}`)}`);
    if (unpaired) {
      console.log(`      ${red('not paired')} — open Xcode → Window → Devices and Simulators,`);
      console.log(`        ${dim('wait for the device to appear, then click "Use for Development".')}`);
    }
    if (devModeOff) {
      console.log(`      ${red('Developer Mode off')} — on the device: Settings → Privacy & Security → Developer Mode → On`);
      console.log(`        ${dim('(the device restarts, then asks you to confirm)')}`);
    }
    if (!blocked) {
      console.log(`      ${green('ready for tapsmith test')}`);
    }
  }
}

/**
 * Where network capture goes from here, printed on every exit: this device's
 * own capture setup, and the simulator track for a user who is in the wrong
 * place.
 */
export function networkCaptureNextSteps(): string[] {
  return [
    bold('Network capture (optional):'),
    `  ${dim('•')} On a physical device: ${bold('tapsmith ios network configure <udid>')}, then ${bold('tapsmith ios network verify <udid>')}`,
    `  ${dim('•')} On an iOS simulator instead: ${bold('tapsmith ios network setup-simulator')}`,
    '',
  ];
}

// ─── JSON output ────────────────────────────────────────────────────────

type DeviceConnectionCheck = ReturnType<typeof checkDeviceConnection>;

/** One device in `ios setup-device --json`. */
export interface SetupDeviceJsonDevice {
  udid: string;
  name: string;
  /** Empty when devicectl does not report it. */
  osVersion: string;
  paired: boolean;
  /** `enabled`, `disabled` or `unknown` (only iOS 16+ reports it). */
  developerMode: string;
  /** How CoreDevice reaches it: `wired` (USB), `localNetwork` (Wi-Fi), or `unknown` (not connected now). */
  transport: string;
  fix?: string;
}

export interface SetupDeviceJson {
  ok: boolean;
  checks: JsonCheck[];
  /** The devices connected now; only these count toward `ok`. */
  devices: SetupDeviceJsonDevice[];
  /** Devices devicectl lists that this Mac only remembers (unplugged, or paired with another Mac). */
  notConnected: Array<{ udid: string; name: string }>;
}

const UNPAIRED_FIX = 'Open Xcode → Window → Devices and Simulators, wait for the device to appear, then click "Use for Development".';
const DEVELOPER_MODE_FIX = 'On the device: Settings → Privacy & Security → Developer Mode → On (the device restarts, then asks you to confirm).';

/**
 * Developer Mode is reported off. `unknown` (devices before iOS 16, which have
 * no Developer Mode, or a status devicectl did not report) is not a failure.
 */
function developerModeOff(d: PhysicalDeviceInfo): boolean {
  return d.developerModeStatus === 'disabled';
}

/** The fixes a listed device needs before it can run tests, in order. */
function deviceFixes(d: PhysicalDeviceInfo): string[] {
  const fixes: string[] = [];
  if (!d.isPaired) fixes.push(UNPAIRED_FIX);
  if (developerModeOff(d)) fixes.push(DEVELOPER_MODE_FIX);
  return fixes;
}

function jsonCheck(id: string, result: { label: string; ok: boolean; detail?: string; fix?: string[]; advisory?: boolean }): JsonCheck {
  const check: JsonCheck = {
    id,
    status: result.ok ? 'pass' : result.advisory === true ? 'warn' : 'fail',
    label: result.label,
  };
  // An empty detail or fix is no detail or fix, as in doctor.
  if (result.detail) check.detail = result.detail;
  if (!result.ok && result.fix && result.fix.length > 0) check.fix = result.fix.join('\n');
  return check;
}

/**
 * The device row of the checklist. It fails when no device is connected and when
 * a connected device is unpaired or has Developer Mode off, so a failing `ok`
 * always has a failing check to explain it.
 */
function deviceConnectedCheck(deviceCheck: DeviceConnectionCheck): JsonCheck {
  const unpaired = deviceCheck.devices.filter((d) => !d.isPaired);
  const devModeOff = deviceCheck.devices.filter(developerModeOff);
  if (!deviceCheck.ok || (unpaired.length === 0 && devModeOff.length === 0)) return jsonCheck('device-connected', deviceCheck);
  const detail: string[] = [];
  const fix: string[] = [];
  if (unpaired.length > 0) {
    detail.push(`not paired: ${deviceNames(unpaired)}`);
    fix.push(UNPAIRED_FIX);
  }
  if (devModeOff.length > 0) {
    detail.push(`Developer Mode off: ${deviceNames(devModeOff)}`);
    fix.push(DEVELOPER_MODE_FIX);
  }
  return {
    id: 'device-connected',
    status: 'fail',
    label: deviceCheck.label,
    detail: detail.join('; '),
    fix: fix.join('\n'),
  };
}

/**
 * Hard-fail criteria, shared by the text and JSON output: any non-advisory
 * check failed, or no device connected, or a connected device is unpaired or
 * has Developer Mode off. Devices devicectl only remembers never count.
 * Advisory checks (agent not yet built, profile near expiry, no passwordless
 * sudo) print a ⚠ hint but don't block. We intentionally don't require
 * `ddiServicesAvailable` either; it's an unreliable "is Xcode currently
 * holding a DDI lease?" signal that false-alarms on healthy idle devices
 * (Tapsmith's `startAgent` flow mounts the DDI on demand).
 */
function requiredChecksPass(results: CheckResult[], deviceCheck: DeviceConnectionCheck): boolean {
  return results.every((r) => r.ok || r.advisory === true)
    && deviceCheck.ok && deviceCheck.devices.every((d) => deviceFixes(d).length === 0);
}

/** The `--json` report. Exported for the schema tests. */
export function buildSetupDeviceJson(
  results: Array<{ id: string; result: CheckResult }>,
  deviceCheck: DeviceConnectionCheck,
): SetupDeviceJson {
  return {
    ok: requiredChecksPass(results.map((r) => r.result), deviceCheck),
    checks: [
      ...results.map(({ id, result }) => jsonCheck(id, result)),
      deviceConnectedCheck(deviceCheck),
    ],
    devices: deviceCheck.devices.map((d) => {
      const entry: SetupDeviceJsonDevice = {
        udid: d.udid,
        name: d.name,
        osVersion: d.osVersion,
        paired: d.isPaired,
        developerMode: d.developerModeStatus,
        transport: d.transportType,
      };
      const fixes = deviceFixes(d);
      if (fixes.length > 0) entry.fix = fixes.join('\n');
      return entry;
    }),
    notConnected: deviceCheck.notConnected.map((d) => ({ udid: d.udid, name: d.name })),
  };
}

// ─── Main entry point ───────────────────────────────────────────────────

export interface SetupDeviceDeps {
  platform: NodeJS.Platform;
  /** The host checks, each with its stable JSON id, in display order. */
  hostChecks: () => Array<{ id: string; result: CheckResult }>;
  deviceCheck: () => DeviceConnectionCheck;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function runHostChecks(): Array<{ id: string; result: CheckResult }> {
  return [
    { id: 'xcode-clt', result: checkXcodeCommandLineTools() },
    { id: 'devicectl', result: checkDevicectl() },
    { id: 'iproxy', result: checkIproxy() },
    { id: 'signing', result: checkSigningIdentities() },
    { id: 'sudo-ddi-mount', result: checkSudoTruePasswordless() },
    { id: 'ios-agent-runner', result: checkIosAgentBuilt() },
    { id: 'profile-expiry', result: checkProfileExpiry() },
  ];
}

const MACOS_ONLY = 'tapsmith ios setup-device is only supported on macOS.';

/** Runs the command and returns the process exit code. */
export async function runSetupIosDevice(opts: { json: boolean }, overrides: Partial<SetupDeviceDeps> = {}): Promise<number> {
  const deps: SetupDeviceDeps = {
    platform: process.platform,
    hostChecks: runHostChecks,
    deviceCheck: checkDeviceConnection,
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    ...overrides,
  };

  if (deps.platform !== 'darwin') {
    if (opts.json) {
      deps.stdout(formatJson(jsonError('UNSUPPORTED_PLATFORM', MACOS_ONLY, {
        fix: 'Run it on the Mac the iPhone or iPad is plugged into',
      })));
    } else {
      deps.stderr(red(MACOS_ONLY) + '\n');
    }
    return 1;
  }

  if (opts.json) {
    let report: SetupDeviceJson;
    try {
      report = buildSetupDeviceJson(deps.hostChecks(), deps.deviceCheck());
    } catch (err) {
      deps.stdout(formatJson(jsonError(
        'UNEXPECTED_ERROR',
        `ios setup-device could not finish: ${err instanceof Error ? err.message : String(err)}`,
        { fix: 'To see the full error, run the same command again without --json' },
      )));
      return 1;
    }
    deps.stdout(formatJson(report));
    return report.ok ? 0 : 1;
  }

  return printSetupIosDevice(deps);
}

function printSetupIosDevice(deps: SetupDeviceDeps): number {
  console.log(bold('Tapsmith physical iOS device setup'));
  console.log(dim('Verifying prerequisites for running tests against a real iPhone/iPad…'));
  console.log();

  console.log(bold('Prerequisites'));
  const results = deps.hostChecks().map((c) => c.result);
  for (const r of results) printCheck(r);
  console.log();

  console.log(bold('Devices'));
  const deviceCheck = deps.deviceCheck();
  if (!deviceCheck.ok) {
    console.log(`  ${red('✗')} ${deviceCheck.label}`);
    if (deviceCheck.fix) {
      for (const line of deviceCheck.fix) console.log(`      ${dim(line)}`);
    }
  } else {
    printDeviceStatus(deviceCheck.devices);
  }
  for (const d of deviceCheck.notConnected) {
    console.log(`  ${dim(`– ${d.name} (${d.udid}) not connected — ignored`)}`);
  }
  console.log();

  if (!requiredChecksPass(results, deviceCheck)) {
    console.log(red('✗ Some checks failed. Address the issues above and re-run.'));
    console.log();
    for (const line of networkCaptureNextSteps()) console.log(line);
    return 1;
  }

  // Happy path — summarise what's verified vs. what the user still has to
  // do themselves, and don't blur the two. Anything we can't check from
  // the Mac (dev-cert trust on the device, auto-lock setting, app bundle
  // paths, test config file) is clearly labelled as "do this once".
  const advisoryFailures = results.filter((r) => !r.ok && r.advisory === true);
  if (advisoryFailures.length === 0) {
    console.log(green('✓ Everything we can check from the host looks good.'));
  } else {
    console.log(
      green('✓ Required checks passed.') +
      ' ' +
      dim(`(${advisoryFailures.length} advisory hint${advisoryFailures.length === 1 ? '' : 's'} above — not blocking)`),
    );
  }
  console.log();

  console.log(bold('Manual steps Tapsmith can\'t verify from the host:'));
  console.log();
  console.log(`  ${yellow('•')} ${bold('Trust the developer certificate on the device.')}`);
  console.log(`    First time only, after the first ${bold('tapsmith test')} run.`);
  console.log(`    On the phone: ${bold('Settings → General → VPN & Device Management')}`);
  console.log(`    → ${bold('Apple Development: <your name>')} → ${bold('Trust')}.`);
  console.log(`    ${dim('Paid Apple Developer Program accounts often skip this — Xcode')}`);
  console.log(`    ${dim('auto-trusts the team when you register the device.')}`);
  console.log();
  console.log(`  ${yellow('•')} ${bold('Turn off Auto-Lock on the device while testing.')}`);
  console.log(`    ${bold('Settings → Display & Brightness → Auto-Lock → Never')}`);
  console.log(`    ${dim('A locked screen blocks XCUITest — tests hang or fail to find elements.')}`);
  console.log(`    ${dim('Restore your normal setting after the test session.')}`);
  console.log();
  console.log(bold('To run a test:'));
  console.log(`  ${dim('1.')} In your Tapsmith config, set ${bold('platform: \'ios\'')} and ${bold('app')} to your device-signed .app`);
  console.log(`     ${dim('(no')} ${dim('simulator')}${dim(').')} Tapsmith finds the device and the signed agent runner itself:`);
  console.log(`     ${dim('set')} ${bold('device')} ${dim('only when more than one device is paired, and')} ${bold('iosXctestrun')}`);
  console.log(`     ${dim('only to pin a runner built somewhere else.')}`);
  console.log(`  ${dim('2.')} ${bold('tapsmith test --config <your-config>')}`);
  console.log();
  for (const line of networkCaptureNextSteps()) console.log(line);
  return 0;
}
