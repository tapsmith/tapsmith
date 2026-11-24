import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { JUnitReporter } from '../reporters/junit.js';
import { BlobReporter, mergeBlobs } from '../reporters/blob.js';
import type { FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
import type { SuiteResult, TestResult } from '../runner.js';

let tmpDir: string;
let rootDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-junit-')));
  rootDir = path.join(tmpDir, 'project');
  fs.mkdirSync(rootDir, { recursive: true });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function config(overrides: Partial<TapsmithConfig> = {}): TapsmithConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir,
    outputDir: 'tapsmith-results',
    workers: 1,
    launchEmulators: false,
    ...overrides,
  };
}

function test(fullName: string, overrides: Partial<TestResult> = {}): TestResult {
  const parts = fullName.split(' > ');
  return {
    name: parts[parts.length - 1],
    fullName,
    status: 'passed',
    durationMs: 1500,
    filePath: path.join(rootDir, 'tests', 'login.test.ts'),
    ...overrides,
  };
}

/** A file's root suite (name ''), as the runner builds it. */
function fileSuite(tests: TestResult[], nested: SuiteResult[] = []): SuiteResult {
  return { name: '', tests, suites: nested, durationMs: 2000 };
}

function result(suites: SuiteResult[]): FullResult {
  const flatten = (s: SuiteResult): TestResult[] => [...s.tests, ...s.suites.flatMap(flatten)];
  const tests = suites.flatMap(flatten);
  return {
    status: tests.some((t) => t.status === 'failed') ? 'failed' : 'passed',
    duration: 5000,
    tests,
    suites,
  };
}

async function writeJUnit(full: FullResult, options: Record<string, unknown> = {}): Promise<Document> {
  const reporter = new JUnitReporter({ outputFile: 'out/results.xml', ...options });
  reporter.onRunStart(config(), 1);
  await reporter.onRunEnd(full);
  const xml = fs.readFileSync(path.join(rootDir, 'out/results.xml'), 'utf-8');
  const doc = new JSDOM(xml, { contentType: 'text/xml' }).window.document;
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

const suitesOf = (doc: Document): Element[] => [...doc.getElementsByTagName('testsuite')];
const casesOf = (el: Document | Element): Element[] => [...el.getElementsByTagName('testcase')];

describe('JUnitReporter suite and case names', () => {
  it('names each <testsuite> and every classname after its file, relative to rootDir', async () => {
    const login = path.join(rootDir, 'tests', 'login.test.ts');
    const cart = path.join(rootDir, 'tests', 'shop', 'cart.test.ts');
    const doc = await writeJUnit(result([
      fileSuite([test('signs in', { filePath: login })], [
        { name: 'Login', durationMs: 10, suites: [], tests: [test('Login > shows an error', { filePath: login })] },
      ]),
      fileSuite([test('adds an item', { filePath: cart })]),
    ]));

    expect(suitesOf(doc).map((s) => s.getAttribute('name'))).toEqual(['tests/login.test.ts', 'tests/shop/cart.test.ts']);
    expect(casesOf(doc).map((c) => [c.getAttribute('classname'), c.getAttribute('name')])).toEqual([
      ['tests/login.test.ts', 'signs in'],
      ['tests/login.test.ts', 'Login > shows an error'],
      ['tests/shop/cart.test.ts', 'adds an item'],
    ]);
  });

  it('keeps a file outside rootDir relative to it', async () => {
    const doc = await writeJUnit(result([
      fileSuite([test('t', { filePath: path.join(tmpDir, 'shared', 'a.test.ts') })]),
    ]));
    expect(suitesOf(doc)[0].getAttribute('name')).toBe('../shared/a.test.ts');
  });

  it('omits a file suite with no tests', async () => {
    const doc = await writeJUnit(result([fileSuite([]), fileSuite([test('t')])]));
    expect(suitesOf(doc)).toHaveLength(1);
  });

  it('counts, times and stamps each suite as Playwright does', async () => {
    const doc = await writeJUnit(result([fileSuite([
      test('a', { durationMs: 1000 }),
      test('b', { durationMs: 500, status: 'failed', error: new Error('boom') }),
      test('c', { durationMs: 0, status: 'skipped' }),
    ])]));
    const suite = suitesOf(doc)[0];
    expect(suite.getAttribute('tests')).toBe('3');
    expect(suite.getAttribute('failures')).toBe('1');
    expect(suite.getAttribute('skipped')).toBe('1');
    expect(suite.getAttribute('errors')).toBe('0');
    expect(suite.getAttribute('time')).toBe('1.500');
    expect(Number.isNaN(Date.parse(suite.getAttribute('timestamp') ?? ''))).toBe(false);
    const root = doc.documentElement;
    expect(root.tagName).toBe('testsuites');
    expect(root.getAttribute('tests')).toBe('3');
    expect(root.getAttribute('failures')).toBe('1');
  });

  it('with one project, names the project as the suite hostname and leaves test names alone', async () => {
    const doc = await writeJUnit(result([fileSuite([test('signs in', { project: 'android' })])]));
    expect(suitesOf(doc)[0].getAttribute('hostname')).toBe('android');
    expect(casesOf(doc)[0].getAttribute('name')).toBe('signs in');
  });

  it('with several projects, prefixes each test name with its project so the copies stay apart', async () => {
    const doc = await writeJUnit(result([
      fileSuite([test('Login > signs in', { project: 'android' })]),
      fileSuite([test('Login > signs in', { project: 'ios' })]),
    ]));
    expect(suitesOf(doc).map((s) => [s.getAttribute('name'), s.getAttribute('hostname')])).toEqual([
      ['tests/login.test.ts', 'android'],
      ['tests/login.test.ts', 'ios'],
    ]);
    expect(casesOf(doc).map((c) => c.getAttribute('name'))).toEqual(['[android] Login > signs in', '[ios] Login > signs in']);
  });

  it('includeProjectInTestName overrides the default either way', async () => {
    const two = result([
      fileSuite([test('t', { project: 'android' })]),
      fileSuite([test('t', { project: 'ios' })]),
    ]);
    const off = await writeJUnit(two, { includeProjectInTestName: false });
    expect(casesOf(off).map((c) => c.getAttribute('name'))).toEqual(['t', 't']);
    const on = await writeJUnit(result([fileSuite([test('t', { project: 'android' })])]), { includeProjectInTestName: true });
    expect(casesOf(on)[0].getAttribute('name')).toBe('[android] t');
  });

  it('falls back to the suite name when no test carries a file (a blob from an older version)', async () => {
    const doc = await writeJUnit(result([
      { name: '', durationMs: 0, suites: [], tests: [test('t', { filePath: undefined })] },
    ]));
    expect(suitesOf(doc)[0].getAttribute('name')).toBe('Tapsmith');
    expect(casesOf(doc)[0].getAttribute('classname')).toBe('Tapsmith');
  });
});

describe('JUnitReporter failures', () => {
  it('gives the first message line as the failure message and leaves out Tapsmith and Node frames', async () => {
    const userFile = path.join(rootDir, 'tests', 'login.test.ts');
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, "import { test } from 'tapsmith';\n\ntest('x', async () => {\n  await expect(a).toBeVisible();\n});\n");
    const error = new Error('\x1b[31mexpect(locator).toBeVisible() failed\x1b[39m\n\nExpected: visible\nReceived: hidden');
    error.stack = [
      'Error: expect(locator).toBeVisible() failed',
      '',
      'Expected: visible',
      'Received: hidden',
      `    at Object.<anonymous> (${userFile}:4:19)`,
      `    at assert (${path.join(rootDir, 'node_modules', 'tapsmith', 'dist', 'expect.js')}:120:11)`,
      `    at runTest (${path.join(rootDir, 'node_modules', 'tapsmith', 'dist', 'runner.js')}:900:5)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    const doc = await writeJUnit(result([fileSuite([test('x', { status: 'failed', error, filePath: userFile })])]));

    const failure = doc.getElementsByTagName('failure')[0];
    expect(failure.getAttribute('message')).toBe('expect(locator).toBeVisible() failed');
    expect(failure.getAttribute('type')).toBe('FAILURE');
    const body = failure.textContent ?? '';
    expect(body).toContain('Expected: visible');
    expect(body).toContain('Received: hidden');
    expect(body).toContain(`${userFile}:4:19`);
    expect(body).toContain('await expect(a).toBeVisible();');
    expect(body).not.toContain('dist/expect.js');
    expect(body).not.toContain('dist/runner.js');
    expect(body).not.toContain('node:internal');
    expect(body).not.toContain('\x1b');
  });

  it('writes a failure whose error has no stack', async () => {
    const error = new Error('device went away');
    error.stack = undefined;
    const doc = await writeJUnit(result([fileSuite([test('x', { status: 'failed', error })])]));
    expect(doc.getElementsByTagName('failure')[0].textContent).toContain('device went away');
  });

  it('keeps a flaky test a pass, with its retry noted', async () => {
    const doc = await writeJUnit(result([fileSuite([
      test('x', { status: 'passed', retry: 1, firstAttemptError: new Error('first try failed') }),
    ])]));
    expect(doc.getElementsByTagName('failure')).toHaveLength(0);
    const retry = [...doc.getElementsByTagName('property')].find((p) => p.getAttribute('name') === 'retry');
    expect(retry?.getAttribute('value')).toBe('1');
  });

  it('escapes markup and drops characters XML cannot hold', async () => {
    const doc = await writeJUnit(result([fileSuite([
      test('a <b> & "c"', { status: 'failed', error: new Error('bad \x1b[1m<value>\x07 & "x"') }),
    ])]));
    expect(casesOf(doc)[0].getAttribute('name')).toBe('a <b> & "c"');
    expect(doc.getElementsByTagName('failure')[0].getAttribute('message')).toBe('bad <value> & "x"');
  });
});

describe('JUnitReporter attachments', () => {
  it('lists the screenshot, trace and video as [[ATTACHMENT|…]] relative to the report', async () => {
    const results = path.join(rootDir, 'tapsmith-results');
    fs.mkdirSync(results, { recursive: true });
    const files = ['shot.png', 'trace.zip', 'video.mp4'].map((f) => path.join(results, f));
    for (const f of files) fs.writeFileSync(f, 'x');
    const doc = await writeJUnit(result([fileSuite([test('x', {
      status: 'failed',
      error: new Error('boom'),
      screenshotPath: files[0],
      tracePath: files[1],
      videoPath: files[2],
    })])]));
    const out = doc.getElementsByTagName('system-out')[0].textContent ?? '';
    expect(out).toContain('[[ATTACHMENT|../tapsmith-results/shot.png]]');
    expect(out).toContain('[[ATTACHMENT|../tapsmith-results/trace.zip]]');
    expect(out).toContain('[[ATTACHMENT|../tapsmith-results/video.mp4]]');
  });

  it('notes a missing attachment on system-err instead of linking it', async () => {
    const doc = await writeJUnit(result([fileSuite([test('x', { screenshotPath: path.join(rootDir, 'gone.png') })])]));
    expect(doc.getElementsByTagName('system-out')).toHaveLength(0);
    expect(doc.getElementsByTagName('system-err')[0].textContent).toContain('gone.png is missing');
  });
});

describe('JUnit names after merge-reports', () => {
  it('keeps each test\'s file and project through a blob, relative to the merge\'s rootDir', async () => {
    const blobDir = path.join(tmpDir, 'blobs');
    const shardRoot = path.join(tmpDir, 'shard-checkout');
    const shardTest = (project: string): TestResult => test('Login > signs in', {
      project,
      filePath: path.join(shardRoot, 'tests', 'login.test.ts'),
    });
    fs.mkdirSync(blobDir);
    for (const project of ['android', 'ios']) {
      // Each shard job writes its own blob directory; the merge job collects them.
      const shardBlobDir = path.join(tmpDir, `blob-${project}`);
      const blob = new BlobReporter({ outputDir: shardBlobDir });
      blob.onRunStart(config({ rootDir: shardRoot }), 1);
      await blob.onRunEnd(result([fileSuite([shardTest(project)])]));
      for (const f of fs.readdirSync(shardBlobDir)) fs.copyFileSync(path.join(shardBlobDir, f), path.join(blobDir, f));
    }

    const merged = mergeBlobs(blobDir, rootDir);
    expect(merged.tests.map((t) => [t.project, t.filePath])).toEqual(expect.arrayContaining([
      ['android', path.join(rootDir, 'tests', 'login.test.ts')],
      ['ios', path.join(rootDir, 'tests', 'login.test.ts')],
    ]));

    const doc = await writeJUnit(merged);
    expect(suitesOf(doc).map((s) => s.getAttribute('name'))).toEqual(['tests/login.test.ts', 'tests/login.test.ts']);
    expect(casesOf(doc).map((c) => c.getAttribute('name')).sort()).toEqual(['[android] Login > signs in', '[ios] Login > signs in']);
  });
});
