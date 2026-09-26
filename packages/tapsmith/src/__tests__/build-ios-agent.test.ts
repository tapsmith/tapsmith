import { describe, it, expect } from 'vitest';
import {
  matchKnownErrorHint,
  parseCodesignIdentities,
  parseXcodeTeams,
} from '../build-ios-agent.js';

describe('parseCodesignIdentities', () => {
  it('extracts a single Apple Development identity', () => {
    const raw = `
Policy: Code Signing
  Matching identities
  1) ABCDEF1234 "Apple Development: Jane Developer (ABCDEFGHIJ)"
     1 identities found
`;
    const identities = parseCodesignIdentities(raw);
    expect(identities).toHaveLength(1);
    expect(identities[0]!.teamId).toBe('ABCDEFGHIJ');
  });

  it('dedupes multiple certs under the same team', () => {
    // Apple Developer team IDs are always exactly 10 uppercase alphanumerics.
    const raw = `
  1) AAA "Apple Development: Jane (TEAMONE123)"
  2) BBB "Apple Development: Jane (TEAMONE123)"
  3) CCC "Apple Development: Jane (TEAMONE123)"
     3 identities found
`;
    const identities = parseCodesignIdentities(raw);
    expect(identities).toHaveLength(1);
    expect(identities[0]!.teamId).toBe('TEAMONE123');
  });

  it('returns distinct entries for different teams', () => {
    const raw = `
  1) AAA "Apple Development: Alice (TEAMONE123)"
  2) BBB "Apple Development: Alice (TEAMTWO456)"
     2 identities found
`;
    const identities = parseCodesignIdentities(raw);
    const teamIds = identities.map((i) => i.teamId).sort();
    expect(teamIds).toEqual(['TEAMONE123', 'TEAMTWO456']);
  });

  it('also accepts Apple Distribution certs', () => {
    const raw = `  1) AAA "Apple Distribution: ACME Corp (DISTTEAM12)"`;
    const identities = parseCodesignIdentities(raw);
    expect(identities[0]!.teamId).toBe('DISTTEAM12');
  });

  it('returns empty for no identities', () => {
    expect(parseCodesignIdentities('0 identities found')).toEqual([]);
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
    const raw = `teamID = "XYZW987654"; teamName = "Acme Corp";`;
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

