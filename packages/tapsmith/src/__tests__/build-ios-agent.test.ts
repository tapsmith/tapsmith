import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tapsmithPackageVersion } from '../ios-agent-paths.js';
import {
  builtRunnerConfigHint,
  matchKnownErrorHint,
  parseCertificateTeams,
  parseFindIdentityOutput,
  parseXcodeTeams,
} from '../build-ios-agent.js';

// Real shape of `security find-identity -v -p codesigning`. The ID in brackets
// at the end of the name is the certificate's own identifier, NOT the team
// (PILOT-1203): the team is the certificate subject's OU.
const FIND_IDENTITY_RAW = `  1) 83A5422D4FE9B5AEAED13D4C301324EDB240F859 "Apple Development: Jane Developer (CERTID9876)"
  2) 69532A777680744301A1E98E01ED0718ACF6AF58 "Apple Distribution: Acme Corp (DISTCRT123)"
  3) 07ABDF3D519B3D2F025A4EF68CD79CF804E407CD "Apple Development: No Team (NOTEAMCRT1)"
  4) 1111111111111111111111111111111111111111 "Developer ID Application: Someone Else (OTHERTEAM1)"
     4 valid identities found
`;

// `security find-certificate -a -Z -p` output for the first three identities
// above: self-signed stand-ins generated with openssl, with Apple's subject
// layout (UID, CN, OU = team ID, O, C). The third has no OU.
const FIND_CERTIFICATE_RAW = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'keychain-find-certificate.txt'),
  'utf-8',
);

describe('parseFindIdentityOutput', () => {
  it('lists Apple development/distribution identities with their SHA-1', () => {
    expect(parseFindIdentityOutput(FIND_IDENTITY_RAW)).toEqual([
      { sha1: '83A5422D4FE9B5AEAED13D4C301324EDB240F859', name: 'Apple Development: Jane Developer (CERTID9876)' },
      { sha1: '69532A777680744301A1E98E01ED0718ACF6AF58', name: 'Apple Distribution: Acme Corp (DISTCRT123)' },
      { sha1: '07ABDF3D519B3D2F025A4EF68CD79CF804E407CD', name: 'Apple Development: No Team (NOTEAMCRT1)' },
    ]);
  });

  it('accepts the legacy iPhone Developer / iPhone Distribution names', () => {
    const raw = `  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "iPhone Developer: Jane (OLDCERT123)"
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "iPhone Distribution: Acme (OLDCERT456)"`;
    expect(parseFindIdentityOutput(raw).map((i) => i.name)).toEqual([
      'iPhone Developer: Jane (OLDCERT123)',
      'iPhone Distribution: Acme (OLDCERT456)',
    ]);
  });

  it('lists an identity once even when it repeats', () => {
    const line = '  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Apple Development: Jane (CERTID1234)"\n';
    expect(parseFindIdentityOutput(line + line)).toHaveLength(1);
  });

  it('returns empty for no identities', () => {
    expect(parseFindIdentityOutput('     0 valid identities found')).toEqual([]);
  });
});

describe('parseCertificateTeams', () => {
  it('maps each certificate SHA-1 to the team ID in its subject OU', () => {
    const teams = parseCertificateTeams(FIND_CERTIFICATE_RAW);
    expect(teams.get('83A5422D4FE9B5AEAED13D4C301324EDB240F859')).toBe('TEAMID1234');
    expect(teams.get('69532A777680744301A1E98E01ED0718ACF6AF58')).toBe('ACMETEAM42');
  });

  it('never takes the bracketed certificate ID from the CN as the team', () => {
    const teams = [...parseCertificateTeams(FIND_CERTIFICATE_RAW).values()];
    expect(teams).not.toContain('CERTID9876');
    expect(teams).not.toContain('DISTCRT123');
    expect(teams).not.toContain('NOTEAMCRT1');
  });

  it('gives a certificate without an OU no team', () => {
    expect(parseCertificateTeams(FIND_CERTIFICATE_RAW).has('07ABDF3D519B3D2F025A4EF68CD79CF804E407CD')).toBe(false);
  });

  it('skips a PEM block that does not parse', () => {
    const raw = 'SHA-1 hash: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n';
    expect(parseCertificateTeams(raw + FIND_CERTIFICATE_RAW).size).toBe(2);
  });

  it('returns empty for empty output', () => {
    expect(parseCertificateTeams('').size).toBe(0);
  });
});

describe('parseXcodeTeams', () => {
  it('parses a single personal team from `defaults read`', () => {
    const raw = `{
    "sam@example.com" =     (
                {
            isFreeProvisioningTeam = 1;
            teamID = ABCD123456;
            teamName = "Sam Smith (Personal Team)";
            teamType = "Personal Team";
        }
    );
}`;
    const teams = parseXcodeTeams(raw);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe('ABCD123456');
    expect(teams[0]!.name).toBe('Sam Smith (Personal Team)');
  });

  it('parses a team with quoted team ID', () => {
    const raw = `{ teamID = "XYZW987654"; teamName = "Acme Corp"; }`;
    const teams = parseXcodeTeams(raw);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe('XYZW987654');
    expect(teams[0]!.name).toBe('Acme Corp');
  });

  it('dedupes repeated team IDs across multiple Apple ID blocks', () => {
    const raw = `
      { teamID = TEAMID1234; teamName = "Shared Corp"; }
      { teamID = TEAMID1234; teamName = "Shared Corp"; }
    `;
    const teams = parseXcodeTeams(raw);
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamId).toBe('TEAMID1234');
  });

  it('parses multiple distinct teams', () => {
    const raw = `
      { teamID = TEAMONE123; teamName = "Team One"; }
      { teamID = TEAMTWO456; teamName = "Team Two"; }
    `;
    const teams = parseXcodeTeams(raw);
    expect(teams.map((t) => t.teamId).sort()).toEqual(['TEAMONE123', 'TEAMTWO456']);
  });

  // PILOT-1203: Xcode 27 keeps the signed-in teams under
  // IDEProvisioningTeamByIdentifier, keyed by account UUID (real output shape).
  it('parses the Xcode 27 IDEProvisioningTeamByIdentifier shape', () => {
    const raw = `{
    "FFE7195A-8755-4A4D-A4AC-5209E88CCCC6" =     (
                {
            isFreeProvisioningTeam = 0;
            teamID = 92878B7448;
            teamName = "JANE Q DEVELOPER";
            teamType = Individual;
        }
    );
}`;
    expect(parseXcodeTeams(raw)).toEqual([{ teamId: '92878B7448', name: 'JANE Q DEVELOPER' }]);
  });

  it('parses a bare (unquoted) team name', () => {
    const raw = `{ isFreeProvisioningTeam = 0; teamID = ACMETEAM42; teamName = Acme; teamType = Company; }`;
    expect(parseXcodeTeams(raw)).toEqual([{ teamId: 'ACMETEAM42', name: 'Acme' }]);
  });

  it('keeps a team whose name comes before its ID', () => {
    const raw = `{ teamName = "Acme Corp"; teamID = ACMETEAM42; }`;
    expect(parseXcodeTeams(raw)).toEqual([{ teamId: 'ACMETEAM42', name: 'Acme Corp' }]);
  });

  it('decodes an escaped quote in a team name', () => {
    const raw = `{ teamID = ACMETEAM42; teamName = "Jane \\"JD\\" Doe"; }`;
    expect(parseXcodeTeams(raw)).toEqual([{ teamId: 'ACMETEAM42', name: 'Jane "JD" Doe' }]);
  });

  it('returns empty on empty / malformed output', () => {
    expect(parseXcodeTeams('')).toEqual([]);
    expect(parseXcodeTeams('Domain com.apple.dt.Xcode does not exist')).toEqual([]);
  });
});

describe('matchKnownErrorHint', () => {
  it('recognizes missing team account', () => {
    const hint = matchKnownErrorHint(
      `error: No Account for Team 'ABCD1234EF' (in target 'TapsmithAgentUITests' ...)`,
    );
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('ABCD1234EF');
    expect(hint!.label).toContain('Xcode → Settings → Accounts');
  });

  it('recognizes missing provisioning profile', () => {
    const hint = matchKnownErrorHint(
      `error: No profiles for 'dev.tapsmith.agent.xctrunner' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'dev.tapsmith.agent.xctrunner'.`,
    );
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('dev.tapsmith.agent.xctrunner');
    expect(hint!.label).toContain('Devices and Simulators');
  });

  it('recognizes Developer Mode disabled', () => {
    const hint = matchKnownErrorHint('DVTCoreDeviceEnabledState_Disabled');
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('Developer Mode');
    expect(hint!.label).toContain('Privacy & Security');
  });

  it('recognizes install-time device trust failure', () => {
    const hint = matchKnownErrorHint(
      `Unable to install "TapsmithAgentUITests-Runner" — installation failed, no valid profile for this device`,
    );
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('VPN & Device Management');
  });

  it('recognizes leftover simulator destination', () => {
    const hint = matchKnownErrorHint(
      `error: The operation couldn't be completed. Unable to find a destination: CoreSimulator...`,
    );
    expect(hint).toBeDefined();
    expect(hint!.label).toContain('generic/platform=iOS');
  });

  it('returns undefined for unknown errors', () => {
    expect(matchKnownErrorHint('error: something unrelated happened')).toBeUndefined();
  });
});


// PILOT-264: the hint used to print a path relative to the build's cwd, which
// broke when pasted into a config whose rootDir is elsewhere.
describe('builtRunnerConfigHint', () => {
  // The hint is styled for the terminal; read the words.
  const plain = (lines: string[]) => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const XCTESTRUN = 'A_iphoneos26.4-arm64.xctestrun';
  let tmp: string;
  let savedHome: string | undefined;
  const writeRunner = (productsDir: string) => {
    fs.mkdirSync(productsDir, { recursive: true });
    const file = path.join(productsDir, XCTESTRUN);
    fs.writeFileSync(file, '<plist/>');
    return file;
  };

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-hint-')));
    fs.mkdirSync(path.join(tmp, 'home'));
    savedHome = process.env.HOME;
    process.env.HOME = path.join(tmp, 'home');
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('an npm build: tapsmith test finds it from anywhere; no pin offered (an upgrade would delete the pinned file)', () => {
    const agent = path.join(tmp, 'home', '.tapsmith', 'ios-agent');
    const runner = writeRunner(path.join(agent, '.build-device', 'Build', 'Products'));
    fs.writeFileSync(path.join(agent, '.tapsmith-version'), tapsmithPackageVersion());
    const app = path.join(tmp, 'app');
    fs.mkdirSync(app);
    const text = plain(builtRunnerConfigHint(runner, app));
    expect(text).toMatch(/finds this runner itself — no `iosXctestrun` needed/);
    expect(text).not.toMatch(/rootDir is/);
    expect(text).not.toContain('iosXctestrun:');
  });

  it('a checkout build is found from rootDirs at or up to five levels inside the build directory', () => {
    const repo = path.join(tmp, 'repo');
    const runner = writeRunner(path.join(repo, 'ios-agent', '.build-device', 'Build', 'Products'));
    const text = plain(builtRunnerConfigHint(runner, repo));
    expect(text).toContain(`when your config's rootDir is ${repo} or up to five levels inside it`);
    expect(text).toContain(`iosXctestrun: '${runner}'`);
  });

  it('a build it will not find (custom --derived-data-path) gets an absolute iosXctestrun to add', () => {
    const runner = writeRunner(path.join(tmp, 'dd', 'Build', 'Products'));
    const text = plain(builtRunnerConfigHint(runner, path.join(tmp, 'home')));
    expect(text).not.toMatch(/finds this runner itself/);
    expect(text).toMatch(/Add to your/);
    expect(text).toContain(`iosXctestrun: '${runner}'`);
  });
});
