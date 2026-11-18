import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  test as tapsmithTest,
  describe as tapsmithDescribe,
  beforeAll as tapsmithBeforeAll,
  collectResults,
  runTestFile,
  _internal,
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

// ─── test.describe aliases (PILOT-544) ───

describe('test.describe', () => {
  it('is the same API as the bare describe', () => {
    expect(tapsmithTest.describe).toBe(tapsmithDescribe);
    expect(typeof tapsmithTest.describe.only).toBe('function');
    expect(typeof tapsmithTest.describe.skip).toBe('function');
    expect(typeof tapsmithTest.describe.serial).toBe('function');
    expect(typeof tapsmithTest.describe.serial.only).toBe('function');
    expect(typeof tapsmithTest.describe.configure).toBe('function');
  });

  it('is available on a test.extend() result', () => {
    const extended = tapsmithTest.extend<{ answer: number }>({
      answer: async ({}, use) => { await use(42); },
    });
    expect(extended.describe).toBe(tapsmithDescribe);
  });

  it('registers a suite whose tests run with a prefixed name', async () => {
    const result = await run(() => {
      tapsmithTest.describe('login', () => {
        tapsmithTest('works', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'login > works': 'passed' });
  });

  it('.only focuses the suite and .skip skips it', async () => {
    const result = await run(() => {
      tapsmithTest.describe('a', () => { tapsmithTest('t', async () => {}); });
      tapsmithTest.describe.only('b', () => { tapsmithTest('t', async () => {}); });
      tapsmithTest.describe.skip('c', () => { tapsmithTest('t', async () => {}); });
    });
    expect(statuses(result)).toEqual({ 'a > t': 'skipped', 'b > t': 'passed', 'c > t': 'skipped' });
  });

  it('rejects call shapes it does not support with a clear message', () => {
    pushContext();
    try {
      // Anonymous describe (Playwright allows a title-less group).
      expect(() => (tapsmithTest.describe as unknown as (fn: () => void) => void)(() => {}))
        .toThrow(/test\.describe\(\) needs a title/);
      // Playwright's (title, details, callback) form.
      expect(() => (tapsmithTest.describe as unknown as (t: string, d: object, fn: () => void) => void)('x', { tag: '@smoke' }, () => {}))
        .toThrow(/details object .* isn't supported yet/);
      expect(() => (tapsmithTest.describe as unknown as (t: string) => void)('x'))
        .toThrow(/test\.describe\('x'\) needs a callback/);
      expect(() => (tapsmithTest.describe.serial as unknown as (t: string) => void)('x'))
        .toThrow(/test\.describe\.serial\('x'\) needs a callback/);
    } finally {
      popContext();
    }
  });
});

// ─── Serial mode ───

describe('test.describe.serial', () => {
  it('skips the rest of the group after a failure, including nested describes', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('one', async () => {});
        tapsmithTest('two', async () => { throw new Error('boom'); });
        tapsmithTest('three', async () => {});
        tapsmithTest.describe('nested', () => {
          tapsmithTest('four', async () => {});
        });
      });
      tapsmithTest.describe('independent', () => {
        tapsmithTest('five', async () => {});
      });
    });
    expect(statuses(result)).toEqual({
      'flow > one': 'passed',
      'flow > two': 'failed',
      'flow > three': 'skipped',
      'flow > nested > four': 'skipped',
      'independent > five': 'passed',
    });
  });

  it('a failure in a nested describe skips the later tests of the enclosing group', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest.describe('first', () => {
          tapsmithTest('fails', async () => { throw new Error('boom'); });
        });
        tapsmithTest.describe('second', () => {
          tapsmithTest('after', async () => {});
        });
      });
    });
    expect(statuses(result)).toEqual({
      'flow > first > fails': 'failed',
      'flow > second > after': 'skipped',
    });
  });

  it('does not run the beforeAll of a nested describe that the failure skipped', async () => {
    const hook = vi.fn();
    await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('fails', async () => { throw new Error('boom'); });
        tapsmithTest.describe('later', () => {
          tapsmithBeforeAll(hook);
          tapsmithTest('t', async () => {});
        });
      });
    });
    expect(hook).not.toHaveBeenCalled();
  });

  it('a beforeAll failure inside the group skips the group\'s later suites', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest.describe('setup', () => {
          tapsmithBeforeAll(() => { throw new Error('setup broke'); });
          tapsmithTest('a', async () => {});
        });
        tapsmithTest.describe('after', () => {
          tapsmithTest('b', async () => {});
        });
      });
    });
    expect(statuses(result)).toEqual({ 'flow > setup > a': 'failed', 'flow > after > b': 'skipped' });
  });

  it('keeps going when a test passes on retry', async () => {
    let attempts = 0;
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('flaky', async () => { attempts++; if (attempts === 1) throw new Error('once'); });
        tapsmithTest('next', async () => {});
      });
    }, { config: makeConfig({ retries: 1 }) });
    expect(statuses(result)).toEqual({ 'flow > flaky': 'passed', 'flow > next': 'passed' });
  });

  it('reports the tests it skipped to the reporter', async () => {
    const ended: TestResult[] = [];
    await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('fails', async () => { throw new Error('boom'); });
        tapsmithTest('skipped test', async () => {});
        tapsmithTest.describe('nested', () => { tapsmithTest('skipped nested', async () => {}); });
      });
    }, { reporter: { onTestEnd: (r: TestResult) => { ended.push(r); } }, projectName: 'p', testFilePath: '/f.test.ts' });
    expect(ended.map((r) => [r.fullName, r.status, r.project, r.filePath])).toEqual([
      ['flow > fails', 'failed', 'p', '/f.test.ts'],
      ['flow > skipped test', 'skipped', 'p', '/f.test.ts'],
      ['flow > nested > skipped nested', 'skipped', 'p', '/f.test.ts'],
    ]);
  });

  it('a failure outside the group does not skip the group', async () => {
    const result = await run(() => {
      tapsmithTest('outside', async () => { throw new Error('boom'); });
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('inside', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ outside: 'failed', 'flow > inside': 'passed' });
  });

  it('.serial.only focuses the group', async () => {
    const result = await run(() => {
      tapsmithTest.describe('other', () => { tapsmithTest('t', async () => {}); });
      tapsmithTest.describe.serial.only('flow', () => { tapsmithTest('t', async () => {}); });
    });
    expect(statuses(result)).toEqual({ 'other > t': 'skipped', 'flow > t': 'passed' });
  });
});

// ─── describe.configure ───

describe('test.describe.configure', () => {
  it('mode: serial inside a describe makes that describe a serial group', async () => {
    const result = await run(() => {
      tapsmithTest.describe('flow', () => {
        tapsmithTest.describe.configure({ mode: 'serial' });
        tapsmithTest('fails', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'flow > fails': 'failed', 'flow > next': 'skipped' });
  });

  it('mode: default inside describe.serial turns serial mode off for it', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest.describe.configure({ mode: 'default' });
        tapsmithTest('fails', async () => { throw new Error('boom'); });
        tapsmithTest('next', async () => {});
      });
    });
    expect(statuses(result)).toEqual({ 'flow > fails': 'failed', 'flow > next': 'passed' });
  });

  it('a nested describe cannot leave an enclosing serial group', async () => {
    const result = await run(() => {
      tapsmithTest.describe.serial('flow', () => {
        tapsmithTest('fails', async () => { throw new Error('boom'); });
        tapsmithTest.describe('default', () => {
          tapsmithTest.describe.configure({ mode: 'default' });
          tapsmithTest('a', async () => {});
        });
        tapsmithTest.describe('parallel', () => {
          tapsmithTest.describe.configure({ mode: 'parallel' });
          tapsmithTest('b', async () => {});
        });
      });
    });
    expect(statuses(result)).toEqual({
      'flow > fails': 'failed',
      'flow > default > a': 'skipped',
      'flow > parallel > b': 'skipped',
    });
  });

  it('mode: parallel is accepted and runs the tests in order', async () => {
    const order: string[] = [];
    const result = await run(() => {
      tapsmithTest.describe('flow', () => {
        tapsmithTest.describe.configure({ mode: 'parallel' });
        tapsmithTest('a', async () => { order.push('a'); });
        tapsmithTest('b', async () => { order.push('b'); });
      });
    });
    expect(order).toEqual(['a', 'b']);
    expect(statuses(result)).toEqual({ 'flow > a': 'passed', 'flow > b': 'passed' });
  });

  it('retries applies to the describe scope', async () => {
    let attempts = 0;
    const result = await run(() => {
      tapsmithTest.describe('flow', () => {
        tapsmithTest.describe.configure({ retries: 2 });
        tapsmithTest('flaky', async () => { attempts++; if (attempts < 3) throw new Error('again'); });
      });
    });
    expect(attempts).toBe(3);
    expect(collectResults(result)[0]).toMatchObject({ status: 'passed', retry: 2 });
  });

  it('timeout applies to the describe scope like test.use({ timeout })', async () => {
    const mockDevice = {
      waitForIdle: vi.fn(async () => {}),
      _getDefaultTimeout: vi.fn(() => 30_000),
      _setDefaultTimeout: vi.fn(),
    };
    await run(() => {
      tapsmithTest.describe('flow', () => {
        tapsmithTest.describe.configure({ timeout: 90_000 });
        tapsmithTest('t', async () => {});
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused device timeout mock
    }, { devices: [{ name: 'device-1', device: mockDevice as any }] });
    expect(mockDevice._setDefaultTimeout).toHaveBeenCalledWith(90_000);
  });

  it('rejects invalid options with a message naming the API', () => {
    pushContext();
    try {
      const configure = tapsmithTest.describe.configure as (o: unknown) => void;
      expect(() => configure({ mode: 'sequential' }))
        .toThrow(/test\.describe\.configure\(\) mode must be one of 'default', 'parallel' or 'serial'/);
      expect(() => configure({ retries: -1 })).toThrow(/test\.describe\.configure\(\) retries must be a non-negative/);
      expect(() => configure({ timeout: 0 })).toThrow(/test\.describe\.configure\(\) timeout must be a positive/);
      expect(() => configure({ workers: 2 })).toThrow(/test\.describe\.configure\(\) does not support 'workers'/);
      expect(() => configure(undefined)).toThrow(/test\.describe\.configure\(\) takes an options object/);
    } finally {
      popContext();
    }
  });

  it('at the top of a file makes the whole file a serial group', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-describe-'));
    const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
    const file = path.join(dir, 'serial.test.mjs');
    fs.writeFileSync(file, [
      `import { test } from ${JSON.stringify(runnerUrl)};`,
      `test.describe.configure({ mode: 'serial' });`,
      `test('one', async () => { throw new Error('boom'); });`,
      `test.describe('later', () => { test('two', async () => {}); });`,
    ].join('\n'));
    try {
      const result = await runTestFile(pathToFileURL(file).href, makeOpts({ bustImportCache: true }));
      expect(statuses(result)).toEqual({ one: 'failed', 'later > two': 'skipped' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
