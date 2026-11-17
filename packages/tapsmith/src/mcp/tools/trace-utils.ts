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
  hasHierarchyAfter?: boolean
}

export interface FailedStep {
  kind: 'action' | 'assertion'
  /**
   * The screen (hierarchy XML) the trace captured for the step, if any: for
   * a failed action, when it failed; for an assertion, when it started
   * (assertions take no capture when they fail).
   */
  hierarchyXml?: string
  /** Whether any action or assertion (a hook's included) follows it in the trace. */
  stepsAfter: boolean
}

export interface TraceSummary {
  steps: string[]
  deviceLogs: string[]
  failureScreenshot?: Buffer
  /**
   * The test's failed step: its last failed action or assertion outside the
   * `afterEach`/`afterAll` hooks. Absent when the trace has none.
   */
  failedStep?: FailedStep
  /** Whether the trace was recorded on a device group (`use.devices`). */
  multiDevice: boolean
}

/** Whether `metadata.json` lists more than one device (a `use.devices` trace). */
function isMultiDeviceTrace(metadataJson: string | undefined): boolean {
  if (!metadataJson) return false;
  try {
    const meta = JSON.parse(metadataJson) as { devices?: unknown };
    return Array.isArray(meta.devices) && meta.devices.length > 1;
  } catch {
    return false;
  }
}

/** Groups whose steps run after the test's own: a failure there is not the test's. */
const AFTER_HOOK_GROUPS = new Set(['afterEach Hooks', 'afterAll Hooks']);

/** The test's failed step (see {@link TraceSummary.failedStep}). */
function failedStepOf(events: TraceEvent[], files: Record<string, Uint8Array>): FailedStep | undefined {
  const open: string[] = [];
  let failed: TraceEvent | undefined;
  let stepsAfter = false;
  for (const e of events) {
    if (e.type === 'group-start') open.push(e.name ?? '');
    else if (e.type === 'group-end') open.pop();
    else if (e.type === 'action' || e.type === 'assertion') {
      if (e.error && !open.some((g) => AFTER_HOOK_GROUPS.has(g))) {
        failed = e;
        stepsAfter = false;
      } else if (failed) {
        stepsAfter = true;
      }
    }
  }
  if (!failed) return undefined;
  let hierarchyXml: string | undefined;
  if (failed.actionIndex !== undefined) {
    const positions: ('before' | 'after')[] = [];
    if (failed.hasHierarchyAfter) positions.push('after');
    if (failed.hasHierarchyBefore) positions.push('before');
    for (const position of positions) {
      const file = files[hierarchyArchivePath(failed.actionIndex, position)];
      if (file) {
        hierarchyXml = new TextDecoder().decode(file);
        break;
      }
    }
  }
  return { kind: failed.type === 'assertion' ? 'assertion' : 'action', hierarchyXml, stepsAfter };
}

export function readTraceSummary(tracePath: string, maxSteps = 10): TraceSummary | undefined {
  try {
    if (!fs.existsSync(tracePath)) return undefined;
    const zipData = new Uint8Array(fs.readFileSync(tracePath));
    const files = unzipSync(zipData);
    const decode = (data: Uint8Array) => new TextDecoder().decode(data);

    const steps: string[] = [];
    const deviceLogs: string[] = [];
    let failedStep: FailedStep | undefined;

    // A trace recorded on a device group names the device on every step and
    // log line (`bob: tap`), the way tapsmith_read_trace does — a two-user
    // failure otherwise reads with no owner. Single-device traces are unchanged.
    const multiDevice = isMultiDeviceTrace(files['metadata.json'] ? decode(files['metadata.json']) : undefined);
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
      failedStep = failedStepOf(events, files);

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

    return { steps, deviceLogs, failureScreenshot, failedStep, multiDevice };
  } catch {
    return undefined;
  }
}
