import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CLAIMS_DIR_ENV,
  SESSION_ENV,
  claimDevice,
  currentSession,
  ensureClaimSession,
  markSessionYieldsToUi,
  releaseDeviceClaim,
  yieldingClaimsElsewhere,
  type DeviceClaim,
  type SessionIdentity,
} from '../device-claims.js';
import { YIELD_SIGNAL, claimsToYield, requestHeadlessYield } from '../ui-yield.js';

// PILOT-1164: a UI session starting in a project asks the coding agent's
// headless MCP session there (`mcp-server --prefer-ui`) to give its devices up.

function session(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    id: `s-${Math.random().toString(36).slice(2)}`,
    pid: process.pid,
    command: 'tapsmith mcp-server --prefer-ui',
    project: '/work/app',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function claim(device: string, owner: SessionIdentity): DeviceClaim {
  return { device, session: owner, claimantPid: owner.pid, claimedAt: new Date().toISOString() };
}

describe('markSessionYieldsToUi', () => {
  it('marks the session this process is the root of, for the claims made from then on', () => {
    const env: NodeJS.ProcessEnv = {};
    const root = ensureClaimSession('tapsmith mcp-server --prefer-ui', { env, exitHook: false });
    expect(root.yieldsToUi).toBeUndefined();
    expect(markSessionYieldsToUi(env)).toBe(true);
    expect(currentSession(env)).toEqual({ ...root, yieldsToUi: true });
  });

  // The signal goes to the root: a root that does not handle it would die of it.
  it('does not mark a session rooted in another process, or when there is none', () => {
    const env: NodeJS.ProcessEnv = { [SESSION_ENV]: JSON.stringify(session({ pid: process.ppid })) };
    expect(markSessionYieldsToUi(env)).toBe(false);
    expect(currentSession(env).yieldsToUi).toBeUndefined();
    expect(markSessionYieldsToUi({})).toBe(false);
  });
});

describe('yieldingClaimsElsewhere', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-yield-'));
    env = { [CLAIMS_DIR_ENV]: dir };
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists the live claims of other sessions that yield, and no others', () => {
    const me = session({ command: 'tapsmith test --ui' });
    // A root whose start time is on record, as a real session's is.
    const startToken = ensureClaimSession('x', { env: {}, exitHook: false }).startToken;
    expect(startToken).toBeDefined();
    const agent = session({ yieldsToUi: true, startToken });
    const plain = session({ command: 'tapsmith test' });
    const dead = session({ yieldsToUi: true, pid: spawnSync(process.execPath, ['-e', '0']).pid ?? 999_999 });
    claimDevice('emulator-5554', agent, { env });
    claimDevice('emulator-5556', plain, { env });
    claimDevice('emulator-5558', { ...me, yieldsToUi: true }, { env });
    fs.writeFileSync(path.join(dir, 'emulator-5560.json'), JSON.stringify(claim('emulator-5560', dead)));
    expect(yieldingClaimsElsewhere(me, { env }).map((c) => c.device)).toEqual(['emulator-5554']);
    releaseDeviceClaim('emulator-5554', agent, { env });
    expect(yieldingClaimsElsewhere(me, { env })).toEqual([]);
  });

  // The signal kills a process that does not handle it, so a root that
  // cannot be told from whatever now runs under its pid is never signalled.
  it('leaves out a session whose root cannot be confirmed: no start time on record, or another one now', () => {
    const me = session({ command: 'tapsmith test --ui' });
    claimDevice('emulator-5554', session({ yieldsToUi: true }), { env });
    claimDevice('emulator-5556', session({ yieldsToUi: true, startToken: 'Mon Jan  1 00:00:00 2001' }), { env });
    expect(yieldingClaimsElsewhere(me, { env })).toEqual([]);
  });
});

describe('claimsToYield', () => {
  it('keeps the claims of sessions started in the UI session\'s project', () => {
    const here = claim('emulator-5554', session({ project: '/work/app/e2e' }));
    const elsewhere = claim('emulator-5556', session({ project: '/work/other' }));
    expect(claimsToYield([here, elsewhere], { cwd: '/work/app/e2e' })).toEqual([here]);
    // A UI session started from the repo root with the project's config.
    expect(claimsToYield([here, elsewhere], { cwd: '/work/app', rootDir: '/work/app/e2e', configPath: '/work/app/e2e/tapsmith.config.ts' })).toEqual([here]);
    expect(claimsToYield([here, elsewhere], { cwd: '/work/app' })).toEqual([]);
  });
});

describe('requestHeadlessYield', () => {
  const project = { cwd: '/work/app' };

  it('signals the session\'s root and returns once its claims are gone', async () => {
    const agent = session({ pid: 4242, yieldsToUi: true });
    let held = [claim('emulator-5554', agent), claim('emulator-5556', agent)];
    const signals: Array<[number, string]> = [];
    const logs: string[] = [];
    const left = await requestHeadlessYield(project, {
      claims: () => held,
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        setTimeout(() => { held = []; }, 20);
      },
      log: (line) => { logs.push(line); },
      platform: 'darwin',
      session: session({ command: 'tapsmith test --ui' }),
    });
    expect(left).toEqual([]);
    // Once per session, however many devices it holds.
    expect(signals).toEqual([[4242, YIELD_SIGNAL]]);
    expect(logs).toEqual([
      'A coding agent\'s headless Tapsmith session in this project holds emulator-5554, emulator-5556: asking it to hand over to this UI session.',
    ]);
  });

  it('gives up after the wait when the session keeps its device, and says so', async () => {
    const held = [claim('emulator-5554', session({ pid: 4242, yieldsToUi: true }))];
    const logs: string[] = [];
    const started = Date.now();
    const left = await requestHeadlessYield(project, {
      claims: () => held, kill: () => {}, log: (line) => { logs.push(line); }, platform: 'linux', timeoutMs: 200,
      session: session(),
    });
    expect(left).toEqual(['emulator-5554']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(logs[1]).toBe('It kept emulator-5554 (a test run in progress there keeps its device until it ends).');
  });

  it('asks nobody when no yielding session of this project holds a device', async () => {
    const signals: number[] = [];
    const kill = (pid: number): void => { signals.push(pid); };
    expect(await requestHeadlessYield(project, { claims: () => [], kill, platform: 'darwin', session: session() })).toEqual([]);
    const other = [claim('emulator-5554', session({ project: '/work/other', yieldsToUi: true }))];
    expect(await requestHeadlessYield(project, { claims: () => other, kill, platform: 'darwin', session: session() })).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('sends no signal on Windows, which has none', async () => {
    const signals: number[] = [];
    const held = [claim('emulator-5554', session({ yieldsToUi: true }))];
    expect(await requestHeadlessYield(project, { claims: () => held, kill: (pid) => { signals.push(pid); }, platform: 'win32', session: session() })).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('carries on when the session exited before the signal reached it', async () => {
    let held = [claim('emulator-5554', session({ pid: 4242, yieldsToUi: true }))];
    const left = await requestHeadlessYield(project, {
      claims: () => held,
      kill: () => {
        held = [];
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      },
      platform: 'darwin',
      session: session(),
    });
    expect(left).toEqual([]);
  });
});
