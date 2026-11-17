import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { zipSync } from 'fflate';
import { readTraceSummary } from '../mcp/tools/trace-utils.js';

function createTraceZip(events: object[], screenshots?: Record<string, Buffer>, metadata: object = { version: 1 }): string {
  const files: Record<string, Uint8Array> = {};
  const ndjson = events.map((e) => JSON.stringify(e)).join('\n');
  files['trace.json'] = new TextEncoder().encode(ndjson);
  files['metadata.json'] = new TextEncoder().encode(JSON.stringify(metadata));
  if (screenshots) {
    for (const [name, data] of Object.entries(screenshots)) {
      files[`screenshots/${name}`] = new Uint8Array(data);
    }
  }
  const zipped = zipSync(files);
  const tmp = path.join(os.tmpdir(), `test-trace-${Date.now()}.zip`);
  fs.writeFileSync(tmp, zipped);
  return tmp;
}

describe('readTraceSummary()', () => {
  it('returns undefined for nonexistent file', () => {
    expect(readTraceSummary('/nonexistent/trace.zip')).toBeUndefined();
  });

  it('extracts action and assertion steps', () => {
    const events = [
      { type: 'action', action: 'tap', selector: 'device.getByText("Login")', duration: 100 },
      { type: 'assertion', assertion: 'toBeVisible', duration: 50 },
      { type: 'assertion', assertion: 'toHaveText', error: 'Expected "A" toHaveText "B"', expected: 'B', actual: 'A', duration: 200 },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary).toBeDefined();
      expect(summary!.steps.length).toBeGreaterThanOrEqual(3);
      expect(summary!.steps[0]).toContain('[OK] tap');
      expect(summary!.steps[0]).toContain('device.getByText("Login")');
      expect(summary!.steps[1]).toContain('[OK] expect toBeVisible');
      expect(summary!.steps[2]).toContain('[FAIL] expect toHaveText');
      expect(summary!.steps.some((s) => s.includes('Expected:'))).toBe(true);
      expect(summary!.steps.some((s) => s.includes('Actual:'))).toBe(true);
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('reads the screen at the test\'s failed step, not at a failed step in an after hook (PILOT-1241)', () => {
    const enc = (t: string) => Buffer.from(t);
    const hierarchy = {
      'hierarchy/action-001-before.xml': '<hierarchy>login</hierarchy>',
      'hierarchy/action-002-before.xml': '<hierarchy>hook</hierarchy>',
    };
    const failedStep = { type: 'assertion', assertion: 'toBeVisible', error: 'not visible', actionIndex: 1, hasHierarchyBefore: true, duration: 50 };
    const hookStep = { type: 'action', action: 'tap', error: 'gone', actionIndex: 2, hasHierarchyBefore: true, duration: 5 };
    const read = (events: object[]) => {
      const files: Record<string, Uint8Array> = {
        'trace.json': new TextEncoder().encode(events.map((e) => JSON.stringify(e)).join('\n')),
        'metadata.json': new TextEncoder().encode('{"version":1}'),
      };
      for (const [name, xml] of Object.entries(hierarchy)) files[name] = new Uint8Array(enc(xml));
      const zip = path.join(os.tmpdir(), `test-trace-h-${Date.now()}-${Math.random()}.zip`);
      fs.writeFileSync(zip, zipSync(files));
      try {
        return readTraceSummary(zip)!.failureHierarchyXml;
      } finally {
        fs.unlinkSync(zip);
      }
    };
    const login = '<hierarchy>login</hierarchy>';
    expect(read([{ type: 'group-start', name: 'Test' }, failedStep, { type: 'group-end', name: 'Test' }])).toBe(login);
    // A hook's failed step after the test's is not the failure.
    expect(read([
      { type: 'group-start', name: 'Test' }, failedStep, { type: 'group-end', name: 'Test' },
      { type: 'group-start', name: 'afterEach Hooks' }, hookStep, { type: 'group-end', name: 'afterEach Hooks' },
    ])).toBe(login);
    // A failure in a beforeEach hook is the test's failure.
    expect(read([{ type: 'group-start', name: 'beforeEach Hooks' }, failedStep, { type: 'group-end', name: 'beforeEach Hooks' }])).toBe(login);
    expect(read([{ type: 'action', action: 'tap', actionIndex: 1, hasHierarchyBefore: true }])).toBeUndefined();
    expect(read([{ ...failedStep, hasHierarchyBefore: false }])).toBeUndefined();
  });

  it('skips group-start events', () => {
    const events = [
      { type: 'group-start', title: 'Test' },
      { type: 'action', action: 'tap', duration: 100 },
      { type: 'group-start', title: 'afterEach' },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.steps).toHaveLength(1);
      expect(summary!.steps[0]).toContain('tap');
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('limits to last N steps with omission notice', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      type: 'action', action: `step${i}`, duration: 10,
    }));
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip, 5);
      expect(summary!.steps[0]).toContain('10 earlier step(s) omitted');
      expect(summary!.steps).toHaveLength(6);
      expect(summary!.steps[5]).toContain('step14');
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('extracts last screenshot as failureScreenshot', () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    const zip = createTraceZip([], { 'action-000-before.png': png, 'action-001-after.png': png });
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.failureScreenshot).toBeDefined();
      expect(summary!.failureScreenshot!.length).toBe(png.length);
    } finally {
      fs.unlinkSync(zip);
    }
  });

  it('includes expected/actual for failed assertions', () => {
    const events = [
      { type: 'assertion', assertion: 'toBe', error: 'fail', expected: false, actual: true, duration: 100 },
    ];
    const zip = createTraceZip(events);
    try {
      const summary = readTraceSummary(zip);
      expect(summary!.steps.some((s) => s.includes('Expected: false'))).toBe(true);
      expect(summary!.steps.some((s) => s.includes('Actual: true'))).toBe(true);
    } finally {
      fs.unlinkSync(zip);
    }
  });

  // A `use.devices` trace: the same failure summary tapsmith_run_tests and
  // tapsmith_list_results print must say whose device each step ran on, as
  // tapsmith_read_trace already does — otherwise a two-user failure has no owner.
  describe('multi-device traces', () => {
    const PAIR = { version: 1, devices: [{ name: 'alice', serial: 'A' }, { name: 'bob', serial: 'B' }] };

    it('prefixes steps and device logs with the device that produced them', () => {
      const zip = createTraceZip([
        { type: 'action', action: 'tap', selector: 'getByText("Send")', deviceId: 'alice', duration: 10 },
        { type: 'assertion', assertion: 'toBeVisible', deviceId: 'bob', error: 'not visible', duration: 5 },
        { type: 'console', source: 'device', level: 'error', message: 'boom', deviceId: 'bob' },
      ], undefined, PAIR);
      const summary = readTraceSummary(zip)!;
      expect(summary.steps).toEqual([
        '[OK] alice: tap on getByText("Send") (10ms)',
        '[FAIL] bob: expect toBeVisible (5ms)',
      ]);
      expect(summary.deviceLogs).toEqual(['[ERROR] bob: boom']);
      fs.unlinkSync(zip);
    });

    it('leaves a single-device trace unprefixed even when events carry a deviceId', () => {
      const zip = createTraceZip([
        { type: 'action', action: 'tap', deviceId: 'device-1', duration: 10 },
        { type: 'console', source: 'device', level: 'warn', message: 'slow', deviceId: 'device-1' },
      ], undefined, { version: 1, devices: [{ name: 'device-1', serial: 'A' }] });
      const summary = readTraceSummary(zip)!;
      expect(summary.steps).toEqual(['[OK] tap (10ms)']);
      expect(summary.deviceLogs).toEqual(['[WARN] slow']);
      fs.unlinkSync(zip);
    });
  });
});
