import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync } from 'fflate';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { traceFormatProblem } from '../../trace/trace-format.js';

export function registerReadTraceTool(server: McpServer): void {
  server.tool(
    'tapsmith_read_trace',
    'Read a Tapsmith trace archive (.zip) and get step-by-step test execution data. Returns actions with their locators, durations, and pass/fail status. Use to debug why a test failed.',
    {
      path: z.string().describe('Path to the trace .zip file'),
      include_screenshots: z.boolean().optional().describe('Include base64 screenshots for each step (default false)'),
      device_logs: z.enum(['errors', 'all', 'none']).optional().describe('Include device logs: "errors" for error/warn only (default), "all" for all levels, "none" to exclude'),
    },
    async ({ path: tracePath, include_screenshots, device_logs }) => {
      const resolved = path.resolve(tracePath);
      if (!resolved.endsWith('.zip')) {
        return { content: [{ type: 'text' as const, text: 'Invalid trace path: must be a .zip file' }], isError: true };
      }
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: 'text' as const, text: `Trace file not found: ${resolved}` }], isError: true };
      }

      try {
        const content = readTraceArchive(resolved, include_screenshots ?? false, device_logs ?? 'errors');
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Failed to read trace: ${msg}` }], isError: true };
      }
    },
  );
}

type ContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function readTraceArchive(tracePath: string, includeScreenshots: boolean, deviceLogs: 'errors' | 'all' | 'none'): ContentItem[] {
  const zipData = new Uint8Array(fs.readFileSync(tracePath));
  const files = unzipSync(zipData);
  const lines: string[] = [];

  const decode = (data: Uint8Array) => new TextDecoder().decode(data);

  // Read metadata. The version gate comes first: a newer format may have
  // moved or re-meant any field below, and a misread is worse than a refusal.
  const meta = (files['metadata.json'] ? JSON.parse(decode(files['metadata.json'])) : undefined) as
    | {
      devices?: unknown
      device?: { name?: string; serial?: string; model?: string; platform?: string }
      version?: number
      testFile?: string
      testDuration?: number
      duration?: number
    }
    | undefined;
  const problem = traceFormatProblem(meta);
  if (problem) throw new Error(problem);
  if (meta) {
    lines.push(`## Trace Metadata`);
    // Multi-device traces list every device by its group name — the same
    // name each step below carries — so the steps read as a conversation.
    const devices: Array<{ name?: string; serial?: string; model?: string; platform?: string }> =
      Array.isArray(meta.devices) && meta.devices.length > 1 ? meta.devices : meta.device ? [meta.device] : [];
    for (const d of devices) {
      const who = devices.length > 1 && d.name ? ` ${d.name}` : '';
      lines.push(`Device${who}: ${d.model ?? d.serial ?? 'unknown'} (${d.platform ?? 'unknown'})`);
    }
    if (meta.testFile) {
      // From format v2 the path is relative to the project's rootDir, which the
      // archive does not record — say so, or an agent resolves it against its
      // own working directory and opens the wrong file.
      const relative = (meta.version ?? 1) >= 2 ? " (relative to the project's rootDir)" : '';
      lines.push(`Test: ${meta.testFile}${relative}`);
    }
    // `testDuration` is the archive's field; `duration` was what this read
    // before (never present, so the line never printed).
    const duration = meta.testDuration ?? meta.duration;
    if (duration) lines.push(`Duration: ${duration}ms`);
    lines.push('');
  }

  // Read trace events
  if (files['trace.json']) {
    const traceData = decode(files['trace.json']);
    const events = traceData.split('\n').filter(Boolean).map((line: string) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    lines.push(`## Steps (${events.length} events)`);
    lines.push('');

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const status = event.error ? 'FAIL' : 'OK';
      const duration = event.duration ? ` (${event.duration}ms)` : '';
      // Which device acted, for a two-user test's interleaved steps.
      const who = event.deviceId ? `${event.deviceId}: ` : '';

      if (event.type === 'action') {
        lines.push(`${i + 1}. [${status}] ${who}${event.action ?? 'action'}${duration}`);
        if (event.selector) lines.push(`   Locator: ${event.selector}`);
        if (event.error) lines.push(`   Error: ${event.error}`);
      } else if (event.type === 'assertion') {
        lines.push(`${i + 1}. [${status}] ${who}expect ${event.assertion ?? 'assertion'}${duration}`);
        if (event.expected !== undefined) lines.push(`   Expected: ${event.expected}`);
        if (event.actual !== undefined) lines.push(`   Actual: ${event.actual}`);
        if (event.error) lines.push(`   Error: ${event.error}`);
      } else if (event.type === 'group-start') {
        lines.push(`\n### ${event.title ?? 'Test'}`);
      }
    }

    // Device logs
    if (deviceLogs !== 'none') {
      const isErrorOnly = deviceLogs === 'errors';
      const logEvents = events.filter((e: Record<string, unknown>) =>
        e.type === 'console' && e.source === 'device'
        && (!isErrorOnly || e.level === 'error' || e.level === 'warn'),
      );
      // One section per device in a multi-device trace; the untagged bucket
      // is the single device of an ordinary run.
      const byDevice = new Map<string | undefined, Record<string, unknown>[]>();
      for (const ev of logEvents) {
        const key = ev.deviceId as string | undefined;
        const bucket = byDevice.get(key) ?? [];
        bucket.push(ev);
        byDevice.set(key, bucket);
      }
      for (const [deviceId, bucket] of byDevice) {
        const cap = isErrorOnly ? 50 : 200;
        const shown = bucket.slice(-cap);
        lines.push('');
        lines.push(`## Device Logs${deviceId ? ` — ${deviceId}` : ''} (${bucket.length} entries${bucket.length > cap ? `, showing last ${cap}` : ''})`);
        lines.push('');
        for (const ev of shown) {
          lines.push(`[${(ev.level as string)?.toUpperCase()}] ${ev.message ?? ''}`);
        }
      }
    }
  }

  const content: ContentItem[] = [{ type: 'text', text: lines.join('\n') }];

  if (includeScreenshots) {
    const screenshotNames = Object.keys(files)
      .filter(name => name.startsWith('screenshots/') && name.endsWith('.png'))
      .sort();
    for (const name of screenshotNames) {
      const label = path.basename(name, '.png');
      content.push({ type: 'text', text: `\n### Screenshot: ${label}` });
      content.push({
        type: 'image',
        data: Buffer.from(files[name]).toString('base64'),
        mimeType: 'image/png',
      });
    }
  }

  return content;
}
