import { describe, expect, it } from 'vitest';
import { capabilitiesAfterRespawn, mergeResetCapabilities, nextCandidate, policyForFile, type CandidateInput, type CandidateProject } from '../ui-mode/readiness-candidate.js';
import type { TapsmithConfig } from '../config.js';

function config(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:1',
    rootDir: '/proj', outputDir: 'out', workers: 1, launchEmulators: false, package: 'com.example.app',
    ...overrides,
  };
}

const A = '/proj/tests/a.test.ts';
const B = '/proj/tests/b.test.ts';
const AUTH = '/proj/tests/auth.test.ts';

function project(name: string, files: string[], extra: Partial<CandidateProject> = {}): CandidateProject {
  return { name, testFiles: files, effectiveConfig: config(), ...extra };
}

function input(overrides: Partial<CandidateInput> = {}): CandidateInput {
  return {
    projects: [],
    rootConfig: config(),
    treeFiles: [A, B],
    fileUse: new Map(),
    ...overrides,
  };
}

describe('policyForFile', () => {
  it('defaults to clear · per file and resolves appState against rootDir', () => {
    expect(policyForFile(A, undefined, input())).toEqual({ mode: 'clear', scope: 'file' });
    const withState = input({ fileUse: new Map([[AUTH, { appState: './auth.tar.gz' }]]) });
    expect(policyForFile(AUTH, undefined, withState)).toEqual({ mode: 'clear', scope: 'file', appState: '/proj/auth.tar.gz' });
  });

  it('file declarations win over project use, which wins over config', () => {
    const p = project('android', [A, B], { use: { appReset: 'restart' }, effectiveConfig: config({ appReset: 'none' }) });
    expect(policyForFile(A, p, input()).mode).toBe('restart');
    const i = input({ fileUse: new Map([[A, { appReset: 'clear' }]]) });
    expect(policyForFile(A, p, i).mode).toBe('clear');
  });

  it('a reset deep link on the project config makes auto warm', () => {
    const p = project('ios', [A], { effectiveConfig: config({ resetAppDeepLink: 'app:///__reset' }) });
    expect(policyForFile(A, p, input())).toEqual({ mode: 'warm', scope: 'file' });
  });
});

describe('nextCandidate', () => {
  it('prefers the selection, then the last run file, then the last-run project, then tree order', () => {
    const p = project('android', [A, B]);
    const base = input({ projects: [p] });
    expect(nextCandidate({ ...base, selected: { file: B, projectName: 'android' } })?.file).toBe(B);
    expect(nextCandidate({ ...base, lastRun: { file: B } })?.file).toBe(B);
    expect(nextCandidate({ ...base, lastRunProject: 'android', treeFiles: [B, A] })?.file).toBe(A);
    expect(nextCandidate({ ...base, treeFiles: [B, A] })?.file).toBe(B);
    expect(nextCandidate({ ...base, treeFiles: [B, A] })?.projectName).toBe('android');
  });

  it('only pre-arms an appState restore when the guess is high-confidence', () => {
    const fileUse = new Map([[AUTH, { appState: './auth.tar.gz' }]]);
    const base = input({ treeFiles: [AUTH, A], fileUse });
    // Tree-order fallback skips the restore file and picks the plain one.
    expect(nextCandidate(base)?.file).toBe(A);
    // Selecting it makes the restore worth pre-running.
    const sel = nextCandidate({ ...base, selected: { file: AUTH } });
    expect(sel?.file).toBe(AUTH);
    expect(sel?.policy.appState).toBe('/proj/auth.tar.gz');
  });

  it('filters by bucket and skips files other workers claimed', () => {
    const android = project('android', [A], { bucketSignature: 'android|emu1||' });
    const ios = project('ios', [B], { bucketSignature: 'ios|iPhone 16|' });
    const base = input({ projects: [android, ios], treeFiles: [A, B] });
    expect(nextCandidate({ ...base, bucketSignature: 'ios|iPhone 16|' })?.file).toBe(B);
    expect(nextCandidate({ ...base, bucketSignature: 'ios|iPhone 16|', selected: { file: A, projectName: 'android' } })?.file).toBe(B);
    expect(nextCandidate({ ...base, exclude: new Set([A, B]) })).toBeUndefined();
    expect(nextCandidate({ ...base, exclude: new Set([A]) })?.file).toBe(B);
  });

  it('returns undefined with no files at all', () => {
    expect(nextCandidate(input({ treeFiles: [] }))).toBeUndefined();
  });
});

describe('mergeResetCapabilities', () => {
  it('returns whichever side exists when the other is unset', () => {
    expect(mergeResetCapabilities(undefined, undefined)).toBeUndefined();
    expect(mergeResetCapabilities({ hooksDetected: true }, undefined)).toEqual({ hooksDetected: true });
    expect(mergeResetCapabilities(undefined, { hooksDetected: false })).toEqual({ hooksDetected: false });
  });

  it('upgrades a missed probe to a later positive detection', () => {
    expect(mergeResetCapabilities({ hooksDetected: false }, { hooksDetected: true })).toEqual({ hooksDetected: true });
    expect(mergeResetCapabilities({}, { hooksDetected: true, isPhysical: false })).toEqual({ hooksDetected: true, isPhysical: false });
  });

  it('never downgrades a verified capability (respawn probe missing the marker)', () => {
    expect(mergeResetCapabilities({ hooksDetected: true, isPhysical: false }, { hooksDetected: false })).toEqual({ hooksDetected: true, isPhysical: false });
    expect(mergeResetCapabilities({ hooksDetected: true }, {})).toEqual({ hooksDetected: true });
    expect(mergeResetCapabilities({ hooksDetected: true }, { hooksDetected: undefined })).toEqual({ hooksDetected: true });
  });

  it('does not mutate its inputs', () => {
    const previous = { hooksDetected: false };
    const next = { hooksDetected: true };
    mergeResetCapabilities(previous, next);
    expect(previous).toEqual({ hooksDetected: false });
    expect(next).toEqual({ hooksDetected: true });
  });
});

describe('capabilitiesAfterRespawn', () => {
  it('carries the old worker\'s capabilities forward, upgrade-only, when the device kept its build', () => {
    expect(capabilitiesAfterRespawn({ hooksDetected: true }, { hooksDetected: false }, false)).toEqual({ hooksDetected: true });
  });

  it('takes the new worker\'s own when it reinstalled a rebuilt app on the way up: the old ones describe a build that is gone', () => {
    expect(capabilitiesAfterRespawn({ hooksDetected: true, hooksUrlPrefix: 'old:///' }, { hooksDetected: false }, true)).toEqual({ hooksDetected: false });
  });
});
