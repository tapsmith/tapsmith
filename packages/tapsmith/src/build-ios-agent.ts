/**
 * `tapsmith build-ios-agent` — thin xcodebuild wrapper for building the Tapsmith
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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { glob } from 'glob';
import { getProfileExpiryInfo, formatExpiryWarning } from './ios-profile-expiry.js';

// ─── iOS agent source resolution ────────────────────────────────────────

/**
 * Locate the `ios-agent/` directory containing the Swift source and Xcode project.
 *
 * Resolution order:
 *   1. `<cwd>/ios-agent/` — monorepo layout
 *   2. `~/.tapsmith/ios-agent/` — previously extracted from the npm package
 *   3. Extract bundled source from the npm package to `~/.tapsmith/ios-agent/`
 */
function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function resolveIosAgentDir(cwd?: string): string {
  // 1. Monorepo
  const monorepo = path.resolve(cwd ?? process.cwd(), 'ios-agent');
  if (fs.existsSync(path.join(monorepo, 'TapsmithAgent.xcodeproj'))) return monorepo;

  // 2. Previously extracted — re-extract if version changed
  const cached = path.join(os.homedir(), '.tapsmith', 'ios-agent');
  const versionFile = path.join(cached, '.tapsmith-version');
  const currentVersion = getPackageVersion();
  const cachedVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';

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

interface SigningIdentity {
  teamId: string
  name: string
}

/**
 * Parse `security find-identity -v -p codesigning` output and extract the
 * team ID from entries like:
 *   1) ABC123 "Apple Development: Jane Developer (TEAMID)"
 *
 * Kept as a public helper for the preflight checklist (`setup-ios-device`)
 * which uses the presence of an identity as a "signed in" signal. Note
 * that keychain identities and Xcode's registered teams can diverge — the
 * cert-based team ID is only used as a fallback; `xcodebuild` consults
 * Xcode's own account list, which is what `resolveTeamId` prefers.
 */
export function parseCodesignIdentities(rawOutput: string): SigningIdentity[] {
  const byTeamId = new Map<string, SigningIdentity>();
  const re = /"(?:Apple Development|iPhone Developer|Apple Distribution|iPhone Distribution)[^"]*\(([A-Z0-9]{10})\)"/g;
  for (const match of rawOutput.matchAll(re)) {
    const teamId = match[1]!;
    if (!byTeamId.has(teamId)) {
      byTeamId.set(teamId, { teamId, name: match[0]!.slice(1, -1) });
    }
  }
  return Array.from(byTeamId.values());
}

/**
 * Parse `defaults read com.apple.dt.Xcode IDEProvisioningTeams` output and
 * extract the list of teams Xcode has registered in its Accounts preferences.
 * These are the teams `xcodebuild` will accept via `DEVELOPMENT_TEAM=`.
 *
 * The format is:
 *   {
 *     "<apple-id-email>" = (
 *       { isFreeProvisioningTeam = 1; teamID = "ABCD123456"; teamName = "..."; ... },
 *       ...
 *     );
 *     ...
 *   }
 *
 * We parse with a regex rather than a full plist parser because the output
 * is tree-structured text, not XML plist. Targeted regex is enough and
 * avoids pulling in a dependency.
 */
export function parseXcodeTeams(rawOutput: string): SigningIdentity[] {
  const byTeamId = new Map<string, SigningIdentity>();
  // Match blocks like `teamID = "ABCD123456";` followed later by `teamName = "..."`.
  // Apple quotes values containing spaces / special chars, and leaves bare
  // identifiers otherwise. Handle both forms.
  const re = /teamID\s*=\s*"?([A-Z0-9]{10})"?;[^}]*?teamName\s*=\s*"([^"]+)"/g;
  for (const match of rawOutput.matchAll(re)) {
    const teamId = match[1]!;
    const teamName = match[2]!;
    if (!byTeamId.has(teamId)) {
      byTeamId.set(teamId, { teamId, name: teamName });
    }
  }
  return Array.from(byTeamId.values());
}

/**
 * Read Xcode's registered teams from `~/Library/Preferences/com.apple.dt.Xcode.plist`
 * via `defaults read`. Returns an empty array when Xcode has no accounts
 * configured (a common failure mode: keychain has a cert but Xcode's
 * Accounts UI is empty — `xcodebuild` refuses to use such an identity).
 */
export function readXcodeRegisteredTeams(): SigningIdentity[] {
  let raw: string;
  try {
    raw = execFileSync('defaults', ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeams'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return parseXcodeTeams(raw);
}

/**
 * Discover and select the user's Apple Developer team ID.
 *
 * Resolution order (most authoritative first):
 *   1. `--team-id` flag if explicit
 *   2. Teams registered in Xcode (`defaults read com.apple.dt.Xcode IDEProvisioningTeams`)
 *      — this is what `xcodebuild` consults, so it's the source of truth
 *      for whether a given `DEVELOPMENT_TEAM` will actually work.
 *   3. Fallback: keychain signing identities from `security find-identity`
 *      — only used when Xcode has no teams registered, because the
 *      keychain can contain certs for teams that aren't signed into
 *      Xcode and `xcodebuild` will reject those.
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
  let rawOutput: string;
  try {
    rawOutput = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      'Failed to run `security find-identity`. Make sure Xcode Command Line Tools are installed ' +
        '(`xcode-select --install`).\n' +
        `  underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const identities = parseCodesignIdentities(rawOutput);
  if (identities.length === 0) {
    throw new Error(
      'No Apple Developer team found.\n\n' +
        '  Fix:\n' +
        '    1. Open Xcode → Settings → Accounts.\n' +
        '    2. Sign in with your Apple ID (free accounts work too).\n' +
        '    3. Select your team so Xcode registers it for automatic signing.\n' +
        '    4. Re-run `tapsmith build-ios-agent`.',
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
  if (identities.length === 1) {
    const only = identities[0]!;
    console.log(dim(`Falling back to keychain team ${only.teamId} (${only.name})`));
    return only.teamId;
  }
  return promptForTeamId(identities);
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

/**
 * Small set of well-known signing / trust errors from xcodebuild output.
 * Each entry turns a cryptic Apple error into a one-line "how to fix" hint.
 *
 * Scoped intentionally — we only pattern-match errors where the fix is
 * unambiguous. Ambiguous failures surface the raw xcodebuild output without
 * guessing.
 */
const KNOWN_ERROR_PATTERNS: Array<{ re: RegExp; hint: (match: RegExpMatchArray) => ErrorHint }> = [
  {
    re: /No Account for Team ['"]([A-Z0-9]+)['"]/,
    hint: (m) => ({
      label: `Xcode has no account for team ${m[1]}. Open Xcode → Settings → Accounts and sign in with the Apple ID that owns team ${m[1]}.`,
    }),
  },
  {
    re: /No profiles for ['"]([^'"]+)['"] were found/,
    hint: (m) => ({
      label: `No provisioning profile for ${m[1]}. Plug in the device and open Xcode → Window → Devices and Simulators; Xcode will auto-register the device and create a profile.`,
    }),
  },
  {
    re: /Automatic signing (?:is|was) unable to resolve/,
    hint: () => ({
      label:
        'Automatic signing could not resolve a profile. Open the project in Xcode once (ios-agent/TapsmithAgent.xcodeproj), select the TapsmithAgentUITests target, and let Xcode refresh signing.',
    }),
  },
  {
    re: /Developer Mode disabled|DVTCoreDeviceEnabledState_Disabled/,
    hint: () => ({
      label:
        'Developer Mode is off on the device. Settings → Privacy & Security → Developer Mode → On, then reboot the device.',
    }),
  },
  {
    re: /Unable to install ['"][^'"]+['"]|installation failed.*valid.*profile/i,
    hint: () => ({
      label:
        'Profile was built but iOS refused installation. On the device, Settings → General → VPN & Device Management → trust the Tapsmith developer profile.',
    }),
  },
  {
    re: /requires a provisioning profile with the (?:NFC|HealthKit|[A-Za-z ]+) feature/,
    hint: () => ({
      label:
        'TapsmithAgent requires an entitlement your current profile does not include. This is unusual for the Tapsmith agent — file an issue with the full xcodebuild output.',
    }),
  },
  {
    re: /The operation couldn['’]t be completed.*CoreSimulator/,
    hint: () => ({
      label:
        'CoreSimulator error during a device build — likely you left the destination as iPhone Simulator. Pass `-destination "generic/platform=iOS"`.',
    }),
  },
];

/** Scan an xcodebuild output line and return any matching hint. */
export function matchKnownErrorHint(line: string): ErrorHint | undefined {
  for (const entry of KNOWN_ERROR_PATTERNS) {
    const m = line.match(entry.re);
    if (m) return entry.hint(m);
  }
  return undefined;
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
    const hints = dedupeHints(tailLines.flatMap((l) => {
      const hit = matchKnownErrorHint(l);
      return hit ? [hit] : [];
    }));
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
    throw new Error(`tapsmith build-ios-agent failed (${elapsedSec}s)`);
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

    console.log('  Add to your ' + bold('tapsmith.config.ts') + ':');
    console.log(`    ${dim('iosXctestrun:')} ${green("'" + path.relative(options.cwd ?? process.cwd(), newest) + "'")}`);
    console.log();
  }
  return newest;
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

function dedupeHints(hints: ErrorHint[]): ErrorHint[] {
  const seen = new Set<string>();
  const out: ErrorHint[] = [];
  for (const h of hints) {
    if (seen.has(h.label)) continue;
    seen.add(h.label);
    out.push(h);
  }
  return out;
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
    console.error(red('tapsmith build-ios-agent is only supported on macOS.'));
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

