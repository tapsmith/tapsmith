import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chooseUiSession, findUiSession, parseUiSession, probeUiSession, uiSessionMatchesProject, type UiSession } from '../mcp/ui-session.js';

// PILOT-1164: `tapsmith mcp-server --prefer-ui` works in the project's
// running UI-mode session. Which session is "the project's" is decided here.

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-ui-session-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function dir(...parts: string[]): string {
  const d = path.join(root, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function session(overrides: Partial<UiSession> & { project: UiSession['project'] }): UiSession {
  return { mcpUrl: 'http://127.0.0.1:9274/mcp', ...overrides };
}

describe('uiSessionMatchesProject', () => {
  it('matches a session started in the same folder', () => {
    const app = dir('app');
    expect(uiSessionMatchesProject({ cwd: app, rootDir: app }, { cwd: app })).toBe(true);
  });

  it('does not match the project next door, or a parent folder', () => {
    const app = dir('app');
    expect(uiSessionMatchesProject({ cwd: dir('other'), rootDir: dir('other') }, { cwd: app })).toBe(false);
    expect(uiSessionMatchesProject({ cwd: root, rootDir: root }, { cwd: app })).toBe(false);
  });

  it('matches a session started from the repo root with a config in the agent\'s folder', () => {
    const e2e = dir('e2e');
    const project = { cwd: root, rootDir: e2e, configPath: path.join(e2e, 'tapsmith.config.ts') };
    expect(uiSessionMatchesProject(project, { cwd: e2e })).toBe(true);
    // A rootDir set elsewhere: the config's own folder still names the project.
    expect(uiSessionMatchesProject({ ...project, rootDir: dir('tests') }, { cwd: e2e })).toBe(true);
  });

  it('matches by the server\'s own --config folder when it runs somewhere else', () => {
    const e2e = dir('e2e');
    expect(uiSessionMatchesProject({ cwd: e2e, rootDir: e2e }, { cwd: root, configFile: 'e2e/tapsmith.config.ts' })).toBe(true);
  });

  it('sees through a symlinked project folder', () => {
    const app = dir('app');
    const link = path.join(root, 'link');
    fs.symlinkSync(app, link);
    expect(uiSessionMatchesProject({ cwd: link }, { cwd: app })).toBe(true);
  });
});

describe('chooseUiSession', () => {
  it('is undefined when no session is the project\'s', () => {
    expect(chooseUiSession([session({ project: { cwd: dir('other') } })], { cwd: dir('app') })).toBeUndefined();
  });

  it('prefers the session on the server\'s own config, then the one started last', () => {
    const app = dir('app');
    const ios = session({ mcpUrl: 'http://127.0.0.1:1/mcp', startedAt: '2026-11-11T10:00:00.000Z', project: { cwd: app, configPath: path.join(app, 'ios.config.mjs') } });
    const android = session({ mcpUrl: 'http://127.0.0.1:2/mcp', startedAt: '2026-11-11T11:00:00.000Z', project: { cwd: app, configPath: path.join(app, 'android.config.mjs') } });
    expect(chooseUiSession([ios, android], { cwd: app })).toBe(android);
    expect(chooseUiSession([android, ios], { cwd: app })).toBe(android);
    expect(chooseUiSession([ios, android], { cwd: app, configFile: 'ios.config.mjs' })).toBe(ios);
  });
});

describe('parseUiSession', () => {
  it('reads the project, and takes the endpoint from the port that answered', () => {
    expect(parseUiSession({
      mcpUrl: 'http://example.com:1/mcp',
      project: { cwd: '/work/app', rootDir: '/work/app', configPath: '/work/app/tapsmith.config.ts' },
      pid: 42,
      startedAt: '2026-11-11T10:00:00.000Z',
      devices: ['emulator-5554'],
    }, 9274)).toEqual({
      mcpUrl: 'http://127.0.0.1:9274/mcp',
      project: { cwd: '/work/app', rootDir: '/work/app', configPath: '/work/app/tapsmith.config.ts' },
      pid: 42,
      startedAt: '2026-11-11T10:00:00.000Z',
    });
  });

  it('is undefined for a UI server that publishes no project, and for anything else', () => {
    expect(parseUiSession({ daemons: [], owned: [], devices: [] }, 9274)).toBeUndefined();
    expect(parseUiSession({ project: {} }, 9274)).toBeUndefined();
    expect(parseUiSession('ok', 9274)).toBeUndefined();
    expect(parseUiSession(null, 9274)).toBeUndefined();
  });
});

describe('findUiSession', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); })));
  });

  /** A stand-in UI server answering `/api/daemon-ports`; returns its port file. */
  async function uiServer(name: string, payload: unknown, status = 200): Promise<string> {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/api/daemon-ports' ? status : 404, { 'Content-Type': 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const file = path.join(root, `ui-port-${name}`);
    fs.writeFileSync(file, String((server.address() as AddressInfo).port));
    return file;
  }

  it('finds the project\'s session among every UI server on the machine', async () => {
    const app = dir('app');
    const other = await uiServer('other', { project: { cwd: dir('other') } });
    const mine = await uiServer('mine', { project: { cwd: app, rootDir: app }, pid: 7 });
    const port = fs.readFileSync(mine, 'utf-8');
    expect(await findUiSession({ cwd: app }, { portFiles: [other, mine] })).toEqual({
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      project: { cwd: app, rootDir: app, configPath: undefined },
      pid: 7,
      startedAt: undefined,
    });
  });

  it('is undefined with no port files, and without asking anyone', async () => {
    expect(await findUiSession({ cwd: dir('app') }, { portFiles: [] })).toBeUndefined();
  });

  it('ignores a port file nothing listens behind, a garbled one, and a server that is not a UI server', async () => {
    const app = dir('app');
    const dead = path.join(root, 'ui-port-dead');
    const closed = http.createServer();
    await new Promise<void>((resolve) => { closed.listen(0, '127.0.0.1', resolve); });
    fs.writeFileSync(dead, String((closed.address() as AddressInfo).port));
    await new Promise<void>((resolve) => { closed.close(() => resolve()); });
    const garbled = path.join(root, 'ui-port-garbled');
    fs.writeFileSync(garbled, '{"port": 1}');
    const notJson = await uiServer('not-json', '<html>');
    const refused = await uiServer('refused', { project: { cwd: app } }, 500);
    expect(await findUiSession({ cwd: app }, { portFiles: [dead, garbled, notJson, refused, path.join(root, 'ui-port-missing')] })).toBeUndefined();
  });

  it('probeUiSession tells a running session from one that ended, was replaced, or is busy', async () => {
    const app = dir('app');
    const file = await uiServer('mine', { project: { cwd: app }, pid: 7, startedAt: 't1' });
    const port = fs.readFileSync(file, 'utf-8');
    const mine = await findUiSession({ cwd: app }, { portFiles: [file] });
    expect(mine).toBeDefined();
    expect(await probeUiSession(mine!)).toBe('alive');
    // Another session answers on that port now.
    expect(await probeUiSession({ ...mine!, pid: 8 })).toBe('gone');
    expect(await probeUiSession({ ...mine!, startedAt: 't0' })).toBe('gone');
    // Too busy to answer in time: still there.
    const slow = http.createServer(() => { /* never answers */ });
    servers.push(slow);
    await new Promise<void>((resolve) => { slow.listen(0, '127.0.0.1', resolve); });
    expect(await probeUiSession({ ...mine!, mcpUrl: `http://127.0.0.1:${(slow.address() as AddressInfo).port}/mcp` }, 100)).toBe('unanswered');
    slow.closeAllConnections();
    // Ended: its kept-alive connection is dead, and nothing listens any more.
    const server = servers.shift()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    expect(await probeUiSession({ ...mine!, mcpUrl: `http://127.0.0.1:${port}/mcp` })).toBe('gone');
  });

  it('gives up on a server that does not answer in time', async () => {
    const app = dir('app');
    const server = http.createServer(() => { /* never answers */ });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const file = path.join(root, 'ui-port-slow');
    fs.writeFileSync(file, String((server.address() as AddressInfo).port));
    expect(await findUiSession({ cwd: app }, { portFiles: [file], timeoutMs: 100 })).toBeUndefined();
    server.closeAllConnections();
  });
});
