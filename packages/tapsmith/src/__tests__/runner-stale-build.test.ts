import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// PILOT-1398: when the app's source changed after the build a run tests, a
// failed test says so in its error (every run path shows the error), and a
// long-lived run path (UI mode, watch, MCP) warns on a test result once per
// edit, so MCP's run_tests lists it even when everything passes.

const mocks = vi.hoisted(() => ({ stale: [] as Array<import('../stale-build.js').StaleBuild>, configs: [] as unknown[], fresh: [] as Array<boolean | undefined> }));

vi.mock('../stale-build.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stale-build.js')>()),
  checkStaleBuilds: vi.fn(async (configs: unknown[], opts?: { fresh?: boolean }) => {
    mocks.configs.push(configs);
    mocks.fresh.push(opts?.fresh);
    return mocks.stale;
  }),
}));

const { collectResults, runTestFile } = await import('../runner.js');
const { resetStaleBuildChecks, staleBuildMessage } = await import('../stale-build.js');
type RunOptions = import('../runner.js').RunOptions;
type TapsmithConfig = import('../config.js').TapsmithConfig;

const STALE = {
  artifact: '/app/android/app/build/outputs/apk/release/app-release.apk',
  newest: '/app/src/app/todos.tsx',
  newestRelative: 'src/app/todos.tsx',
  count: 1,
  newestMtimeMs: 2000,
  buildMtimeMs: 1000,
};
const HINT = 'src/app/todos.tsx changed after app-release.apk was built. Tapsmith tests the installed build, not your source';

function makeConfig(): TapsmithConfig {
  return {
    timeout: 30_000, retries: 0, screenshot: 'never', testMatch: [], daemonAddress: 'localhost:50051',
    rootDir: '/tmp', outputDir: 'out', workers: 1, launchEmulators: false,
  };
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return { config: makeConfig(), devices: [], resetCapabilities: {}, runMode: 'test', networkApisInRun: false, ...overrides };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
let tempDir: string;

function writeTest(name: string, body: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, `import { test } from ${JSON.stringify(runnerUrl)};\n${body}`);
  return filePath;
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-stale-build-runner-')));
  mocks.stale = [STALE];
  mocks.configs = [];
  mocks.fresh = [];
  resetStaleBuildChecks();
});
afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }));

describe('runTestFile with a build older than the app source (PILOT-1398)', () => {
  it("adds the hint to a failed test's error, once", async () => {
    const file = writeTest('a.test.mjs', `
      test('fails', async () => { throw new Error('Expected element getByText("Jo\\'s Todos") to be visible'); });
    `);
    const [result] = collectResults(await runTestFile(file, makeOpts({ config: { ...makeConfig(), retries: 1 } })));
    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('to be visible\n\nNote: ' + HINT);
    expect(result.error?.message.split('Note: ').length).toBe(2);
  });

  it('adds it to every test a failed beforeAll fails', async () => {
    const file = writeTest('b.test.mjs', `
      test.beforeAll(async () => { throw new Error('login failed'); });
      test('one', async () => {});
      test('two', async () => {});
    `);
    const results = collectResults(await runTestFile(file, makeOpts()));
    expect(results.map((r) => r.status)).toEqual(['failed', 'failed']);
    for (const r of results) expect(r.error?.message).toMatch(/: login failed\n\nNote: /);
    for (const r of results) expect(r.error?.message.endsWith(`login failed\n\nNote: ${staleBuildMessage(STALE)}`)).toBe(true);
  });

  it('leaves a passing test alone in `tapsmith test`, which prints its own line before the run', async () => {
    const file = writeTest('c.test.mjs', "test('passes', async () => {});");
    const [result] = collectResults(await runTestFile(file, makeOpts({ runMode: 'test-parallel' })));
    expect(result.status).toBe('passed');
    expect(result.warnings).toBeUndefined();
  });

  it('warns on a passing test in UI mode, watch and MCP, once per edit', async () => {
    const file = writeTest('d.test.mjs', "test('passes', async () => {});\ntest('also passes', async () => {});");
    const first = collectResults(await runTestFile(file, makeOpts({ runMode: 'mcp' })));
    expect(first[0].warnings).toEqual([expect.stringContaining(HINT)]);
    expect(first[1].warnings).toBeUndefined();
    // The same edit again (the next file, the next run in a UI worker): said already.
    const again = collectResults(await runTestFile(writeTest('d2.test.mjs', "test('passes', async () => {});"), makeOpts({ runMode: 'ui' })));
    expect(again[0].warnings).toBeUndefined();
    // Another edit: said again.
    mocks.stale = [{ ...STALE, newestMtimeMs: 3000 }];
    // A UI worker outlives its runs: it never reuses an earlier answer.
    expect(mocks.fresh).toEqual([false, true]);
    const edited = collectResults(await runTestFile(writeTest('d3.test.mjs', "test('passes', async () => {});"), makeOpts({ runMode: 'watch' })));
    expect(edited[0].warnings).toEqual([expect.stringContaining(HINT)]);
  });

  it('says nothing when the build is current', async () => {
    mocks.stale = [];
    const file = writeTest('e.test.mjs', "test('fails', async () => { throw new Error('boom'); });");
    const [result] = collectResults(await runTestFile(file, makeOpts({ runMode: 'ui' })));
    expect(result.error?.message).toBe('boom');
    expect(result.warnings).toBeUndefined();
  });
});
