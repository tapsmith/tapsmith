/**
 * The published trace-format JSON Schema against what the packager writes.
 *
 * The schema is the contract a server-side indexer validates uploads with
 * (PILOT-331), so it must accept every archive the packager produces and
 * reject the shapes the format rules out. A rich archive — every event type
 * the collector emits, network bodies, a device group, sources — is packaged
 * through the real `packageTrace` and parsed the way an indexer would.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { TraceCollector } from '../trace/trace-collector.js';
import { packageTrace } from '../trace/trace-packager.js';
import { TRACE_FORMAT_VERSION } from '../trace/trace-format.js';
import type { NetworkEntry, TraceConfig } from '../trace/types.js';

const SCHEMA_PATH = path.resolve(import.meta.dirname, '../../schema/trace-format.schema.json');

interface ParsedArchive {
  members: string[]
  metadata: Record<string, unknown>
  events: Record<string, unknown>[]
  network: Record<string, unknown>[]
  sources: Record<string, string>
}

/** Parse a zip into the shape the schema's root describes. */
function parseArchive(zipPath: string): ParsedArchive {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const ndjson = (name: string) => (files[name]
    ? strFromU8(files[name]).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : []);
  return {
    members: Object.keys(files).sort(),
    metadata: JSON.parse(strFromU8(files['metadata.json'])) as Record<string, unknown>,
    events: ndjson('trace.json'),
    network: ndjson('network.json'),
    sources: files['sources.json'] ? JSON.parse(strFromU8(files['sources.json'])) as Record<string, string> : {},
  };
}

const config: TraceConfig = {
  mode: 'on', screenshots: true, snapshots: true, sources: true, attachments: true,
  network: true, deviceLogs: true, daemonLogs: true,
};

let schema: Record<string, unknown>;
let validate: ValidateFunction;
let rootDir: string;
let archive: ParsedArchive;

function errorsOf(value: unknown): string[] {
  return validate(value)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
}

/** A deep copy of the valid archive with `mutate` applied. */
function variant(mutate: (a: ParsedArchive) => void): ParsedArchive {
  const copy = structuredClone(archive);
  mutate(copy);
  return copy;
}

beforeAll(async () => {
  schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8')) as Record<string, unknown>;
  validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

  rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-schema-')));
  const testFile = path.join(rootDir, 'e2e', 'chat.test.ts');
  fs.mkdirSync(path.dirname(testFile), { recursive: true });
  fs.writeFileSync(testFile, 'test("chat", async () => {})\n');
  const frame = { file: testFile, line: 1, column: 1 };

  const c = new TraceCollector(config, path.join(rootDir, 'tmp'));
  c.startGroup('Test');
  const { actionIndex } = await c.captureBeforeAction(
    async () => Buffer.from('png-bytes'),
    async () => '<hierarchy><node text="Send"/></hierarchy>',
  );
  c.addActionEvent({
    category: 'tap', action: 'tap', selector: '{"text":"Send"}', duration: 12, success: true,
    hasScreenshotBefore: true, hasScreenshotAfter: false, hasHierarchyBefore: true, hasHierarchyAfter: false,
    bounds: { left: 0, top: 0, right: 10, bottom: 10 }, point: { x: 5, y: 5 },
    sourceLocation: frame, stack: [frame], deviceId: 'alice', log: ['resolved'], origin: 'inline',
  }, actionIndex);
  c.addAssertionEvent({
    assertion: 'toBeVisible', selector: '{"text":"Hi"}', passed: false, soft: false, negated: false,
    duration: 30, attempts: 3, error: 'not visible', sourceLocation: frame, stack: [frame], deviceId: 'bob',
  });
  c.addLogcatEntry('error', 'E/App: boom', 'alice', Date.now());
  c.addDaemonLogEntry('info', 'daemon line', 'bob');
  c.addError('Test failed', 'Error: Test failed\n    at chat.test.ts:1:1');
  c.endGroup();

  const networkEntries: NetworkEntry[] = [{
    index: 0, deviceId: 'alice', actionIndex: 0, startTime: 1, endTime: 2, method: 'POST',
    url: 'https://api.example.com/messages', status: 201, contentType: 'application/json',
    requestSize: 2, responseSize: 2, duration: 1,
    requestHeaders: { 'content-type': 'application/json' }, responseHeaders: {},
    requestBody: Buffer.from('{}'), responseBody: Buffer.from('{}'), routeAction: 'mocked',
  }, {
    index: 1, actionIndex: 0, startTime: 1, endTime: 3, method: 'CONNECT', url: 'pinned.example.com:443',
    status: 0, contentType: '', requestSize: 0, responseSize: 0, duration: 2,
    requestHeaders: {}, responseHeaders: {}, routeAction: 'passthrough', inFlight: true,
  }];

  const alice = { serial: 'emulator-5554', name: 'alice', platform: 'android' as const, isEmulator: true };
  const bob = { serial: 'SIM-UDID', name: 'bob', platform: 'ios' as const, isEmulator: true, devicePixelRatio: 3 };
  const zipPath = packageTrace(c, {
    testFile, testName: 'chat > sends', testStatus: 'failed', testDuration: 100,
    startTime: 1, endTime: 101, device: alice, devices: [alice, bob],
    tapsmithVersion: '0.5.0', error: 'not visible', outputDir: path.join(rootDir, 'out'), rootDir,
    sourceFiles: [testFile], networkEntries, project: 'android',
    appState: path.join(rootDir, 'states', 'logged-in.tar.gz'), appReset: 'warm', appResetScope: 'file',
  });
  archive = parseArchive(zipPath);
});

afterAll(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('trace-format.schema.json', () => {
  it('pins the same format version the packager writes', () => {
    const version = ((schema.$defs as Record<string, { properties?: Record<string, unknown> }>)
      .metadata.properties?.version) as { const?: unknown };
    expect(version.const).toBe(TRACE_FORMAT_VERSION);
  });

  it('accepts a packaged archive exercising every event type the collector emits', () => {
    // Guard the fixture: a validation that passes over an archive missing the
    // interesting shapes proves nothing.
    expect(new Set(archive.events.map((e) => e.type))).toEqual(
      new Set(['group-start', 'group-end', 'action', 'assertion', 'console', 'error']),
    );
    expect(archive.network).toHaveLength(2);
    expect(archive.members).toEqual(expect.arrayContaining([
      'screenshots/action-000-before.png', 'hierarchy/action-000-before.xml',
      'network/req-0.bin', 'network/res-0.bin', 'sources.json',
    ]));

    expect(errorsOf(archive)).toEqual([]);
  });

  it('accepts a documented attachment event (reserved; no producer yet)', () => {
    const withAttachment = variant((a) => {
      a.events.push({
        type: 'attachment', actionIndex: 0, timestamp: 1, name: 'log', contentType: 'text/plain',
        path: 'attachments/log.txt', size: 3,
      });
      a.members.push('attachments/log.txt');
    });
    expect(errorsOf(withAttachment)).toEqual([]);
  });

  describe('forward compatibility — additive changes must not need a version bump', () => {
    it('accepts unknown fields on metadata, events, network entries and devices', () => {
      const extended = variant((a) => {
        a.metadata.futureField = { anything: true };
        (a.metadata.device as Record<string, unknown>).thermalState = 'nominal';
        a.events[0].futureField = 1;
        a.network[0].timings = { dns: 1 };
      });
      expect(errorsOf(extended)).toEqual([]);
    });

    it('accepts an event type it does not know, as long as it carries the base fields', () => {
      const extended = variant((a) => {
        a.events.push({ type: 'video-frame', actionIndex: 0, timestamp: 5, frame: 12 });
      });
      expect(errorsOf(extended)).toEqual([]);
    });

    it('accepts an action category and route action it does not know', () => {
      const extended = variant((a) => {
        const action = a.events.find((e) => e.type === 'action')!;
        action.category = 'pinch';
        a.network[0].routeAction = 'throttled';
      });
      expect(errorsOf(extended)).toEqual([]);
    });
  });

  describe('rejects what the format rules out', () => {
    const cases: Array<[string, (a: ParsedArchive) => void]> = [
      ['a v1 archive', (a) => { a.metadata.version = 1; }],
      ['a missing version', (a) => { delete a.metadata.version; }],
      ['an absolute testFile', (a) => { a.metadata.testFile = '/home/runner/work/app/e2e/chat.test.ts'; }],
      ['a Windows drive testFile', (a) => { a.metadata.testFile = 'C:/work/app/e2e/chat.test.ts'; }],
      ['a backslash-separated testFile', (a) => { a.metadata.testFile = 'e2e\\chat.test.ts'; }],
      ['an absolute appState', (a) => { a.metadata.appState = '/Users/sam/states/x.tar.gz'; }],
      ['an absolute stack frame', (a) => {
        const action = a.events.find((e) => e.type === 'action')!;
        (action.stack as Array<{ file: string }>)[0].file = '/Users/sam/app/e2e/chat.test.ts';
      }],
      ['an absolute sources.json key', (a) => { a.sources['/Users/sam/app/e2e/chat.test.ts'] = ''; }],
      ['a member escaping the archive root', (a) => { a.members.push('../evil.sh'); }],
      ['an absolute member', (a) => { a.members.push('/etc/passwd'); }],
      ['a body path escaping the archive root', (a) => { a.network[0].responseBodyPath = 'network/../../x.bin'; }],
      ['an event without an actionIndex', (a) => { delete a.events[0].actionIndex; }],
      ['a negative actionIndex', (a) => { a.events[0].actionIndex = -1; }],
      ['an action missing its capture flags', (a) => {
        delete a.events.find((e) => e.type === 'action')!.hasScreenshotBefore;
      }],
      ['an assertion missing passed', (a) => { delete a.events.find((e) => e.type === 'assertion')!.passed; }],
      ['a console event with an unknown source', (a) => {
        a.events.find((e) => e.type === 'console')!.source = 'kernel';
      }],
      ['a network entry that serialized its transient body buffer', (a) => {
        a.network[0].responseBody = { type: 'Buffer', data: [123, 125] };
      }],
      ['a network entry without a url', (a) => { delete a.network[0].url; }],
      ['a device without a serial', (a) => { delete (a.metadata.device as Record<string, unknown>).serial; }],
      ['an unknown test status', (a) => { a.metadata.testStatus = 'flaky'; }],
      ['a traceConfig missing a channel', (a) => {
        delete (a.metadata.traceConfig as Record<string, unknown>).network;
      }],
    ];

    for (const [name, mutate] of cases) {
      it(name, () => {
        expect(errorsOf(variant(mutate))).not.toEqual([]);
      });
    }
  });
});
