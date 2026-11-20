import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectResults, runTestFile, type RunOptions } from '../runner.js';
import type { TapsmithConfig } from '../config.js';
import { takeSoftErrors } from '../expect.js';

// A failed expect.soft() fails the test at its end, as in Playwright, even
// when the test read the failures itself with flushSoftErrors(): the runner
// keeps its own record, and the user's flush does not clear it.

function makeOpts(config: Partial<TapsmithConfig> = {}): RunOptions {
  return {
    config: {
      timeout: 30_000,
      retries: 0,
      screenshot: 'never',
      testMatch: [],
      daemonAddress: 'localhost:50051',
      rootDir: '/tmp',
      outputDir: 'out',
      workers: 1,
      launchEmulators: false,
      ...config,
    },
    devices: [],
    resetCapabilities: {},
    runMode: 'test',
    networkApisInRun: false,
  };
}

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
const expectUrl = pathToFileURL(path.resolve('src/expect.ts')).href;
let tempDir: string;

function writeFile(name: string, source: string): string {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(
    filePath,
    `import { test } from ${JSON.stringify(runnerUrl)};\n`
    + `import { expect, flushSoftErrors } from ${JSON.stringify(expectUrl)};\n${source}`,
  );
  return filePath;
}

async function run(source: string, config: Partial<TapsmithConfig> = {}) {
  const filePath = writeFile(`t${Math.random().toString(36).slice(2)}.test.mjs`, source);
  return collectResults(await runTestFile(filePath, makeOpts(config)));
}

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-soft-')));
  takeSoftErrors();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('runTestFile — soft assertion failures', () => {
  it('fails the test when a soft assertion failed', async () => {
    const [result] = await run(`
      test('soft', async () => { expect.soft(1).toBe(2); });
    `);

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe('1 soft assertion(s) failed:\nExpected 1 to be 2');
  });

  it('still fails the test after the test read the failures with flushSoftErrors()', async () => {
    const [result] = await run(`
      test('flushes and ignores', async () => {
        expect.soft(1).toBe(2);
        const errors = flushSoftErrors();
        if (errors.length !== 1) throw new Error('flush returned ' + errors.length);
        expect.soft(3).toBe(4);
      });
    `);

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      '2 soft assertion(s) failed:\nExpected 1 to be 2\nExpected 3 to be 4',
    );
  });

  it('keeps a hard failure as the headline and lists flushed soft failures after it', async () => {
    const [result] = await run(`
      test('both', async () => {
        expect.soft(1).toBe(2);
        flushSoftErrors();
        throw new Error('hard failure');
      });
    `);

    expect(result.status).toBe('failed');
    expect(result.error!.message).toBe(
      'hard failure\n\n--- Additionally ---\n1 soft assertion(s) failed:\nExpected 1 to be 2',
    );
  });

  it('passes when every soft assertion passed, flushed or not', async () => {
    const results = await run(`
      test('flushes', async () => {
        expect.soft(1).toBe(1);
        if (flushSoftErrors().length !== 0) throw new Error('unexpected soft errors');
      });
      test('does not flush', async () => { expect.soft(2).toBe(2); });
    `);

    expect(results.map((r) => r.status)).toEqual(['passed', 'passed']);
  });

  it("does not carry a test's soft failures, flushed or not, into the next test or a retry", async () => {
    const results = await run(`
      let attempt = 0;
      test('flaky', async () => {
        if (attempt++ === 0) { expect.soft(1).toBe(2); flushSoftErrors(); }
      });
      test('after it', async () => {
        if (flushSoftErrors().length !== 0) throw new Error('leaked soft errors');
      });
    `, { retries: 1 });

    expect(results.map((r) => [r.status, r.retry])).toEqual([['passed', 1], ['passed', undefined]]);
  });
});

describe('soft errors shared with another copy of the SDK', () => {
  // A global CLI and the project's own install can be different versions in
  // one process. Older copies keep the errors as an array on this key, push
  // to it, and replace it with an empty one when they flush.
  const LEGACY_KEY = Symbol.for('tapsmith.softErrors');
  const g = globalThis as unknown as Record<symbol, Error[]>;

  it('takes failures an older copy recorded, and gives an older runner the ones this copy recorded', async () => {
    const { expect: softExpect } = await import('../expect.js');
    g[LEGACY_KEY].push(new Error('from an older copy'));
    softExpect.soft(1).toBe(2);

    // An older runner's flush: read the array, then assign an empty one.
    const seenByOlderRunner = g[LEGACY_KEY];
    expect(seenByOlderRunner.map((e) => e.message)).toEqual(['from an older copy', 'Expected 1 to be 2']);
  });

  it('keeps failures an older copy\'s flush assigned away during the test, so this runner still fails the test', async () => {
    const { expect: softExpect } = await import('../expect.js');
    softExpect.soft(1).toBe(2);
    // The test calls an older copy's flushSoftErrors(), which empties the record by assignment.
    g[LEGACY_KEY] = [];
    g[LEGACY_KEY].push(new Error('after the older flush'));
    expect(takeSoftErrors().map((e) => e.message)).toEqual(['Expected 1 to be 2', 'after the older flush']);
    expect(takeSoftErrors()).toEqual([]);
  });

  it('starts flushSoftErrors() over when an older copy replaced the array', async () => {
    const { expect: softExpect, flushSoftErrors } = await import('../expect.js');
    softExpect.soft(1).toBe(2);
    softExpect.soft(3).toBe(4);
    expect(flushSoftErrors()).toHaveLength(2);
    g[LEGACY_KEY] = [new Error('recorded after an older flush')];
    expect(flushSoftErrors().map((e) => e.message)).toEqual(['recorded after an older flush']);
  });
});
