/**
 * Lightweight HTTP server for the `tapsmith show-trace` CLI command.
 *
 * Serves the bundled trace viewer HTML and local trace zip files.
 * Opens the default browser automatically.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLocalHttpServer } from '../local-server-guard.js';

const VIEWER_HTML_PATH = path.resolve(import.meta.dirname, '../trace-viewer/index.html');


export interface ShowTraceOptions {
  /** Path to a local trace zip file. */
  tracePath: string
  /** Port to bind to (0 = ephemeral). */
  port?: number
}

/**
 * Start the trace viewer server, open the browser, and return a cleanup function.
 */
export async function showTrace(options: ShowTraceOptions): Promise<{ port: number; close: () => void }> {
  const { tracePath, port: preferredPort } = options;
  const resolvedTrace = path.resolve(tracePath);

  if (!fs.existsSync(resolvedTrace)) {
    throw new Error(`Trace file not found: ${resolvedTrace}`);
  }

  if (!resolvedTrace.endsWith('.zip')) {
    throw new Error(`Expected a .zip file, got: ${resolvedTrace}`);
  }

  // Check if bundled viewer exists
  let viewerHtml: string;
  if (fs.existsSync(VIEWER_HTML_PATH)) {
    viewerHtml = fs.readFileSync(VIEWER_HTML_PATH, 'utf-8');
  } else {
    // Fallback: minimal viewer that loads the zip
    viewerHtml = buildFallbackViewer();
  }

  // Local requests only: a DNS-rebinding page must not read the trace (PILOT-1215).
  const server = createLocalHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);

    // Serve the viewer HTML
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(viewerHtml);
      return;
    }

    // Serve vendored fflate browser ESM bundle from node_modules
    if (url.pathname === '/vendor/fflate.js') {
      const fflatePath = path.resolve(import.meta.dirname, '../node_modules/fflate/esm/browser.js');
      if (!fs.existsSync(fflatePath)) {
        res.writeHead(404);
        res.end('fflate bundle not found');
        return;
      }
      const stat = fs.statSync(fflatePath);
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Length': stat.size,
      });
      fs.createReadStream(fflatePath).pipe(res);
      return;
    }

    // Serve the trace zip
    if (url.pathname === '/trace.zip') {
      const stat = fs.statSync(resolvedTrace);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
      });
      fs.createReadStream(resolvedTrace).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const actualPort = await new Promise<number>((resolve, reject) => {
    const tryPort = preferredPort ?? 0;
    server.listen(tryPort, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to bind'));
      }
    });
    server.on('error', reject);
  });

  // Open browser
  const viewerUrl = `http://127.0.0.1:${actualPort}/?trace=/trace.zip`;
  try {
    const open = await import('open');
    await open.default(viewerUrl);
  } catch {
    console.log(`Open: ${viewerUrl}`);
  }

  return {
    port: actualPort,
    close: () => server.close(),
  };
}

function buildFallbackViewer(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tapsmith Trace Viewer</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 40px; background: #1a1a2e; color: #e0e0e0; }
    h1 { color: #fff; }
    .loading { color: #888; }
    .info { background: #16213e; border: 1px solid #0f3460; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .meta { display: grid; grid-template-columns: 120px 1fr; gap: 8px; }
    .meta dt { color: #888; }
    .meta dd { margin: 0; }
    .events { margin-top: 20px; }
    .event { padding: 8px 12px; border-left: 3px solid #0f3460; margin: 4px 0; background: #16213e; border-radius: 0 4px 4px 0; font-family: monospace; font-size: 13px; }
    .event.failed { border-left-color: #e74c3c; background: #2c1a1a; }
    .event.assertion { border-left-color: #f39c12; }
    .event.group { border-left-color: #3498db; font-weight: bold; }
    .screenshots { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 20px; }
    .screenshots img { max-width: 300px; border-radius: 4px; border: 1px solid #333; }
  </style>
</head>
<body>
  <h1>Tapsmith Trace Viewer</h1>
  <div id="app" class="loading">Loading trace...</div>
  <script type="module">
    import { unzipSync, strFromU8 } from '/vendor/fflate.js'

    const params = new URLSearchParams(location.search)
    const tracePath = params.get('trace') ?? '/trace.zip'

    async function loadTrace() {
      const resp = await fetch(tracePath)
      if (!resp.ok) throw new Error('Failed to load trace: ' + resp.status)
      const buf = new Uint8Array(await resp.arrayBuffer())
      const files = unzipSync(buf)

      const decoder = new TextDecoder()
      const metadata = JSON.parse(decoder.decode(files['metadata.json']))
      const traceLines = decoder.decode(files['trace.json']).trim().split('\\n').filter(Boolean)
      const events = traceLines.map(line => JSON.parse(line))

      // Collect screenshot URLs
      const screenshots = {}
      for (const [name, data] of Object.entries(files)) {
        if (name.startsWith('screenshots/') && name.endsWith('.png')) {
          screenshots[name] = URL.createObjectURL(new Blob([data], { type: 'image/png' }))
        }
      }

      renderTrace(metadata, events, screenshots)
    }

    function renderTrace(meta, events, screenshots) {
      const app = document.getElementById('app')
      app.className = ''

      const status = meta.testStatus === 'passed' ? '✅' : meta.testStatus === 'skipped' ? '⏭️' : '❌'
      let html = '<div class="info"><dl class="meta">'
      html += '<dt>Test</dt><dd>' + esc(meta.testName) + ' ' + status + '</dd>'
      html += '<dt>File</dt><dd>' + esc(meta.testFile) + '</dd>'
      html += '<dt>Duration</dt><dd>' + meta.testDuration + 'ms</dd>'
      html += '<dt>Device</dt><dd>' + esc(meta.device.serial) + (meta.device.model ? ' (' + esc(meta.device.model) + ')' : '') + '</dd>'
      if (meta.project) html += '<dt>Project</dt><dd>' + esc(meta.project) + '</dd>'
      if (meta.appState) html += '<dt>App State</dt><dd>' + esc(meta.appState) + '</dd>'
      html += '<dt>Actions</dt><dd>' + meta.actionCount + '</dd>'
      html += '<dt>Screenshots</dt><dd>' + meta.screenshotCount + '</dd>'
      if (meta.error) html += '<dt>Error</dt><dd style="color:#e74c3c">' + esc(meta.error) + '</dd>'
      html += '</dl></div>'

      html += '<div class="events">'
      for (const ev of events) {
        const cls = ev.type === 'assertion' ? 'assertion' : (ev.type === 'group-start' || ev.type === 'group-end') ? 'group' : ''
        const failed = (ev.success === false || ev.passed === false) ? ' failed' : ''
        html += '<div class="event ' + cls + failed + '">'

        if (ev.type === 'action') {
          html += '<strong>' + esc(ev.action) + '</strong>'
          if (ev.selector) html += ' <span style="color:#888">' + esc(ev.selector) + '</span>'
          html += ' <span style="color:#666">' + (ev.wallDuration ?? ev.duration) + 'ms</span>'
          if (!ev.success && ev.error) html += '<br><span style="color:#e74c3c">' + esc(ev.error) + '</span>'
        } else if (ev.type === 'assertion') {
          html += '<strong>' + esc(ev.assertion) + '</strong>'
          if (ev.expected) html += ' expected: ' + esc(ev.expected)
          if (!ev.passed && ev.error) html += '<br><span style="color:#e74c3c">' + esc(ev.error) + '</span>'
        } else if (ev.type === 'group-start') {
          html += '▸ ' + esc(ev.name)
        } else if (ev.type === 'group-end') {
          html += '◂ ' + esc(ev.name)
        } else if (ev.type === 'console') {
          const color = ev.level === 'error' ? '#e74c3c' : ev.level === 'warn' ? '#f39c12' : '#888'
          html += '<span style="color:' + color + '">[' + ev.level + ']</span> ' + esc(ev.message)
        } else if (ev.type === 'error') {
          html += '<span style="color:#e74c3c">' + esc(ev.message) + '</span>'
        }

        html += '</div>'
      }
      html += '</div>'

      // Screenshots
      const screenshotUrls = Object.values(screenshots)
      if (screenshotUrls.length > 0) {
        html += '<h2>Screenshots</h2><div class="screenshots">'
        for (const [name, url] of Object.entries(screenshots)) {
          html += '<div><img src="' + url + '" alt="' + esc(name) + '"><br><small>' + esc(name) + '</small></div>'
        }
        html += '</div>'
      }

      app.innerHTML = html
    }

    function esc(s) {
      if (!s) return ''
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }

    loadTrace().catch(err => {
      document.getElementById('app').innerHTML = '<p style="color:#e74c3c">Error: ' + esc(err.message) + '</p>'
    })
  </script>
</body>
</html>`;
}
