import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// PILOT-1203: how `tapsmith ios build-agent`, `tapsmith ios setup-device` and
// the init wizard find the user's Apple Developer team. Every host command is
// faked here; the fake answers are the real outputs from a Mac signed in to
// Xcode 27.2 (team IDs and names replaced).

type Answer = string | Error;
const answers = new Map<string, Answer>();
const calls: string[][] = [];

function key(cmd: string, args: readonly string[]): string {
  return [cmd, ...args].join(' ');
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      const answer = answers.get(key(cmd, args));
      if (answer === undefined) throw new Error(`unexpected command: ${key(cmd, args)}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
});

const {
  readXcodeRegisteredTeams,
  readKeychainSigningIdentities,
  resolveTeamId,
  selectErrorHints,
} = await import('../build-ios-agent.js');
const { checkSigningIdentities } = await import('../setup-ios-device.js');

const missingKey = (k: string): Error =>
  new Error(`Command failed: defaults read\nCould not find key '${k}' in domain 'com.apple.dt.Xcode'.`);

const XCODE27_TEAMS = `{
    "FFE7195A-8755-4A4D-A4AC-5209E88CCCC6" =     (
                {
            isFreeProvisioningTeam = 0;
            teamID = TEAMID1234;
            teamName = "Jane Developer";
            teamType = Individual;
        }
    );
}`;

const LEGACY_TEAMS = `{
    "jane@example.com" =     (
                {
            isFreeProvisioningTeam = 1;
            teamID = OLDTEAM123;
            teamName = "Jane Developer (Personal Team)";
            teamType = "Personal Team";
        }
    );
}`;

const FIND_IDENTITY = `  1) 83A5422D4FE9B5AEAED13D4C301324EDB240F859 "Apple Development: Jane Developer (CERTID9876)"
     1 valid identities found
`;

const FIND_CERTIFICATE = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures', 'keychain-find-certificate.txt'),
  'utf-8',
);

const XCODE_NEW = ['defaults', ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeamByIdentifier']] as const;
const XCODE_OLD = ['defaults', ['read', 'com.apple.dt.Xcode', 'IDEProvisioningTeams']] as const;
const FIND_ID = ['security', ['find-identity', '-v', '-p', 'codesigning']] as const;
const findCert = (name: string) => ['security', ['find-certificate', '-a', '-Z', '-p', '-c', name]] as const;

function answer([cmd, args]: readonly [string, readonly string[]], value: Answer): void {
  answers.set(key(cmd, args), value);
}

/** Xcode 27.2 signed in to one team; the keychain has its development cert. */
function xcode27SignedIn(): void {
  answer(XCODE_NEW, XCODE27_TEAMS);
  answer(XCODE_OLD, missingKey('IDEProvisioningTeams'));
  answer(FIND_ID, FIND_IDENTITY);
  answer(findCert('Apple Development: Jane Developer (CERTID9876)'), FIND_CERTIFICATE);
}

/** Xcode has no account at all, either key. */
function xcodeSignedOut(): void {
  answer(XCODE_NEW, missingKey('IDEProvisioningTeamByIdentifier'));
  answer(XCODE_OLD, missingKey('IDEProvisioningTeams'));
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
let logs: string[];

beforeEach(() => {
  answers.clear();
  calls.length = 0;
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(plain(a.map(String).join(' '))); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('readXcodeRegisteredTeams', () => {
  it('reads the Xcode 27 key when the old one is missing', () => {
    xcode27SignedIn();
    expect(readXcodeRegisteredTeams()).toEqual([{ teamId: 'TEAMID1234', name: 'Jane Developer' }]);
  });

  it('still reads the pre-Xcode 27 key', () => {
    answer(XCODE_NEW, missingKey('IDEProvisioningTeamByIdentifier'));
    answer(XCODE_OLD, LEGACY_TEAMS);
    expect(readXcodeRegisteredTeams()).toEqual([{ teamId: 'OLDTEAM123', name: 'Jane Developer (Personal Team)' }]);
  });

  it('lists a team present under both keys once', () => {
    answer(XCODE_NEW, XCODE27_TEAMS);
    answer(XCODE_OLD, XCODE27_TEAMS);
    expect(readXcodeRegisteredTeams()).toHaveLength(1);
  });

  it('merges different teams from the two keys', () => {
    answer(XCODE_NEW, XCODE27_TEAMS);
    answer(XCODE_OLD, LEGACY_TEAMS);
    expect(readXcodeRegisteredTeams().map((t) => t.teamId)).toEqual(['TEAMID1234', 'OLDTEAM123']);
  });

  it('returns empty when Xcode has no account under either key', () => {
    xcodeSignedOut();
    expect(readXcodeRegisteredTeams()).toEqual([]);
  });
});

describe('readKeychainSigningIdentities', () => {
  it("takes each identity's team from its certificate's OU", () => {
    xcode27SignedIn();
    expect(readKeychainSigningIdentities()).toEqual([
      { sha1: '83A5422D4FE9B5AEAED13D4C301324EDB240F859', name: 'Apple Development: Jane Developer (CERTID9876)', teamId: 'TEAMID1234' },
    ]);
  });

  it('keeps an identity whose certificate cannot be read, with no team', () => {
    answer(FIND_ID, FIND_IDENTITY);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), new Error('security: SecKeychainSearchCopyNext'));
    expect(readKeychainSigningIdentities()).toEqual([
      { sha1: '83A5422D4FE9B5AEAED13D4C301324EDB240F859', name: 'Apple Development: Jane Developer (CERTID9876)', teamId: undefined },
    ]);
  });

  it('asks for each distinct certificate name once', () => {
    answer(FIND_ID, `  1) 83A5422D4FE9B5AEAED13D4C301324EDB240F859 "Apple Development: Jane Developer (CERTID9876)"
  2) 69532A777680744301A1E98E01ED0718ACF6AF58 "Apple Distribution: Acme Corp (DISTCRT123)"`);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), FIND_CERTIFICATE);
    answer(findCert('Apple Distribution: Acme Corp (DISTCRT123)'), FIND_CERTIFICATE);
    expect(readKeychainSigningIdentities().map((i) => i.teamId)).toEqual(['TEAMID1234', 'ACMETEAM42']);
    expect(calls.filter((c) => c[1] === 'find-certificate')).toHaveLength(2);
  });

  it('throws when find-identity cannot run', () => {
    answer(FIND_ID, new Error('ENOENT'));
    expect(() => readKeychainSigningIdentities()).toThrow(/find-identity/);
  });
});

describe('resolveTeamId', () => {
  it('uses the Xcode 27 registered team without falling back to the keychain', async () => {
    xcode27SignedIn();
    await expect(resolveTeamId()).resolves.toBe('TEAMID1234');
    expect(logs.join('\n')).not.toMatch(/Warning|keychain/);
    expect(calls.some((c) => c[0] === 'security')).toBe(false);
  });

  it("falls back to the keychain certificate's OU team, not the certificate ID", async () => {
    xcodeSignedOut();
    answer(FIND_ID, FIND_IDENTITY);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), FIND_CERTIFICATE);
    await expect(resolveTeamId()).resolves.toBe('TEAMID1234');
    expect(logs.join('\n')).toContain('Falling back to keychain team TEAMID1234');
  });

  it('refuses with --team-id advice when no certificate names a team', async () => {
    xcodeSignedOut();
    answer(FIND_ID, FIND_IDENTITY);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), new Error('boom'));
    await expect(resolveTeamId()).rejects.toThrow(/--team-id/);
  });

  it('refuses with the sign-in steps when there is nothing at all', async () => {
    xcodeSignedOut();
    answer(FIND_ID, '     0 valid identities found');
    await expect(resolveTeamId()).rejects.toThrow(/No Apple Developer team found[\s\S]*Settings → Accounts/);
  });

  it('an explicit team wins without reading anything', async () => {
    await expect(resolveTeamId('EXPLICIT12')).resolves.toBe('EXPLICIT12');
    expect(calls).toEqual([]);
  });
});

describe('checkSigningIdentities (setup-device and init preflight)', () => {
  it('passes on Xcode 27 signed in, with the keychain cert matching the team', () => {
    xcode27SignedIn();
    expect(checkSigningIdentities()).toEqual({
      label: 'Apple Developer team registered with Xcode',
      ok: true,
      detail: 'TEAMID1234',
    });
  });

  it("notes a keychain cert for a different team, judged by the cert's OU", () => {
    answer(XCODE_NEW, missingKey('IDEProvisioningTeamByIdentifier'));
    answer(XCODE_OLD, LEGACY_TEAMS);
    answer(FIND_ID, FIND_IDENTITY);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), FIND_CERTIFICATE);
    expect(checkSigningIdentities()).toMatchObject({
      ok: true,
      detail: 'OLDTEAM123 (keychain has a cert for a different team)',
    });
  });

  it('fails when Xcode has no account under either key', () => {
    xcodeSignedOut();
    answer(FIND_ID, FIND_IDENTITY);
    answer(findCert('Apple Development: Jane Developer (CERTID9876)'), FIND_CERTIFICATE);
    expect(checkSigningIdentities()).toMatchObject({ label: 'Apple Developer team registered with Xcode', ok: false });
  });

  it('fails when the keychain has no development identity', () => {
    answer(FIND_ID, '     0 valid identities found');
    expect(checkSigningIdentities()).toMatchObject({ label: 'Code signing identity', ok: false });
  });
});

describe('selectErrorHints', () => {
  const NO_ACCOUNT_FOR_TEAM = `error: No Account for Team "CERTID9876". Add a new account in Accounts settings or verify that your accounts have valid credentials. (in target 'TapsmithAgentUITests' from project 'TapsmithAgent')`;
  const NO_PROFILES = `error: No profiles for 'dev.tapsmith.agent.xctrunner' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'dev.tapsmith.agent.xctrunner'. (in target 'TapsmithAgentUITests' from project 'TapsmithAgent')`;
  const NO_ACCOUNTS = 'error: No Accounts: Add a new account in Accounts settings. (in target \'TapsmithAgentUITests\' from project \'TapsmithAgent\')';
  const JANE = { teamId: 'TEAMID1234', name: 'Jane Developer' };
  const ACME = { teamId: 'ACMETEAM42', name: 'Acme Corp' };
  const labels = (lines: string[], teams: { teamId: string, name: string }[] = [], requestedTeam = 'CERTID9876') =>
    selectErrorHints(lines, { xcodeTeams: teams, requestedTeam }).map((h) => h.label);

  it('drops the provisioning-profile hint when an account error caused it', () => {
    const out = labels([NO_ACCOUNT_FOR_TEAM, NO_PROFILES]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('CERTID9876');
    expect(out.join('\n')).not.toContain('Devices and Simulators');
  });

  it('keeps the provisioning-profile hint when it is the only error', () => {
    const out = labels([NO_PROFILES]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Devices and Simulators');
  });

  it('maps "No Accounts" to the sign-in hint, not the profile hint', () => {
    const out = labels([NO_ACCOUNTS, NO_PROFILES]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/no Apple ID signed in[\s\S]*Settings → Accounts/);
  });

  it('when Xcode is signed in to another team, says to pass that team instead of "sign in"', () => {
    const out = labels([NO_ACCOUNT_FOR_TEAM], [JANE]);
    expect(out[0]).toContain('--team-id TEAMID1234');
    expect(out[0]).not.toMatch(/sign in with the Apple ID/);
  });

  it('lists every signed-in team when there are several', () => {
    const out = labels([NO_ACCOUNT_FOR_TEAM], [JANE, ACME]);
    expect(out[0]).toContain('TEAMID1234 (Jane Developer)');
    expect(out[0]).toContain('ACMETEAM42 (Acme Corp)');
  });

  it('keeps the sign-in advice when Xcode has no account at all', () => {
    const out = labels([NO_ACCOUNT_FOR_TEAM]);
    expect(out[0]).toMatch(/sign in with the Apple ID that owns team CERTID9876/);
  });

  // Xcode 27.2 reports a team no signed-in account owns as "No Accounts",
  // not "No Account for Team" (seen on a real Mac signed in to another team).
  it('"No Accounts" for a team Xcode is not signed in to names the signed-in team', () => {
    const out = labels([NO_ACCOUNTS, NO_PROFILES], [JANE]);
    expect(out).toEqual([
      'Xcode is signed in to team TEAMID1234 (Jane Developer), not CERTID9876. Re-run with `--team-id TEAMID1234`.',
    ]);
  });

  it('"No Accounts" and "No Account for Team" for the same wrong team give one hint', () => {
    expect(labels([NO_ACCOUNT_FOR_TEAM, NO_ACCOUNTS, NO_PROFILES], [JANE])).toHaveLength(1);
  });

  it('an account error for a team Xcode lists says to re-enter that account, not to switch teams', () => {
    for (const line of [NO_ACCOUNTS, NO_ACCOUNT_FOR_TEAM]) {
      const out = labels([line], [{ teamId: 'CERTID9876', name: 'Jane Developer' }, ACME]);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatch(/lists team CERTID9876[\s\S]*Settings → Accounts/);
      expect(out[0]).not.toContain('--team-id ACMETEAM42');
    }
  });

  it('recognises a lowercase team ID in "No Account for Team" and drops the profile hint', () => {
    const out = labels([`error: No Account for Team "abc". Add a new account in Accounts settings.`, NO_PROFILES], [JANE], 'abc');
    expect(out).toEqual([
      'Xcode is signed in to team TEAMID1234 (Jane Developer), not abc. Re-run with `--team-id TEAMID1234`.',
    ]);
  });

  it('prints a repeated hint once', () => {
    expect(labels([NO_PROFILES, NO_PROFILES])).toHaveLength(1);
  });
});
