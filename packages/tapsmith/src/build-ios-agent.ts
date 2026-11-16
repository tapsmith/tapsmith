/**
 * `tapsmith ios build-agent` — thin xcodebuild wrapper for building the Tapsmith
 * XCUITest runner for physical iOS devices.
 *
 * Simulator builds don't need this command — the existing
 * `cd ios-agent && xcodebuild build-for-testing -destination 'platform=iOS Simulator,...'`
 * path works as-is because iphonesimulator SDK auto-disables code signing.
 *
 * Physical device builds require a signed bundle, which is where the DX
 * goes sideways without help. This wrapper:
 *   1. Auto-detects the Apple Developer team ID from existing signing
 *      identities (or accepts one via --team-id), so users rarely have to
 *      type it.
 *   2. Invokes `xcodebuild build-for-testing -destination 'generic/platform=iOS'`
 *      with `CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=<team>` passed as
 *      CLI overrides — this means project.pbxproj stays untouched and the
 *      simulator-only build continues to work byte-for-byte.
 *   3. Parses the xcodebuild output stream for a small set of known
 *      signing / trust errors and appends actionable hints to the final
 *      error message.
 *   4. Locates the resulting `.xctestrun` under the pinned DerivedData
 *      directory and prints a ready-to-paste config snippet.
 *
 * Non-goals:
 *   - Diagnosing arbitrary xcodebuild failures (raw output is preserved).
 *   - Auto-registering devices with Apple Developer (user does this once
 *     via Xcode's Devices & Simulators window).
 *   - Fixing Xcode account state (user does this via Xcode → Settings → Accounts).
 */

import { execFileSync, spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import { getProfileExpiryInfo, formatExpiryWarning } from './ios-profile-expiry.js';
import { npmIosAgentDir, npmIosAgentVersion, npmIosAgentVersionFile, tapsmithPackageVersion } from './ios-agent-paths.js';
import { findDeviceXctestrun } from './ios-device-resolve.js';

// ─── iOS agent source resolution ────────────────────────────────────────

/**
 * Locate the `ios-agent/` directory containing the Swift source and Xcode project.
 *
 * Resolution order:
 *   1. `<cwd>/ios-agent/` — monorepo layout
 *   2. `~/.tapsmith/ios-agent/` — previously extracted from the npm package
 *   3. Extract bundled source from the npm package to `~/.tapsmith/ios-agent/`
 */
export function resolveIosAgentDir(cwd?: string): string {
  // 1. Monorepo
  const monorepo = path.resolve(cwd ?? process.cwd(), 'ios-agent');
  if (fs.existsSync(path.join(monorepo, 'TapsmithAgent.xcodeproj'))) return monorepo;

  // 2. Previously extracted — re-extract if version changed. Re-extracting
  // also removes the device build under it (`.build-device`): that runner was
  // built from the previous version's agent source. The device xctestrun
  // lookup already refuses it and says to rebuild (PILOT-264).
  const cached = npmIosAgentDir();
  const versionFile = npmIosAgentVersionFile();
  const currentVersion = tapsmithPackageVersion();
  const cachedVersion = npmIosAgentVersion() ?? '';

  if (fs.existsSync(path.join(cached, 'TapsmithAgent.xcodeproj')) && cachedVersion === currentVersion) {
    return cached;
  }

  // 3. Extract from bundled npm package source
  const bundled = path.resolve(import.meta.dirname, 'ios-agent');
  if (fs.existsSync(path.join(bundled, 'TapsmithAgent.xcodeproj'))) {
    if (fs.existsSync(cached)) fs.rmSync(cached, { recursive: true, force: true });
    fs.mkdirSync(cached, { recursive: true });
    fs.cpSync(bundled, cached, { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
    const script = path.join(cached, 'create-xcode-project.sh');
    if (fs.existsSync(script)) {
      try { fs.chmodSync(script, 0o755); } catch { /* non-fatal — build will fail later if script isn't executable */ }
    }
    return cached;
  }

  // Nothing found — return the monorepo path so the caller gets a clear error
  return monorepo;
}

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

// ─── Options ─────────────────────────────────────────────────────────────

export interface BuildIosAgentOptions {
  /** Apple Developer team ID. When undefined, auto-detects from keychain. */
  teamId?: string
  /** Working directory containing ios-agent/. Defaults to cwd. */
  cwd?: string
  /** Emit raw xcodebuild stdout/stderr to the terminal. */
  verbose?: boolean
  /** Override the DerivedData output directory. */
  derivedDataPath?: string
  /** Suppress informational output (config hints, timing). Used when called from the init wizard. */
  quiet?: boolean
}

// ─── Team ID resolution (DX win #1) ──────────────────────────────────────

export interface SigningIdentity {
  teamId: string
  name: string
}

/** A code-signing identity in the keychain, with the team its certificate belongs to. */
export interface KeychainIdentity {
  /** SHA-1 of the certificate, as `security find-identity` prints it. */
  sha1: string
  /** e.g. `Apple Development: Jane Developer (A1B2C3D4E5)`. */
  name: string
  /** The certificate subject's OU; undefined when the certificate could not be read. */
  teamId: string | undefined
}

/**
 * Parse `security find-identity -v -p codesigning` output into the Apple
 * development and distribution identities it lists:
 *   1) 0D03…3637 "Apple Development: Jane Developer (C8YTWZ6YM3)"
 *
 * The ID in brackets is the certificate's own identifier, not the team, so
 * this returns no team: the team is the certificate subject's OU, which
 * `parseCertificateTeams` reads.
 */
export function parseFindIdentityOutput(rawOutput: string): Array<{ sha1: string, name: string }> {
  const bySha1 = new Map<string, { sha1: string, name: string }>();
  const re = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"((?:Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution)[^"]*)"/gm;
  for (const match of rawOutput.matchAll(re)) {
    const sha1 = match[1]!.toUpperCase();
    if (!bySha1.has(sha1)) bySha1.set(sha1, { sha1, name: match[2]! });
  }
  return Array.from(bySha1.values());
}

/**
 * Parse `security find-certificate -a -Z -p` output (each certificate's
 * `SHA-1 hash:` line followed by its PEM) into a map from SHA-1 to the team
 * ID in the certificate subject's OU — Apple puts the team there:
 *   UID=…, CN=Apple Development: Jane Developer (C8YTWZ6YM3), OU=92878B7448, O=…
 * A certificate with no OU, or whose PEM does not parse, is left out.
 */
export function parseCertificateTeams(rawOutput: string): Map<string, string> {
  const teams = new Map<string, string>();
  const re = /SHA-1 hash:\s*([0-9A-Fa-f]{40})\s*(-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----)/g;
  for (const match of rawOutput.matchAll(re)) {
    let subject: string;
    try {
      subject = new X509Certificate(match[2]!).subject;
    } catch {
      continue;
    }
    const ou = /^OU=([A-Z0-9]{10})$/m.exec(subject);
    if (ou) teams.set(match[1]!.toUpperCase(), ou[1]!);
  }
  return teams;
}

/**
 * The keychain's Apple code-signing identities, each with the team its
 * certificate belongs to. Throws when `security find-identity` cannot run.
 *
 * Note that keychain identities and Xcode's registered teams can diverge —
 * `xcodebuild` consults Xcode's own account list, which is what
 * `resolveTeamId` prefers; the keychain is only a fallback and a "has a
 * certificate" signal for the preflight checklist (`ios setup-device`).
 */
export function readKeychainSigningIdentities(): KeychainIdentity[] {
  let raw: string;
  try {
    raw = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `\`security find-identity\` failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const identities = parseFindIdentityOutput(raw);
  const teams = new Map<string, string>();
  // `-c` matches on the certificate's name; one lookup per distinct name.
  for (const name of new Set(identities.map((i) => i.name))) {
    try {
      const pem = execFileSync('security', ['find-certificate', '-a', '-Z', '-p', '-c', name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const [sha1, team] of parseCertificateTeams(pem)) teams.set(sha1, team);
    } catch {
      // The identity stays listed, with no team.
    }
  }
  return identities.map((i) => ({ ...i, teamId: teams.get(i.sha1) }));
}

/**
 * Parse `defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier`
 * (Xcode 27+) or `… IDEProvisioningTeams` (earlier Xcodes) output into the
 * teams Xcode has registered in its Accounts preferences. These are the
 * teams `xcodebuild` will accept via `DEVELOPMENT_TEAM=`.
 *
 * Both keys hold one dictionary per team, grouped by account (an account
 * UUID in Xcode 27, the Apple ID email before):
 *   {
 *     "<account>" = (
 *       { isFreeProvisioningTeam = 0; teamID = 92878B7448; teamName = "Jane Developer"; teamType = Individual; },
 *       ...
 *     );
 *   }
 *
 * `defaults` prints an old-style plist, not XML, so each innermost `{…}` is
 * read with a regex. Values are bare when they are plain identifiers and
 * quoted (with `\"` escapes) otherwise.
 */
export function parseXcodeTeams(rawOutput: string): SigningIdentity[] {
  const byTeamId = new Map<string, SigningIdentity>();
  const value = (block: string, field: string): string | undefined => {
    const m = new RegExp(`\\b${field}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]+))\\s*;`).exec(block);
    if (!m) return undefined;
    return m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2];
  };
  for (const [block] of rawOutput.matchAll(/\{[^{}]*\}/g)) {
    const teamId = value(block, 'teamID');
    if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId) || byTeamId.has(teamId)) continue;
    byTeamId.set(teamId, { teamId, name: value(block, 'teamName') ?? teamId });
  }
  return Array.from(byTeamId.values());
}

/**
 * Xcode's preference keys for the teams of its signed-in accounts: Xcode 27
 * moved them from `IDEProvisioningTeams` to `IDEProvisioningTeamByIdentifier`
 * (PILOT-1203). Both are read, so either Xcode works.
 */
const XCODE_TEAM_KEYS = ['IDEProvisioningTeamByIdentifier', 'IDEProvisioningTeams'] as const;

/**
 * Read Xcode's registered teams from `~/Library/Preferences/com.apple.dt.Xcode.plist`
 * via `defaults read`. Returns an empty array when Xcode has no accounts
 * configured (a common failure mode: keychain has a cert but Xcode's
 * Accounts UI is empty — `xcodebuild` refuses to use such an identity).
 */
export function readXcodeRegisteredTeams(): SigningIdentity[] {
  const byTeamId = new Map<string, SigningIdentity>();
  for (const key of XCODE_TEAM_KEYS) {
    let raw: string;
    try {
      raw = execFileSync('defaults', ['read', 'com.apple.dt.Xcode', key], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      continue; // this Xcode doesn't use the key, or no account is signed in
    }
    for (const team of parseXcodeTeams(raw)) {
      if (!byTeamId.has(team.teamId)) byTeamId.set(team.teamId, team);
    }
  }
  return Array.from(byTeamId.values());
}

/**
 * Discover and select the user's Apple Developer team ID.
 *
 * Resolution order (most authoritative first):
 *   1. `--team-id` flag if explicit
 *   2. Teams registered in Xcode (`readXcodeRegisteredTeams`) — this is what
 *      `xcodebuild` consults, so it's the source of truth for whether a
 *      given `DEVELOPMENT_TEAM` will actually work.
 *   3. Fallback: the teams of the keychain's signing certificates — only
 *      used when Xcode has no teams registered, because the keychain can
 *      contain certs for teams that aren't signed into Xcode and
 *      `xcodebuild` will reject those.
 *
 * If multiple teams are found at a level, prompts the user to pick.
 */
export async function resolveTeamId(explicit?: string): Promise<string> {
  if (explicit) return explicit;

  // Step 1: try Xcode's own account list first.
  const xcodeTeams = readXcodeRegisteredTeams();
  if (xcodeTeams.length === 1) {
    const only = xcodeTeams[0]!;
    console.log(dim(`Using Xcode-registered team ${only.teamId} (${only.name})`));
    return only.teamId;
  }
  if (xcodeTeams.length > 1) {
    console.log(dim(`Multiple Xcode-registered teams found.`));
    return promptForTeamId(xcodeTeams);
  }

  // Step 2: fall back to keychain identities.
  let identities: KeychainIdentity[];
  try {
    identities = readKeychainSigningIdentities();
  } catch (err) {
    throw new Error(
      'Failed to run `security find-identity`. Make sure Xcode Command Line Tools are installed ' +
        '(`xcode-select --install`).\n' +
        `  underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (identities.length === 0) {
    throw new Error(
      'No Apple Developer team found.\n\n' +
        '  Fix:\n' +
        '    1. Open Xcode → Settings → Accounts.\n' +
        '    2. Sign in with your Apple ID (free accounts work too).\n' +
        '    3. Select your team so Xcode registers it for automatic signing.\n' +
        '    4. Re-run `tapsmith ios build-agent`.',
    );
  }

  const byTeamId = new Map<string, SigningIdentity>();
  for (const i of identities) {
    if (i.teamId && !byTeamId.has(i.teamId)) byTeamId.set(i.teamId, { teamId: i.teamId, name: i.name });
  }
  const keychainTeams = Array.from(byTeamId.values());
  if (keychainTeams.length === 0) {
    throw new Error(
      'Xcode has no registered Apple Developer account, and the team of the keychain\'s signing ' +
        `certificate${identities.length === 1 ? '' : 's'} could not be read:\n` +
        identities.map((i) => `  ${i.name}`).join('\n') + '\n\n' +
        '  Fix: open Xcode → Settings → Accounts and sign in, or pass your team ID with ' +
        '`tapsmith ios build-agent --team-id <TEAMID>`.',
    );
  }

  // If keychain has a cert but Xcode has NO teams registered, warn loudly —
  // this is the "signed certs but Xcode Accounts UI is empty" failure mode.
  console.log(
    yellow(
      'Warning: a signing certificate is present in the keychain, but Xcode has no ' +
        'registered Apple Developer account. `xcodebuild` may refuse this team with ' +
        '"No Account for Team". Fix: open Xcode → Settings → Accounts and sign in.',
    ),
  );
  if (keychainTeams.length === 1) {
    const only = keychainTeams[0]!;
    console.log(dim(`Falling back to keychain team ${only.teamId} (${only.name})`));
    return only.teamId;
  }
  return promptForTeamId(keychainTeams);
}

async function promptForTeamId(identities: SigningIdentity[]): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `Multiple signing identities found. Pass --team-id explicitly:\n` +
        identities.map((i, idx) => `  ${idx + 1}) ${i.teamId}  ${i.name}`).join('\n'),
    );
  }

  console.log(bold('Multiple Apple Developer teams found:'));
  identities.forEach((i, idx) => {
    console.log(`  ${idx + 1}) ${bold(i.teamId)}  ${dim(i.name)}`);
  });
  console.log();

  // Lazy-import readline so we don't pay the cost for non-interactive paths.
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = (await rl.question(`Select a team [1-${identities.length}]: `)).trim();
      const idx = Number.parseInt(answer, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= identities.length) {
        return identities[idx - 1]!.teamId;
      }
      console.log(red(`Invalid selection. Enter a number between 1 and ${identities.length}.`));
    }
  } finally {
    rl.close();
  }
}

// ─── Error pattern matching (DX win #3) ──────────────────────────────────

interface ErrorHint {
  /** Human-readable label shown after the `hint:` tag. */
  label: string
}

/** What a hint needs to know beyond the matched line. */
export interface HintContext {
  /** The teams Xcode is signed in to (`readXcodeRegisteredTeams`). */
  xcodeTeams: SigningIdentity[]
  /** The team the build asked for (`DEVELOPMENT_TEAM`). */
  requestedTeam: string
}

/**
 * The advice for an xcodebuild account error about `team`. Xcode reports a
 * team that no signed-in account owns either as "No Account for Team" or,
 * on Xcode 27.2, as plain "No Accounts", so both come here. "Sign in" is only
 * right when Xcode has no team at all; a user already signed in to another
 * team just asked for the wrong one.
 */
function accountHint(team: string, xcodeTeams: SigningIdentity[]): ErrorHint {
  if (xcodeTeams.length === 0) {
    return {
      label: `Xcode has no Apple ID signed in. Open Xcode → Settings → Accounts, click + and sign in with the Apple ID that owns team ${team} (free accounts work too), then re-run \`tapsmith ios build-agent\`.`,
    };
  }
  if (xcodeTeams.some((t) => t.teamId === team)) {
    return {
      label: `Xcode lists team ${team}, but xcodebuild found no usable account for it. Open Xcode → Settings → Accounts, select that Apple ID and sign in again if it shows an error, then re-run.`,
    };
  }
  const list = xcodeTeams.map((t) => `${t.teamId} (${t.name})`).join(', ');
  return {
    label: xcodeTeams.length === 1
      ? `Xcode is signed in to team ${list}, not ${team}. Re-run with \`--team-id ${xcodeTeams[0]!.teamId}\`.`
      : `Xcode is signed in to teams ${list}, not ${team}. Re-run with \`--team-id <one of them>\`.`,
  };
}

/**
 * `account` errors (no Apple ID, or none for the team) make every signing step
 * after them fail too, so a `profile` hint seen with one is only a knock-on
 * effect, and its advice (plug in the device) sends the user to the wrong place.
 */
type HintKind = 'account' | 'profile' | 'other';

/**
 * Small set of well-known signing / trust errors from xcodebuild output.
 * Each entry turns a cryptic Apple error into a one-line "how to fix" hint.
 *
 * Scoped intentionally — we only pattern-match errors where the fix is
 * unambiguous. Ambiguous failures surface the raw xcodebuild output without
 * guessing.
 */
const KNOWN_ERROR_PATTERNS: Array<{ re: RegExp, kind: HintKind, hint: (match: RegExpMatchArray, ctx: HintContext) => ErrorHint }> = [
  {
    re: /No Account for Team ['"]([A-Za-z0-9]+)['"]/,
    kind: 'account',
    hint: (m, { xcodeTeams }) => accountHint(m[1]!, xcodeTeams),
  },
  {
    re: /\bNo Accounts:/,
    kind: 'account',
    hint: (_m, { xcodeTeams, requestedTeam }) => accountHint(requestedTeam, xcodeTeams),
  },
  {
    re: /No profiles for ['"]([^'"]+)['"] were found/,
    kind: 'profile',
    hint: (m) => ({
      label: `No provisioning profile for ${m[1]}. Plug in the device and open Xcode → Window → Devices and Simulators; Xcode will auto-register the device and create a profile.`,
    }),
  },
  {
    re: /Automatic signing (?:is|was) unable to resolve/,
    kind: 'other',
    hint: () => ({
      label:
        'Automatic signing could not resolve a profile. Open the project in Xcode once (ios-agent/TapsmithAgent.xcodeproj), select the TapsmithAgentUITests target, and let Xcode refresh signing.',
    }),
  },
  {
    re: /Developer Mode disabled|DVTCoreDeviceEnabledState_Disabled/,
    kind: 'other',
    hint: () => ({
      label:
        'Developer Mode is off on the device. Settings → Privacy & Security → Developer Mode → On, then reboot the device.',
    }),
  },
  {
    re: /Unable to install ['"][^'"]+['"]|installation failed.*valid.*profile/i,
    kind: 'other',
    hint: () => ({
      label:
        'Profile was built but iOS refused installation. On the device, Settings → General → VPN & Device Management → trust the Tapsmith developer profile.',
    }),
  },
  {
    re: /requires a provisioning profile with the (?:NFC|HealthKit|[A-Za-z ]+) feature/,
    kind: 'other',
    hint: () => ({
      label:
        'TapsmithAgent requires an entitlement your current profile does not include. This is unusual for the Tapsmith agent — file an issue with the full xcodebuild output.',
    }),
  },
  {
    re: /The operation couldn['’]t be completed.*CoreSimulator/,
    kind: 'other',
    hint: () => ({
      label:
        'CoreSimulator error during a device build — likely you left the destination as iPhone Simulator. Pass `-destination "generic/platform=iOS"`.',
    }),
  },
];

function matchKnownError(line: string, ctx: HintContext): { kind: HintKind, hint: ErrorHint } | undefined {
  for (const entry of KNOWN_ERROR_PATTERNS) {
    const m = line.match(entry.re);
    if (m) return { kind: entry.kind, hint: entry.hint(m, ctx) };
  }
  return undefined;
}

/** Scan an xcodebuild output line and return any matching hint. */
export function matchKnownErrorHint(line: string, ctx: HintContext = { xcodeTeams: [], requestedTeam: '' }): ErrorHint | undefined {
  return matchKnownError(line, ctx)?.hint;
}

/**
 * The hints for a failed build's output: each once, in order, and without the
 * provisioning-profile hint when an account error caused it.
 */
export function selectErrorHints(lines: string[], ctx: HintContext): ErrorHint[] {
  const matched = lines.flatMap((l) => {
    const hit = matchKnownError(l, ctx);
    return hit ? [hit] : [];
  });
  const accountError = matched.some((h) => h.kind === 'account');
  const seen = new Set<string>();
  const out: ErrorHint[] = [];
  for (const { kind, hint } of matched) {
    if (accountError && kind === 'profile') continue;
    if (seen.has(hint.label)) continue;
    seen.add(hint.label);
    out.push(hint);
  }
  return out;
}

// ─── xcodebuild invocation ───────────────────────────────────────────────

export async function buildIosAgent(options: BuildIosAgentOptions): Promise<string> {
  const iosAgentDir = resolveIosAgentDir(options.cwd);

  if (!fs.existsSync(path.join(iosAgentDir, 'TapsmithAgent.xcodeproj'))) {
    throw new Error(
      `ios-agent/TapsmithAgent.xcodeproj not found.\n` +
        '  Run this command from the Tapsmith repo root, or pass a different --cwd.',
    );
  }

  const teamId = await resolveTeamId(options.teamId);
  const derivedDataPath = options.derivedDataPath
    ?? path.join(iosAgentDir, '.build-device');

  // Pre-clean the DerivedData dir's Logs/Test so we don't accumulate
  // multi-GB xcresult bundles on every invocation.
  const testLogs = path.join(derivedDataPath, 'Logs', 'Test');
  if (fs.existsSync(testLogs)) {
    try { fs.rmSync(testLogs, { recursive: true, force: true }); } catch {}
  }
  fs.mkdirSync(derivedDataPath, { recursive: true });

  const args = [
    'build-for-testing',
    '-project', path.join(iosAgentDir, 'TapsmithAgent.xcodeproj'),
    '-scheme', 'TapsmithAgentUITests',
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derivedDataPath,
    // Let xcodebuild auto-create / fetch provisioning profiles from the
    // Apple Developer portal when they're missing. Without this flag
    // automatic signing still works for profiles that Xcode has already
    // cached, but a fresh clone / new device / new team will fail with
    // "Automatic signing is disabled and unable to generate a profile".
    '-allowProvisioningUpdates',
    // Override the simulator-oriented defaults baked into project.pbxproj.
    // CLI settings take precedence over project file settings. We have to
    // set CODE_SIGN_IDENTITY explicitly because project.pbxproj hardcodes
    // it to "" for simulator builds; "Apple Development" is the canonical
    // development identity name used by xcodebuild's automatic signing.
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGNING_REQUIRED=YES',
    'CODE_SIGN_IDENTITY=Apple Development',
    'CODE_SIGN_STYLE=Automatic',
    `DEVELOPMENT_TEAM=${teamId}`,
  ];

  if (!options.quiet) {
    console.log(bold('Building TapsmithAgent runner for iOS devices…'));
    console.log(dim(`  team:         ${teamId}`));
    console.log(dim(`  destination:  generic/platform=iOS`));
    console.log(dim(`  derivedData:  ${derivedDataPath}`));
    console.log(dim('  Typical build time: 60–120s on first run, <10s incremental.'));
    console.log();
  }

  const startedAt = Date.now();
  const { ok, tailLines } = await runXcodebuild('xcodebuild', args, options.verbose === true);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!ok) {
    const hints = selectErrorHints(tailLines, { xcodeTeams: readXcodeRegisteredTeams(), requestedTeam: teamId });
    console.log();
    console.log(red(`✗ xcodebuild failed after ${elapsedSec}s.`));
    if (hints.length > 0) {
      console.log();
      console.log(bold('Actionable hints:'));
      for (const h of hints) {
        console.log(`  ${yellow('→')} ${h.label}`);
      }
    }
    if (!options.verbose) {
      console.log();
      console.log(dim('Re-run with --verbose for full xcodebuild output.'));
    }
    throw new Error(`tapsmith ios build-agent failed (${elapsedSec}s)`);
  }

  // Locate the freshly built xctestrun under DerivedData.
  const candidates = await glob('Build/Products/*.xctestrun', {
    cwd: derivedDataPath,
    absolute: true,
  });
  const deviceXctestruns = candidates.filter((p) => !p.endsWith('.patched.xctestrun'));
  if (deviceXctestruns.length === 0) {
    throw new Error(
      `xcodebuild reported success but no .xctestrun was found under ${derivedDataPath}/Build/Products.\n` +
        '  This is unexpected. Re-run with --verbose and file a bug with the full output.',
    );
  }
  // Sort by mtime desc so we return the freshest build.
  const newest = deviceXctestruns
    .map((p) => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]!.path;

  stripDstRootPath(newest);

  if (!options.quiet) {
    console.log();
    console.log(green(`✓ Built TapsmithAgent runner in ${elapsedSec}s.`));
    console.log();

    // Surface provisioning-profile expiry up front. Free Apple Developer
    // accounts roll the profile every 7 days — without a heads-up, users
    // run into cryptic signing errors mid-test a week later.
    const expiry = getProfileExpiryInfo(newest);
    if (expiry) {
      const warning = formatExpiryWarning(expiry);
      if (warning) {
        console.log(`  ${yellow('⚠')} ${warning}`);
        console.log();
      }
    }

    for (const line of builtRunnerConfigHint(newest, path.resolve(options.cwd ?? process.cwd()))) console.log(line);
    console.log();
  }
  return newest;
}

/**
 * What to tell the user about configuring the runner just built. It used to
 * print a cwd-relative `iosXctestrun`, which broke in a config whose rootDir
 * is elsewhere; `tapsmith test` now finds this build itself in the
 * usual layouts, so say that, and give an absolute path for pinning or for a
 * build it will not find (a custom `--derived-data-path`).
 */
export function builtRunnerConfigHint(xctestrun: string, cwd: string): string[] {
  const pin = `    ${dim('iosXctestrun:')} ${green(`'${xctestrun}'`)}`;
  if (findDeviceXctestrun(cwd) !== xctestrun) {
    return ['  Add to your ' + bold('tapsmith.config.ts') + ' (an absolute path, so it works from any rootDir):', pin];
  }
  const inNpmAgentDir = !path.relative(npmIosAgentDir(), xctestrun).startsWith('..');
  if (inNpmAgentDir) {
    // No pin offered: upgrading Tapsmith replaces ~/.tapsmith/ios-agent, so a
    // pinned path there would turn into a hard error, where auto-detection
    // just asks for a rebuild.
    return [`  ${bold('tapsmith test')} finds this runner itself — no \`iosXctestrun\` needed.`];
  }
  // findDeviceXctestrun walks up five parents from rootDir.
  return [
    `  ${bold('tapsmith test')} finds this runner itself when your config's rootDir is ${cwd} or up to five levels inside it — no \`iosXctestrun\` needed.`,
    dim('  To pin this build instead, add to your tapsmith.config.ts:'),
    pin,
  ];
}

/**
 * Strip `DSTROOTPath` from an xctestrun file. When xcodebuild build-for-testing
 * is invoked with `-derivedDataPath`, it emits a `DSTROOTPath` key pointing at
 * a staging directory (e.g. `/tmp/TapsmithAgent.dst`). Xcode 26+ interprets that
 * key as a request to install the test bundle using "Root" install style,
 * which is reserved for internal Apple OS builds. The resulting
 * `test-without-building` run fails on public devices with:
 *   "Root install style is not supported on this device. To install internal
 *    content, the device must allow installing app bundles and roots, and be
 *    running an internal OS build."
 * Removing the key forces standard "User" install and the same xctestrun
 * runs fine on any public device.
 */
export function stripDstRootPath(xctestrunPath: string): void {
  try {
    const jsonRaw = execFileSync('plutil', ['-convert', 'json', '-o', '-', xctestrunPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const data = JSON.parse(jsonRaw) as Record<string, unknown>;

    const removeKey = (obj: unknown): void => {
      if (obj && typeof obj === 'object') {
        if (Array.isArray(obj)) {
          for (const item of obj) removeKey(item);
        } else {
          const record = obj as Record<string, unknown>;
          delete record['DSTROOTPath'];
          for (const k of Object.keys(record)) removeKey(record[k]);
        }
      }
    };
    removeKey(data);

    const xml = execFileSync('plutil', ['-convert', 'xml1', '-o', '-', '-'], {
      input: JSON.stringify(data),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    fs.writeFileSync(xctestrunPath, xml);
  } catch {
    // Non-fatal — if plutil is missing or the xctestrun isn't a plist we'd
    // rather proceed than block the build. The worst case is the user hits
    // the "Root install style" error at test time, which has a clear message.
  }
}

/**
 * Spawn xcodebuild with a spinner + rolling tail buffer. The tail is used
 * later to pattern-match known errors if the build fails.
 *
 * Returning the last N lines (vs the whole output) keeps memory bounded on
 * very large xcodebuild runs and is enough for the known-error patterns we
 * care about — they all appear near the bottom of the output.
 */
async function runXcodebuild(
  binary: string,
  args: string[],
  verbose: boolean,
): Promise<{ ok: boolean; tailLines: string[] }> {
  const tailLines: string[] = [];
  const TAIL_LIMIT = 200;

  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const appendTail = (line: string): void => {
      tailLines.push(line);
      if (tailLines.length > TAIL_LIMIT) tailLines.shift();
    };

    const handleLines = (stream: NodeJS.ReadableStream): void => {
      let buf = '';
      stream.on('data', (chunk: Buffer | string) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          appendTail(line);
          if (verbose) process.stdout.write(line + '\n');
          idx = buf.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (buf.length > 0) {
          appendTail(buf);
          if (verbose) process.stdout.write(buf + '\n');
        }
      });
    };

    handleLines(child.stdout!);
    handleLines(child.stderr!);

    // Spinner — only shown when not in verbose mode (would otherwise clash
    // with the raw xcodebuild stream).
    const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinnerIdx = 0;
    const spinnerHandle = !verbose && process.stdout.isTTY
      ? setInterval(() => {
        process.stdout.write(`\r${dim(spinnerFrames[spinnerIdx]!)} building… `);
        spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
      }, 120)
      : undefined;

    child.on('close', (code) => {
      if (spinnerHandle) {
        clearInterval(spinnerHandle);
        process.stdout.write('\r\x1b[K'); // clear spinner line
      }
      resolve({ ok: code === 0, tailLines });
    });
  });
}

// ─── CLI entry point ─────────────────────────────────────────────────────

export async function runBuildIosAgent(opts: BuildIosAgentOptions): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error(red('tapsmith ios build-agent is only supported on macOS.'));
    process.exit(1);
  }

  try {
    await buildIosAgent(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(msg));
    process.exit(1);
  }
}

