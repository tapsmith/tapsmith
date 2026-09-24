/**
 * Programmatic tracing API.
 *
 * Provides start/stop/chunk control over trace recording, mirroring
 * Playwright's `page.context().tracing` API.
 *
 * Usage:
 *   await device.tracing.start()
 *   // ... perform actions ...
 *   await device.tracing.stop({ path: 'trace.zip' })
 */

import type { TraceConfig } from './types.js';
import { resolveTraceConfig } from './types.js';
import { TraceCollector } from './trace-collector.js';
import { packageTrace, type PackageOptions } from './trace-packager.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── Types ───

export interface TracingStartOptions {
  /** Enable screenshot capture. Default: true. */
  screenshots?: boolean
  /** Enable view hierarchy snapshots. Default: true. */
  snapshots?: boolean
  /** Include test source files. Default: true. */
  sources?: boolean
  /** Custom title for the trace. */
  title?: string
}

export interface TracingStopOptions {
  /** Path to write the trace zip. If not specified, uses default output dir. */
  path?: string
}

// ─── Tracing class ───

export class Tracing {
  private _collector: TraceCollector | null = null;
  private _startTime = 0;
  private _title?: string;
  /**
   * @internal — Project root the archive's paths are made relative to. Set by
   * the runner from `config.rootDir`; outside the runner (a standalone
   * script) the working directory stands in for it.
   */
  _rootDir?: string;
  /**
   * @internal — Test file the runner is executing, recorded as the archive's
   * `testFile`. It also seeds the path mapper, so a symlinked test directory
   * is spelled the way the runner's own trace spells it.
   */
  _testFile?: string;
  private _getScreenshot: () => Promise<Buffer | undefined>;
  private _getHierarchy: () => Promise<string | undefined>;

  /** @internal */
  constructor(
    getScreenshot: () => Promise<Buffer | undefined>,
    getHierarchy: () => Promise<string | undefined>,
  ) {
    this._getScreenshot = getScreenshot;
    this._getHierarchy = getHierarchy;
  }

  /** Whether tracing is currently active. */
  get isActive(): boolean {
    return this._collector !== null;
  }

  /** @internal — Get the current collector (used by device action wrappers). */
  get _currentCollector(): TraceCollector | null {
    return this._collector;
  }

  /**
   * Start tracing. Must be called before performing any actions that should
   * be recorded.
   */
  async start(options?: TracingStartOptions): Promise<void> {
    if (this._collector) {
      throw new Error('Tracing is already started. Call stop() before starting again.');
    }

    const config: TraceConfig = resolveTraceConfig({
      mode: 'on',
      screenshots: options?.screenshots ?? true,
      snapshots: options?.snapshots ?? true,
      sources: options?.sources ?? true,
      attachments: true,
    });

    this._startTime = Date.now();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-'));
    this._collector = new TraceCollector(config, tempDir, this._startTime);
    this._collector.startConsoleCapture();
    this._title = options?.title;
  }

  /**
   * Stop tracing and optionally write the trace archive.
   */
  async stop(options?: TracingStopOptions): Promise<string | undefined> {
    if (!this._collector) {
      throw new Error('Tracing is not started. Call start() first.');
    }

    const collector = this._collector;
    collector.stopConsoleCapture();
    this._collector = null;

    if (!options?.path) {
      collector.cleanup();
      return undefined;
    }

    const outputDir = path.dirname(options.path);
    const version = await getVersion();

    const packageOptions: PackageOptions = {
      testFile: this._testFile ?? '',
      // Snapshot the named test file even when no frame reached it, as the
      // runner's own traces do (packageTrace only reads it with sources on).
      ...(this._testFile ? { sourceFiles: [this._testFile] } : {}),
      testName: this._title ?? 'manual-trace',
      testStatus: 'passed',
      testDuration: Date.now() - this._startTime,
      startTime: this._startTime,
      endTime: Date.now(),
      device: {
        serial: 'unknown',
        isEmulator: false,
      },
      tapsmithVersion: version,
      outputDir,
      rootDir: this._rootDir ?? process.cwd(),
    };

    const zipPath = packageTrace(collector, packageOptions);

    // Rename to the requested path if different
    if (zipPath !== options.path) {
      fs.renameSync(zipPath, options.path);
      return options.path;
    }

    return zipPath;
  }

  /**
   * Start a new trace chunk. The previous chunk is finalized and a new
   * recording begins.
   */
  async startChunk(options?: TracingStartOptions): Promise<void> {
    if (this._collector) {
      // Stop current recording (discard data)
      this._collector.stopConsoleCapture();
      this._collector.cleanup();
    }

    await this.start(options);
  }

  /**
   * Stop the current chunk and write it to disk.
   */
  async stopChunk(options?: TracingStopOptions): Promise<string | undefined> {
    return this.stop(options);
  }

  /**
   * Start a named group for organizing actions in the trace viewer.
   */
  group(name: string): void {
    this._collector?.startGroup(name);
  }

  /**
   * End the current group.
   */
  groupEnd(): void {
    this._collector?.endGroup();
  }

  // ── Internal helpers ──

  /** @internal — Create a collector for runner-managed tracing. */
  _startManaged(config: TraceConfig, tempDir: string): TraceCollector {
    if (this._collector) {
      this._collector.stopConsoleCapture();
      this._collector.cleanup();
    }

    this._startTime = Date.now();
    this._collector = new TraceCollector(config, tempDir, this._startTime);
    this._collector.startConsoleCapture();
    return this._collector;
  }

  /** @internal — Stop managed tracing and return the collector for packaging. */
  _stopManaged(): TraceCollector | null {
    const collector = this._collector;
    if (collector) {
      collector.stopConsoleCapture();
    }
    this._collector = null;
    return collector;
  }

  /** @internal */
  get _screenshotFn(): () => Promise<Buffer | undefined> {
    return this._getScreenshot;
  }

  /** @internal */
  get _hierarchyFn(): () => Promise<string | undefined> {
    return this._getHierarchy;
  }
}

async function getVersion(): Promise<string> {
  try {
    const pkgPath = path.resolve(import.meta.dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
