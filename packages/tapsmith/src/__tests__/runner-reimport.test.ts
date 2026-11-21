import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectResults,
  discoverTestFile,
  runTestFile,
  type RunOptions,
  type TestResult,
} from '../runner.js';
import type { TapsmithConfig } from '../config.js';

// PILOT-953: a test file imported a second time in one process — by a second
// project, a retry, a persistent parallel worker or a UI-mode rerun — must
// register its tests again. Node caches modules by URL, so a plain second
// import() returned the cached module: the second project registered no tests
// and the run reported green having never run it.

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

const runnerUrl = pathToFileURL(path.resolve('src/runner.ts')).href;
let tempDir: string | undefined;

function writeTestFile(name: string, source: string): string {
  tempDir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-reimport-')));
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

const TWO_TESTS = `
  import { test, describe } from ${JSON.stringify(runnerUrl)};
  test('first', async () => {});
  describe('group', () => {
    test('second', async () => {});
  });
`;

describe('runTestFile — the same file run again in one process (PILOT-953)', () => {
  it('runs and reports every project\'s tests when two projects run the same file', async () => {
    const filePath = writeTestFile('shared.test.mjs', TWO_TESTS);
    const ended: TestResult[] = [];
    const reporter = { onTestEnd: (r: TestResult): void => { ended.push(r); } };

    // Back to back, as the sequential CLI loop runs them: same file, same
    // devices, no retry — and fast enough to land in the same millisecond.
    const one = await runTestFile(filePath, makeOpts({ projectName: 'one', reporter }));
    const two = await runTestFile(filePath, makeOpts({ projectName: 'two', reporter }));

    expect(collectResults(one).map((r) => [r.project, r.fullName, r.status])).toEqual([
      ['one', 'first', 'passed'],
      ['one', 'group > second', 'passed'],
    ]);
    expect(collectResults(two).map((r) => [r.project, r.fullName, r.status])).toEqual([
      ['two', 'first', 'passed'],
      ['two', 'group > second', 'passed'],
    ]);
    // Reporters (list, JUnit, HTML) hear every result of both projects.
    expect(ended.map((r) => `${r.project}:${r.fullName}`)).toEqual([
      'one:first', 'one:group > second', 'two:first', 'two:group > second',
    ]);
  });

  it('re-registers the tests however the path is spelled (path, then file URL)', async () => {
    const filePath = writeTestFile('spelled.test.mjs', TWO_TESTS);
    await runTestFile(filePath, makeOpts());
    const again = await runTestFile(pathToFileURL(filePath).href, makeOpts());
    expect(collectResults(again)).toHaveLength(2);
  });

  it('re-executes the file body on every run, many times in a row', async () => {
    const counter = '__pilot953Imports';
    (globalThis as Record<string, unknown>)[counter] = 0;
    const filePath = writeTestFile('counted.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      globalThis.${counter}++;
      test('t', async () => {});
    `);
    try {
      for (let i = 0; i < 5; i++) {
        const suite = await runTestFile(filePath, makeOpts());
        expect(collectResults(suite)).toHaveLength(1);
      }
      expect((globalThis as Record<string, unknown>)[counter]).toBe(5);
    } finally {
      delete (globalThis as Record<string, unknown>)[counter];
    }
  });

  it('runs the file\'s tests after UI mode discovered it in the same process', async () => {
    const filePath = writeTestFile('discovered.test.mjs', TWO_TESTS);
    const discovered = await discoverTestFile(filePath);
    expect(discovered.tests.length + discovered.suites.length).toBe(2);
    const suite = await runTestFile(filePath, makeOpts());
    expect(collectResults(suite)).toHaveLength(2);
  });

  it('picks up an edit to the file between runs', async () => {
    const filePath = writeTestFile('edited.test.mjs', TWO_TESTS);
    await runTestFile(filePath, makeOpts());
    fs.writeFileSync(filePath, `
      import { test } from ${JSON.stringify(runnerUrl)};
      test('only one now', async () => {});
    `);
    const suite = await runTestFile(filePath, makeOpts());
    expect(collectResults(suite).map((r) => r.fullName)).toEqual(['only one now']);
  });

  it('fails the file, naming the cause, when tests an imported module registered do not register again', async () => {
    // Tests registered at the top level of a helper register only when the
    // helper first loads: the second project would silently lose them.
    writeTestFile('shared-suite.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      test('shared a', async () => {});
      test('shared b', async () => {});
    `);
    const filePath = writeTestFile('uses-shared.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      import './shared-suite.mjs';
      test('own', async () => {});
    `);
    const one = await runTestFile(filePath, makeOpts({ projectName: 'one' }));
    expect(collectResults(one).map((r) => r.fullName)).toEqual(['shared a', 'shared b', 'own']);

    const two = await runTestFile(filePath, makeOpts({ projectName: 'two' }));
    const [result, ...rest] = collectResults(two);
    expect(rest).toEqual([]);
    expect(result).toMatchObject({ status: 'failed', fileLevelFailure: true, project: 'two' });
    expect(result.error?.message).toMatch(
      /uses-shared\.test\.mjs imports shared-suite\.mjs, which declares tests at its top level/,
    );
  });

  it('runs a test file that another test file imported first', async () => {
    const imported = writeTestFile('imported.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      export const users = ['alice'];
      test('imported own', async () => {});
    `);
    const importer = writeTestFile('importer.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      import { users } from './imported.test.mjs';
      test('importer own ' + users.length, async () => {});
    `);
    await runTestFile(importer, makeOpts());
    const suite = await runTestFile(imported, makeOpts());
    expect(collectResults(suite).map((r) => r.fullName)).toEqual(['imported own']);
  });

  it('discovers a test file that another test file imported first', async () => {
    const imported = writeTestFile('imported-d.test.mjs', `
      import { test } from ${JSON.stringify(runnerUrl)};
      test('only here', async () => {});
    `);
    const importer = writeTestFile('importer-d.test.mjs', `
      import './imported-d.test.mjs';
    `);
    await discoverTestFile(importer);
    const discovered = await discoverTestFile(imported);
    expect(discovered.tests.map((t) => t.name)).toEqual(['only here']);
  });

  it('reports an emptied file as empty, not as a stale import', async () => {
    const filePath = writeTestFile('emptied.test.mjs', TWO_TESTS);
    await runTestFile(filePath, makeOpts());
    // A later mtime: the user deleted every test from the file.
    fs.writeFileSync(filePath, `import { test } from ${JSON.stringify(runnerUrl)};\n`);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(filePath, later, later);
    const suite = await runTestFile(filePath, makeOpts());
    expect(collectResults(suite)).toEqual([]);
  });
});
