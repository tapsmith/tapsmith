/**
 * The Tapsmith plugin for Claude Code, Cursor and Codex (plugins/): its
 * generated files match their one source, and its MCP server command starts
 * the project's own installed Tapsmith rather than a global or npx copy.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCodingAgents, isOnPath } from '../agent-plugins.js';
import { childExecArgv, firstWorkspaceFolder, locateTapsmith, projectDir } from '../../../../plugins/source/mcp-launcher.mjs';
import { generatedFiles, staleFiles } from '../../../../plugins/source/sync.mjs';

const REPO = path.resolve(import.meta.dirname, '../../../..');

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-plugin-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, text: string): string {
  const file = path.resolve(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/**
 * A fake installed tapsmith in `<dir>/node_modules/tapsmith` whose bin
 * prints what it was started with, as JSON on stdout.
 */
function installFakeTapsmith(dir: string, version = '9.9.9'): string {
  write(path.join(dir, 'node_modules/tapsmith/package.json'), JSON.stringify({
    name: 'tapsmith',
    version,
    type: 'module',
    main: 'dist/index.js',
    bin: { tapsmith: 'dist/bin.js' },
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  }));
  write(path.join(dir, 'node_modules/tapsmith/dist/index.js'), 'export {};\n');
  // An ES module child, forked as the real server forks its discovery and run
  // children: with the parent's execArgv.
  write(path.join(dir, 'node_modules/tapsmith/dist/child.js'), 'process.exit(0);\n');
  return write(
    path.join(dir, 'node_modules/tapsmith/dist/bin.js'),
    [
      "import { fork } from 'node:child_process';",
      "const child = fork(new URL('./child.js', import.meta.url).pathname, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });",
      "let childErr = '';",
      "child.stderr.on('data', (d) => { childErr += d; });",
      "child.on('exit', (childExit) => process.stdout.write(JSON.stringify({",
      "  args: process.argv.slice(2), cwd: process.cwd(), bin: process.argv[1], childExit, childErr,",
      "  preferUi: process.env.TAPSMITH_MCP_PREFER_UI,",
      "})));",
      '',
    ].join('\n'),
  );
}

/**
 * A fake installed tapsmith whose `mcp-server` speaks MCP over stdio, as the
 * real one does: it lists two tools; `probe` returns what it was started
 * with, and `crash` exits 3.
 */
function installFakeMcpTapsmith(dir: string): string {
  // Built aside and moved in whole, so the server's poll never sees half of it.
  const stage = fs.mkdtempSync(path.join(path.dirname(tmp), 'tapsmith-stage-'));
  const bin = installFakeTapsmith(stage);
  fs.writeFileSync(bin, [
    "import * as readline from 'node:readline';",
    'let init; let initialized = false;',
    'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const m = JSON.parse(line);',
    "  if (m.method === 'initialize') { init = m.params; return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'tapsmith', version: '9.9.9' } } }); }",
    "  if (m.method === 'notifications/initialized') { initialized = true; return; }",
    "  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'tapsmith_snapshot', inputSchema: { type: 'object' } }, { name: 'probe', inputSchema: { type: 'object' } }] } });",
    "  if (m.method === 'tools/call' && m.params.name === 'crash') process.exit(3);",
    "  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify({",
    '    args: process.argv.slice(2), cwd: process.cwd(), bin: process.argv[1], preferUi: process.env.TAPSMITH_MCP_PREFER_UI,',
    '    execArgv: process.execArgv, init, initialized,',
    '  }) }] } });',
    "  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } });",
    '});',
    '',
  ].join('\n'));
  fs.renameSync(path.join(stage, 'node_modules'), path.join(dir, 'node_modules'));
  fs.rmSync(stage, { recursive: true });
  return path.join(dir, path.relative(stage, bin));
}

/* eslint-disable @typescript-eslint/no-explicit-any -- JSON-RPC messages in tests */
type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

/**
 * The plugin's MCP server started as an MCP client starts it, with a small
 * newline-delimited JSON-RPC client on its stdio.
 */
function startPluginServer(configFile: (typeof CONFIGS)[number], cwd: string, env: Record<string, string> = {}, extraArgs: string[] = []) {
  const config = JSON.parse(generatedFiles(REPO)[`plugins/tapsmith/${configFile}`]!) as McpConfig;
  const args = config.mcpServers['tapsmith']!.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', path.join(REPO, 'plugins/tapsmith')));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of ['CLAUDE_PROJECT_DIR', 'TAPSMITH_PROJECT_DIR', 'WORKSPACE_FOLDER_PATHS', 'TAPSMITH_MCP_PREFER_UI']) {
    if (!(name in env)) delete childEnv[name];
  }
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [...args, ...extraArgs], { cwd, env: childEnv });
  const messages: RpcMessage[] = [];
  const waiters: Array<{ match: (m: RpcMessage) => boolean; resolve: (m: RpcMessage) => void }> = [];
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  child.stdout.on('data', (d: Buffer) => {
    buffer += d.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as RpcMessage;
      messages.push(message);
      for (const w of waiters.filter((w) => w.match(message))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  });
  const handle = {
    exited: undefined as number | null | undefined,
    closed: new Promise<void>((resolve) => child.on('exit', (code) => { handle.exited = code; resolve(); })),
    stderr: () => stderr,
    waitFor(match: (m: RpcMessage) => boolean, timeoutMs = 10_000): Promise<RpcMessage> {
      const seen = messages.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no matching message; stderr:\n${stderr}`)), timeoutMs);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
    },
    request(method: string, params?: unknown): Promise<any> {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })}\n`);
      return handle.waitFor((m) => m.id === id && m.method === undefined);
    },
    async initialize(): Promise<any> {
      const init = await handle.request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return init;
    },
    async close(): Promise<void> {
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await handle.closed;
      clearTimeout(timer);
    },
  };
  return handle;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type McpConfig = { mcpServers: Record<string, { command: string; args: string[] }> };

/** The MCP server configs: Claude Code's (.mcp.json) and Cursor's and Codex's (mcp-inline.json). */
const CONFIGS = ['.mcp.json', 'mcp-inline.json'] as const;

/**
 * Run the MCP server command a plugin config registers, as an MCP client
 * would: Claude Code's `${CLAUDE_PLUGIN_ROOT}` is the plugin directory on disk
 * (the drift test keeps it equal to what sync.mjs generates).
 */
function runPluginServer(configFile: (typeof CONFIGS)[number], cwd: string, env: Record<string, string> = {}, extraArgs: string[] = []) {
  const config = JSON.parse(generatedFiles(REPO)[`plugins/tapsmith/${configFile}`]!) as McpConfig;
  const server = config.mcpServers['tapsmith']!;
  expect(server.command).toBe('node');
  const args = server.args.map((a) => a.replace('${CLAUDE_PLUGIN_ROOT}', path.join(REPO, 'plugins/tapsmith')));
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  if (!('CLAUDE_PROJECT_DIR' in env)) delete childEnv.CLAUDE_PROJECT_DIR;
  if (!('TAPSMITH_PROJECT_DIR' in env)) delete childEnv.TAPSMITH_PROJECT_DIR;
  if (!('WORKSPACE_FOLDER_PATHS' in env)) delete childEnv.WORKSPACE_FOLDER_PATHS;
  if (!('TAPSMITH_MCP_PREFER_UI' in env)) delete childEnv.TAPSMITH_MCP_PREFER_UI;
  return spawnSync(process.execPath, [...args, ...extraArgs], { cwd, env: childEnv, encoding: 'utf8' });
}

describe('plugin files', () => {
  it('match what plugins/source/sync.mjs generates (run it after changing a source)', () => {
    expect(staleFiles(REPO)).toEqual([]);
  });

  it('are not git-ignored, so they reach the repository the marketplaces install from', () => {
    const files = Object.keys(generatedFiles(REPO));
    const ignored = spawnSync('git', ['check-ignore', '--no-index', ...files], { cwd: REPO, encoding: 'utf8' });
    // Exit 1: none of them is ignored. Exit 128: not a git checkout.
    if (ignored.status !== 128) expect(ignored.stdout.trim().split('\n').filter(Boolean)).toEqual([]);
  });

  it('carry the tapsmith package version in every manifest', () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/tapsmith/package.json'), 'utf8')) as { version: string };
    const files = generatedFiles(REPO);
    for (const tool of ['claude', 'cursor', 'codex']) {
      expect(JSON.parse(files[`plugins/tapsmith/.${tool}-plugin/plugin.json`]!).version).toBe(version);
    }
  });

  it('point every marketplace at the plugin directory, which has a skill', () => {
    const files = generatedFiles(REPO);
    expect(JSON.parse(files['.claude-plugin/marketplace.json']!).plugins[0].source).toBe('./plugins/tapsmith');
    expect(JSON.parse(files['.cursor-plugin/marketplace.json']!).plugins[0].source).toBe('./plugins/tapsmith');
    expect(JSON.parse(files['.agents/plugins/marketplace.json']!).plugins[0].source.path).toBe('./plugins/tapsmith');
    const skill = fs.readFileSync(path.join(REPO, 'plugins/tapsmith/skills/tapsmith/SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: tapsmith\ndescription: .+\n---\n/);
    expect(skill).toContain('node_modules/tapsmith/docs/');
  });

  it('name only docs pages the package ships in the skill', () => {
    const skill = fs.readFileSync(path.join(REPO, 'plugins/tapsmith/skills/tapsmith/SKILL.md'), 'utf8');
    const pages = [...skill.matchAll(/`([a-z-]+\.md)(?:#[a-z0-9-]+)?`/g)].map((m) => m[1]!);
    expect(pages.length).toBeGreaterThan(5);
    for (const page of pages) expect(fs.existsSync(path.join(REPO, 'docs', page)), page).toBe(true);
  });
});

describe('projectDir', () => {
  it('prefers TAPSMITH_PROJECT_DIR, then CLAUDE_PROJECT_DIR, then the working directory', () => {
    expect(projectDir({ TAPSMITH_PROJECT_DIR: '/a', CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/a');
    expect(projectDir({ CLAUDE_PROJECT_DIR: '/b' }, '/c')).toBe('/b');
    expect(projectDir({ CLAUDE_PROJECT_DIR: '' }, '/c')).toBe('/c');
  });

  it("uses Cursor's workspace folder before the working directory, which Cursor may set elsewhere", () => {
    fs.mkdirSync(path.join(tmp, 'ws'));
    expect(projectDir({ WORKSPACE_FOLDER_PATHS: path.join(tmp, 'ws') }, '/c')).toBe(path.join(tmp, 'ws'));
    expect(projectDir({ CLAUDE_PROJECT_DIR: '/b', WORKSPACE_FOLDER_PATHS: path.join(tmp, 'ws') }, '/c')).toBe('/b');
    expect(projectDir({ WORKSPACE_FOLDER_PATHS: path.join(tmp, 'missing') }, '/c')).toBe('/c');
  });
});

describe('firstWorkspaceFolder', () => {
  it('takes the first existing folder of a list, whatever its separator', () => {
    for (const name of ['a', 'b']) fs.mkdirSync(path.join(tmp, name));
    const [a, b] = [path.join(tmp, 'a'), path.join(tmp, 'b')];
    expect(firstWorkspaceFolder(a)).toBe(a);
    expect(firstWorkspaceFolder(`${a},${b}`)).toBe(a);
    expect(firstWorkspaceFolder(`${path.join(tmp, 'gone')}${path.delimiter}${b}`)).toBe(b);
    expect(firstWorkspaceFolder('')).toBeUndefined();
    expect(firstWorkspaceFolder(undefined)).toBeUndefined();
  });
});

describe('childExecArgv', () => {
  it("drops the inline launcher's --input-type and -e script, keeping every other option", () => {
    expect(childExecArgv(['--input-type=module', '-e', 'code', '--no-warnings'])).toEqual(['--no-warnings']);
    expect(childExecArgv(['--input-type', 'module', '--eval', 'code'])).toEqual([]);
    expect(childExecArgv(['--eval=code', '-p', 'x', '--print=y', '--max-old-space-size=4096'])).toEqual(['--max-old-space-size=4096']);
    expect(childExecArgv([])).toEqual([]);
  });
});

describe('locateTapsmith', () => {
  it('finds the tapsmith the project resolves, from a subfolder too', () => {
    const bin = installFakeTapsmith(tmp);
    expect(locateTapsmith(tmp)).toEqual({ dir: tmp, bin, version: '9.9.9' });
    fs.mkdirSync(path.join(tmp, 'src'));
    expect(locateTapsmith(path.join(tmp, 'src'))).toMatchObject({ bin });
  });

  it('finds it in the one folder below that holds a Tapsmith config (a monorepo e2e/ package)', () => {
    const e2e = path.join(tmp, 'e2e');
    write('e2e/tapsmith.config.ts', 'export default {};\n');
    const bin = installFakeTapsmith(e2e);
    write('app/package.json', '{}');
    expect(locateTapsmith(tmp)).toEqual({ dir: e2e, bin, version: '9.9.9' });
  });

  it('refuses to guess between several installed projects below', () => {
    for (const name of ['e2e-android', 'e2e-ios']) {
      write(`${name}/tapsmith.config.ts`, 'export default {};\n');
      installFakeTapsmith(path.join(tmp, name));
    }
    const found = locateTapsmith(tmp);
    expect(found.error).toMatch(/several projects/);
    expect(found.error).toContain('e2e-android, e2e-ios');
    expect(found.error).toContain('TAPSMITH_PROJECT_DIR');
  });

  it('says the project folder does not exist, rather than that Tapsmith is not installed there', () => {
    const missing = path.join(tmp, 'typo');
    const found = locateTapsmith(missing);
    expect(found.error).toContain(`The project folder ${missing} does not exist`);
    expect(found.error).toContain('TAPSMITH_PROJECT_DIR');
  });

  it('says how to install Tapsmith when the project has none', () => {
    const found = locateTapsmith(tmp);
    expect(found.error).toContain(`Tapsmith is not installed in ${tmp}`);
    expect(found.error).toContain('npm install -D tapsmith');
  });

  it('sees an install made after it last looked, and not one still being written', () => {
    // Node's resolver would cache the missing package.json from the first look.
    fs.mkdirSync(path.join(tmp, 'node_modules/tapsmith'), { recursive: true });
    expect(locateTapsmith(tmp).error).toBeDefined();
    write('node_modules/tapsmith/package.json', JSON.stringify({ name: 'tapsmith', version: '9.9.9', bin: { tapsmith: 'dist/bin.js' } }));
    expect(locateTapsmith(tmp).error).toBeDefined();
    const bin = write('node_modules/tapsmith/dist/bin.js', '');
    expect(locateTapsmith(tmp)).toEqual({ dir: tmp, bin, version: '9.9.9' });
  });

  it('ignores a package called something else that a tapsmith import would not reach', () => {
    write('node_modules/other/package.json', JSON.stringify({ name: 'other', bin: { tapsmith: 'x.js' } }));
    expect(locateTapsmith(tmp).error).toBeDefined();
  });
});

describe.each(CONFIGS)('the plugin MCP server command in %s', (configFile) => {
  it("runs the project's tapsmith mcp-server in the project, passing extra arguments on", () => {
    const bin = installFakeTapsmith(tmp);
    const run = runPluginServer(configFile, tmp, {}, ['--config', 'tapsmith.config.ios.mjs']);
    expect(run.stderr).toContain(`starting tapsmith 9.9.9 mcp-server in ${tmp}`);
    expect(run.status).toBe(0);
    // stdout is the MCP protocol: only the server writes to it.
    expect(JSON.parse(run.stdout)).toMatchObject({ args: ['mcp-server', '--config', 'tapsmith.config.ios.mjs'], cwd: tmp, bin });
  });

  it('lets the server fork its children: none inherits the launcher\'s own Node options', () => {
    installFakeTapsmith(tmp);
    const run = runPluginServer(configFile, tmp);
    expect(run.status).toBe(0);
    const out = JSON.parse(run.stdout) as { childExit: number; childErr: string };
    expect(out.childErr).toBe('');
    expect(out.childExit).toBe(0);
  });

  // By variable, not by flag: an installed Tapsmith that predates the server
  // which follows a UI session ignores the variable and runs headless.
  it('asks for the server that works in a running UI session, without a flag', () => {
    installFakeTapsmith(tmp);
    const out = JSON.parse(runPluginServer(configFile, tmp).stdout) as { args: string[]; preferUi?: string };
    expect(out.preferUi).toBe('1');
    expect(out.args).toEqual(['mcp-server']);
  });

  it('leaves a TAPSMITH_MCP_PREFER_UI the user set alone', () => {
    installFakeTapsmith(tmp);
    expect(JSON.parse(runPluginServer(configFile, tmp, { TAPSMITH_MCP_PREFER_UI: '0' }).stdout).preferUi).toBe('0');
  });

  it('registers one server, named tapsmith', () => {
    const config = JSON.parse(generatedFiles(REPO)[`plugins/tapsmith/${configFile}`]!) as McpConfig;
    expect(Object.keys(config.mcpServers)).toEqual(['tapsmith']);
  });

  it('passes no extra arguments when there are none', () => {
    installFakeTapsmith(tmp);
    const run = runPluginServer(configFile, tmp);
    expect(JSON.parse(run.stdout).args).toEqual(['mcp-server']);
  });

  it('uses CLAUDE_PROJECT_DIR over the working directory', () => {
    installFakeTapsmith(path.join(tmp, 'project'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    const run = runPluginServer(configFile, path.join(tmp, 'elsewhere'), { CLAUDE_PROJECT_DIR: path.join(tmp, 'project') });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).cwd).toBe(path.join(tmp, 'project'));
  });

  it("uses Cursor's WORKSPACE_FOLDER_PATHS over the working directory", () => {
    installFakeTapsmith(path.join(tmp, 'project'));
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    const run = runPluginServer(configFile, path.join(tmp, 'elsewhere'), { WORKSPACE_FOLDER_PATHS: path.join(tmp, 'project') });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout).cwd).toBe(path.join(tmp, 'project'));
  });

  it('stays up when Tapsmith is not installed, logging the reason on stderr too', async () => {
    const client = startPluginServer(configFile, tmp);
    try {
      await client.initialize();
      expect(client.stderr()).toContain('tapsmith plugin: Tapsmith is not installed');
      expect(client.exited).toBeUndefined();
    } finally {
      await client.close();
    }
  });
});

describe.each(CONFIGS)('the plugin MCP server in %s, before Tapsmith is installed', { timeout: 20_000 }, (configFile) => {
  it('tells the agent why there are no Tapsmith tools: in its instructions and in every tool call', async () => {
    const client = startPluginServer(configFile, tmp);
    try {
      const init = await client.initialize();
      expect(init.result.serverInfo.name).toBe('tapsmith');
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect(init.result.capabilities.tools).toEqual({ listChanged: true });
      expect(init.result.instructions).toContain(`Tapsmith is not installed in ${tmp}`);
      expect(init.result.instructions).toContain('npm install -D tapsmith');

      const list = await client.request('tools/list');
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['tapsmith_setup_status']);
      expect(list.result.tools[0].description).toContain('npm install -D tapsmith');
      expect((await client.request('resources/list')).result).toEqual({ resources: [] });
      expect(await client.request('ping')).toMatchObject({ result: {} });

      for (const name of ['tapsmith_setup_status', 'tapsmith_snapshot']) {
        const call = await client.request('tools/call', { name, arguments: {} });
        expect(call.result.isError).toBe(true);
        expect(call.result.content[0].text).toContain(`Tapsmith is not installed in ${tmp}`);
      }
      expect((await client.request('no/such/method')).error.code).toBe(-32601);
    } finally {
      await client.close();
    }
    expect(client.exited).toBe(0);
  });

  it('explains the other reasons it cannot start Tapsmith the same way', async () => {
    for (const name of ['e2e-android', 'e2e-ios']) {
      write(`${name}/tapsmith.config.ts`, 'export default {};\n');
      installFakeTapsmith(path.join(tmp, name));
    }
    const client = startPluginServer(configFile, tmp);
    try {
      const init = await client.initialize();
      expect(init.result.instructions).toMatch(/several projects/);
      const call = await client.request('tools/call', { name: 'tapsmith_snapshot', arguments: {} });
      expect(call.result.content[0].text).toContain('e2e-android, e2e-ios');
    } finally {
      await client.close();
    }
  });

  it("switches to the project's Tapsmith once it is installed, telling the client its tools changed", async () => {
    const client = startPluginServer(configFile, tmp, {}, ['--config', 'tapsmith.config.ios.mjs']);
    try {
      await client.initialize();
      const bin = installFakeMcpTapsmith(tmp);
      await client.waitFor((m) => m.method === 'notifications/tools/list_changed');
      expect(client.stderr()).toContain(`starting tapsmith 9.9.9 mcp-server in ${tmp}`);

      const list = await client.request('tools/list');
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['tapsmith_snapshot', 'probe']);
      const probe = JSON.parse((await client.request('tools/call', { name: 'probe', arguments: {} })).result.content[0].text);
      expect(probe).toMatchObject({
        args: ['mcp-server', '--config', 'tapsmith.config.ios.mjs'],
        cwd: tmp,
        bin,
        preferUi: '1',
        execArgv: [],
        // The client's own initialize, replayed with the version the launcher agreed.
        init: { protocolVersion: '2025-06-18', clientInfo: { name: 'plugin-test' } },
        initialized: true,
      });
      // Its own tool still answers, for clients that never re-list tools.
      const status = await client.request('tools/call', { name: 'tapsmith_setup_status', arguments: {} });
      expect(status.result.isError).toBeFalsy();
      expect(status.result.content[0].text).toContain('Tapsmith 9.9.9 is loaded');
    } finally {
      await client.close();
    }
    // stdin closed: the server exits, and the launcher with its code.
    expect(client.exited).toBe(0);
  });

  it('checks again on the next call, without waiting for its poll', async () => {
    const client = startPluginServer(configFile, tmp);
    try {
      await client.initialize();
      installFakeMcpTapsmith(tmp);
      const call = await client.request('tools/call', { name: 'probe', arguments: {} });
      expect(JSON.parse(call.result.content[0].text)).toMatchObject({ cwd: tmp });
    } finally {
      await client.close();
    }
  });

  it("leaves a TAPSMITH_MCP_PREFER_UI the user set alone", async () => {
    const client = startPluginServer(configFile, tmp, { TAPSMITH_MCP_PREFER_UI: '0' });
    try {
      await client.initialize();
      installFakeMcpTapsmith(tmp);
      const call = await client.request('tools/call', { name: 'probe', arguments: {} });
      expect(JSON.parse(call.result.content[0].text)).toMatchObject({ preferUi: '0' });
    } finally {
      await client.close();
    }
  });

  it('serves on when the installed server exits as it starts, and starts it again on the next call', async () => {
    const client = startPluginServer(configFile, tmp);
    try {
      await client.initialize();
      const bin = installFakeTapsmith(tmp);
      fs.writeFileSync(bin, 'process.exit(2);\n');
      const call = await client.request('tools/call', { name: 'tapsmith_snapshot', arguments: {} });
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0].text).toContain(`Tapsmith 9.9.9 is installed in ${tmp}, but its MCP server exited with code 2 as it started`);
      expect(client.exited).toBeUndefined();

      fs.rmSync(path.join(tmp, 'node_modules'), { recursive: true });
      installFakeMcpTapsmith(tmp);
      const retry = await client.request('tools/call', { name: 'probe', arguments: {} });
      expect(JSON.parse(retry.result.content[0].text)).toMatchObject({ cwd: tmp });
    } finally {
      await client.close();
    }
  });

  it("answers a call the server never did when the server dies, and exits with the server's code", async () => {
    const client = startPluginServer(configFile, tmp);
    await client.initialize();
    installFakeMcpTapsmith(tmp);
    await client.waitFor((m) => m.method === 'notifications/tools/list_changed');
    const call = await client.request('tools/call', { name: 'crash', arguments: {} });
    expect(call.error.message).toMatch(/exited with code 3/);
    await client.closed;
    expect(client.exited).toBe(3);
  });
});

describe('the inline launcher', () => {
  it('drops the comments, which the agents would show as part of the command', () => {
    const config = JSON.parse(generatedFiles(REPO)['plugins/tapsmith/mcp-inline.json']!) as McpConfig;
    const script = config.mcpServers['tapsmith']!.args[2]!;
    expect(script).not.toMatch(/^\s*\/\//m);
    expect(script).not.toContain('/**');
    expect(script.startsWith('import ')).toBe(true);
  });

  it('holds no `${`, which Cursor would substitute as a placeholder in a plugin MCP config', () => {
    const config = JSON.parse(generatedFiles(REPO)['plugins/tapsmith/mcp-inline.json']!) as McpConfig;
    expect(config.mcpServers['tapsmith']!.args.join(' ')).not.toContain('${');
  });
});

describe('detectCodingAgents', () => {
  it('finds an agent by its project files', () => {
    write('CLAUDE.md', '# notes');
    write('.cursor/rules/x.mdc', '');
    expect(detectCodingAgents(tmp, () => false)).toEqual(['claude', 'cursor']);
  });

  it('finds an agent by its command on PATH', () => {
    expect(detectCodingAgents(tmp, (cli) => cli === 'codex')).toEqual(['codex']);
    expect(detectCodingAgents(tmp, () => false)).toEqual([]);
  });
});

describe('isOnPath', () => {
  it('finds an executable file in a PATH directory, not a directory or a plain file', () => {
    const bin = write('bin/claude', '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    write('bin/codex', 'not executable');
    fs.mkdirSync(path.join(tmp, 'bin/cursor'));
    const env = { PATH: ['/nonexistent', path.join(tmp, 'bin')].join(path.delimiter) };
    expect(isOnPath('claude', env, 'darwin')).toBe(true);
    expect(isOnPath('codex', env, 'darwin')).toBe(false);
    expect(isOnPath('cursor', env, 'darwin')).toBe(false);
    expect(isOnPath('claude', {}, 'darwin')).toBe(false);
  });
});
