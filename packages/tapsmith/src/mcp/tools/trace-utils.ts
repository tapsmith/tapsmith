import * as fs from 'node:fs';
import { unzipSync } from 'fflate';
import { hierarchyArchivePath } from '../../trace/trace-collector.js';

export interface TraceEvent {
  type: string
  action?: string
  assertion?: string
  selector?: string
  title?: string
  error?: string
  expected?: unknown
  actual?: unknown
  duration?: number
  wallDuration?: number
  level?: string
  message?: string
  source?: string
  /** Group member that produced the event, on a multi-device trace. */
  deviceId?: string
  /** Index of an action or assertion; names its hierarchy files. */
  actionIndex?: number
  /** A group marker's name (`afterEach Hooks`, …). */
  name?: string
  hasHierarchyBefore?: boolean
}

export interface TraceSummary {
  steps: string[]
  deviceLogs: string[]
  failureScreenshot?: Buffer
  /**
   * The screen (hierarchy XML) the trace captured at the test's failed step:
   * its last action or assertion, outside the `afterEach`/`afterAll` hooks,
   * whose error is the test's error. Steps are captured when they start (an
   * assertion or an action that waits takes no capture when it fails), so the
   * app may have moved on while the step waited. Absent when the trace has no such capture.
   */
  failureHierarchyXml?: string
  /** Whether the trace was recorded on a device group (`use.devices`). */
  multiDevice: boolean
}

interface TraceMetadata { devices?: unknown; error?: unknown }

function parseMetadata(metadataJson: string | undefined): TraceMetadata {
  if (!metadataJson) return {};
  try {
    return (JSON.parse(metadataJson) as TraceMetadata | null) ?? {};
  } catch {
    return {};
  }
}

/** The line the runner puts between the error a test stopped on and the soft or unhandled errors it appends. */
const ADDITIONALLY = '\n\n--- Additionally ---\n';

/** The error a test stopped on, without the soft or unhandled errors the runner appends after it. */
export function primaryError(error: string): string {
  return error.split(ADDITIONALLY)[0];
}

/** Groups whose steps run after the test's own: a failure there is not the test's. */
const AFTER_HOOK_GROUPS = new Set(['afterEach Hooks', 'afterAll Hooks']);

/**
 * The screen captured at the test's failed step (see {@link TraceSummary.failureHierarchyXml}).
 * A failed step did not necessarily fail the test (user code catches errors,
 * soft assertions carry on, a fixture's teardown runs after the test), so the
 * failed step is the last one whose error is the test's error, as
 * tapsmith_read_trace picks it (PILOT-917), outside the after hooks. A step a timed-out test left in
 * flight is recorded with the timeout's message, so it matches too.
 */
function failedStepHierarchy(events: TraceEvent[], files: Record<string, Uint8Array>, testError: string): string | undefined {
  if (!testError) return undefined;
  const open: string[] = [];
  let failed: TraceEvent | undefined;
  for (const e of events) {
    if (e.type === 'group-start') open.push(e.name ?? '');
    else if (e.type === 'group-end') open.pop();
    else if ((e.type === 'action' || e.type === 'assertion') && e.error && testError.includes(String(e.error))
      && !open.some((g) => AFTER_HOOK_GROUPS.has(g))) failed = e;
  }
  if (failed?.actionIndex === undefined || !failed.hasHierarchyBefore) return undefined;
  const file = files[hierarchyArchivePath(failed.actionIndex, 'before')];
  return file ? new TextDecoder().decode(file) : undefined;
}

export function readTraceSummary(tracePath: string, maxSteps = 10): TraceSummary | undefined {
  try {
    if (!fs.existsSync(tracePath)) return undefined;
    const zipData = new Uint8Array(fs.readFileSync(tracePath));
    const files = unzipSync(zipData);
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);

    const steps: string[] = [];
    const deviceLogs: string[] = [];
    let failureHierarchyXml: string | undefined;

    // A trace recorded on a device group names the device on every step and
    // log line (`bob: tap`), the way tapsmith_read_trace does — a two-user
    // failure otherwise reads with no owner. Single-device traces are unchanged.
    const meta = parseMetadata(files['metadata.json'] ? decode(files['metadata.json']) : undefined);
    const multiDevice = Array.isArray(meta.devices) && meta.devices.length > 1;
    const who = (event: TraceEvent): string => (multiDevice && event.deviceId ? `${event.deviceId}: ` : '');

    if (files['trace.json']) {
      const events: TraceEvent[] = decode(files['trace.json'])
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);

      // Take last N meaningful events (actions + assertions, skip group markers)
      const meaningful = events.filter((e) => e.type === 'action' || e.type === 'assertion');
      const tail = meaningful.slice(-maxSteps);
      failureHierarchyXml = failedStepHierarchy(events, files, primaryError(String(meta.error ?? '')));

      for (const event of tail) {
        const status = event.error ? 'FAIL' : 'OK';
        const shownDuration = event.wallDuration ?? event.duration;
        const dur = shownDuration ? ` (${shownDuration}ms)` : '';
        if (event.type === 'action') {
          const sel = event.selector ? ` on ${event.selector}` : '';
          steps.push(`[${status}] ${who(event)}${event.action ?? 'action'}${sel}${dur}`);
        } else if (event.type === 'assertion') {
          steps.push(`[${status}] ${who(event)}expect ${event.assertion ?? 'assertion'}${dur}`);
          if (event.error) {
            if (event.expected !== undefined) steps.push(`  Expected: ${JSON.stringify(event.expected)}`);
            if (event.actual !== undefined) steps.push(`  Actual: ${JSON.stringify(event.actual)}`);
          }
        }
      }

      if (meaningful.length > maxSteps) {
        steps.unshift(`... ${meaningful.length - maxSteps} earlier step(s) omitted`);
      }

      // Extract error/warn device logs (capped)
      const maxDeviceLogs = 20;
      const deviceLogEvents = events.filter(
        (e) => e.type === 'console' && e.source === 'device' && (e.level === 'error' || e.level === 'warn'),
      );
      const deviceLogTail = deviceLogEvents.slice(-maxDeviceLogs);
      for (const ev of deviceLogTail) {
        deviceLogs.push(`[${ev.level?.toUpperCase()}] ${who(ev)}${ev.message ?? ''}`);
      }
      if (deviceLogEvents.length > maxDeviceLogs) {
        deviceLogs.unshift(`... ${deviceLogEvents.length - maxDeviceLogs} earlier device log(s) omitted`);
      }
    }

    // Find failure screenshot (last screenshot in the archive)
    let failureScreenshot: Buffer | undefined;
    const screenshotNames = Object.keys(files)
      .filter((name) => name.startsWith('screenshots/') && name.endsWith('.png'))
      .sort();
    if (screenshotNames.length > 0) {
      const last = screenshotNames[screenshotNames.length - 1];
      failureScreenshot = Buffer.from(files[last]);
    }

    return { steps, deviceLogs, failureScreenshot, failureHierarchyXml, multiDevice };
  } catch {
    return undefined;
  }
}
