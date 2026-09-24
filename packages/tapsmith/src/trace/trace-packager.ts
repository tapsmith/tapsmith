/**
 * Trace archive packager.
 *
 * Builds a .zip archive from trace collector data. Uses fflate for
 * streaming zip construction to avoid holding all screenshots in memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { TraceCollector, HierarchyCapture } from './trace-collector.js';
import { collectReferencedFiles } from './trace-collector.js';
import type { TraceMetadata, TraceDeviceInfo, NetworkEntry } from './types.js';
import { TRACE_FORMAT_VERSION } from './trace-format.js';
import { archivePathMapper, withPortablePaths, type ArchivePathMapper } from './archive-paths.js';

export interface PackageOptions {
  /** Test file path. Recorded relative to `rootDir`. */
  testFile: string
  /** Fully qualified test name. */
  testName: string
  /** Test status. */
  testStatus: 'passed' | 'failed' | 'skipped'
  /** Test duration in ms. */
  testDuration: number
  /** Start timestamp. */
  startTime: number
  /** End timestamp. */
  endTime: number
  /** Device information. */
  device: TraceDeviceInfo
  /** Every device of a multi-device test, primary first; written when there is more than one. */
  devices?: TraceDeviceInfo[]
  /** Tapsmith SDK version. */
  tapsmithVersion: string
  /** Error message if test failed. */
  error?: string
  /** Output directory for the trace zip. */
  outputDir: string
  /**
   * Project root (`config.rootDir`). Every local path the archive records —
   * `testFile`, `appState`, stack frames, `sources.json` keys — is written
   * relative to it, so the archive does not depend on where it was recorded.
   */
  rootDir: string
  /** Test source files to include. */
  sourceFiles?: string[]
  /** Captured network entries to include. */
  networkEntries?: NetworkEntry[]
  /** Project name this test belongs to. */
  project?: string
  /** Path to the app state archive restored before this test. */
  appState?: string
  /** Declared app reset mode / scope for this test (see TapsmithConfig.appReset). */
  appReset?: string
  appResetScope?: string
  /** Zero-based attempt number; retries get a `-retryN` filename suffix. */
  retry?: number
}

/** Screenshot members in a zip — what `metadata.screenshotCount` reports. */
function countScreenshotMembers(zipData: Zippable): number {
  return Object.keys(zipData).filter((name) => name.startsWith('screenshots/')).length;
}

/** Per-file cap on snapshotted sources, to keep the archive small. */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Snapshot `files` into `sources`, keyed by archive path, skipping any key
 * already present and any file that is missing, unreadable, or over the cap.
 * Returns whether anything was added.
 */
function snapshotSources(
  sources: Record<string, string>,
  files: Iterable<string>,
  toPath: ArchivePathMapper,
): boolean {
  let added = false;
  for (const file of files) {
    const key = toPath(file);
    if (key in sources) continue;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
      sources[key] = fs.readFileSync(file, 'utf-8');
      added = true;
    } catch {
      // Skip unreadable / missing source files
    }
  }
  return added;
}

function toNDJSON(events: readonly unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * Build a safe filename from a test name.
 */
function safeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100);
}

/**
 * Package trace data into a .zip archive.
 *
 * @returns The absolute path to the created zip file.
 */
export function packageTrace(
  collector: TraceCollector,
  options: PackageOptions,
): string {
  const zipData: Zippable = {};

  // Allocate teardown/finalization time to the last visible action so the
  // action list's wall-clock durations reconcile with metadata.testDuration.
  collector.finalizeTimeline(options.endTime);

  // Every local path goes in rootDir-relative. The test file and explicit
  // sources are the lexical spellings the frames are mapped back to.
  const knownFiles = [options.testFile, ...(options.sourceFiles ?? [])]
    .filter(Boolean)
    .map((f) => path.resolve(options.rootDir, f));
  const toPath = archivePathMapper(options.rootDir, knownFiles);

  // 1. trace.json — NDJSON event log
  const events = withPortablePaths(collector.events, toPath);
  zipData['trace.json'] = new TextEncoder().encode(toNDJSON(events));

  // 2. metadata.json
  const metadata: TraceMetadata = {
    version: TRACE_FORMAT_VERSION,
    tapsmithVersion: options.tapsmithVersion,
    testFile: toPath(options.testFile),
    testName: options.testName,
    testStatus: options.testStatus,
    testDuration: options.testDuration,
    startTime: options.startTime,
    endTime: options.endTime,
    device: options.device,
    ...(options.devices && options.devices.length > 1 ? { devices: options.devices } : {}),
    traceConfig: {
      screenshots: collector.config.screenshots,
      snapshots: collector.config.snapshots,
      sources: collector.config.sources,
      network: collector.config.network,
      deviceLogs: collector.config.deviceLogs,
      daemonLogs: collector.config.daemonLogs,
    },
    actionCount: collector.currentActionIndex,
    screenshotCount: 0, // set below, once the screenshots are written
    error: options.error,
    project: options.project,
    appState: options.appState ? toPath(options.appState) : undefined,
    appReset: options.appReset,
    appResetScope: options.appResetScope,
  };

  // 3. Screenshots — before metadata.json is encoded, so screenshotCount is
  //    the members actually written: a vanished temp file is skipped, and two
  //    captures sharing a path are one member.
  for (const screenshot of collector.screenshots) {
    try {
      const data = fs.readFileSync(screenshot.diskPath);
      zipData[screenshot.archivePath] = new Uint8Array(data);
    } catch {
      // Skip missing screenshots
    }
  }
  metadata.screenshotCount = countScreenshotMembers(zipData);
  zipData['metadata.json'] = new TextEncoder().encode(
    JSON.stringify(metadata, null, 2),
  );

  // 4. Hierarchy XML snapshots
  for (const hierarchy of collector.hierarchies as HierarchyCapture[]) {
    zipData[hierarchy.archivePath] = new TextEncoder().encode(hierarchy.xml);
  }

  // 5. Source files (optional) — snapshot every file referenced by an action's
  //    stack, so the Source tab shows the exact code that ran. Keyed by the
  //    same rootDir-relative path the frames carry. Capped per file to keep
  //    the archive small.
  if (collector.config.sources) {
    // Relative paths are rootDir-relative, as toArchivePath reads them.
    const referenced = [...(options.sourceFiles ?? []), ...collectReferencedFiles(collector.events)]
      .map((f) => path.resolve(options.rootDir, f));
    const sources: Record<string, string> = {};
    if (snapshotSources(sources, referenced, toPath)) {
      zipData['sources.json'] = new TextEncoder().encode(JSON.stringify(sources));
    }
  }

  // 6. Network entries (optional)
  if (options.networkEntries && options.networkEntries.length > 0) {
    // Write body files into the archive and set paths
    for (const entry of options.networkEntries) {
      if (entry.requestBody && entry.requestBody.length > 0) {
        const bodyPath = `network/req-${entry.index}.bin`;
        zipData[bodyPath] = new Uint8Array(entry.requestBody);
        entry.requestBodyPath = bodyPath;
      }
      if (entry.responseBody && entry.responseBody.length > 0) {
        const bodyPath = `network/res-${entry.index}.bin`;
        zipData[bodyPath] = new Uint8Array(entry.responseBody);
        entry.responseBodyPath = bodyPath;
      }
    }

    // Serialize entries without transient body fields
    const networkNdjson = options.networkEntries
      .map((e) => {
        const { requestBody: _rb, responseBody: _rsb, ...rest } = e;
        return JSON.stringify(rest);
      })
      .join('\n') + '\n';
    zipData['network.json'] = new TextEncoder().encode(networkNdjson);
  }

  // Build zip
  const zipped = zipSync(zipData, { level: 6 });

  // Write to output directory
  fs.mkdirSync(options.outputDir, { recursive: true });
  const safeName = safeFileName(options.testName);
  const projectPrefix = options.project ? `${safeFileName(options.project)}-` : '';
  // Retries carry their attempt in the name so a flaky test's failed-attempt
  // and retry traces are distinguishable in CI artifacts.
  const retrySuffix = options.retry ? `-retry${options.retry}` : '';
  const zipPath = path.join(options.outputDir, `trace-${projectPrefix}${safeName}${retrySuffix}-${options.startTime}.zip`);
  fs.writeFileSync(zipPath, zipped);

  // Clean up temporary screenshot files. External captures (replayed from a
  // hook collector) are shared with other tests' collectors and cleaned up by
  // their owning collector after the suite — deleting them here would strip
  // hook screenshots from every later test's archive and live stream.
  for (const screenshot of collector.screenshots) {
    if (screenshot.external) continue;
    try {
      fs.unlinkSync(screenshot.diskPath);
    } catch {
      // best-effort
    }
  }

  return zipPath;
}

/**
 * Read the recorded action count from a packaged trace's metadata.json.
 * Used to offset hook collector action indices so appended events don't
 * collide with the archive's existing actions.
 */
export function readTraceActionCount(zipPath: string): number {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (file) => file.name === 'metadata.json',
  });
  if (!files['metadata.json']) return 0;
  const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json'])) as TraceMetadata;
  return typeof metadata.actionCount === 'number' ? metadata.actionCount : 0;
}

/** Shift the action index embedded in a capture archive path (e.g.
 * `screenshots/action-002-before.png` → index+offset). Paths that don't
 * match the action naming scheme are returned unchanged. */
function shiftArchivePath(archivePath: string, offset: number): string {
  return archivePath.replace(
    /action-(\d+)-(before|after)/,
    (_, idx: string, position: string) =>
      `action-${String(parseInt(idx, 10) + offset).padStart(3, '0')}-${position}`,
  );
}

/**
 * Append a hook collector's events to an existing packaged trace archive.
 *
 * Used for afterAll hooks: by the time they run, the last test's trace has
 * already been packaged, so its zip is rewritten in place with the hook
 * events, screenshots, and hierarchy snapshots appended. The collector
 * records with its own zero-based indices (UI mode live-streams those and
 * shifts client-side); `actionIndexOffset` shifts the appended events and
 * capture paths past the archive's existing actions (see
 * {@link readTraceActionCount}) so nothing collides.
 */
export function appendEventsToTrace(
  zipPath: string,
  collector: TraceCollector,
  endTime: number,
  /** Project root the appended events' paths are made relative to (see PackageOptions.rootDir). */
  rootDir: string,
  actionIndexOffset = 0,
): void {
  if (collector.events.length === 0) return;
  collector.finalizeTimeline(endTime);

  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const zipData: Zippable = { ...files };

  // The archive records the test file rootDir-relative; resolving it again
  // gives the lexical spelling that realpath'd hook frames map back to.
  let recordedTestFile: string | undefined;
  try {
    const recorded = files['metadata.json']
      ? (JSON.parse(decoder.decode(files['metadata.json'])) as { testFile?: unknown }).testFile
      : undefined;
    if (typeof recorded === 'string' && recorded) recordedTestFile = path.resolve(rootDir, recorded);
  } catch {
    // Unparseable metadata — the metadata block below keeps the original too.
  }
  const toPath = archivePathMapper(rootDir, recordedTestFile ? [recordedTestFile] : []);

  const shifted = withPortablePaths(collector.events, toPath).map((e) => ({
    ...e,
    actionIndex: e.actionIndex + actionIndexOffset,
  }));
  const appendedNdjson = toNDJSON(shifted);
  const existing = files['trace.json'] ? decoder.decode(files['trace.json']).trimEnd() : '';
  zipData['trace.json'] = encoder.encode(
    (existing ? existing + '\n' : '') + appendedNdjson,
  );

  for (const screenshot of collector.screenshots) {
    try {
      // Buffer is a Uint8Array — no copy needed for fflate.
      zipData[shiftArchivePath(screenshot.archivePath, actionIndexOffset)] =
        fs.readFileSync(screenshot.diskPath);
    } catch {
      // Skip missing screenshots
    }
  }

  if (files['metadata.json']) {
    try {
      const metadata = JSON.parse(decoder.decode(files['metadata.json'])) as TraceMetadata;
      // Guard each field before arithmetic: a missing or malformed value
      // (older/foreign archive) would otherwise produce NaN, which
      // JSON.stringify serializes as null — silently corrupting the
      // metadata and breaking readTraceActionCount on any later append.
      const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      // Only actions move actionCount — a collector holding just console or
      // error events would otherwise bump it by the offset's +1 slack.
      metadata.actionCount = collector.currentActionIndex > 0
        ? Math.max(
          asNumber(metadata.actionCount),
          actionIndexOffset + collector.currentActionIndex,
        )
        : asNumber(metadata.actionCount);
      metadata.endTime = Math.max(asNumber(metadata.endTime), endTime);
      // The members now in the zip, existing and appended alike.
      metadata.screenshotCount = countScreenshotMembers(zipData);
      zipData['metadata.json'] = encoder.encode(JSON.stringify(metadata, null, 2));
    } catch {
      // Unparseable metadata — keep the original.
    }
  }

  // Frames the hook added may name files the test itself never reached (a
  // cleanup helper); snapshot those too, so every frame still resolves.
  if (collector.config.sources) {
    let sources: Record<string, string> = {};
    try {
      if (files['sources.json']) sources = JSON.parse(decoder.decode(files['sources.json'])) as Record<string, string>;
    } catch {
      // Unparseable sources.json — rebuild it from what the hook references.
      sources = {};
    }
    const referenced = collectReferencedFiles(collector.events).map((f) => path.resolve(rootDir, f));
    if (snapshotSources(sources, referenced, toPath)) {
      zipData['sources.json'] = encoder.encode(JSON.stringify(sources));
    }
  }

  for (const hierarchy of collector.hierarchies) {
    zipData[shiftArchivePath(hierarchy.archivePath, actionIndexOffset)] =
      encoder.encode(hierarchy.xml);
  }

  const zipped = zipSync(zipData, { level: 6 });
  // Write-then-rename so a crash mid-write can't leave a truncated archive.
  const tmpPath = `${zipPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, zipped);
    fs.renameSync(tmpPath, zipPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
