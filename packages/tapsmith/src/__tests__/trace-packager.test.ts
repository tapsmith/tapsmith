import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { unzipSync, zipSync, strFromU8 } from 'fflate';
import { TraceCollector } from '../trace/trace-collector.js';
import { appendEventsToTrace, packageTrace, readTraceActionCount, type PackageOptions } from '../trace/trace-packager.js';
import { TRACE_FORMAT_VERSION } from '../trace/trace-format.js';
import type { ActionTraceEvent, AnyTraceEvent, TraceConfig, TraceDeviceInfo } from '../trace/types.js';

function makeConfig(overrides: Partial<TraceConfig> = {}): TraceConfig {
  return {
    mode: 'on',
    screenshots: false,
    snapshots: false,
    sources: false,
    attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    ...overrides,
  };
}

function makeActionEvent(overrides: Record<string, unknown> = {}) {
  return {
    category: 'tap' as const,
    action: 'tap',
    duration: 10,
    success: true,
    hasScreenshotBefore: false,
    hasScreenshotAfter: false,
    hasHierarchyBefore: false,
    hasHierarchyAfter: false,
    ...overrides,
  };
}

describe('trace packager', () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-test-'));
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-output-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('creates a valid zip with trace.json and metadata.json', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      selector: '{"text":"Hello"}',
      duration: 42,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      inputValue: 'world',
      duration: 100,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'my test',
      testStatus: 'passed',
      testDuration: 500,
      startTime: 1000,
      endTime: 1500,
      device: { serial: 'emulator-5554', isEmulator: true },
      tapsmithVersion: '0.1.0',
      outputDir,
      rootDir: tempDir,
    });

    expect(fs.existsSync(zipPath)).toBe(true);
    expect(zipPath.endsWith('.zip')).toBe(true);

    // Verify zip contents
    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);

    // metadata.json
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.version).toBe(TRACE_FORMAT_VERSION);
    expect(metadata.testName).toBe('my test');
    expect(metadata.testStatus).toBe('passed');
    expect(metadata.tapsmithVersion).toBe('0.1.0');
    expect(metadata.actionCount).toBe(2);
    expect(metadata.device.serial).toBe('emulator-5554');

    // trace.json (NDJSON)
    const traceLines = strFromU8(files['trace.json']).trim().split('\n');
    expect(traceLines).toHaveLength(2);
    const event0 = JSON.parse(traceLines[0]);
    expect(event0.type).toBe('action');
    expect(event0.action).toBe('tap');
    expect(event0.actionIndex).toBe(0);
    const event1 = JSON.parse(traceLines[1]);
    expect(event1.action).toBe('type');
    expect(event1.actionIndex).toBe(1);
  });

  it('includes source files when configured', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: true,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    // Create a fake source file
    const sourceFile = path.join(tempDir, 'test.ts');
    fs.writeFileSync(sourceFile, 'test("hello", () => {})');

    const collector = new TraceCollector(config, tempDir);

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'source test',
      testStatus: 'passed',
      testDuration: 100,
      startTime: 1000,
      endTime: 1100,
      device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.1.0',
      outputDir,
      rootDir: tempDir,
      sourceFiles: [sourceFile],
    });

    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);
    expect(files['sources.json']).toBeDefined();
    const sources = JSON.parse(strFromU8(files['sources.json']));
    // sources.json is keyed by the rootDir-relative path.
    expect(sources['test.ts']).toBe('test("hello", () => {})');
  });

  it('records failed test metadata', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    };

    const collector = new TraceCollector(config, tempDir);
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 50,
      success: false,
      error: 'Element not found',
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    });

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'failing test',
      testStatus: 'failed',
      testDuration: 200,
      startTime: 1000,
      endTime: 1200,
      device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.1.0',
      error: 'Element not found',
      outputDir,
      rootDir: tempDir,
    });

    const zipData = new Uint8Array(fs.readFileSync(zipPath));
    const files = unzipSync(zipData);
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.testStatus).toBe('failed');
    expect(metadata.error).toBe('Element not found');
  });
});

describe('packageTrace sources.json', () => {
  it('writes referenced source files keyed by rootDir-relative path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-'));
    try {
      const srcFile = path.join(tmp, 'helper.ts');
      fs.writeFileSync(srcFile, 'export const x = 1\n');

      const device: TraceDeviceInfo = { serial: 'test', isEmulator: false };
      const c = new TraceCollector(
        { mode: 'on', screenshots: false, snapshots: false, sources: true, attachments: false, network: false, deviceLogs: false, daemonLogs: false },
        tmp,
      );
      c.addActionEvent({
        category: 'tap', action: 'tap', duration: 1, success: true,
        hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
        sourceLocation: { file: srcFile, line: 1 }, stack: [{ file: srcFile, line: 1 }],
      });

      const zipPath = packageTrace(c, {
        testFile: srcFile, testName: 't', testStatus: 'passed', testDuration: 1,
        startTime: 1, endTime: 2, device,
        tapsmithVersion: '0.0.0', outputDir: tmp, rootDir: tmp, sourceFiles: [srcFile],
      });

      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      const sources = JSON.parse(new TextDecoder().decode(files['sources.json']));
      expect(sources['helper.ts']).toBe('export const x = 1\n');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('packageTrace screenshot cleanup', () => {
  it('deletes owned screenshots but preserves external (replayed hook) screenshots', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-ext-'));
    try {
      const collector = new TraceCollector(makeConfig({ screenshots: true }), tmp);

      // Owned capture: written into this collector's temp dir.
      const { actionIndex } = await collector.captureBeforeAction(
        async () => Buffer.from('own-png'),
        async () => undefined,
      );
      collector.addActionEvent(makeActionEvent({ hasScreenshotBefore: true }), actionIndex);
      const ownedPath = collector.screenshots[0].diskPath;

      // External capture: a beforeAll screenshot replayed into this collector,
      // still needed by later tests' replays after this trace packages.
      const externalPath = path.join(tmp, 'ba-action-000-before.png');
      fs.writeFileSync(externalPath, Buffer.from('hook-png'));
      collector.ingestReplayedEvent(
        {
          type: 'action', actionIndex: 5, timestamp: 1000,
          ...makeActionEvent({ hasScreenshotBefore: true }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial trace event literal
        } as any,
        { screenshotBefore: externalPath },
      );

      const zipPath = packageTrace(collector, {
        testFile: 't.ts', testName: 't', testStatus: 'passed', testDuration: 1,
        startTime: 1, endTime: 2, device: { serial: 'test', isEmulator: false },
        tapsmithVersion: '0.0.0', outputDir: tmp, rootDir: tmp,
      });

      const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
      expect(files['screenshots/action-000-before.png']).toBeDefined();
      expect(files['screenshots/action-005-before.png']).toBeDefined();
      expect(fs.existsSync(ownedPath)).toBe(false);
      expect(fs.existsSync(externalPath)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('appendEventsToTrace', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-append-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function packageBaseTrace(): string {
    const collector = new TraceCollector(makeConfig(), path.join(tmp, 'base'));
    collector.addActionEvent(makeActionEvent());
    collector.addActionEvent(makeActionEvent({ action: 'type' }));
    return packageTrace(collector, {
      testFile: 't.ts', testName: 'last test', testStatus: 'passed', testDuration: 100,
      startTime: 1000, endTime: 1100, device: { serial: 'test', isEmulator: false },
      tapsmithVersion: '0.0.0', outputDir: tmp, rootDir: tmp,
    });
  }

  it('reads the action count from a packaged trace', () => {
    const zipPath = packageBaseTrace();
    expect(readTraceActionCount(zipPath)).toBe(2);
  });

  it('appends hook events, screenshots, and hierarchies to an existing archive', async () => {
    const zipPath = packageBaseTrace();

    // The hook collector records with its own zero-based indices (like the
    // runner's afterAll collector); the offset is applied at append time.
    const hookCollector = new TraceCollector(
      makeConfig({ screenshots: true, snapshots: true }),
      path.join(tmp, 'hook'),
    );
    hookCollector.startGroup('afterAll Hooks');
    // A capture reserves the action's index; the emit hands it back so the
    // event lands where the screenshot was written.
    const { actionIndex } = await hookCollector.captureBeforeAction(
      async () => Buffer.from('after-all-png'),
      async () => '<hierarchy/>',
    );
    hookCollector.addActionEvent(makeActionEvent({
      action: 'openDeepLink', hasScreenshotBefore: true, hasHierarchyBefore: true,
    }), actionIndex);
    hookCollector.endGroup();

    appendEventsToTrace(zipPath, hookCollector, Date.now(), tmp, readTraceActionCount(zipPath) + 1);

    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const events = strFromU8(files['trace.json']).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string; name?: string; action?: string; actionIndex?: number });

    // Original events are preserved, hook events appended after them.
    expect(events[0].action).toBe('tap');
    expect(events[1].action).toBe('type');
    expect(events.some((e) => e.type === 'group-start' && e.name === 'afterAll Hooks')).toBe(true);
    const hookAction = events.find((e) => e.action === 'openDeepLink');
    expect(hookAction?.actionIndex).toBe(3);

    // Captures land at the offset archive paths.
    expect(files['screenshots/action-003-before.png']).toBeDefined();
    expect(files['hierarchy/action-003-before.xml']).toBeDefined();

    // Metadata reflects the appended events.
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.actionCount).toBe(4);
    expect(metadata.screenshotCount).toBe(1);
    expect(metadata.testName).toBe('last test');
  });

  it('sanitizes malformed metadata fields instead of serializing NaN', () => {
    const zipPath = packageBaseTrace();
    // Corrupt the archive's metadata the way an older/foreign trace might
    // look: numeric fields missing or carrying the wrong type.
    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    metadata.actionCount = 'two';
    delete metadata.endTime;
    delete metadata.screenshotCount;
    files['metadata.json'] = new TextEncoder().encode(JSON.stringify(metadata));
    fs.writeFileSync(zipPath, zipSync(files));

    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    hookCollector.startGroup('afterAll Hooks');
    hookCollector.addActionEvent(makeActionEvent());
    hookCollector.endGroup();
    appendEventsToTrace(zipPath, hookCollector, 5000, tmp, 3);

    const amended = JSON.parse(
      strFromU8(unzipSync(new Uint8Array(fs.readFileSync(zipPath)))['metadata.json']),
    );
    expect(amended.actionCount).toBe(4); // 3 offset + 1 hook action, not NaN/null
    expect(amended.endTime).toBe(5000);
    expect(amended.screenshotCount).toBe(0);
  });

  it('does not bump actionCount when the hook collector has events but no actions', () => {
    const zipPath = packageBaseTrace();

    // Console entries record events without advancing the action index —
    // actionCount must not absorb the offset's +1 slack in that case.
    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    hookCollector.addLogcatEntry('log', 'teardown message');
    appendEventsToTrace(zipPath, hookCollector, Date.now(), tmp, readTraceActionCount(zipPath) + 1);

    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    const metadata = JSON.parse(strFromU8(files['metadata.json']));
    expect(metadata.actionCount).toBe(2);
    const events = strFromU8(files['trace.json']).trim().split('\n')
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.filter((e) => e.type === 'console')).toHaveLength(1);
  });

  it('leaves the archive untouched when the hook collector recorded nothing', () => {
    const zipPath = packageBaseTrace();
    const before = fs.readFileSync(zipPath);

    const hookCollector = new TraceCollector(makeConfig(), path.join(tmp, 'hook'));
    appendEventsToTrace(zipPath, hookCollector, Date.now(), tmp);

    expect(fs.readFileSync(zipPath).equals(before)).toBe(true);
  });
});

// ─── Portable format (PILOT-331) ───

describe('packageTrace format contract', () => {
  let rootDir: string;
  let outputDir: string;

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-portable-root-')));
    outputDir = path.join(rootDir, 'out');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writeFile(rel: string, content: string): string {
    const abs = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  function baseOptions(overrides: Partial<PackageOptions> = {}): PackageOptions {
    return {
      testFile: '', testName: 't', testStatus: 'passed', testDuration: 1,
      startTime: 1, endTime: 2, device: { serial: 's', isEmulator: false },
      tapsmithVersion: '0.0.0', outputDir, rootDir,
      ...overrides,
    };
  }

  function read(zipPath: string) {
    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
    return {
      files,
      metadata: JSON.parse(strFromU8(files['metadata.json'])) as Record<string, unknown>,
      events: strFromU8(files['trace.json']).trim().split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as AnyTraceEvent),
      sources: files['sources.json']
        ? JSON.parse(strFromU8(files['sources.json'])) as Record<string, string>
        : {},
    };
  }

  const pack = (collector: TraceCollector, overrides: Partial<PackageOptions> = {}) =>
    read(packageTrace(collector, baseOptions(overrides)));

  it('stamps the current format version', () => {
    const { metadata } = pack(new TraceCollector(makeConfig(), rootDir));
    expect(metadata.version).toBe(TRACE_FORMAT_VERSION);
  });

  it('records testFile and appState relative to rootDir', () => {
    const testFile = writeFile('e2e/login.test.ts', '');
    const { metadata } = pack(new TraceCollector(makeConfig(), rootDir), {
      testFile,
      appState: path.join(rootDir, 'states', 'logged-in.tar.gz'),
    });
    expect(metadata.testFile).toBe('e2e/login.test.ts');
    expect(metadata.appState).toBe('states/logged-in.tar.gz');
  });

  it('keeps an already-relative appState as the rootDir-relative path it is', () => {
    const { metadata } = pack(new TraceCollector(makeConfig(), rootDir), { appState: 'states/a.tar.gz' });
    expect(metadata.appState).toBe('states/a.tar.gz');
  });

  it('keys sources.json by the same relative paths the stack frames carry', () => {
    const testFile = writeFile('e2e/login.test.ts', 'the test');
    const screen = writeFile('e2e/screens/login.ts', 'the screen');
    const c = new TraceCollector(makeConfig({ sources: true }), rootDir);
    c.addActionEvent(makeActionEvent({
      sourceLocation: { file: screen, line: 2 },
      stack: [{ file: screen, line: 2 }, { file: testFile, line: 7 }],
    }));

    const { events, sources } = pack(c, { testFile, sourceFiles: [testFile] });

    const action = events[0] as ActionTraceEvent;
    expect(action.sourceLocation?.file).toBe('e2e/screens/login.ts');
    expect(action.stack?.map((f) => f.file)).toEqual(['e2e/screens/login.ts', 'e2e/login.test.ts']);
    // The test file arrives both as sourceFiles and as a frame: one key.
    expect(sources).toEqual({
      'e2e/login.test.ts': 'the test',
      'e2e/screens/login.ts': 'the screen',
    });
  });

  it('climbs with .. for a helper outside rootDir instead of recording its absolute path', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-outside-')));
    try {
      const helper = path.join(outside, 'helper.ts');
      fs.writeFileSync(helper, 'helper');
      const c = new TraceCollector(makeConfig({ sources: true }), rootDir);
      c.addActionEvent(makeActionEvent({ stack: [{ file: helper, line: 1 }] }));

      const { events, sources } = pack(c);

      const expected = path.relative(rootDir, helper).split(path.sep).join('/');
      expect(expected.startsWith('../')).toBe(true);
      expect((events[0] as ActionTraceEvent).stack?.[0].file).toBe(expected);
      expect(sources[expected]).toBe('helper');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes no absolute local path into any structured field', () => {
    const testFile = writeFile('e2e/a.test.ts', 'x');
    const c = new TraceCollector(makeConfig({ sources: true }), rootDir);
    c.addActionEvent(makeActionEvent({
      sourceLocation: { file: testFile, line: 1 }, stack: [{ file: testFile, line: 1 }],
    }));
    c.addAssertionEvent({
      assertion: 'toBeVisible', passed: true, soft: false, negated: false, duration: 1, attempts: 1,
      sourceLocation: { file: testFile, line: 2 }, stack: [{ file: testFile, line: 2 }],
    });

    const { files, metadata } = pack(c, {
      testFile, sourceFiles: [testFile], appState: path.join(rootDir, 's.tgz'),
    });

    const structured = [
      strFromU8(files['trace.json']),
      JSON.stringify({ testFile: metadata.testFile, appState: metadata.appState }),
      JSON.stringify(Object.keys(JSON.parse(strFromU8(files['sources.json'])) as object)),
    ].join('\n');
    expect(structured).not.toContain(rootDir);
  });

  it('leaves the collector events absolute for UI mode, which streams them live', () => {
    const testFile = writeFile('e2e/a.test.ts', 'x');
    const c = new TraceCollector(makeConfig(), rootDir);
    c.addActionEvent(makeActionEvent({ stack: [{ file: testFile, line: 1 }] }));
    pack(c);
    expect((c.events[0] as ActionTraceEvent).stack?.[0].file).toBe(testFile);
  });

  it('rewrites the paths of events an afterAll hook appends', () => {
    const testFile = writeFile('e2e/a.test.ts', 'x');
    const zipPath = packageTrace(new TraceCollector(makeConfig(), rootDir), baseOptions({ testFile }));
    const hook = new TraceCollector(makeConfig(), path.join(rootDir, 'hook'));
    hook.addActionEvent(makeActionEvent({
      sourceLocation: { file: testFile, line: 9 }, stack: [{ file: testFile, line: 9 }],
    }));

    appendEventsToTrace(zipPath, hook, 3, rootDir, 1);

    const { events, metadata } = read(zipPath);
    const appended = events.at(-1) as ActionTraceEvent;
    expect(appended.sourceLocation?.file).toBe('e2e/a.test.ts');
    expect(appended.stack?.[0].file).toBe('e2e/a.test.ts');
    expect(metadata.version).toBe(TRACE_FORMAT_VERSION);
  });

  it('snapshots the sources of frames an afterAll hook appends', () => {
    // A cleanup helper the last test never called: without merging, the
    // appended frames name a file sources.json does not hold.
    const testFile = writeFile('e2e/a.test.ts', 'the test');
    const helper = writeFile('e2e/screens/logout.screen.ts', 'the logout helper');
    const last = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'last'));
    last.addActionEvent(makeActionEvent({ stack: [{ file: testFile, line: 1 }] }));
    const zipPath = packageTrace(last, baseOptions({ testFile, sourceFiles: [testFile] }));

    const hook = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'hook'));
    hook.addActionEvent(makeActionEvent({ stack: [{ file: helper, line: 4 }, { file: testFile, line: 9 }] }));
    appendEventsToTrace(zipPath, hook, 3, rootDir, 2);

    const { sources, events } = read(zipPath);
    expect(sources).toEqual({
      'e2e/a.test.ts': 'the test',
      'e2e/screens/logout.screen.ts': 'the logout helper',
    });
    for (const e of events) {
      for (const frame of (e as ActionTraceEvent).stack ?? []) expect(sources[frame.file]).toBeDefined();
    }
  });

  it('adds no sources.json on append when the sources channel is off', () => {
    const testFile = writeFile('e2e/a.test.ts', 'x');
    const zipPath = packageTrace(new TraceCollector(makeConfig(), path.join(rootDir, 'last')), baseOptions({ testFile }));
    const hook = new TraceCollector(makeConfig(), path.join(rootDir, 'hook'));
    hook.addActionEvent(makeActionEvent({ stack: [{ file: testFile, line: 9 }] }));
    appendEventsToTrace(zipPath, hook, 3, rootDir, 1);
    expect(read(zipPath).files['sources.json']).toBeUndefined();
  });

  it('spells a frame through a symlinked test directory the way discovery spelled the test file', () => {
    // rootDir/e2e is a link into another tree. Discovery hands the runner the
    // lexical path; the ESM loader reports frames by realpath. Both must land
    // on one archive path, or testFile and the frames stop joining.
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-linked-tests-')));
    try {
      fs.writeFileSync(path.join(elsewhere, 'a.test.ts'), 'linked test');
      fs.symlinkSync(elsewhere, path.join(rootDir, 'e2e'), 'dir');
      const lexical = path.join(rootDir, 'e2e', 'a.test.ts');
      const physical = path.join(elsewhere, 'a.test.ts');

      const c = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'tmp'));
      c.addActionEvent(makeActionEvent({
        sourceLocation: { file: physical, line: 1 }, stack: [{ file: physical, line: 1 }],
      }));
      const { metadata, events, sources } = pack(c, { testFile: lexical, sourceFiles: [lexical] });

      expect(metadata.testFile).toBe('e2e/a.test.ts');
      expect((events[0] as ActionTraceEvent).stack?.[0].file).toBe('e2e/a.test.ts');
      expect((events[0] as ActionTraceEvent).sourceLocation?.file).toBe('e2e/a.test.ts');
      expect(sources).toEqual({ 'e2e/a.test.ts': 'linked test' });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('spells every module under a symlinked test directory lexically, not just the test file', () => {
    // The test sits in e2e/tests/, its screen object in e2e/screens/ — a
    // sibling of the test's own directory, reached only through the link.
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-linked-tree-')));
    // A physical sibling whose name shares the linked dir's prefix: it is not
    // under the link, so it must not be claimed by it.
    const lookalike = `${elsewhere}-lookalike`;
    try {
      fs.mkdirSync(path.join(elsewhere, 'tests'));
      fs.mkdirSync(path.join(elsewhere, 'screens'));
      fs.mkdirSync(lookalike);
      fs.writeFileSync(path.join(elsewhere, 'tests', 'a.test.ts'), 'linked test');
      fs.writeFileSync(path.join(elsewhere, 'screens', 'login.ts'), 'linked screen');
      fs.writeFileSync(path.join(lookalike, 'other.ts'), 'not linked');
      fs.symlinkSync(elsewhere, path.join(rootDir, 'e2e'), 'dir');
      const lexicalTest = path.join(rootDir, 'e2e', 'tests', 'a.test.ts');

      const c = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'tmp'));
      c.addActionEvent(makeActionEvent({
        stack: [
          { file: path.join(elsewhere, 'screens', 'login.ts'), line: 2 },
          { file: path.join(elsewhere, 'tests', 'a.test.ts'), line: 5 },
          { file: path.join(lookalike, 'other.ts'), line: 1 },
        ],
      }));
      const { metadata, events, sources } = pack(c, { testFile: lexicalTest, sourceFiles: [lexicalTest] });

      const frames = (events[0] as ActionTraceEvent).stack!.map((f) => f.file);
      const lookalikeRel = path.relative(rootDir, path.join(lookalike, 'other.ts')).split(path.sep).join('/');
      expect(metadata.testFile).toBe('e2e/tests/a.test.ts');
      expect(frames).toEqual(['e2e/screens/login.ts', 'e2e/tests/a.test.ts', lookalikeRel]);
      expect(lookalikeRel.startsWith('../')).toBe(true);
      expect(sources).toEqual({
        'e2e/tests/a.test.ts': 'linked test',
        'e2e/screens/login.ts': 'linked screen',
        [lookalikeRel]: 'not linked',
      });
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
      fs.rmSync(lookalike, { recursive: true, force: true });
    }
  });

  it('spells a symlinked test directory lexically when its target is also inside rootDir', () => {
    // R/e2e → R/shared/e2e: the frame's realpath is inside rootDir, so the
    // direct answer (`shared/e2e/…`) does not escape — the lexical spelling
    // the test was discovered under must still win.
    fs.mkdirSync(path.join(rootDir, 'shared', 'e2e', 'screens'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, 'shared', 'e2e', 'a.test.ts'), 'aliased test');
    fs.writeFileSync(path.join(rootDir, 'shared', 'e2e', 'screens', 'login.ts'), 'aliased screen');
    fs.symlinkSync(path.join(rootDir, 'shared', 'e2e'), path.join(rootDir, 'e2e'), 'dir');
    const lexicalTest = path.join(rootDir, 'e2e', 'a.test.ts');

    const c = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'tmp'));
    c.addActionEvent(makeActionEvent({
      stack: [
        { file: path.join(rootDir, 'shared', 'e2e', 'screens', 'login.ts'), line: 2 },
        { file: path.join(rootDir, 'shared', 'e2e', 'a.test.ts'), line: 5 },
      ],
    }));
    const { metadata, events, sources } = pack(c, { testFile: lexicalTest, sourceFiles: [lexicalTest] });

    expect(metadata.testFile).toBe('e2e/a.test.ts');
    expect((events[0] as ActionTraceEvent).stack!.map((f) => f.file)).toEqual(['e2e/screens/login.ts', 'e2e/a.test.ts']);
    expect(sources).toEqual({ 'e2e/a.test.ts': 'aliased test', 'e2e/screens/login.ts': 'aliased screen' });
  });

  it('counts the screenshots it wrote, not the captures it was handed', async () => {
    // A capture whose temp file is gone by packaging time is skipped; the
    // documented screenshotCount is the number of screenshot members.
    const c = new TraceCollector(makeConfig({ screenshots: true }), path.join(rootDir, 'tmp'));
    fs.mkdirSync(path.join(rootDir, 'tmp', 'screenshots'), { recursive: true });
    await c.captureBeforeAction(async () => Buffer.from('kept'), async () => undefined);
    await c.captureBeforeAction(async () => Buffer.from('lost'), async () => undefined);
    fs.rmSync(c.screenshots[1].diskPath);

    const zipPath = packageTrace(c, baseOptions());
    const { files, metadata } = read(zipPath);
    const members = Object.keys(files).filter((f) => f.startsWith('screenshots/'));
    expect(members).toHaveLength(1);
    expect(metadata.screenshotCount).toBe(1);

    // The afterAll append counts the same way.
    const hook = new TraceCollector(makeConfig({ screenshots: true }), path.join(rootDir, 'hook'));
    fs.mkdirSync(path.join(rootDir, 'hook', 'screenshots'), { recursive: true });
    await hook.captureBeforeAction(async () => Buffer.from('hook kept'), async () => undefined);
    await hook.captureBeforeAction(async () => Buffer.from('hook lost'), async () => undefined);
    hook.addActionEvent(makeActionEvent());
    fs.rmSync(hook.screenshots[1].diskPath);
    appendEventsToTrace(zipPath, hook, 3, rootDir, 3);
    const after = read(zipPath);
    expect(Object.keys(after.files).filter((f) => f.startsWith('screenshots/'))).toHaveLength(2);
    expect(after.metadata.screenshotCount).toBe(2);
  });

  it('counts one screenshot member when two captures share an archive path', async () => {
    const c = new TraceCollector(makeConfig({ screenshots: true }), path.join(rootDir, 'tmp'));
    fs.mkdirSync(path.join(rootDir, 'tmp', 'screenshots'), { recursive: true });
    await c.captureBeforeAction(async () => Buffer.from('frame'), async () => undefined);
    // A replayed capture landing on the same slot (the list does not enforce
    // unique paths): one member in the zip, so one in the count.
    (c.screenshots as Array<(typeof c.screenshots)[number]>).push({ ...c.screenshots[0], external: true });

    const { files, metadata } = read(packageTrace(c, baseOptions()));
    expect(Object.keys(files).filter((f) => f.startsWith('screenshots/'))).toHaveLength(1);
    expect(metadata.screenshotCount).toBe(1);
  });

  it('keys a relative frame the same way the frame spells it when cwd is not rootDir', () => {
    // A relative frame is rootDir-relative by convention; resolving it against
    // the working directory instead would key its source under another path.
    writeFile('e2e/rel.ts', 'relative source');
    expect(process.cwd()).not.toBe(rootDir);
    const c = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'tmp'));
    c.addActionEvent(makeActionEvent({ stack: [{ file: 'e2e/rel.ts', line: 1 }] }));
    const { events, sources } = pack(c);
    expect((events[0] as ActionTraceEvent).stack?.[0].file).toBe('e2e/rel.ts');
    expect(sources).toEqual({ 'e2e/rel.ts': 'relative source' });
  });

  it('spells an afterAll helper under a symlinked test directory lexically', () => {
    const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-linked-append-')));
    try {
      fs.mkdirSync(path.join(elsewhere, 'screens'));
      fs.writeFileSync(path.join(elsewhere, 'a.test.ts'), 'linked test');
      fs.writeFileSync(path.join(elsewhere, 'screens', 'logout.ts'), 'linked logout');
      fs.symlinkSync(elsewhere, path.join(rootDir, 'e2e'), 'dir');
      const lexicalTest = path.join(rootDir, 'e2e', 'a.test.ts');
      const zipPath = packageTrace(
        new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'last')),
        baseOptions({ testFile: lexicalTest, sourceFiles: [lexicalTest] }),
      );

      const hook = new TraceCollector(makeConfig({ sources: true }), path.join(rootDir, 'hook'));
      hook.addActionEvent(makeActionEvent({ stack: [{ file: path.join(elsewhere, 'screens', 'logout.ts'), line: 3 }] }));
      appendEventsToTrace(zipPath, hook, 3, rootDir, 1);

      const { events, sources } = read(zipPath);
      expect((events.at(-1) as ActionTraceEvent).stack?.[0].file).toBe('e2e/screens/logout.ts');
      expect(sources['e2e/screens/logout.ts']).toBe('linked logout');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
