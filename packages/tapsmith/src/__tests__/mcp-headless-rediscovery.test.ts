import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TapsmithConfig } from '../config.js';
import type { TestTreeEntry } from '../mcp/test-dispatcher.js';
import type { TestTreeNode } from '../ui-mode/ui-protocol.js';

// PILOT-836: the headless MCP server globbed its test files once, on the first
// call that needed the session. An agent that wrote a test after a device tool
// (snapshot → write the file → run it) could neither list nor run it:
// `run_tests` answered "matched no discovered test file" for a file that was
// plainly there. Every test-management call now brings the files up to date
// with the disk first.

vi.mock('../mcp/connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mcp/connection.js')>();
  return {
    ...actual,
    ensurePlatformTarget: async (config: TapsmithConfig) => ({
      address: '127.0.0.1:50100',
      deviceSerial: config.device ?? 'emulator-5556',
      platform: config.platform,
    }),
    platformTargetIsLive: async () => true,
  };
});

const { HeadlessTestDispatcher } = await import('../mcp/headless-dispatcher.js');

/** The SDK entry the test files import, so discovery children register into the same module. */
const SDK_ENTRY = path.resolve(import.meta.dirname, '..', 'index.ts');

interface Internals {
  _fileNodes: Map<string, TestTreeNode>
}

const testNames = (entries: TestTreeEntry[]): string[] => entries.flatMap((e) =>
  e.type === 'test' ? [e.fullName] : testNames(e.children ?? []));

describe('headless MCP rediscovers test files (PILOT-836)', () => {
  let root: string;
  let originalCwd: string;

  function writeTest(name: string, tests: string[]): string {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `import { test } from ${JSON.stringify(SDK_ENTRY)};\n`
      + tests.map((t) => `test(${JSON.stringify(t)}, async () => {});\n`).join(''));
    return file;
  }

  /** Move a file's mtime on, so a rewrite within the same clock tick still counts as a change. */
  function touchLater(file: string): void {
    const later = new Date(fs.statSync(file).mtimeMs + 5_000);
    fs.utimesSync(file, later, later);
  }

  function dispatcher(config = 'export default { platform: "android", package: "com.x", testMatch: ["**/*.test.ts"] }\n'): InstanceType<typeof HeadlessTestDispatcher> {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), config);
    return new HeadlessTestDispatcher({ configFile: path.join(root, 'tapsmith.config.mjs') });
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-rediscover-')));
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finds a file written after a device tool prepared the session', async () => {
    const first = writeTest('a.test.ts', ['first']);
    const d = dispatcher();
    // A device tool (snapshot, launch_app) prepares the session first.
    await d.ensureDevicesReady();

    const added = writeTest('tests/new.test.ts', ['the new test']);
    await d.refreshTestFiles();

    expect(d.getTestFiles()).toEqual([first, added]);
    expect(testNames(d.getTestTree())).toEqual(['first', 'the new test']);
    expect(d.resolveRequestedFiles(['tests/new.test.ts'])).toEqual([added]);
  }, 60_000);

  it('finds a file written after the test list was first read', async () => {
    writeTest('a.test.ts', ['first']);
    const d = dispatcher();
    await d.refreshTestFiles();
    expect(testNames(d.getTestTree())).toEqual(['first']);

    writeTest('b.test.ts', ['second']);
    await d.refreshTestFiles();
    expect(testNames(d.getTestTree())).toEqual(['first', 'second']);
  }, 60_000);

  it('picks up a test added to an existing file, and re-discovers only the files that changed', async () => {
    const a = writeTest('a.test.ts', ['first']);
    writeTest('b.test.ts', ['second']);
    const d = dispatcher();
    await d.refreshTestFiles();
    const before = new Map((d as unknown as Internals)._fileNodes);

    writeTest('a.test.ts', ['first', 'another']);
    touchLater(a);
    await d.refreshTestFiles();

    expect(testNames(d.getTestTree())).toEqual(['first', 'another', 'second']);
    const after = (d as unknown as Internals)._fileNodes;
    expect(after.get(a)).not.toBe(before.get(a));
    // Untouched: not forked again, so a large suite pays only for what changed.
    expect(after.get(path.join(root, 'b.test.ts'))).toBe(before.get(path.join(root, 'b.test.ts')));
  }, 60_000);

  it('drops a deleted file from the list and from what a run can match', async () => {
    writeTest('a.test.ts', ['first']);
    const b = writeTest('b.test.ts', ['second']);
    const d = dispatcher();
    await d.refreshTestFiles();

    fs.rmSync(b);
    await d.refreshTestFiles();

    expect(d.getTestFiles()).toEqual([path.join(root, 'a.test.ts')]);
    expect(testNames(d.getTestTree())).toEqual(['first']);
    expect(d.resolveRequestedFiles([b])).toEqual([]);
  }, 60_000);

  it('stops reporting a load failure once the file is fixed', async () => {
    const broken = path.join(root, 'broken.test.ts');
    fs.writeFileSync(broken, 'import "./does-not-exist.js";\n');
    const d = dispatcher();
    await d.refreshTestFiles();
    expect(d.getDiscoveryErrors().map((e) => e.filePath)).toEqual([broken]);

    writeTest('broken.test.ts', ['fixed']);
    touchLater(broken);
    await d.refreshTestFiles();

    expect(d.getDiscoveryErrors()).toEqual([]);
    expect(testNames(d.getTestTree())).toEqual(['fixed']);
  }, 60_000);

  it('clears a load failure fixed in a module the test imports', async () => {
    const helper = path.join(root, 'screens', 'cart.ts');
    fs.mkdirSync(path.dirname(helper));
    fs.writeFileSync(helper, 'throw new Error("broken screen object");\n');
    const file = path.join(root, 'cart.test.ts');
    fs.writeFileSync(file, `import ${JSON.stringify(helper)};\nimport { test } from ${JSON.stringify(SDK_ENTRY)};\ntest("adds an item", async () => {});\n`);
    const d = dispatcher();
    await d.refreshTestFiles();
    expect(d.getDiscoveryErrors().map((e) => e.filePath)).toEqual([file]);

    // Only the helper changes: the test file's own stamp does not move.
    fs.writeFileSync(helper, 'export {};\n');
    await d.refreshTestFiles();

    expect(d.getDiscoveryErrors()).toEqual([]);
    expect(testNames(d.getTestTree())).toEqual(['adds an item']);
  }, 60_000);

  it('discovers the first file of a session that started with none', async () => {
    const d = dispatcher();
    await d.refreshTestFiles();
    expect(d.getTestTree()).toEqual([]);

    writeTest('a.test.ts', ['first']);
    await d.refreshTestFiles();
    expect(testNames(d.getTestTree())).toEqual(['first']);
  }, 60_000);

  it('updates each project\'s files, so a new file routes to its project', async () => {
    const d = dispatcher(
      'export default { package: "com.x", projects: ['
      + '{ name: "android", testMatch: ["android/**/*.test.ts"], use: { platform: "android" } },'
      + '{ name: "ios", testMatch: ["ios/**/*.test.ts"], use: { platform: "ios" } },'
      + '] }\n',
    );
    writeTest('android/a.test.ts', ['on android']);
    await d.refreshTestFiles();

    const added = writeTest('ios/b.test.ts', ['on ios']);
    await d.refreshTestFiles();

    const projects = d.getSessionInfo().projects;
    expect(projects.find((p) => p.name === 'ios')?.testFiles).toEqual([added]);
    expect(projects.find((p) => p.name === 'android')?.testFiles).toEqual([path.join(root, 'android/a.test.ts')]);
    expect(d.getTestTree().map((e) => e.name)).toEqual(['android', 'ios']);
  }, 60_000);

  it('gives a caller arriving during a refresh one that sees its file', async () => {
    writeTest('a.test.ts', ['first']);
    const d = dispatcher();
    await d.refreshTestFiles();

    const inFlight = d.refreshTestFiles();
    // Written after that refresh began globbing: only a later pass can see it.
    const added = writeTest('b.test.ts', ['second']);
    const mine = d.refreshTestFiles();
    await Promise.all([inFlight, mine]);

    expect(d.getTestFiles()).toContain(added);
  }, 60_000);

  it('marks a run refused because another is under way', async () => {
    const file = writeTest('a.test.ts', ['first']);
    const d = dispatcher();
    await d.ensureDevicesReady();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const internals = d as unknown as {
      _runFileInChild(file: string): Promise<{ results: unknown[]; suite: { durationMs: number } }>
    };
    internals._runFileInChild = async () => {
      await gate;
      return { results: [{ status: 'passed' }], suite: { durationMs: 1 } };
    };
    const first = d.runFiles([file]);
    // Behind the session's first discovery child, which a loaded CI runner
    // takes well over vi.waitFor's 1 s default to fork.
    await vi.waitFor(() => expect(d.isRunning()).toBe(true), { timeout: 30_000 });
    const second = await d.runFiles([file]);
    expect(second.busy).toBe(true);
    release();
    expect((await first).busy).toBeUndefined();
  }, 60_000);

  it('runs a file written mid-session', async () => {
    const d = dispatcher();
    await d.ensureDevicesReady();
    const added = writeTest('new.test.ts', ['the new test']);
    const ran: string[] = [];
    const internals = d as unknown as {
      _runFileInChild(file: string): Promise<{ results: unknown[]; suite: { durationMs: number } }>
    };
    internals._runFileInChild = async (file: string) => {
      ran.push(file);
      return { results: [{ status: 'passed' }], suite: { durationMs: 1 } };
    };

    const result = await d.runFiles([added]);
    expect(ran).toEqual([added]);
    expect(result.status).toBe('passed');
  }, 60_000);
});
