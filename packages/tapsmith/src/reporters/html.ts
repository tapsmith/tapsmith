/**
 * HTML reporter — self-contained interactive web report.
 *
 * Generates a single HTML file with an embedded test report that includes
 * filtering by status, test details with errors and screenshots, and
 * summary statistics. No external dependencies required to view.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractStack } from '../trace/trace-collector.js';
import { errorStackFrames } from './base.js';
import type { TapsmithReporter, FullResult } from '../reporter.js';
import type { TapsmithConfig } from '../config.js';
type OpenMode = 'always' | 'never' | 'on-failure'

export class HtmlReporter implements TapsmithReporter {
  private _outputFolder: string;
  private _open: OpenMode;
  private _config?: TapsmithConfig;
  private _startTime = new Date();

  constructor(options: Record<string, unknown> = {}) {
    this._outputFolder = (options.outputFolder as string) ?? 'tapsmith-report';
    this._open = (options.open as OpenMode) ?? 'on-failure';
  }

  onRunStart(config: TapsmithConfig, _fileCount: number): void {
    this._config = config;
    this._startTime = new Date();
  }

  async onRunEnd(result: FullResult): Promise<void> {
    const rootDir = this._config?.rootDir ?? process.cwd();
    const outputDir = path.resolve(rootDir, this._outputFolder);
    fs.mkdirSync(outputDir, { recursive: true });

    // Copy screenshots to report folder
    const screenshotMap = new Map<string, string>();
    for (const test of result.tests) {
      if (test.screenshotPath && fs.existsSync(test.screenshotPath)) {
        const basename = path.basename(test.screenshotPath);
        const dest = path.join(outputDir, basename);
        fs.copyFileSync(test.screenshotPath, dest);
        screenshotMap.set(test.screenshotPath, basename);
      }
    }

    // Copy trace zips to report folder
    const traceMap = new Map<string, string>();
    for (const test of result.tests) {
      if (test.tracePath && fs.existsSync(test.tracePath)) {
        const basename = path.basename(test.tracePath);
        const dest = path.join(outputDir, basename);
        fs.copyFileSync(test.tracePath, dest);
        traceMap.set(test.tracePath, basename);
      }
    }

    // Copy video MP4s to report folder (PILOT-114)
    const videoMap = new Map<string, string>();
    for (const test of result.tests) {
      if (test.videoPath && fs.existsSync(test.videoPath)) {
        try {
          const basename = path.basename(test.videoPath);
          const dest = path.join(outputDir, basename);
          await fs.promises.copyFile(test.videoPath, dest);
          videoMap.set(test.videoPath, basename);
        } catch (err) {
          console.warn(`[HtmlReporter] Failed to copy video ${test.videoPath}:`, err);
        }
      }
    }

    const html = generateHtml(result, this._startTime, screenshotMap, traceMap, videoMap);
    const indexPath = path.join(outputDir, 'index.html');
    fs.writeFileSync(indexPath, html);

    const hasFailed = result.tests.some((t) => t.status === 'failed');
    const shouldOpen =
      this._open === 'always' || (this._open === 'on-failure' && hasFailed);

    if (shouldOpen) {
      try {
        const { spawn } = await import('node:child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(cmd, [indexPath], { detached: true, stdio: 'ignore' }).unref();
      } catch {
        // Best-effort open
      }
    }

    process.stderr.write(`HTML report written to ${indexPath}\n`);
  }
}

function generateHtml(
  result: FullResult,
  startTime: Date,
  screenshotMap: Map<string, string>,
  traceMap: Map<string, string>,
  videoMap: Map<string, string>,
): string {
  const passed = result.tests.filter((t) => t.status === 'passed').length;
  const failed = result.tests.filter((t) => t.status === 'failed').length;
  const skipped = result.tests.filter((t) => t.status === 'skipped').length;
  const duration = (result.duration / 1000).toFixed(2);

  const testRows = result.tests.map((t) => {
    const screenshotFile = t.screenshotPath ? screenshotMap.get(t.screenshotPath) : null;
    const traceFile = t.tracePath ? traceMap.get(t.tracePath) : null;
    const videoFile = t.videoPath ? videoMap.get(t.videoPath) : null;
    // Flaky (passed-on-retry) tests carry the first failed attempt's error;
    // surface it the same way as a failure so the flake is diagnosable.
    const displayError = t.error ?? t.firstAttemptError;
    return {
      name: escapeHtml(t.fullName),
      status: t.status,
      flaky: t.status === 'passed' && (t.retry ?? 0) > 0,
      duration: t.durationMs,
      error: displayError ? escapeHtml(displayError.message) : null,
      stack: displayError?.stack ? escapeHtml(errorStackFrames(displayError, 5).join('\n')) || null : null,
      codeSnippet: displayError?.stack ? extractCodeSnippetForHtml(displayError) : null,
      screenshot: screenshotFile,
      trace: traceFile,
      video: videoFile,
      project: t.project || null,
      warnings: (t.warnings ?? []).map(escapeHtml),
    };
  });

  const testDataJson = JSON.stringify(testRows);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tapsmith Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; color: #333; padding: 20px; }
  .header { background: #1a1a2e; color: white; padding: 24px; border-radius: 8px; margin-bottom: 20px; }
  .header h1 { font-size: 24px; margin-bottom: 12px; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat { text-align: center; }
  .stat-value { font-size: 28px; font-weight: bold; }
  .stat-label { font-size: 12px; opacity: 0.7; text-transform: uppercase; }
  .stat-passed .stat-value { color: #4caf50; }
  .stat-failed .stat-value { color: #f44336; }
  .stat-skipped .stat-value { color: #ff9800; }
  .filters { margin-bottom: 16px; display: flex; gap: 8px; }
  .filter-btn { padding: 6px 16px; border: 1px solid #ddd; border-radius: 20px; background: white; cursor: pointer; font-size: 13px; }
  .filter-btn.active { background: #1a1a2e; color: white; border-color: #1a1a2e; }
  .filter-btn:hover { background: #e0e0e0; }
  .filter-btn.active:hover { background: #2a2a4e; }
  .search { margin-bottom: 16px; }
  .search input { width: 100%; padding: 10px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; }
  .test-list { list-style: none; }
  .test-item { background: white; border-radius: 8px; margin-bottom: 8px; overflow: hidden; border: 1px solid #e0e0e0; }
  .test-header { padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 12px; }
  .test-header:hover { background: #fafafa; }
  .test-icon { width: 24px; font-size: 16px; text-align: center; }
  .test-name { flex: 1; font-size: 14px; }
  .test-duration { font-size: 12px; color: #999; }
  .test-details { padding: 0 16px 16px; border-top: 1px solid #f0f0f0; display: none; }
  .test-details.open { display: block; padding-top: 12px; }
  .warning-msg { background: #fff8e1; border-left: 3px solid #f9a825; padding: 8px 12px; font-size: 13px; margin-bottom: 8px; border-radius: 0 4px 4px 0; }
  .error-msg { background: #fff3f3; border-left: 3px solid #f44336; padding: 12px; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-bottom: 8px; border-radius: 0 4px 4px 0; }
  .code-snippet { background: #1e1e2e; border-radius: 6px; padding: 0; margin-bottom: 8px; overflow-x: auto; font-family: 'SF Mono', Menlo, Monaco, Consolas, monospace; font-size: 12px; line-height: 1.6; }
  .code-snippet .code-file { padding: 8px 12px; background: #2a2a3e; color: #a0a0c0; font-size: 11px; border-radius: 6px 6px 0 0; }
  .code-snippet .code-lines { padding: 8px 0; }
  .code-line { display: flex; }
  .code-line .gutter { width: 48px; text-align: right; padding-right: 12px; color: #555; user-select: none; flex-shrink: 0; }
  .code-line .code { padding-right: 12px; color: #ccc; white-space: pre; }
  .code-line.highlight { background: rgba(244,67,54,0.15); }
  .code-line.highlight .gutter { color: #f44336; }
  .code-line.highlight .code { color: #fff; }
  .stack-trace { background: #f8f8f8; padding: 12px; font-family: monospace; font-size: 12px; white-space: pre-wrap; color: #666; border-radius: 4px; }
  .screenshot { margin-top: 12px; }
  .screenshot img { max-width: 400px; border: 1px solid #ddd; border-radius: 4px; cursor: pointer; }
  .screenshot img:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
  .video-section { margin-top: 12px; }
  .video-section video { max-width: 400px; border: 1px solid #ddd; border-radius: 4px; background: black; display: block; }
  .video-section a { display: inline-block; margin-top: 6px; font-size: 12px; color: #555; text-decoration: none; }
  .video-section a:hover { color: #1a1a2e; text-decoration: underline; }
  .video-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #00b894; color: white; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 6px; }
  .trace-section { margin-top: 12px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .trace-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; background: #6c5ce7; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; text-decoration: none; transition: background 0.15s; }
  .trace-btn:hover { background: #5a4bd1; }
  .trace-btn svg { width: 16px; height: 16px; fill: currentColor; }
  .trace-cmd { display: inline-block; margin-top: 6px; padding: 6px 12px; background: #f8f8f8; border: 1px solid #e0e0e0; border-radius: 4px; font-family: monospace; font-size: 12px; color: #555; cursor: pointer; width: 100%; }
  .trace-cmd:hover { background: #f0f0f0; }
  .trace-cmd-copied { background: #e8f5e9; border-color: #a5d6a7; }
  .project-badge { display: inline-block; padding: 1px 6px; background: #dfe6e9; color: #636e72; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .trace-badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: #6c5ce7; color: white; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 8px; }
  .flaky-badge { display: inline-flex; align-items: center; padding: 2px 8px; background: #ff9800; color: white; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 8px; }
  .status-passed { color: #4caf50; }
  .status-failed { color: #f44336; }
  .status-skipped { color: #ff9800; }
</style>
</head>
<body>
<div class="header">
  <h1>Tapsmith Test Report</h1>
  <p style="opacity:0.7;margin-bottom:12px">${escapeHtml(startTime.toLocaleString())} &middot; ${duration}s</p>
  <div class="stats">
    <div class="stat stat-passed"><div class="stat-value">${passed}</div><div class="stat-label">Passed</div></div>
    <div class="stat stat-failed"><div class="stat-value">${failed}</div><div class="stat-label">Failed</div></div>
    <div class="stat stat-skipped"><div class="stat-value">${skipped}</div><div class="stat-label">Skipped</div></div>
    <div class="stat"><div class="stat-value">${result.tests.length}</div><div class="stat-label">Total</div></div>
  </div>
</div>

<div class="filters">
  <button class="filter-btn active" data-filter="all">All (${result.tests.length})</button>
  <button class="filter-btn" data-filter="passed">Passed (${passed})</button>
  <button class="filter-btn" data-filter="failed">Failed (${failed})</button>
  <button class="filter-btn" data-filter="skipped">Skipped (${skipped})</button>
</div>

<div class="search">
  <input type="text" id="search" placeholder="Filter tests by name...">
</div>

<ul class="test-list" id="test-list"></ul>

<script>
const tests = ${testDataJson};

function render(filter, query) {
  const list = document.getElementById('test-list');
  list.innerHTML = '';
  const q = (query || '').toLowerCase();
  tests.forEach(function(t, i) {
    if (filter !== 'all' && t.status !== filter) return;
    if (q && t.name.toLowerCase().indexOf(q) === -1) return;
    var icon = t.status === 'passed' ? '✓' : t.status === 'failed' ? '✗' : '○';
    var dur = t.duration < 1000 ? t.duration + 'ms' : (t.duration/1000).toFixed(1) + 's';
    var li = document.createElement('li');
    li.className = 'test-item';
    var header = '<div class="test-header" onclick="toggle(' + i + ')">';
    header += '<span class="test-icon status-' + t.status + '">' + icon + '</span>';
    header += '<span class="test-name">';
    if (t.project) header += '<span class="project-badge">' + t.project + '</span> ';
    header += t.name;
    if (t.flaky) header += '<span class="flaky-badge">flaky</span>';
    if (t.trace) header += '<span class="trace-badge">&#9654; Trace</span>';
    if (t.video) header += '<span class="video-badge">&#9210; Video</span>';
    header += '</span>';
    header += '<span class="test-duration">' + dur + '</span></div>';
    var details = '<div class="test-details" id="details-' + i + '">';
    if (t.trace && t.status === 'failed') {
      details += '<div class="trace-section">';
      details += '<a class="trace-btn" href="' + t.trace + '" download><svg viewBox="0 0 24 24"><path d="M13 3v9.59l3.3-3.3 1.4 1.42L12 16.41l-5.7-5.7 1.4-1.42L11 12.59V3h2zM4 19v2h16v-2H4z"/></svg>Download Trace</a>';
      details += '</div>';
      details += '<div class="trace-cmd" onclick="copyCmd(this)" title="Click to copy">npx tapsmith show-trace ' + t.trace + '</div>';
    }
    if (t.error) details += '<div class="error-msg">' + t.error + '</div>';
    (t.warnings || []).forEach(function(w) { details += '<div class="warning-msg">⚠ ' + w + '</div>'; });
    if (t.codeSnippet) {
      details += '<div class="code-snippet"><div class="code-file">' + t.codeSnippet.file + '</div><div class="code-lines">';
      t.codeSnippet.lines.forEach(function(sl) {
        var cls = sl.highlight ? 'code-line highlight' : 'code-line';
        details += '<div class="' + cls + '"><span class="gutter">' + sl.lineNumber + '</span><span class="code">' + sl.text + '</span></div>';
      });
      details += '</div></div>';
    }
    if (t.stack) details += '<div class="stack-trace">' + t.stack + '</div>';
    if (t.screenshot) details += '<div class="screenshot"><img src="' + t.screenshot + '" onclick="window.open(this.src)"></div>';
    if (t.video) {
      details += '<div class="video-section">';
      details += '<video controls preload="metadata" src="' + t.video + '"></video>';
      details += '<a href="' + t.video + '" download>Download video</a>';
      details += '</div>';
    }
    if (t.trace && t.status !== 'failed') {
      details += '<div class="trace-section">';
      details += '<a class="trace-btn" href="' + t.trace + '" download><svg viewBox="0 0 24 24"><path d="M13 3v9.59l3.3-3.3 1.4 1.42L12 16.41l-5.7-5.7 1.4-1.42L11 12.59V3h2zM4 19v2h16v-2H4z"/></svg>Download Trace</a>';
      details += '</div>';
      details += '<div class="trace-cmd" onclick="copyCmd(this)" title="Click to copy">npx tapsmith show-trace ' + t.trace + '</div>';
    }
    details += '</div>';
    li.innerHTML = header + details;
    list.appendChild(li);
  });
}

function toggle(i) {
  var el = document.getElementById('details-' + i);
  if (el) el.classList.toggle('open');
}

function copyCmd(el) {
  var text = el.textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(function() {
      el.classList.add('trace-cmd-copied');
      var orig = el.textContent;
      el.textContent = 'Copied!';
      setTimeout(function() { el.textContent = orig; el.classList.remove('trace-cmd-copied'); }, 1500);
    });
  }
}

document.querySelectorAll('.filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    render(btn.dataset.filter, document.getElementById('search').value);
  });
});

document.getElementById('search').addEventListener('input', function(e) {
  var active = document.querySelector('.filter-btn.active');
  render(active ? active.dataset.filter : 'all', e.target.value);
});

render('all', '');
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface HtmlSnippetLine {
  lineNumber: number
  text: string
  highlight: boolean
}

function extractCodeSnippetForHtml(
  error: Error,
): { file: string; lines: HtmlSnippetLine[] } | null {
  if (!error.stack) return null;

  // extractStack owns the framework-frame classification: it skips tapsmith
  // internals in both layouts (packages/tapsmith/* in the monorepo,
  // node_modules/* for npm installs) plus node internals.
  const userLoc = extractStack(error.stack)[0];
  if (!userLoc) return null;

  const filePath = userLoc.file;
  const lineNum = userLoc.line;

  try {
    if (!fs.existsSync(filePath)) return null;
    const source = fs.readFileSync(filePath, 'utf-8');
    const sourceLines = source.split('\n');

    const contextSize = 2;
    const start = Math.max(0, lineNum - 1 - contextSize);
    const end = Math.min(sourceLines.length, lineNum + contextSize);

    const lines: HtmlSnippetLine[] = [];
    for (let i = start; i < end; i++) {
      lines.push({
        lineNumber: i + 1,
        text: escapeHtml(sourceLines[i]),
        highlight: i + 1 === lineNum,
      });
    }

    // Show a relative path for the header
    const cwd = process.cwd();
    const relFile = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;

    return { file: escapeHtml(`${relFile}:${lineNum}`), lines };
  } catch {
    return null;
  }
}
