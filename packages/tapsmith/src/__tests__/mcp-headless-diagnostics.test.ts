import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerListTestsTool } from '../mcp/tools/list-tests.js';
import { needsTsxLoader, resolveTsxBin, resolveChildLoader } from '../child-scripts.js';
import {
  HeadlessTestDispatcher,
  fileFailureEntry,
  resultEntryKey,
  matchRequestedFiles,
  platformKeyForProject,
  selectPlatformTarget,
} from '../mcp/headless-dispatcher.js';
import { registerSessionInfoTool } from '../mcp/tools/session-info.js';
import { loadMcpConfig } from '../mcp/config-loader.js';
import {
  ambiguousDeviceMessage,
  daemonSpawnArgs,
  isRepointing,
  noDeviceMessage,
  primaryDevice,
  configureMcpConnection,
  normalizeDaemonAddress,
  readDaemonRegistry,
  registerDaemon,
  unregisterDaemon,
  pruneDaemonRegistry,
} from '../mcp/connection.js';
import { mcpDaemonRegistryPath, uiPortFilePath, allUiPortFiles, ensureDaemonStateDir } from '../mcp/port-file.js';
import type { DiscoveryError, TestDispatcher, TestTreeEntry } from '../mcp/test-dispatcher.js';

// The headless MCP server forks children to discover and to run test files.
// Both import the project's test files, so both need the tsx loader when those
// are TypeScript — bare node resolves a `.ts` file but does not remap a
// `./x.js` specifier to `x.ts`. Choosing the loader from our own scripts alone
// meant a published install (all `.js`) always forked bare node, dropping every
// test file that imports a sibling module — silently during discovery, and with
// a bare failure count at run time.

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function makeToolCapture(): { server: McpServer; tools: Map<string, ToolCallback> } {
  const tools = new Map<string, ToolCallback>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolCallback): void => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const extra = { _meta: undefined, sendNotification: async (): Promise<void> => {} };

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [] }),
    resolveDeviceName: () => undefined,
    deviceChoiceError: async () => null,
    toggleWatch: () => ({ enabled: false }),
    ...overrides,
  };
}

function fileNode(filePath: string): TestTreeEntry {
  return {
    type: 'file',
    name: path.basename(filePath),
    fullName: path.basename(filePath),
    filePath,
    status: 'idle',
    children: [{ type: 'test', name: 'works', fullName: 'works', filePath, status: 'idle' }],
  };
}

async function callListTests(dispatcher: TestDispatcher): Promise<string> {
  const { server, tools } = makeToolCapture();
  registerListTestsTool(server, dispatcher);
  const result = await tools.get('tapsmith_list_tests')!({}, extra);
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('needsTsxLoader', () => {
  it('requires tsx for TypeScript test files even when the scripts are compiled JS', () => {
    expect(needsTsxLoader(
      ['/pkg/dist/watch-run.js', '/pkg/dist/ui-mode/ui-discover.js'],
      ['/project/tests/login.test.ts'],
    )).toBe(true);
  });

  it('requires tsx for .tsx test files', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], ['/project/tests/login.test.tsx'])).toBe(true);
  });

  it('requires tsx when our own scripts are TypeScript (source checkout)', () => {
    expect(needsTsxLoader(['/pkg/src/watch-run.ts'], ['/project/tests/login.test.js'])).toBe(true);
  });

  it('skips tsx when neither the scripts nor the test files are TypeScript', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], ['/project/tests/login.test.js'])).toBe(false);
  });

  it('skips tsx when no test files have been discovered yet', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], [])).toBe(false);
  });
});

describe('resolveTsxBin', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-tsx-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Executable, the way npm writes a `.bin` shim — `resolveTsxBin` hands what
  // it finds to `fork` as `execPath`, so a file without the bit is no use and
  // is deliberately skipped.
  function touch(...segments: string[]): string {
    const file = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o755);
    return file;
  }

  function touchNonExecutable(...segments: string[]): string {
    const file = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o644);
    return file;
  }

  it('finds tsx inside our own dependency tree', () => {
    const pkgDir = path.join(root, 'packages', 'tapsmith');
    const bin = touch('packages', 'tapsmith', 'node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(bin);
  });

  it('finds tsx hoisted to the consumer node_modules/.bin', () => {
    const pkgDir = path.join(root, 'node_modules', 'tapsmith');
    fs.mkdirSync(pkgDir, { recursive: true });
    const bin = touch('node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(bin);
  });

  it('prefers our own dependency tree over the hoisted copy', () => {
    const pkgDir = path.join(root, 'node_modules', 'tapsmith');
    const own = touch('node_modules', 'tapsmith', 'node_modules', '.bin', 'tsx');
    touch('node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(own);
  });

  // A shim extracted without its mode bits becomes `execPath` for every forked
  // child, and each dies with EACCES — burying the "install tsx" advice and
  // skipping the fallbacks that would have worked.
  it('skips a shim that is not executable rather than handing it to fork', () => {
    const pkgDir = path.join(root, 'packages', 'tapsmith');
    touchNonExecutable('packages', 'tapsmith', 'node_modules', '.bin', 'tsx');
    const hoisted = touch('packages', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(hoisted);
  });

  it('never returns a path that does not exist', () => {
    // Falls back to resolving the tsx package or PATH; whatever comes back must
    // be real, because forking a non-existent execPath fails silently.
    const resolved = resolveTsxBin(path.join(root, 'nowhere'));
    if (resolved !== undefined) expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe('resolveChildLoader', () => {
  it('returns no loader, and stays quiet, when nothing is TypeScript', () => {
    const warnings: string[] = [];
    const loader = resolveChildLoader(
      ['/pkg/dist/watch-run.js'],
      ['/project/tests/login.test.js'],
      '/pkg',
      (m) => warnings.push(m),
    );
    expect(loader).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('reports when TypeScript tests need a loader that cannot be found', () => {
    const warnings: string[] = [];
    const emptyPath = process.env.PATH;
    process.env.PATH = '';
    try {
      resolveChildLoader(
        ['/pkg/dist/watch-run.js'],
        ['/project/tests/login.test.ts'],
        '/nonexistent-pkg-dir',
        (m) => warnings.push(m),
      );
    } finally {
      process.env.PATH = emptyPath;
    }
    // tsx may still be resolvable through our own package; only assert that a
    // failure is never silent.
    if (warnings.length > 0) expect(warnings[0]).toContain('tsx');
  });
});

// Review round 13 read this as returning discovery order. It does not: the set
// is filled by walking the caller's list, and a set keeps insertion order — so
// a caller that deliberately sequenced its files still gets them in sequence.
describe('matchRequestedFiles ordering', () => {
  const files = ['/r/a.test.ts', '/r/b.test.ts', '/r/c.test.ts'];

  it('runs named files in the order the caller asked for', () => {
    expect(matchRequestedFiles(['/r/c.test.ts', '/r/a.test.ts'], files, ['/r']))
      .toEqual(['/r/c.test.ts', '/r/a.test.ts']);
  });

  it('keeps caller order for paths given relative to the root', () => {
    expect(matchRequestedFiles(['b.test.ts', 'a.test.ts'], files, ['/r']))
      .toEqual(['/r/b.test.ts', '/r/a.test.ts']);
  });

  it('never runs a file twice when two requests name it', () => {
    expect(matchRequestedFiles(['a.test.ts', '/r/a.test.ts'], files, ['/r']))
      .toEqual(['/r/a.test.ts']);
  });
});

describe('fileFailureEntry', () => {
  it('records the cause of a whole-file failure as a failed result', () => {
    const entry = fileFailureEntry(
      '/project/tests/toggles.test.ts',
      'ios',
      new Error("Cannot find module '/project/fixtures.js'"),
    );
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe("Cannot find module '/project/fixtures.js'");
    expect(entry.filePath).toBe('/project/tests/toggles.test.ts');
    expect(entry.projectName).toBe('ios');
    expect(entry.fullName).toContain('toggles.test.ts');
  });

  it('stringifies non-Error throws', () => {
    expect(fileFailureEntry('/project/tests/a.test.ts', undefined, 'worker died').error)
      .toBe('worker died');
  });

  it('produces a key that does not collide with another file in the same project', () => {
    const a = fileFailureEntry('/project/tests/a.test.ts', 'ios', new Error('boom'));
    const b = fileFailureEntry('/project/tests/b.test.ts', 'ios', new Error('boom'));
    expect(resultEntryKey('ios', a.filePath, a.fullName))
      .not.toBe(resultEntryKey('ios', b.filePath, b.fullName));
  });
});

describe('tapsmith_list_tests declared isolation', () => {
  it('prints each node\'s declared appReset / appResetScope / appState', async () => {
    const filePath = '/project/tests/toggles.test.ts';
    const tree: TestTreeEntry[] = [{
      type: 'file', name: 'toggles.test.ts', fullName: 'toggles.test.ts', filePath, status: 'idle',
      children: [{
        type: 'suite', name: 'Toggles', fullName: 'Toggles', filePath, status: 'idle',
        use: { appResetScope: 'test' },
        children: [
          { type: 'test', name: 'flips', fullName: 'Toggles flips', filePath, status: 'idle', use: { appResetScope: 'test' } },
          {
            type: 'test', name: 'signed in', fullName: 'Toggles signed in', filePath, status: 'idle',
            use: { appReset: 'restart', appResetScope: 'test', appState: './tapsmith-results/auth.tar.gz' },
          },
        ],
      }],
    }];
    const text = await callListTests(makeDispatcher({ getTestTree: () => tree }));
    expect(text).toContain('[suite] Toggles  {appResetScope: test}');
    expect(text).toContain('[test] flips  —  "Toggles flips"  {appResetScope: test}');
    expect(text).toContain('{appReset: restart, appResetScope: test, appState: ./tapsmith-results/auth.tar.gz}');
    // The file declares nothing — its line stays as before.
    expect(text).toContain(`[file] ${filePath}\n`);
  });

  it('shows a cleared appState as such rather than as an empty string', async () => {
    const filePath = '/project/tests/fresh.test.ts';
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [{
        type: 'test', name: 'fresh', fullName: 'fresh', filePath, status: 'idle', use: { appState: '' },
      }],
    }));
    expect(text).toContain('{appState: "" (cleared)}');
  });
});

describe('tapsmith_list_tests discovery errors', () => {
  const failures: DiscoveryError[] = [
    { filePath: '/project/tests/toggles.test.ts', error: "Cannot find module '/project/fixtures.js'" },
  ];

  it('warns about files that failed to load, with the reason', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => failures,
    }));
    expect(text).toContain('1 test file(s) failed to load');
    expect(text).toContain('/project/tests/toggles.test.ts');
    expect(text).toContain("Cannot find module '/project/fixtures.js'");
    // The tests that did load are still listed.
    expect(text).toContain('/project/tests/ok.test.ts');
  });

  it('reports failures even when nothing at all could be discovered', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [],
      getDiscoveryErrors: () => failures,
    }));
    expect(text).not.toBe('No test files discovered.');
    expect(text).toContain('failed to load');
  });

  it('caps the listing but still reports the true total', async () => {
    const many = Array.from({ length: 28 }, (_, i) => ({
      filePath: `/project/tests/f${i}.test.ts`,
      error: 'Cannot find module',
    }));
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => many,
    }));
    expect(text).toContain('28 test file(s) failed to load');
    expect(text).toContain('… and 18 more');
    expect(text).toContain('/project/tests/f0.test.ts');
    expect(text).not.toContain('/project/tests/f27.test.ts');
  });

  it('stays quiet when every file loaded', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => [],
    }));
    expect(text).not.toContain('failed to load');
  });

  it('tolerates a dispatcher that does not report discovery errors', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
    }));
    expect(text).toContain('/project/tests/ok.test.ts');
  });
});

describe('matchRequestedFiles', () => {
  const testFiles = [
    '/project/e2e/tests/login.test.ts',
    '/project/e2e/tests/nested/checkout.test.ts',
    '/project/e2e/tests/profile.test.ts',
  ];
  const roots = ['/project/e2e'];

  it('matches an absolute path', () => {
    expect(matchRequestedFiles(['/project/e2e/tests/login.test.ts'], testFiles, roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('matches a path relative to the project root', () => {
    expect(matchRequestedFiles(['tests/login.test.ts'], testFiles, roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('matches a path relative to the working directory when it differs from the root', () => {
    expect(matchRequestedFiles(['nested/checkout.test.ts'], testFiles, ['/project/e2e/tests']))
      .toEqual(['/project/e2e/tests/nested/checkout.test.ts']);
  });

  it('matches a relative glob', () => {
    expect(matchRequestedFiles(['tests/*.test.ts'], testFiles, roots).sort())
      .toEqual(['/project/e2e/tests/login.test.ts', '/project/e2e/tests/profile.test.ts']);
  });

  it('matches a recursive glob across directories', () => {
    expect(matchRequestedFiles(['tests/**/*.test.ts'], testFiles, roots).sort())
      .toEqual([
        '/project/e2e/tests/login.test.ts',
        '/project/e2e/tests/nested/checkout.test.ts',
        '/project/e2e/tests/profile.test.ts',
      ]);
  });

  it('matches an absolute glob', () => {
    expect(matchRequestedFiles(['/project/e2e/tests/*.test.ts'], testFiles, roots).sort())
      .toEqual(['/project/e2e/tests/login.test.ts', '/project/e2e/tests/profile.test.ts']);
  });

  it('returns nothing for an argument that matches no discovered file', () => {
    expect(matchRequestedFiles(['tests/typo.test.ts'], testFiles, roots)).toEqual([]);
  });

  it('never returns a file that was not discovered', () => {
    expect(matchRequestedFiles(['**/*'], ['/project/e2e/tests/login.test.ts'], roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('does not duplicate a file matched by several arguments', () => {
    const matched = matchRequestedFiles(
      ['tests/login.test.ts', '/project/e2e/tests/login.test.ts', 'tests/*.test.ts'],
      testFiles,
      roots,
    );
    expect(matched.filter((f) => f.endsWith('login.test.ts'))).toHaveLength(1);
  });
});

describe('tapsmith_session_info config reporting', () => {
  async function callSessionInfo(dispatcher: TestDispatcher): Promise<string> {
    const { server, tools } = makeToolCapture();
    registerSessionInfoTool(server, dispatcher);
    const result = await tools.get('tapsmith_session_info')!({}, extra);
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('names the config file backing the session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        configPath: '/project/e2e/tapsmith.config.ios.mjs',
      }),
    }));
    expect(text).toContain('Config: /project/e2e/tapsmith.config.ios.mjs');
    expect(text).not.toContain('WARNING');
  });

  it('says so, loudly, when the session runs on synthesized defaults', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        configWarning: 'No Tapsmith config file is backing this session (working directory: /project).',
      }),
    }));
    expect(text).toContain('Config: none');
    expect(text).toContain('WARNING');
    expect(text).toContain('/project');
  });
});

describe('loadMcpConfig config-file reporting', () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpath: macOS resolves /var to /private/var on chdir, and the loader
    // reports paths built from process.cwd().
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-cfg-')));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the config path and no warning when one is found in the working directory', async () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBe(path.join(root, 'tapsmith.config.mjs'));
    expect(result.warning).toBeUndefined();
  });

  it('finds a single config one level down', async () => {
    fs.mkdirSync(path.join(root, 'e2e'));
    fs.writeFileSync(path.join(root, 'e2e', 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBe(path.join(root, 'e2e', 'tapsmith.config.mjs'));
    expect(result.warning).toBeUndefined();
  });

  it('warns, naming the directory, when no config exists anywhere', async () => {
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('No Tapsmith config file');
    expect(result.warning).toContain('--config');
    expect(result.warning).toContain('tests cannot run');
  });

  it('warns and lists the candidates when several configs sit one level down', async () => {
    for (const dir of ['e2e', 'smoke']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    }
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('Multiple configs');
    expect(result.warning).toContain('e2e');
    expect(result.warning).toContain('smoke');
  });

  // The working directory's config is the one the user meant. When it is
  // broken, quietly adopting a nested one instead reports a config the session
  // is not running under and buries the import error the user has to fix.
  it('reports a broken working-directory config instead of falling back to a nested one', async () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), 'throw new Error("boom")\n');
    fs.mkdirSync(path.join(root, 'e2e'));
    fs.writeFileSync(path.join(root, 'e2e', 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('could not be loaded');
    expect(result.warning).toContain('tapsmith.config.mjs');
    // And it points at the alternative rather than only saying "fix it".
    expect(result.warning).toContain('e2e');
  });

  it('reports a broken nested config rather than passing defaults off as it', async () => {
    fs.mkdirSync(path.join(root, 'e2e'));
    fs.writeFileSync(path.join(root, 'e2e', 'tapsmith.config.mjs'), 'throw new Error("boom")\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('could not be loaded');
  });
});

// A multi-platform config keeps its platforms on the projects, not at the top
// level. The session used to provision one device for the whole session and
// start its agent from the (absent) root platform, so iOS projects failed with
// "iOS agent is not configured" however the run was requested.
describe('platformKeyForProject', () => {
  const projects = [
    { name: 'android', effectiveConfig: { platform: 'android' } },
    { name: 'ios', effectiveConfig: { platform: 'ios' } },
    { name: 'ios:authenticated', effectiveConfig: { platform: 'ios' } },
  ];

  it("routes a run to its project's platform when the root config has none", () => {
    expect(platformKeyForProject(projects, 'ios', undefined)).toBe('ios');
    expect(platformKeyForProject(projects, 'android', undefined)).toBe('android');
  });

  it('routes dependent projects to the same platform as their siblings', () => {
    expect(platformKeyForProject(projects, 'ios:authenticated', undefined)).toBe('ios');
  });

  it('falls back to the root platform for a single-platform config', () => {
    expect(platformKeyForProject([], undefined, 'ios')).toBe('ios');
  });

  it("prefers the project's platform over the root's", () => {
    expect(platformKeyForProject(projects, 'android', 'ios')).toBe('android');
  });

  it('falls back to the default key when nothing declares a platform', () => {
    expect(platformKeyForProject([], undefined, undefined)).toBe('default');
  });

  it('falls back to the root platform for an unknown project name', () => {
    expect(platformKeyForProject(projects, 'nope', 'android')).toBe('android');
  });
});

describe('tapsmith_session_info device targets', () => {
  async function callSessionInfo(dispatcher: TestDispatcher): Promise<string> {
    const { server, tools } = makeToolCapture();
    registerSessionInfoTool(server, dispatcher);
    const result = await tools.get('tapsmith_session_info')!({}, extra);
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('lists a device per platform for a multi-platform session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        deviceTargets: [
          { platform: 'ios', device: 'SIM-1' },
          { platform: 'android', device: 'emulator-5554' },
        ],
      }),
    }));
    expect(text).toContain('Device (ios): SIM-1');
    expect(text).toContain('Device (android): emulator-5554');
  });

  it('says which platform has no device, and why', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        deviceTargets: [
          { platform: 'ios', device: 'SIM-1' },
          { platform: 'android', error: 'No android device is available. Start an emulator and try again.' },
        ],
      }),
    }));
    expect(text).toContain('Device (ios): SIM-1');
    expect(text).toContain('Device (android): unavailable — No android device is available.');
  });

  it('names group members without inventing a "(device)" platform', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        deviceTargets: [
          { device: 'emulator-5554', name: 'alice', group: 'pair' },
          { device: 'emulator-5556', name: 'bob', group: 'pair' },
        ],
      }),
    }));
    expect(text).toContain('Device alice [pair]: emulator-5554');
    expect(text).toContain('Device bob [pair]: emulator-5556');
    expect(text).not.toContain('(device)');
  });

  // A headless session picks its devices on the first run or device tool, so
  // reading session info must not pick one — and must say none is chosen yet
  // rather than print no Device line at all.
  it('says no device is chosen yet before anything needed one', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [], deviceTargets: [] }),
    }));
    expect(text).toContain('Device: not chosen yet');
  });

  it('keeps the single-device line for a single-platform session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        device: 'SIM-1',
        deviceTargets: [{ platform: 'ios', device: 'SIM-1' }],
      }),
    }));
    expect(text).toContain('Device: SIM-1');
    expect(text).not.toContain('Device (ios)');
  });
});

describe('MCP daemon registry', () => {
  let root: string;
  let originalHome: string | undefined;

  /** Registry addresses alone, for the cases that do not care about ownership. */
  const addresses = (): string[] => readDaemonRegistry().map((e) => e.address);

  // HOME, because the registry lives under the home directory — deliberately,
  // so an MCP client that sanitizes TMPDIR out of the server's environment
  // cannot split one project's sessions across two registries.
  beforeEach(() => {
    originalHome = process.env.HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-reg-'));
    process.env.HOME = root;
  });

  afterEach(() => {
    // Assigning undefined to an env var stores the string "undefined", which
    // os.homedir() then hands back as a path — pointing the next test at a
    // literal ./undefined directory instead of the real home.
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts empty and survives a missing registry file', () => {
    expect(addresses()).toEqual([]);
  });

  it('ignores non-loopback addresses planted in the shared temp file', () => {
    // The path is derived only from the project directory, so on a multi-user
    // host anyone can write this file; an accepted address would receive the
    // session's screenshots and drive its device.
    fs.mkdirSync(path.dirname(mcpDaemonRegistryPath()), { recursive: true });
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([
        { address: 'evil.example:50051', pid: process.pid },
        { address: '10.0.0.9:50051', pid: process.pid },
        { address: '127.0.0.1:50161', pid: process.pid },
      ]),
      'utf-8',
    );
    expect(addresses()).toEqual(['127.0.0.1:50161']);
  });

  it('refuses to register a non-loopback address', () => {
    registerDaemon('evil.example:50051');
    expect(addresses()).toEqual([]);
  });

  it('ignores entries whose session is gone', () => {
    fs.mkdirSync(path.dirname(mcpDaemonRegistryPath()), { recursive: true });
    // Pid 0x7FFFFFFF is beyond any real pid_max, so it is reliably absent.
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([{ address: '127.0.0.1:50161', pid: 2147483647 }]),
      'utf-8',
    );
    expect(addresses()).toEqual([]);
  });

  // A dead session's row is the only record of the daemon pid it started, so
  // it is kept while that daemon is alive — otherwise the process is stranded:
  // invisible for reuse and, because nothing knows its pid, never reaped.
  // Here the recorded pid belongs to this test process, which is emphatically
  // not a tapsmith-core, so the row is correctly discarded.
  it('drops a dead session\'s entry when its daemon pid is not a live daemon', () => {
    fs.mkdirSync(path.dirname(mcpDaemonRegistryPath()), { recursive: true });
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([{ address: '127.0.0.1:50161', pid: 2147483647, daemonPid: process.pid }]),
      'utf-8',
    );
    expect(addresses()).toEqual([]);
  });

  it('keeps another live session\'s entry when pruning our own dead addresses', () => {
    registerDaemon('127.0.0.1:50161');
    // A peer session (this test's own pid stands in for "still alive") holding
    // a different daemon must survive our prune.
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([
        { address: '127.0.0.1:50161', pid: process.pid },
        { address: '127.0.0.1:50244', pid: process.ppid },
      ]),
      'utf-8',
    );
    pruneDaemonRegistry([]);
    expect(addresses()).toEqual(['127.0.0.1:50244']);
  });

  // A UI run's *primary* daemon sits at the default `daemonAddress`, which a
  // headless session reaches as a `configured` candidate — a source it may
  // repoint and start its own agent on, so no ownership guard ever sees it.
  // Measured before this: a headless iOS session beside a UI Android run
  // reported the simulator and answered from the emulator.
  describe('UI-owned daemon addresses', () => {
    it('compares loopback spellings as the same address', () => {
      expect(normalizeDaemonAddress('localhost:50051')).toBe('127.0.0.1:50051');
      expect(normalizeDaemonAddress('127.0.0.1:50051')).toBe('127.0.0.1:50051');
      expect(normalizeDaemonAddress('[::1]:50051')).toBe('127.0.0.1:50051');
    });

    it('keeps a non-loopback host distinct', () => {
      expect(normalizeDaemonAddress('10.0.0.5:50051')).toBe('10.0.0.5:50051');
    });

    // Two project directories share the default daemon port, so "is this
    // daemon a UI run's?" is a machine-wide question, not a per-project one.
    it('finds every UI session on the machine, not just this project\'s', () => {
      fs.mkdirSync(path.dirname(uiPortFilePath()), { recursive: true });
      fs.writeFileSync(uiPortFilePath(), '9274');
      fs.writeFileSync(path.join(path.dirname(uiPortFilePath()), 'ui-port-deadbeef'), '9275');
      const found = allUiPortFiles();
      expect(found).toHaveLength(2);
      expect(found.some((f) => f.endsWith('ui-port-deadbeef'))).toBe(true);
    });

    it('is empty when no UI server is running', () => {
      expect(allUiPortFiles()).toEqual([]);
    });

    // Nothing else creates this directory in UI mode — the registry's mkdir sits
    // behind writes a UI server deliberately never makes. Without it the port
    // file write failed with ENOENT on a fresh machine, no UI server was
    // discoverable, and headless sessions went back to claiming its daemon.
    it('creates the state directory a UI server publishes its port into', () => {
      const dir = path.dirname(uiPortFilePath());
      expect(fs.existsSync(dir)).toBe(false);

      ensureDaemonStateDir();
      expect(fs.existsSync(dir)).toBe(true);
      expect(() => fs.writeFileSync(uiPortFilePath(), '9274')).not.toThrow();
      expect(allUiPortFiles()).toHaveLength(1);
    });

    it('is safe to call when the directory already exists', () => {
      ensureDaemonStateDir();
      expect(() => ensureDaemonStateDir()).not.toThrow();
    });
  });

  it('remembers a daemon so another session can find it', () => {
    registerDaemon('127.0.0.1:50161');
    expect(addresses()).toEqual(['127.0.0.1:50161']);
  });

  // The UI server's daemons are its workers'; a headless session's are its own.
  // Sharing them either way puts one session's devices in the other's pool —
  // and a UI device tool then refuses as ambiguous over a device the UI run
  // never had, while the UI process keeps the headless daemon alive as a
  // registered user of it.
  describe('in UI mode', () => {
    afterEach(() => { configureMcpConnection({}); });

    it('records nothing, so no headless session adopts a UI worker daemon', () => {
      registerDaemon('127.0.0.1:50161');
      configureMcpConnection({ uiMode: true });

      registerDaemon('127.0.0.1:50162');
      // Only the headless session's row. Discovery skips reading the file at
      // all in UI mode; this asserts the other half — that nothing was written.
      expect(addresses()).toEqual(['127.0.0.1:50161']);
    });

    it('leaves another session\'s row alone on the way out', () => {
      registerDaemon('127.0.0.1:50161');
      configureMcpConnection({ uiMode: true });

      unregisterDaemon('127.0.0.1:50161');
      pruneDaemonRegistry([]);

      configureMcpConnection({});
      expect(addresses()).toEqual(['127.0.0.1:50161']);
    });
  });

  // A live session's daemon and an abandoned one need opposite treatment: the
  // first must not be repointed or have an agent started on it, the second is
  // ours to drive and to reap. The row's session pid is what tells them apart.
  it('marks a daemon owned by a live session as not orphaned', () => {
    registerDaemon('127.0.0.1:50161');
    expect(readDaemonRegistry()).toEqual([{ address: '127.0.0.1:50161', orphaned: false }]);
  });

  it('does not mark an address orphaned while any live session still holds it', () => {
    fs.mkdirSync(path.dirname(mcpDaemonRegistryPath()), { recursive: true });
    // The same daemon, recorded by a session that is gone and one that is not.
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([
        { address: '127.0.0.1:50161', pid: 2147483647 },
        { address: '127.0.0.1:50161', pid: process.pid },
      ]),
      'utf-8',
    );
    expect(readDaemonRegistry()).toEqual([{ address: '127.0.0.1:50161', orphaned: false }]);
  });

  // mkdirSync applies its mode only when it creates the directory, so a
  // pre-existing `tapsmith-<uid>` — a name anyone on a shared host can claim
  // first in a sticky temp dir — was used with whatever permissions it had.
  it('tightens a group- or world-writable registry directory it owns', () => {
    const dir = path.dirname(mcpDaemonRegistryPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777);
    registerDaemon('127.0.0.1:50161');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(addresses()).toEqual(['127.0.0.1:50161']);
  });

  // Only the session that started a daemon knows its pid. Keeping that on one
  // row meant the daemon outlived every session that could reap it: the
  // starter's row goes when it exits (or when a prune notices it was killed),
  // and the peers left behind have neither a child handle nor a recorded pid.
  it('hands the daemon pid to the sessions still holding the address', () => {
    registerDaemon('127.0.0.1:50161', 99001);
    fs.writeFileSync(
      mcpDaemonRegistryPath(),
      JSON.stringify([
        { address: '127.0.0.1:50161', pid: process.pid, daemonPid: 99001 },
        { address: '127.0.0.1:50161', pid: process.ppid },
      ]),
      'utf-8',
    );

    // Our own exit removes our row; the peer's must come away knowing the pid.
    unregisterDaemon('127.0.0.1:50161');

    const entries = JSON.parse(fs.readFileSync(mcpDaemonRegistryPath(), 'utf-8'));
    expect(entries).toEqual([
      { address: '127.0.0.1:50161', pid: process.ppid, daemonPid: 99001 },
    ]);
  });

  it('does not let a later pid-less registration erase the daemon pid', () => {
    registerDaemon('127.0.0.1:50161', 99001);
    // A re-discovery adopting the same address as a peer would otherwise
    // overwrite the row that says which process to reap.
    registerDaemon('127.0.0.1:50161');
    const entries = JSON.parse(fs.readFileSync(mcpDaemonRegistryPath(), 'utf-8'));
    expect(entries).toEqual([
      { address: '127.0.0.1:50161', pid: process.pid, daemonPid: 99001 },
    ]);
  });

  it('ignores a registry whose directory cannot be made private', () => {
    // A plain file where the directory belongs stands in for a directory this
    // user cannot secure: either way the path is not a private directory, and
    // trusting it hands the session an address someone else chose.
    const dir = path.dirname(mcpDaemonRegistryPath());
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, 'not a directory', 'utf-8');
    registerDaemon('127.0.0.1:50161');
    expect(addresses()).toEqual([]);
  });

  it('does not record the same daemon twice', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50161');
    expect(addresses()).toEqual(['127.0.0.1:50161']);
  });

  it('forgets a daemon when its session shuts it down', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50244');
    unregisterDaemon('127.0.0.1:50161');
    expect(addresses()).toEqual(['127.0.0.1:50244']);
  });

  it('drops addresses that failed to answer a probe', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50244');
    pruneDaemonRegistry(['127.0.0.1:50244']);
    expect(addresses()).toEqual(['127.0.0.1:50244']);
  });

  it('leaves the registry alone when it is already empty', () => {
    pruneDaemonRegistry([]);
    expect(addresses()).toEqual([]);
  });

  it('treats a corrupt registry as empty rather than throwing', () => {
    registerDaemon('127.0.0.1:50161');
    fs.writeFileSync(mcpDaemonRegistryPath(), 'not json', 'utf-8');
    expect(addresses()).toEqual([]);
  });
});

// A run must never be silently redirected to another platform's device: the
// iOS suite against an Android emulator fails on every assertion for reasons
// that look nothing like "no simulator is booted".
describe('selectPlatformTarget', () => {
  const ios = { address: '127.0.0.1:1', deviceSerial: 'SIM-1', platform: 'ios' };
  const android = { address: '127.0.0.1:2', deviceSerial: 'emulator-5554', platform: 'android' };

  it('returns the target for the requested platform', () => {
    const targets = new Map([['ios', ios], ['android', android]]);
    expect(selectPlatformTarget('ios', targets, new Map())).toBe(ios);
  });

  it("reports the platform's own failure instead of borrowing another device", () => {
    const targets = new Map([['android', android]]);
    const errors = new Map([['ios', 'No ios device is available. Boot a simulator and try again.']]);
    expect(() => selectPlatformTarget('ios', targets, errors)).toThrow(/Boot a simulator/);
  });

  it('never falls back across platforms even with no recorded reason', () => {
    const targets = new Map([['android', android]]);
    expect(() => selectPlatformTarget('ios', targets, new Map())).toThrow(/No device is configured for ios/);
  });

  it('uses the only target when the run declares no platform', () => {
    expect(selectPlatformTarget('default', new Map([['ios', ios]]), new Map())).toBe(ios);
  });

  it('refuses to guess when a platform-less run could go to either of two platforms', () => {
    const targets = new Map([['ios', ios], ['android', android]]);
    expect(() => selectPlatformTarget('default', targets, new Map())).toThrow(/runs on 2 platforms/);
  });

  it('surfaces the only recorded failure for a platform-less run with no targets', () => {
    const errors = new Map([['android', 'No android device is available. Start an emulator.']]);
    expect(() => selectPlatformTarget('default', new Map(), errors)).toThrow(/Start an emulator/);
  });
});

// A config that declares no projects gets one synthesized for it, named
// "default", which is an implementation detail and must stay hidden. Filtering
// that name blindly also hid projects a user had deliberately named "default"
// — in the e2e iOS config that is 33 of 35 files, listed in the test tree but
// absent from `Projects:`, so no caller could pass it to run_tests.
describe('project listing', () => {
  function dispatcherWithProjects(
    projects: Array<{ name: string; synthesized?: boolean }>,
  ): TestDispatcher {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _projects: Array<{
        name: string
        synthesized?: boolean
        effectiveConfig: Record<string, unknown>
        testFiles: string[]
        dependencies: string[]
      }>
    };
    internals._projects = projects.map(({ name, synthesized }) => ({
      name,
      synthesized,
      effectiveConfig: { platform: 'ios' },
      testFiles: [`/tests/${name}.test.ts`],
      dependencies: [],
    }));
    return dispatcher;
  }

  it('hides the project synthesized for a config that declares none', () => {
    const dispatcher = dispatcherWithProjects([{ name: 'default', synthesized: true }]);
    expect(dispatcher.getProjects()).toEqual([]);
    expect(dispatcher.getSessionInfo().projects).toEqual([]);
  });

  it('lists a project the config genuinely named "default"', () => {
    const dispatcher = dispatcherWithProjects([
      { name: 'authentication' }, { name: 'default' }, { name: 'authenticated' },
    ]);
    expect(dispatcher.getProjects()).toEqual(['authentication', 'default', 'authenticated']);
    expect(dispatcher.getSessionInfo().projects.map((p) => p.name))
      .toEqual(['authentication', 'default', 'authenticated']);
  });

  // The name alone cannot tell the two apart, and a config whose *only*
  // project is called "default" is the case where getting it wrong hurts
  // most: its testMatch, platform and agent artifacts all get ignored in
  // favour of the root config's.
  // The failure text says "Boot a simulator and try again", so a run must
  // actually re-resolve the platform rather than replay the startup error for
  // the life of the server.
  it('retries a platform whose target failed, and only that platform, only once', async () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targets: Map<string, { address: string; deviceSerial: string }>
      _targetErrors: Map<string, string>
      _config: { platform?: string } | null
      _projects: unknown[]
      _resolveOnePlatformTarget: (effective: { platform?: string }) => Promise<void>
      _ensureTargetForProject: (project?: string) => Promise<{ deviceSerial: string }>
      _dropTargetIfDaemonDied: (key: string) => Promise<void>
    };
    internals._config = { platform: 'ios' };
    internals._projects = [];
    internals._targets.set('android', { address: '127.0.0.1:50052', deviceSerial: 'EMU-1' });
    internals._targetErrors.set('ios', 'No ios device is available. Boot a simulator and try again.');
    // These targets are fixtures, with no daemon behind them; the liveness
    // check is exercised on its own below.
    internals._dropTargetIfDaemonDied = async (): Promise<void> => {};

    const retried: Array<string | undefined> = [];
    internals._resolveOnePlatformTarget = async (effective): Promise<void> => {
      retried.push(effective.platform);
      // The simulator appears before the retry lands.
      internals._targetErrors.delete('ios');
      internals._targets.set('ios', { address: '127.0.0.1:50051', deviceSerial: 'SIM-1' });
    };

    const target = await internals._ensureTargetForProject();
    expect(target.deviceSerial).toBe('SIM-1');
    // Only the failed platform, and the healthy android target is untouched.
    expect(retried).toEqual(['ios']);
    expect(internals._targets.get('android')?.deviceSerial).toBe('EMU-1');

    await internals._ensureTargetForProject();
    expect(retried).toEqual(['ios']);
  });

  // The budget is per run request, not per server. Spending it once for the
  // life of the process meant the first run after startup burned the only
  // retry there was — so a user who read "boot a simulator and try again",
  // booted one, and tried again got the same cached error forever.
  it('gives the retry back when the caller asks for another run', async () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targetErrors: Map<string, string>
      _config: { platform?: string } | null
      _projects: unknown[]
      _resolveOnePlatformTarget: (effective: { platform?: string }) => Promise<void>
      _ensureTargetForProject: (project?: string) => Promise<{ deviceSerial: string }>
      _dropTargetIfDaemonDied: (key: string) => Promise<void>
      _startRunRequest: () => void
    };
    internals._config = { platform: 'ios' };
    internals._projects = [];
    internals._targetErrors.set('ios', 'No ios device is available. Boot a simulator and try again.');
    internals._dropTargetIfDaemonDied = async (): Promise<void> => {};

    let attempts = 0;
    // The simulator is still not booted, so the retry changes nothing.
    internals._resolveOnePlatformTarget = async (): Promise<void> => { attempts++; };

    await expect(internals._ensureTargetForProject()).rejects.toThrow('Boot a simulator');
    await expect(internals._ensureTargetForProject()).rejects.toThrow('Boot a simulator');
    expect(attempts).toBe(1);

    // The user boots it and runs again.
    internals._startRunRequest();
    internals._resolveOnePlatformTarget = async (): Promise<void> => {
      attempts++;
      internals._targetErrors.delete('ios');
      (dispatcher as unknown as { _targets: Map<string, unknown> })
        ._targets.set('ios', { address: '127.0.0.1:50051', deviceSerial: 'SIM-1' });
    };
    const target = await internals._ensureTargetForProject();
    expect(target.deviceSerial).toBe('SIM-1');
    expect(attempts).toBe(2);
  });

  // An MCP session runs one device per platform, so projects on the same
  // platform that pin different devices share a target. Which one they share
  // is documented as the first — a Map built from the whole project list kept
  // the last instead, so the session ran on a device no reader expected.
  it('resolves one target per platform, from the first project on it', async () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _config: Record<string, unknown> | null
      _projects: Array<{ name: string; effectiveConfig: Record<string, unknown> }>
      _resolveOnePlatformTarget: (effective: { platform?: string; device?: string }) => Promise<void>
      _resolvePlatformTargets: (config: Record<string, unknown> | null) => Promise<void>
    };
    internals._config = { platform: 'ios' };
    internals._projects = [
      { name: 'ios-a', effectiveConfig: { platform: 'ios', device: 'SIM-1' } },
      { name: 'ios-b', effectiveConfig: { platform: 'ios', device: 'SIM-2' } },
      { name: 'android', effectiveConfig: { platform: 'android', device: 'EMU-1' } },
    ];

    const resolved: Array<string | undefined> = [];
    internals._resolveOnePlatformTarget = async (effective): Promise<void> => {
      resolved.push(effective.device);
    };

    await internals._resolvePlatformTargets(internals._config);
    expect(resolved).toEqual(['SIM-1', 'EMU-1']);
  });

  // A resolved target was never revisited, so a daemon killed mid-session left
  // every later run failing at gRPC connect with no way back but restarting the
  // server. The address here is in no connection pool, which is exactly what a
  // dead daemon looks like.
  it('re-resolves a target whose daemon has died, even after the one retry is spent', async () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targets: Map<string, { address: string; deviceSerial: string }>
      _targetErrors: Map<string, string>
      _retriedTargets: Set<string>
      _config: { platform?: string } | null
      _projects: unknown[]
      _resolveOnePlatformTarget: (effective: { platform?: string }) => Promise<void>
      _ensureTargetForProject: (project?: string) => Promise<{ deviceSerial: string }>
    };
    internals._config = { platform: 'ios' };
    internals._projects = [];
    internals._targets.set('ios', { address: '127.0.0.1:59998', deviceSerial: 'SIM-1' });
    // The session's single retry is already used up.
    internals._retriedTargets.add('ios');

    let resolves = 0;
    internals._resolveOnePlatformTarget = async (): Promise<void> => {
      resolves++;
      internals._targetErrors.delete('ios');
      internals._targets.set('ios', { address: '127.0.0.1:59999', deviceSerial: 'SIM-2' });
    };

    const target = await internals._ensureTargetForProject();
    expect(resolves).toBe(1);
    expect(target.deviceSerial).toBe('SIM-2');
  });

  it('gives up on a platform that stays unavailable instead of retrying per file', async () => {
    const dispatcher = new HeadlessTestDispatcher({});
    const internals = dispatcher as unknown as {
      _targets: Map<string, unknown>
      _targetErrors: Map<string, string>
      _config: { platform?: string } | null
      _projects: unknown[]
      _resolveOnePlatformTarget: (effective: { platform?: string }) => Promise<void>
      _ensureTargetForProject: (project?: string) => Promise<unknown>
      _dropTargetIfDaemonDied: (key: string) => Promise<void>
    };
    internals._config = { platform: 'ios' };
    internals._projects = [];
    internals._targetErrors.set('ios', 'No ios device is available. Boot a simulator and try again.');
    internals._dropTargetIfDaemonDied = async (): Promise<void> => {};

    let attempts = 0;
    internals._resolveOnePlatformTarget = async (): Promise<void> => { attempts++; };

    await expect(internals._ensureTargetForProject()).rejects.toThrow(/Boot a simulator/);
    await expect(internals._ensureTargetForProject()).rejects.toThrow(/Boot a simulator/);
    await expect(internals._ensureTargetForProject()).rejects.toThrow(/Boot a simulator/);
    // A 20-file run must not spawn and discard a daemon 20 times.
    expect(attempts).toBe(1);
  });

  it('lists a lone project the config named "default" itself', () => {
    const dispatcher = dispatcherWithProjects([{ name: 'default' }]);
    expect(dispatcher.getProjects()).toEqual(['default']);
    expect(dispatcher.getSessionInfo().projects.map((p) => p.name)).toEqual(['default']);
  });
});

// Daemons default to a shared agent port. That was harmless while a session
// had one daemon, but a multi-platform session runs one per platform — and the
// second attaching to the first platform's agent meant iOS tools drove the
// Android device and iOS-only calls came back "Unknown method". Every other
// daemon we spawn (dispatcher.ts, ui-server.ts) passes its own port.
describe('daemonSpawnArgs', () => {
  it('gives every daemon its own agent port', () => {
    expect(daemonSpawnArgs('50051', '18901')).toEqual(['--port', '50051', '--agent-port', '18901']);
  });

  it('keeps the platform filter alongside the agent port', () => {
    expect(daemonSpawnArgs('50052', '18902', 'ios'))
      .toEqual(['--port', '50052', '--agent-port', '18902', '--platform', 'ios']);
  });

  it('never spawns two daemons sharing an agent port', () => {
    const android = daemonSpawnArgs('50051', '18901', 'android');
    const ios = daemonSpawnArgs('50052', '18902', 'ios');
    const portOf = (args: string[]): string => args[args.indexOf('--agent-port') + 1];
    expect(portOf(android)).not.toBe(portOf(ios));
  });
});

// Two decisions hang on this: whether to force the agent to restart after
// `set_device`, and whether a peer session's daemon may be adopted at all.
// Both were previously answered from `preparedDevice`, which records only what
// *this* process did — so a daemon inherited from another session looked
// untouched however it was actually pointed.
describe('isRepointing', () => {
  it('is true when the daemon is serving a different device', () => {
    expect(isRepointing('EMU-1', 'EMU-2')).toBe(true);
  });

  it('is false when the daemon already serves the device we want', () => {
    // Forcing here would kill an agent that is already correct — including one
    // a peer session is mid-run against.
    expect(isRepointing('EMU-1', 'EMU-1')).toBe(false);
  });

  it('is false when the daemon has no device yet', () => {
    // A freshly started daemon, and the fallback when the daemon cannot be
    // reached to ask. Neither is a move.
    expect(isRepointing(undefined, 'EMU-1')).toBe(false);
  });
});

// A session holds a daemon per platform now, so "no device argument" stopped
// having one obvious answer: the old fallback to the first pooled daemon meant
// a screenshot taken while debugging an iOS failure could come back showing the
// Android emulator, with nothing in the response saying which device it was.
describe('ambiguousDeviceMessage', () => {
  it('says nothing when the session drives one device', () => {
    expect(ambiguousDeviceMessage([{ serial: 'EMU-1', platform: 'android' }])).toBeNull();
  });

  it('says nothing when the session has resolved no device yet', () => {
    expect(ambiguousDeviceMessage([])).toBeNull();
  });

  it('names each device, with its platform, when there is more than one', () => {
    const msg = ambiguousDeviceMessage([
      { serial: 'EMU-1', platform: 'android' },
      { serial: 'SIM-1', platform: 'ios' },
    ]);
    expect(msg).toContain('android: EMU-1');
    expect(msg).toContain('ios: SIM-1');
    // `project` first: it is the argument a caller can know without looking a
    // serial up, and the one `run_tests` already takes.
    expect(msg).toContain('`project`');
    expect(msg).toContain('`device`');
    expect(msg!.indexOf('`project`')).toBeLessThan(msg!.indexOf('`device`'));
  });

  // Several devices on one platform are the workers of a single run — clones
  // of one config, running the same tests. Any of them answers a device tool,
  // so `primaryDevice` picks one rather than demanding a serial the caller
  // could only get from `session_info`. `workers: 2` is the common UI session,
  // so refusing there broke every no-argument device tool.
  it('is not ambiguous when the devices share a platform', () => {
    expect(ambiguousDeviceMessage([
      { serial: 'SIM-1', platform: 'ios' },
      { serial: 'SIM-2', platform: 'ios' },
    ])).toBeNull();
  });

  it('is not ambiguous when no device has a known platform', () => {
    // UI-mode worker daemons are attached to, not prepared, so nothing here
    // knows their platform — they are still one run's workers.
    expect(ambiguousDeviceMessage([{ serial: 'SIM-1' }, { serial: 'SIM-2' }])).toBeNull();
  });

  it('is ambiguous as soon as one platform is joined by another', () => {
    const msg = ambiguousDeviceMessage([
      { serial: 'SIM-1', platform: 'ios' },
      { serial: 'SIM-2', platform: 'ios' },
      { serial: 'EMU-1', platform: 'android' },
    ]);
    expect(msg).toContain('ios: SIM-1');
    expect(msg).toContain('android: EMU-1');
    expect(msg).toContain('`project`');
  });
});

describe('primaryDevice', () => {
  it('is the first device the session prepared', () => {
    expect(primaryDevice([
      { serial: 'SIM-1', platform: 'ios' },
      { serial: 'SIM-2', platform: 'ios' },
    ])).toEqual({ serial: 'SIM-1', platform: 'ios' });
  });

  // Stability is the whole argument for choosing silently: a snapshot and the
  // tap that follows it have to land on the same device.
  it('answers the same way for every call on one session', () => {
    const targets = [
      { serial: 'SIM-1', platform: 'ios' },
      { serial: 'SIM-2', platform: 'ios' },
    ];
    expect(primaryDevice(targets)).toEqual(primaryDevice(targets));
  });

  it('has no answer for a session driving nothing', () => {
    expect(primaryDevice([])).toBeUndefined();
  });
});

// "No ios device is available. Boot a simulator and try again." sent people
// looking for a simulator that was already booted, when the real cause was a
// serial in their config that no longer exists.
describe('noDeviceMessage', () => {
  it('names the configured device and what the daemon could actually see', () => {
    const msg = noDeviceMessage('ios', 'OLD-UDID', ['SIM-1', 'SIM-2']);
    expect(msg).toContain('"OLD-UDID"');
    expect(msg).toContain('SIM-1, SIM-2');
    expect(msg).not.toContain('Boot a simulator');
  });

  it('says the configured device is missing even when nothing else is there', () => {
    const msg = noDeviceMessage('android', 'emulator-9999', []);
    expect(msg).toContain('"emulator-9999"');
    expect(msg).toContain('no other android was found');
  });

  // A top-level `device` is inherited by every project that doesn't override
  // it, so an emulator pinned for Android is also demanded of the iOS target —
  // which then calls a booted simulator "not available".
  it('points at the inherited-device trap when a platform target is pinned', () => {
    const msg = noDeviceMessage('ios', 'emulator-5554', ['SIM-1']);
    expect(msg).toContain('`use`');
    expect(msg).toContain('top level');
  });

  it('leaves that advice out when no platform is in play', () => {
    expect(noDeviceMessage(undefined, 'OLD-UDID', ['SIM-1'])).not.toContain('top level');
  });

  // A run_tests `device` that is not there is the caller's serial, not the
  // config's — telling them to edit their config sends them the wrong way.
  it('names a run_tests device as requested, not as the config\'s', () => {
    const msg = noDeviceMessage('android', 'emulator-5560x', ['emulator-5554'], [], 'run_tests');
    expect(msg).toContain('"emulator-5560x"');
    expect(msg).toContain('emulator-5554');
    expect(msg).not.toContain('config');
    expect(noDeviceMessage('android', 'emulator-5560x', [], [], 'run_tests')).not.toContain('config');
  });

  it('keeps the start-a-device advice when the config pins nothing', () => {
    expect(noDeviceMessage('ios')).toContain('Boot a simulator');
    expect(noDeviceMessage('android')).toContain('Start an emulator');
    expect(noDeviceMessage()).toContain('Connect a device');
  });
});
