import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  test as tapsmithTest,
  beforeAll as tapsmithBeforeAll,
  afterAll as tapsmithAfterAll,
  beforeEach as tapsmithBeforeEach,
  afterEach as tapsmithAfterEach,
  collectResults,
  discoverTestFile,
  runTestFile,
  _internal,
  type DiscoveredSuite,
  type RunOptions,
  type SuiteResult,
  type TestResult,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';

const { pushContext, popContext, runSuiteContext } = _internal;

function makeConfig(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'never',
    testMatch: [],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp',
    outputDir: 'out',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function makeOpts(overrides: Partial<RunOptions> = {}): RunOptions {
  return { config: makeConfig(), devices: [], resetCapabilities: {}, runMode: 'test', networkApisInRun: false, ...overrides };
}

function statuses(result: SuiteResult): Record<string, string> {
  return Object.fromEntries(collectResults(result).map((t) => [t.fullName, t.status]));
}

async function run(register: () => void, overrides: Partial<RunOptions> = {}): Promise<SuiteResult> {
  pushContext();
  register();
  const ctx = popContext();
  return runSuiteContext(ctx, '', [], [], makeOpts(overrides));
}

/** Loosely-typed handle for call shapes the TypeScript overloads reject. */
const looseSkip = tapsmithTest.skip as unknown as (...args: unknown[]) => void;

// ─── Declaring a skipped test ───

describe('test.skip(title, fn)', () => {
  it('declares a skipped test that never runs', async () => {
    const body = vi.fn();
    const result = await run(() => {
      tapsmithTest.skip('broken', body);
      tapsmithTest('works', async () => {});
    });
    expect(statuses(result)).toEqual({ broken: 'skipped', works: 'passed' });
    expect(body).not.toHaveBeenCalled();
  });
});

// ─── Describe / file level (PILOT-546) ───

describe('test.skip(condition) in a describe', () => {
  it('skips every test in the scope, with no phantom test named after the condition', async () => {
    const body = vi.fn();
    const result = await run(() => {
      tapsmithTest.describe('ci-only', () => {
        tapsmithTest.skip(true, 'only runs on CI');
        tapsmithTest('should be skipped locally', body);
      });
    });
    expect(statuses(result)).toEqual({ 'ci-only > should be skipped locally': 'skipped' });
    expect(body).not.toHaveBeenCalled();
  });

  it('runs the scope normally when the condition is falsy', async () => {
    const result = await run(() => {
      tapsmithTest.describe('ci-only', () => {
        tapsmithTest.skip(false, 'only runs on CI');
        tapsmithTest('runs', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'ci-only > runs': 'passed' });
  });

  it('treats any truthy value as the condition, like Playwright', async () => {
    const result = await run(() => {
      tapsmithTest.describe('a', () => {
        looseSkip('1', 'env var set');
        tapsmithTest('t', async () => { throw new Error('ran'); });
      });
      tapsmithTest.describe('b', () => {
        looseSkip(undefined, 'env var unset');
        tapsmithTest('t', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'a > t': 'skipped', 'b > t': 'passed' });
  });

  it('a bare test.skip() skips the scope', async () => {
    const result = await run(() => {
      tapsmithTest.describe('wip', () => {
        tapsmithTest('t', async () => { throw new Error('ran'); });
        tapsmithTest.skip();
      });
    });
    expect(statuses(result)).toEqual({ 'wip > t': 'skipped' });
  });

  it('also skips tests declared before the call and nested describes, but not sibling scopes', async () => {
    const result = await run(() => {
      tapsmithTest.describe('skipped', () => {
        tapsmithTest('before', async () => { throw new Error('ran'); });
        tapsmithTest.skip(true);
        tapsmithTest.describe('nested', () => {
          tapsmithTest('deep', async () => { throw new Error('ran'); });
        });
      });
      tapsmithTest.describe('sibling', () => {
        tapsmithTest('runs', async () => {});
      });
    });
    expect(statuses(result)).toEqual({
      'skipped > before': 'skipped',
      'skipped > nested > deep': 'skipped',
      'sibling > runs': 'passed',
    });
  });

  it('runs none of the scope hooks', async () => {
    const hook = vi.fn();
    await run(() => {
      tapsmithTest.describe('skipped', () => {
        tapsmithTest.skip(true);
        tapsmithBeforeAll(hook);
        tapsmithBeforeEach(hook);
        tapsmithAfterEach(hook);
        tapsmithAfterAll(hook);
        tapsmithTest('t', async () => {});
      });
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it('reports each skipped test, nested ones included', async () => {
    const ended: TestResult[] = [];
    await run(() => {
      tapsmithTest.describe('skipped', () => {
        tapsmithTest.skip(true);
        tapsmithTest('a', async () => {});
        tapsmithTest.describe('nested', () => { tapsmithTest('b', async () => {}); });
      });
    }, { reporter: { onTestEnd: (r: TestResult) => { ended.push(r); } } });
    expect(ended.map((r) => [r.fullName, r.status])).toEqual([
      ['skipped > a', 'skipped'],
      ['skipped > nested > b', 'skipped'],
    ]);
  });

  it('works on a test.extend() result', async () => {
    const extended = tapsmithTest.extend<{ answer: number }>({
      answer: async ({}, use) => { await use(42); },
    });
    const result = await run(() => {
      tapsmithTest.describe('skipped', () => {
        extended.skip(true, 'reason');
        extended('t', async ({ answer }) => { throw new Error(`ran ${answer}`); });
      });
    });
    expect(statuses(result)).toEqual({ 'skipped > t': 'skipped' });
  });

  it('at the top of a file skips the whole file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-skip-'));
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const file = path.join(dir, 'skip.test.mjs');
    fs.writeFileSync(file, [
      `import { test } from ${JSON.stringify(runnerUrl)};`,
      `test.skip(true, 'not on this platform');`,
      `test('one', async () => { throw new Error('ran'); });`,
      `test.describe('group', () => { test('two', async () => { throw new Error('ran'); }); });`,
    ].join('\n'));
    try {
      // UI mode's discovery shows them as skipped too. (A copy: both calls
      // cache-bust the import by timestamp, and within one millisecond the
      // second would get a cached module that registers nothing.)
      const copy = path.join(dir, 'skip-copy.test.mjs');
      fs.copyFileSync(file, copy);
      const discovered = await discoverTestFile(pathToFileURL(copy).href);
      const skips = (s: DiscoveredSuite): boolean[] => [...s.tests.map((t) => t.skip), ...s.suites.flatMap(skips)];
      expect(skips(discovered)).toEqual([true, true]);
      const result = await runTestFile(pathToFileURL(file).href, makeOpts({ bustImportCache: true }));
      expect(statuses(result)).toEqual({ one: 'skipped', 'group > two': 'skipped' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('at the top of a file sets up no worker fixture; a skip inside one is refused', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-skip-'));
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const write = (name: string, skipLine: string, fixtureBody: string): string => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, [
        `import { test as base } from ${JSON.stringify(runnerUrl)};`,
        `const test = base.extend({ backend: [async ({}, use) => { ${fixtureBody} await use(1); }, { scope: 'worker' }] });`,
        skipLine,
        `test('one', async ({ backend }) => { throw new Error('ran ' + backend); });`,
      ].join('\n'));
      return pathToFileURL(file).href;
    };
    try {
      const unreachable = write('a.test.mjs', `test.skip(true, 'needs the CI backend');`, `throw new Error('backend unreachable');`);
      expect(statuses(await runTestFile(unreachable, makeOpts({ bustImportCache: true })))).toEqual({ one: 'skipped' });
      const skipsInFixture = write('b.test.mjs', '', `test.skip(true, 'no backend');`);
      await expect(runTestFile(skipsInFixture, makeOpts({ bustImportCache: true })))
        .rejects.toThrow(/test\.skip\(\) isn't supported in a worker-scoped fixture yet/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a declaration with a missing function does not skip its scope', async () => {
    const result = await run(() => {
      tapsmithTest.describe('group', () => {
        try { looseSkip('slow flow', undefined); } catch { /* refused, as asserted below */ }
        tapsmithTest('runs', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'group > runs': 'passed' });
  });

  it('refuses call shapes it does not support with a clear message', () => {
    pushContext();
    try {
      expect(() => looseSkip(() => true, 'reason'))
        .toThrow(/test\.skip\(callback\) isn't supported yet.*test\.skip\(condition, description\) inside the test/);
      expect(() => looseSkip('title', { tag: '@slow' }, async () => {}))
        .toThrow(/test\.skip\('title', details, callback\): the details object .* isn't supported yet/);
      // A declaration whose function is missing must not skip the whole scope.
      expect(() => looseSkip('slow flow', undefined)).toThrow(/test\.skip\('slow flow', …\) needs a test function.*Got undefined/);
      expect(() => looseSkip('slow flow', null)).toThrow(/needs a test function.*Got null/);
      // A computed title that is not a string must neither drop the test nor skip the scope.
      expect(() => looseSkip(undefined, async () => {})).toThrow(/test\.skip\(title, fn\) needs a string title \(got undefined\)/);
      expect(() => looseSkip(true, async () => {})).toThrow(/needs a string title \(got boolean\)/);
    } finally {
      popContext();
    }
  });
});

// ─── Inside a running test (PILOT-546) ───

describe('test.skip() inside a test', () => {
  it('marks the running test skipped and stops it', async () => {
    const after = vi.fn();
    const result = await run(() => {
      tapsmithTest('x', async () => {
        tapsmithTest.skip(true, 'reason');
        after();
      });
      tapsmithTest('bare', async () => {
        tapsmithTest.skip();
        after();
      });
      tapsmithTest('next', async () => {});
    });
    expect(statuses(result)).toEqual({ x: 'skipped', bare: 'skipped', next: 'passed' });
    const x = collectResults(result).find((t) => t.fullName === 'x');
    expect(x?.error).toBeUndefined();
    expect(after).not.toHaveBeenCalled();
  });

  // UI mode and the headless MCP run one test or group through a testFilter
  // and report every result the runner sends: the filter must drop only the
  // tests it excludes, never a selected test that skipped itself (PILOT-546,
  // PILOT-569).
  it('reports a selected test that skips itself under a test filter, and nothing for the rest', async () => {
    const result = await run(() => {
      tapsmithTest.describe('share', () => {
        tapsmithTest('sheet', async () => { tapsmithTest.skip(); });
        tapsmithTest('link', async () => {});
      });
      tapsmithTest('other', async () => {});
    }, { testFilter: 'share' });
    expect(statuses(result)).toEqual({ 'share > sheet': 'skipped', 'share > link': 'passed' });
  });

  it('reports the selected tests of a scope whose beforeAll skips it under a test filter', async () => {
    const result = await run(() => {
      tapsmithTest.describe('share', () => {
        tapsmithBeforeAll(async () => { tapsmithTest.skip(); });
        tapsmithTest('sheet', async () => {});
        tapsmithTest('link', async () => {});
      });
    }, { testFilter: 'sheet' });
    expect(statuses(result)).toEqual({ 'share > sheet': 'skipped' });
  });

  it('carries on when the condition is falsy', async () => {
    const after = vi.fn();
    const result = await run(() => {
      tapsmithTest('x', async () => {
        tapsmithTest.skip(false, 'reason');
        after();
      });
    });
    expect(statuses(result)).toEqual({ x: 'passed' });
    expect(after).toHaveBeenCalledOnce();
  });

  it('can be decided from a fixture value', async () => {
    const result = await run(() => {
      tapsmithTest('android only', async ({ platform }) => {
        tapsmithTest.skip(platform !== 'ios', 'iOS only');
        throw new Error('ran');
      });
    });
    expect(statuses(result)).toEqual({ 'android only': 'skipped' });
  });

  it('still runs afterEach hooks, and reports one skipped result', async () => {
    const afterEachHook = vi.fn();
    const ended: TestResult[] = [];
    await run(() => {
      tapsmithAfterEach(afterEachHook);
      tapsmithTest('x', async () => { tapsmithTest.skip(); });
    }, { reporter: { onTestEnd: (r: TestResult) => { ended.push(r); } } });
    expect(afterEachHook).toHaveBeenCalledOnce();
    expect(ended.map((r) => r.status)).toEqual(['skipped']);
  });

  it('is not retried', async () => {
    const body = vi.fn(async () => { tapsmithTest.skip(); });
    const result = await run(() => {
      tapsmithTest('x', body);
    }, { config: makeConfig({ retries: 2 }) });
    expect(statuses(result)).toEqual({ x: 'skipped' });
    expect(body).toHaveBeenCalledOnce();
  });

  it('on a retry after a failed attempt still reports the failure', async () => {
    let attempt = 0;
    const result = await run(() => {
      tapsmithTest('x', async () => {
        if (attempt++ === 0) throw new Error('first attempt failed');
        tapsmithTest.skip(true, 'backend went away');
      });
    }, { config: makeConfig({ retries: 1 }) });
    const x = collectResults(result)[0];
    expect(x.status).toBe('failed');
    expect(x.error?.message).toBe('first attempt failed');
  });

  it('does not stop a serial group', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('one', async () => { tapsmithTest.skip(); });
        tapsmithTest('two', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'flow > one': 'skipped', 'flow > two': 'passed' });
  });

  it('in beforeEach skips that test only', async () => {
    const body = vi.fn();
    const result = await run(() => {
      tapsmithBeforeEach(async () => { tapsmithTest.skip(true); });
      tapsmithTest('x', body);
    });
    expect(statuses(result)).toEqual({ x: 'skipped' });
    expect(body).not.toHaveBeenCalled();
  });

  it('in a test-scoped fixture skips the test', async () => {
    const extended = tapsmithTest.extend<{ needsIos: void }>({
      needsIos: async ({}, use) => { tapsmithTest.skip(true, 'iOS only'); await use(); },
    });
    const result = await run(() => {
      extended('x', async ({ needsIos }) => { void needsIos; throw new Error('ran'); });
    });
    expect(statuses(result)).toEqual({ x: 'skipped' });
  });

  it('in afterEach marks a passed test skipped', async () => {
    const result = await run(() => {
      tapsmithAfterEach(async () => { tapsmithTest.skip(); });
      tapsmithTest('x', async () => {});
    });
    expect(statuses(result)).toEqual({ x: 'skipped' });
  });

  it('in afterEach keeps a failed test failed', async () => {
    const result = await run(() => {
      tapsmithAfterEach(async () => { tapsmithTest.skip(); });
      tapsmithTest('x', async () => { throw new Error('boom'); });
    });
    expect(statuses(result)).toEqual({ x: 'failed' });
  });

  it('in beforeAll skips every test of the scope', async () => {
    const body = vi.fn();
    const result = await run(() => {
      tapsmithTest.describe('group', () => {
        tapsmithBeforeAll(async () => { tapsmithTest.skip(true, 'backend down'); });
        tapsmithTest('a', body);
        tapsmithTest.describe('nested', () => { tapsmithTest('b', body); });
      });
      tapsmithTest('outside', async () => {});
    });
    expect(statuses(result)).toEqual({
      'group > a': 'skipped',
      'group > nested > b': 'skipped',
      outside: 'passed',
    });
    expect(body).not.toHaveBeenCalled();
  });

  it('in beforeAll still runs the scope afterAll hooks', async () => {
    const cleanup = vi.fn();
    const result = await run(() => {
      tapsmithTest.describe('group', () => {
        tapsmithBeforeAll(async () => { /* creates a backend account */ });
        tapsmithBeforeAll(async () => { tapsmithTest.skip(true, 'flag off'); });
        tapsmithAfterAll(cleanup);
        tapsmithTest('a', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'group > a': 'skipped' });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('is recognised when thrown by another copy of the runner module (CommonJS projects)', async () => {
    // A CJS user project loads its own instance of runner.js, so the skip it
    // throws is not an instance of this module's class.
    const foreignSkip = Object.assign(new Error('Test skipped'), { [Symbol.for('tapsmith.TestSkipError')]: true });
    const result = await run(() => {
      tapsmithTest('x', async () => { throw foreignSkip; });
    });
    expect(statuses(result)).toEqual({ x: 'skipped' });
  });

  it('in afterAll is ignored rather than reported as a hook error', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await run(() => {
        tapsmithAfterAll(async () => { tapsmithTest.skip(); });
        tapsmithTest('x', async () => {});
      });
      expect(statuses(result)).toEqual({ x: 'passed' });
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).not.toMatch(/afterAll hook error/);
    } finally {
      stderr.mockRestore();
    }
  });

  it('refuses the callback form', async () => {
    const result = await run(() => {
      tapsmithTest('x', async () => { looseSkip(() => true); });
    });
    const x = collectResults(result)[0];
    expect(x.status).toBe('failed');
    expect(x.error?.message).toMatch(/test\.skip\(callback\) isn't supported yet/);
  });
});
