import * as preact from 'preact';
import { useState, useMemo } from 'preact/hooks';
import type { NetworkEntry } from '../../trace/types.js';
import { decodeBodyForDisplay, isProtobufContentType } from '../../trace/grpc-protobuf.js';
import { deviceHueAt } from './device-frames.js';

// ─── Injected Styles ───

const NETWORK_STYLES = `
  .net-container { display: flex; flex-direction: column; height: 100%; min-height: 0; }

  /* Horizontal padding here because NetworkTab renders inside a flush
   * detail-content (no parent padding) so the table can extend edge-to-edge. */
  .net-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; flex-shrink: 0; flex-wrap: wrap; border-bottom: 1px solid var(--color-border); }
  .net-search { flex: 1; min-width: 180px; padding: 4px 8px; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-secondary); font-size: 12px; outline: none; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .net-search:focus { border-color: var(--color-accent); }
  .net-pills { display: flex; gap: 2px; flex-wrap: wrap; }
  /* The groups exist to name each set for assistive tech; they must not
     introduce a layout box, so they lay out as the flex row they replace. */
  .net-pill-group { display: flex; gap: 2px; flex-wrap: wrap; }
  .net-pill { padding: 2px 8px; background: transparent; border: 1px solid var(--color-border); border-radius: 10px; color: var(--color-text-muted); font-size: 10px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; }
  .net-pill:hover { color: var(--color-text-secondary); border-color: var(--color-text-faintest); }
  .net-pill.active { color: var(--color-text-primary); border-color: var(--color-accent); background: var(--color-highlight); }
  .net-pill-sep { width: 1px; background: var(--color-border); margin: 2px 4px; align-self: stretch; }
  .net-pill-device { text-transform: none; }
  .net-pill-device.active { border-color: oklch(0.65 0.13 var(--device-h, var(--accent-h))); background: oklch(0.65 0.13 var(--device-h, var(--accent-h)) / 0.14); color: var(--color-text-primary); }
  .net-device .action-device-tag { margin-left: 0; }

  .net-main { flex: 1; display: flex; min-height: 0; overflow: hidden; gap: 0; }
  .net-list { flex: 1; min-width: 0; overflow: auto; }
  .net-list.with-detail { flex: 0 0 42%; border-right: 1px solid var(--color-border); }

  .net-table { width: 100%; min-width: 800px; border-collapse: collapse; font-size: 11px; table-layout: fixed; }
  .net-list.with-detail .net-table { min-width: 420px; }
  .net-table th { text-align: left; padding: 4px 8px; color: var(--color-text-muted); border-bottom: 1px solid var(--color-border); cursor: pointer; user-select: none; white-space: nowrap; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--color-bg); position: sticky; top: 0; z-index: 1; }
  .net-table th:hover { color: var(--color-text-secondary); }
  .net-sort-indicator { margin-left: 4px; font-size: 9px; }
  .net-table td { padding: 3px 8px; border-bottom: 1px solid var(--color-bg-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .net-table tr.net-row { cursor: pointer; }
  .net-table tr.net-row:hover { background: var(--color-bg-hover); }
  .net-table tr.net-row.selected { background: var(--color-bg-selected); }
  .net-table tr.net-row.selected td { color: var(--color-text-primary); }

  .net-status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; margin-right: 6px; flex-shrink: 0; }
  .net-status-dot.s2xx { background: var(--color-success); }
  .net-status-dot.s3xx { background: var(--color-accent); }
  .net-status-dot.s4xx { background: var(--color-warning); }
  .net-status-dot.s5xx { background: var(--color-error); }
  .net-status-dot.saborted { background: var(--color-error); }
  .net-status-dot.spending { background: var(--color-text-faintest); }

  .net-name-cell { display: flex; align-items: center; min-width: 0; }
  .net-name { flex-shrink: 0; max-width: 50%; overflow: hidden; text-overflow: ellipsis; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; color: var(--color-text-secondary); }
  .net-inherited-label { color: var(--color-text-muted); font-size: 10px; white-space: normal; }
  .net-name-origin { padding-left: 14px; margin-top: 2px; }
  .net-domain { color: var(--color-text-faintest); margin-left: 6px; font-size: 10px; flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

  .net-method { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 10px; font-weight: 700; color: var(--color-text-muted); }
  .net-method.get { color: var(--color-accent); }
  .net-method.post { color: var(--color-success); }
  .net-method.put { color: var(--color-warning); }
  .net-method.delete { color: var(--color-error); }
  .net-method.patch { color: var(--color-warning); }

  .net-status-text { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; }
  .net-status-2xx { color: var(--color-success); }
  .net-status-3xx { color: var(--color-accent); }
  .net-status-4xx { color: var(--color-warning); }
  .net-status-5xx { color: var(--color-error); }
  .net-status-aborted { color: var(--color-error); font-style: italic; }

  .net-type { color: var(--color-text-muted); }
  .net-duration, .net-size { color: var(--color-text-muted); text-align: right; }

  .net-waterfall-cell { padding: 0 8px; position: relative; height: 20px; min-width: 80px; }
  .net-waterfall-track { position: relative; height: 100%; width: 100%; }
  .net-waterfall-bar { position: absolute; top: 50%; transform: translateY(-50%); height: 6px; background: var(--color-accent); border-radius: 2px; min-width: 2px; opacity: 0.85; }
  .net-waterfall-bar.s4xx { background: var(--color-warning); }
  .net-waterfall-bar.s5xx, .net-waterfall-bar.saborted { background: var(--color-error); }
  .net-waterfall-bar.mocked { background: #7c3aed; }

  .net-route-badge { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 9px; font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; margin-left: 6px; vertical-align: middle; flex-shrink: 0; }
  .net-route-mocked { background: #7c3aed22; color: #7c3aed; border: 1px solid #7c3aed44; }
  .net-route-aborted { background: #ef444422; color: #ef4444; border: 1px solid #ef444444; }
  .net-route-continued { background: #eab30822; color: #ca8a04; border: 1px solid #eab30844; }
  .net-route-fetched { background: #3b82f622; color: #3b82f6; border: 1px solid #3b82f644; }
  .net-route-passthrough { background: #6b728022; color: #6b7280; border: 1px solid #6b728044; }

  .net-streaming-badge { color: var(--color-accent); border: 1px solid var(--color-accent); }
  .net-streaming-note { color: var(--color-text-muted); margin-bottom: 10px; }

  /* Detail panel */
  .net-detail { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--color-bg-secondary); overflow: hidden; }
  .net-detail-header { display: flex; align-items: center; padding: 4px 4px 4px 12px; border-bottom: 1px solid var(--color-border); flex-shrink: 0; gap: 4px; }
  .net-detail-tabs { display: flex; gap: 0; flex: 1; min-width: 0; overflow-x: auto; }
  .net-detail-tab { padding: 4px 10px; cursor: pointer; color: var(--color-text-muted); border-bottom: 2px solid transparent; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; white-space: nowrap; background: transparent; border-top: none; border-left: none; border-right: none; }
  .net-detail-tab:hover { color: var(--color-text-secondary); }
  .net-detail-tab.active { color: var(--color-text-primary); border-bottom-color: var(--color-accent); }
  .net-detail-close { background: transparent; border: none; color: var(--color-text-muted); cursor: pointer; padding: 4px 8px; font-size: 14px; line-height: 1; border-radius: 3px; flex-shrink: 0; }
  .net-detail-close:hover { color: var(--color-text-primary); background: var(--color-bg-hover); }

  .net-detail-body { flex: 1; overflow: auto; padding: 10px 14px; font-size: 12px; min-height: 0; }
  .net-detail-section { margin-bottom: 14px; }
  .net-detail-section:last-child { margin-bottom: 0; }
  .net-detail-section-title { color: var(--color-accent); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; padding-bottom: 3px; border-bottom: 1px solid var(--color-border); }
  .net-summary-grid { display: grid; grid-template-columns: 120px 1fr; gap: 3px 12px; font-size: 11px; }
  .net-summary-key { color: var(--color-text-muted); }
  .net-summary-value { color: var(--color-text-secondary); font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; word-break: break-all; }
  .net-summary-value.s2xx { color: var(--color-success); }
  .net-summary-value.s3xx { color: var(--color-accent); }
  .net-summary-value.s4xx { color: var(--color-warning); }
  .net-summary-value.s5xx { color: var(--color-error); }
  .net-headers-grid { display: grid; grid-template-columns: minmax(140px, auto) 1fr; gap: 2px 12px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; }
  .net-header-key { color: var(--color-attr); }
  .net-header-value { color: var(--color-string); word-break: break-all; }
  .net-body-block { background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 3px; padding: 8px 10px; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; font-size: 11px; color: var(--color-text-secondary); white-space: pre-wrap; word-break: break-all; max-height: none; overflow: auto; margin: 0; }
  .net-body-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; gap: 8px; }
  .net-body-info { color: var(--color-text-faintest); font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  .net-toggle { background: transparent; border: 1px solid var(--color-border); border-radius: 3px; color: var(--color-text-muted); font-size: 10px; padding: 2px 6px; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; }
  .net-toggle:hover { color: var(--color-text-secondary); border-color: var(--color-text-faintest); }
  .net-toggle.active { color: var(--color-text-primary); border-color: var(--color-accent); background: var(--color-highlight); }

  .net-timing { display: flex; flex-direction: column; gap: 8px; font-size: 11px; }
  .net-timing-row { display: grid; grid-template-columns: 100px 1fr 70px; align-items: center; gap: 10px; }
  .net-timing-label { color: var(--color-text-muted); }
  .net-timing-track { position: relative; height: 10px; background: var(--color-bg); border-radius: 2px; }
  .net-timing-bar { position: absolute; top: 0; bottom: 0; background: var(--color-accent); border-radius: 2px; min-width: 2px; }
  .net-timing-value { text-align: right; font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; color: var(--color-text-secondary); }

  .net-empty { color: var(--color-text-faintest); font-size: 12px; padding: 24px; text-align: center; }
  .net-empty-note { color: var(--color-text-faintest); font-size: 11px; margin-top: 6px; }
  .net-empty-inline { color: var(--color-text-faintest); font-size: 11px; font-style: italic; }
  .net-host-wide { padding: 6px 10px; font-size: 11px; color: var(--color-warning); border-bottom: 1px solid var(--color-border); background: var(--color-bg-secondary); }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = NETWORK_STYLES;
  document.head.appendChild(el);
}

// ─── Types ───

interface Props {
  networkCaptureEnabled?: boolean
  entries: NetworkEntry[]
  bodies: Map<string, Uint8Array>
  /**
   * Devices of a multi-device trace (group order). With two or more, rows show
   * the device whose proxy captured them and a device filter is offered.
   */
  deviceNames?: string[]
  /**
   * The capture ran through the host-wide macOS system proxy (iOS simulator
   * fallback), so entries may come from any app on the Mac and requests to
   * localhost are missing.
   */
  hostWideCapture?: boolean
}

function HostWideCaptureNotice() {
  return (
    <div class="net-host-wide" data-testid="network-host-wide-notice" role="note">
      Captured through the macOS system proxy because the Network Extension was unavailable.
      These requests may include traffic from other apps on the Mac, and requests to localhost are not captured.
    </div>
  );
}

type ResourceType = 'all' | 'fetch' | 'doc' | 'js' | 'css' | 'img' | 'font' | 'media' | 'other'
type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx' | 'mocked'
type DetailTab = 'headers' | 'payload' | 'response' | 'timing'
type SortColumn = 'name' | 'method' | 'status' | 'type' | 'size' | 'time' | 'waterfall'
type SortDirection = 'asc' | 'desc'

// ─── Helpers ───

function resourceType(entry: NetworkEntry): Exclude<ResourceType, 'all'> {
  const ct = entry.contentType.toLowerCase();
  if (ct.includes('html')) return 'doc';
  if (ct.includes('json') || ct.includes('x-www-form-urlencoded') || ct.includes('multipart')) return 'fetch';
  if (ct.includes('javascript') || ct.includes('ecmascript')) return 'js';
  if (ct.includes('css')) return 'css';
  if (ct.startsWith('image/') || ct.includes('svg')) return 'img';
  if (ct.startsWith('font/') || ct.includes('woff') || ct.includes('ttf') || ct.includes('otf')) return 'font';
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return 'media';
  // Fall back to URL extension
  const path = entry.url.split('?')[0];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'js';
  if (ext === 'css') return 'css';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) return 'img';
  if (['woff', 'woff2', 'ttf', 'otf'].includes(ext)) return 'font';
  if (['mp4', 'webm', 'mp3', 'wav', 'ogg'].includes(ext)) return 'media';
  if (['html', 'htm'].includes(ext)) return 'doc';
  return 'other';
}

function splitUrl(url: string): { name: string; domain: string } {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? u.hostname;
    const name = last + (u.search || '');
    const parentPath = segments.length > 1 ? '/' + segments.slice(0, -1).join('/') : '';
    return { name, domain: u.hostname + parentPath };
  } catch {
    const [path] = url.split('?');
    const parts = path.split('/').filter(Boolean);
    return { name: parts[parts.length - 1] ?? url, domain: '' };
  }
}

function statusBucket(entry: NetworkEntry): '2xx' | '3xx' | '4xx' | '5xx' | 'aborted' | 'pending' {
  if (entry.routeAction === 'aborted') return 'aborted';
  // status is typed as number; collectors emit 0 when no response was
  // received (connection failure, aborted before headers, still in flight).
  if (!entry.status) return 'pending';
  if (entry.status >= 500) return '5xx';
  if (entry.status >= 400) return '4xx';
  if (entry.status >= 300) return '3xx';
  return '2xx';
}

function statusDotClass(entry: NetworkEntry): string {
  const b = statusBucket(entry);
  return `net-status-dot s${b}`;
}

function statusTextClass(bucket: ReturnType<typeof statusBucket>): string {
  if (bucket === 'aborted') return 'net-status-aborted';
  if (bucket === 'pending') return '';
  return `net-status-${bucket}`;
}

function methodClass(method: string): string {
  return `net-method ${method.toLowerCase()}`;
}

function shortenContentType(contentType: string): string {
  if (!contentType) return '';
  const ct = contentType.split(';')[0].trim();
  const mapping: Record<string, string> = {
    'application/json': 'json',
    'text/html': 'html',
    'text/plain': 'text',
    'text/css': 'css',
    'text/javascript': 'js',
    'application/javascript': 'js',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'application/octet-stream': 'binary',
    'application/x-www-form-urlencoded': 'form',
    'multipart/form-data': 'multipart',
  };
  return mapping[ct] ?? ct.replace(/^application\//, '').replace(/^text\//, '');
}

function formatSize(bytes: number): string {
  // 0 bytes is a valid result (e.g. 204 No Content) and should read as
  // "0 B", not the missing-data dash. Only treat null/undefined/NaN as
  // missing — in practice the upstream type is `number`, but defend
  // against unset values that coerce to falsy here too.
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function startedBeforeTest(entry: NetworkEntry): boolean {
  return entry.observedStartTime !== undefined && entry.observedStartTime > entry.startTime;
}

function observedStart(entry: NetworkEntry): number {
  return Math.max(entry.startTime, entry.observedStartTime ?? entry.startTime);
}

function observedDuration(entry: NetworkEntry): number {
  return startedBeforeTest(entry) ? Math.max(0, entry.endTime - observedStart(entry)) : entry.duration;
}

function streamAge(entry: NetworkEntry): string {
  if (entry.duration < 60_000) return formatDuration(entry.duration);
  return `${Math.floor(entry.duration / 60_000)} min ${Math.floor(entry.duration % 60_000 / 1000)} s`;
}

function entryDuration(entry: NetworkEntry): string {
  if (startedBeforeTest(entry)) return `${formatDuration(observedDuration(entry))} this test`;
  return formatDuration(entry.duration) + (entry.inFlight ? ' so far' : '');
}

function streamingBadge(entry: NetworkEntry): preact.JSX.Element | null {
  return entry.inFlight
    ? <span class="net-route-badge net-streaming-badge" title="Stream was still open at capture time">Streaming</span>
    : null;
}

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('json');
}

function prettyJson(body: string): { text: string; pretty: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), pretty: true };
  } catch {
    return { text: body, pretty: false };
  }
}

function matchesStatusFilter(entry: NetworkEntry, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  // 'passthrough' marks an un-intercepted tunnel, not a route action.
  if (filter === 'mocked') return !!entry.routeAction && entry.routeAction !== 'passthrough';
  const bucket = statusBucket(entry);
  return bucket === filter;
}

function routeBadge(routeAction?: string): preact.JSX.Element | null {
  if (!routeAction) return null;
  const label = routeAction === 'continued' ? 'modified' : routeAction;
  return <span class={`net-route-badge net-route-${routeAction}`}>{label}</span>;
}

// ─── Component ───

export function NetworkTab({ entries, bodies, deviceNames, networkCaptureEnabled, hostWideCapture }: Props) {
  injectStyles();

  const showDevices = !!deviceNames && deviceNames.length > 1;
  const [deviceFilter, setDeviceFilter] = useState<string>('all');
  const [urlFilter, setUrlFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<ResourceType>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('headers');
  // Chronological by default, like DevTools and Playwright's trace viewer:
  // the waterfall reads top-to-bottom as the test unfolded, and a request's
  // place in the list matches its place on the timeline. Duration ("Time")
  // and size are opt-in sorts.
  const [sortColumn, setSortColumn] = useState<SortColumn>('waterfall');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const timeExtent = useMemo(() => {
    if (entries.length === 0) return { min: 0, max: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const e of entries) {
      if (observedStart(e) < min) min = observedStart(e);
      if (e.endTime > max) max = e.endTime;
    }
    return { min, max: max > min ? max : min + 1 };
  }, [entries]);

  const filteredAndSorted = useMemo(() => {
    let result = entries.filter(e => {
      if (urlFilter) {
        const lf = urlFilter.toLowerCase();
        if (!e.url.toLowerCase().includes(lf) && !e.method.toLowerCase().includes(lf)) return false;
      }
      if (typeFilter !== 'all' && resourceType(e) !== typeFilter) return false;
      if (!matchesStatusFilter(e, statusFilter)) return false;
      if (showDevices && deviceFilter !== 'all' && e.deviceId !== deviceFilter) return false;
      return true;
    });

    // Precompute sort keys that are expensive per-call (splitUrl builds a
    // URL object; shortenContentType mapping) so we don't recompute O(n log
    // n) times inside the comparator.
    const sortKey = new Map<number, string>();
    if (sortColumn === 'name') {
      for (const e of result) sortKey.set(e.index, splitUrl(e.url).name);
    } else if (sortColumn === 'type') {
      for (const e of result) sortKey.set(e.index, shortenContentType(e.contentType));
    }

    result = [...result].sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case 'name': cmp = sortKey.get(a.index)!.localeCompare(sortKey.get(b.index)!); break;
        case 'method': cmp = a.method.localeCompare(b.method); break;
        case 'status': cmp = a.status - b.status; break;
        case 'type': cmp = sortKey.get(a.index)!.localeCompare(sortKey.get(b.index)!); break;
        case 'size': cmp = a.responseSize - b.responseSize; break;
        // "Time" column displays duration (`formatDuration(entry.duration)`),
        // so sort by duration — sorting by startTime would silently reorder
        // rows without matching the values the user sees. Chronological
        // ordering lives on the Waterfall column instead.
        case 'time': cmp = observedDuration(a) - observedDuration(b); break;
        case 'waterfall': cmp = observedStart(a) - observedStart(b); break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [entries, urlFilter, typeFilter, statusFilter, sortColumn, sortDirection, showDevices, deviceFilter]);

  const selected = selectedIndex !== null
    ? entries.find(e => e.index === selectedIndex)
    : undefined;

  const handleSort = (col: SortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      // Largest / slowest first for size and duration; the waterfall
      // returns to chronological order.
      setSortDirection(col === 'size' || col === 'time' ? 'desc' : 'asc');
    }
  };

  const sortIndicator = (col: SortColumn) => {
    if (sortColumn !== col) return null;
    return <span class="net-sort-indicator">{sortDirection === 'asc' ? '\u25B2' : '\u25BC'}</span>;
  };

  if (entries.length === 0) {
    return (
      <>
        {hostWideCapture && <HostWideCaptureNotice />}
        <div class="no-content" data-testid="no-content">
          No network requests captured
          {networkCaptureEnabled === false && <div class="no-content-note">Enable network capture in your trace config to record HTTP requests.</div>}
        </div>
      </>
    );
  }

  const hasMocked = entries.some(e => !!e.routeAction && e.routeAction !== 'passthrough');
  const TYPE_FILTERS: { value: ResourceType; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'fetch', label: 'Fetch/XHR' },
    { value: 'doc', label: 'Doc' },
    { value: 'js', label: 'JS' },
    { value: 'css', label: 'CSS' },
    { value: 'img', label: 'Img' },
    { value: 'font', label: 'Font' },
    { value: 'media', label: 'Media' },
    { value: 'other', label: 'Other' },
  ];
  const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
    { value: '2xx', label: '2xx' },
    { value: '3xx', label: '3xx' },
    { value: '4xx', label: '4xx' },
    { value: '5xx', label: '5xx' },
    ...(hasMocked ? [{ value: 'mocked' as StatusFilter, label: 'Mocked' }] : []),
  ];

  return (
    <div class="net-container">
      {hostWideCapture && <HostWideCaptureNotice />}
      <div class="net-toolbar">
        <input
          class="net-search"
          type="text"
          aria-label="Filter network requests"
          placeholder="Filter by URL or method..."
          value={urlFilter}
          onInput={(e) => setUrlFilter((e.target as HTMLInputElement).value)}
        />
        <div class="net-pills">
          {/* Grouped and named, as the test explorer's status filters are: these
              are mutually exclusive within each set, and ungrouped they read as
              a dozen unrelated toggles with no cue that one releases another. */}
          <div class="net-pill-group" role="group" aria-label="Filter by type">
          {TYPE_FILTERS.map(f => (
            <button
              key={f.value}
              class={`net-pill${typeFilter === f.value ? ' active' : ''}`}
              aria-pressed={typeFilter === f.value}
              onClick={() => setTypeFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
          </div>
          <span class="net-pill-sep" />
          {showDevices && (
            <div class="net-pill-group" role="group" aria-label="Filter by device">
              <button
                class={`net-pill${deviceFilter === 'all' ? ' active' : ''}`}
                aria-pressed={deviceFilter === 'all'}
                onClick={() => setDeviceFilter('all')}
              >All devices</button>
              {deviceNames!.map((name, i) => (
                <button
                  key={name}
                  class={`net-pill net-pill-device${deviceFilter === name ? ' active' : ''}`}
                  style={{ '--device-h': String(deviceHueAt(i)) }}
                  aria-pressed={deviceFilter === name}
                  onClick={() => setDeviceFilter(name)}
                >{name}</button>
              ))}
            </div>
          )}
          <div class="net-pill-group" role="group" aria-label="Filter by status">
          <button
            class={`net-pill${statusFilter === 'all' ? ' active' : ''}`}
            aria-pressed={statusFilter === 'all'}
            onClick={() => setStatusFilter('all')}
          >
            Any
          </button>
          {STATUS_FILTERS.map(f => (
            <button
              key={f.value}
              class={`net-pill${statusFilter === f.value ? ' active' : ''}`}
              aria-pressed={statusFilter === f.value}
              onClick={() => setStatusFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
          </div>
        </div>
      </div>

      <div class="net-main">
        <div class={`net-list${selected ? ' with-detail' : ''}`}>
          <table class="net-table">
            {/* One <col> per rendered column: the widths are positional, so a
                Device column needs its own entry or every width shifts one
                column right and Name collapses. With devices the fixed columns
                tighten so Name keeps the room it has on a single-device trace. */}
            <colgroup>
              {selected ? (
                showDevices ? (
                  <>
                    <col style={{ width: '42%' }} />
                    <col style={{ width: '56px' }} />
                    <col style={{ width: '56px' }} />
                    <col style={{ width: '56px' }} />
                    <col style={{ width: '64px' }} />
                  </>
                ) : (
                  <>
                    <col style={{ width: '52%' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ width: '60px' }} />
                    <col style={{ width: '70px' }} />
                  </>
                )
              ) : showDevices ? (
                <>
                  <col />
                  <col style={{ width: '56px' }} />
                  <col style={{ width: '64px' }} />
                  <col style={{ width: '60px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '110px' }} />
                </>
              ) : (
                <>
                  <col />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '70px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '80px' }} />
                  <col style={{ width: '100px' }} />
                  <col style={{ width: '140px' }} />
                </>
              )}
            </colgroup>
            <thead>
              <tr>
                <th onClick={() => handleSort('name')}>Name{sortIndicator('name')}</th>
                {showDevices && <th>Device</th>}
                <th onClick={() => handleSort('method')}>Method{sortIndicator('method')}</th>
                <th onClick={() => handleSort('status')}>Status{sortIndicator('status')}</th>
                {!selected && <th onClick={() => handleSort('type')}>Type{sortIndicator('type')}</th>}
                {!selected && <th style={{ textAlign: 'right' }} onClick={() => handleSort('size')}>Size{sortIndicator('size')}</th>}
                <th style={{ textAlign: 'right' }} onClick={() => handleSort('time')}>Time{sortIndicator('time')}</th>
                {!selected && <th onClick={() => handleSort('waterfall')}>Waterfall{sortIndicator('waterfall')}</th>}
              </tr>
            </thead>
            <tbody>
              {filteredAndSorted.map(entry => {
                const { name, domain } = splitUrl(entry.url);
                const bucket = statusBucket(entry);
                const isSelected = selected && selected.index === entry.index;
                return (
                  <tr
                    key={entry.index}
                    class={`net-row${isSelected ? ' selected' : ''}`}
                    onClick={() => setSelectedIndex(entry.index)}
                  >
                    <td>
                      <div class="net-name-cell">
                        <span class={statusDotClass(entry)} />
                        <span class="net-name" title={entry.url}>{name}</span>
                        {streamingBadge(entry)}
                        {!selected && domain && <span class="net-domain" title={domain}>{domain}</span>}
                        {routeBadge(entry.routeAction)}
                      </div>
                      {startedBeforeTest(entry) && <div class="net-inherited-label net-name-origin">Started before this test</div>}
                    </td>
                    {showDevices && (
                      <td class="net-device" data-testid="net-device">
                        {entry.deviceId
                          ? <span class="action-device-tag" style={{ '--device-h': String(deviceHueAt(deviceNames!.indexOf(entry.deviceId))) }}>{entry.deviceId}</span>
                          : '—'}
                      </td>
                    )}
                    <td class={methodClass(entry.method)}>{entry.method}</td>
                    <td class={`net-status-text ${statusTextClass(bucket)}`}>
                      {entry.routeAction === 'aborted' ? 'ABORTED' : (entry.status || '—')}
                    </td>
                    {!selected && <td class="net-type">{shortenContentType(entry.contentType) || '—'}</td>}
                    {!selected && <td class="net-size">{formatSize(entry.responseSize)}</td>}
                    <td class="net-duration" title={startedBeforeTest(entry) ? `${entry.inFlight ? 'Stream age' : 'Total request duration'}: ${streamAge(entry)}` : undefined}>
                      {startedBeforeTest(entry) ? <>{formatDuration(observedDuration(entry))}<div class="net-inherited-label">this test</div></> : entryDuration(entry)}
                    </td>
                    {!selected && (
                      <td class="net-waterfall-cell">
                        <Waterfall entry={entry} extent={timeExtent} />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selected && (
          <DetailPanel
            entry={selected}
            bodies={bodies}
            tab={detailTab}
            onTab={setDetailTab}
            onClose={() => setSelectedIndex(null)}
            extent={timeExtent}
          />
        )}
      </div>
    </div>
  );
}

// ─── Waterfall bar ───

function Waterfall({ entry, extent }: { entry: NetworkEntry; extent: { min: number; max: number } }) {
  const span = extent.max - extent.min;
  const left = ((observedStart(entry) - extent.min) / span) * 100;
  const width = Math.max((Math.max(0, entry.endTime - observedStart(entry)) / span) * 100, 0.5);
  const cls = entry.routeAction === 'mocked' ? 'mocked'
    : entry.routeAction === 'aborted' ? 'saborted'
    : entry.status >= 500 ? 's5xx'
    : entry.status >= 400 ? 's4xx'
    : '';
  return (
    <div class="net-waterfall-track">
      <div class={`net-waterfall-bar ${cls}`} style={{ left: `${left}%`, width: `${width}%` }} />
    </div>
  );
}

// ─── Detail panel ───

interface DetailPanelProps {
  entry: NetworkEntry
  bodies: Map<string, Uint8Array>
  tab: DetailTab
  onTab: (t: DetailTab) => void
  onClose: () => void
  extent: { min: number; max: number }
}

function DetailPanel({ entry, bodies, tab, onTab, onClose, extent }: DetailPanelProps) {
  const requestBody = entry.requestBodyPath ? bodies.get(entry.requestBodyPath) : undefined;
  const responseBody = entry.responseBodyPath ? bodies.get(entry.responseBodyPath) : undefined;

  const TABS: { value: DetailTab; label: string }[] = [
    { value: 'headers', label: 'Headers' },
    { value: 'payload', label: 'Payload' },
    { value: 'response', label: 'Response' },
    { value: 'timing', label: 'Timing' },
  ];

  return (
    <div class="net-detail">
      <div class="net-detail-header">
        <div class="net-detail-tabs">
          {TABS.map(t => (
            <button
              key={t.value}
              class={`net-detail-tab${tab === t.value ? ' active' : ''}`}
              onClick={() => onTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button class="net-detail-close" onClick={onClose} title="Close" aria-label="Close">{'\u2715'}</button>
      </div>
      <div class="net-detail-body" data-testid="net-detail-body">
        {startedBeforeTest(entry) && <div class="net-streaming-note">
          Started before this test. Timing shows the period observed during this test; bodies and byte counts are cumulative since the request started.
        </div>}
        {entry.inFlight && <div class="net-streaming-note">
          Streaming — still open at capture time. This snapshot shows the headers and body bytes captured so far.
        </div>}
        {tab === 'headers' && <HeadersTab entry={entry} />}
        {tab === 'payload' && <PayloadTab entry={entry} body={requestBody} />}
        {tab === 'response' && <ResponseTab entry={entry} body={responseBody} />}
        {tab === 'timing' && <TimingTab entry={entry} extent={extent} />}
      </div>
    </div>
  );
}

function HeadersTab({ entry }: { entry: NetworkEntry }) {
  const bucket = statusBucket(entry);
  return (
    <>
      <div class="net-detail-section">
        <div class="net-detail-section-title">General</div>
        <div class="net-summary-grid">
          <span class="net-summary-key">Request URL</span>
          <span class="net-summary-value">{entry.url}</span>
          <span class="net-summary-key">Request Method</span>
          <span class="net-summary-value">{entry.method}</span>
          <span class="net-summary-key">Status Code</span>
          <span class={`net-summary-value s${bucket}`}>
            {entry.routeAction === 'aborted' ? 'ABORTED' : (entry.status || '(pending)')}
            {routeBadge(entry.routeAction)}{streamingBadge(entry)}
          </span>
          {entry.contentType && <>
            <span class="net-summary-key">Content-Type</span>
            <span class="net-summary-value">{entry.contentType}</span>
          </>}
          <span class="net-summary-key">Duration</span>
          <span class="net-summary-value">{entryDuration(entry)}</span>
          <span class="net-summary-key">Request Size</span>
          <span class="net-summary-value">{formatSize(entry.requestSize)}</span>
          <span class="net-summary-key">Response Size</span>
          <span class="net-summary-value">{formatSize(entry.responseSize)}</span>
        </div>
      </div>

      <div class="net-detail-section">
        <div class="net-detail-section-title">Response Headers</div>
        <HeadersGrid headers={entry.responseHeaders} />
      </div>

      <div class="net-detail-section">
        <div class="net-detail-section-title">Request Headers</div>
        <HeadersGrid headers={entry.requestHeaders} />
      </div>
    </>
  );
}

function HeadersGrid({ headers }: { headers: Record<string, string> }) {
  const entries = Object.entries(headers);
  if (entries.length === 0) return <span class="net-empty-inline">None</span>;
  return (
    <div class="net-headers-grid">
      {entries.map(([k, v]) => (
        <>
          <span class="net-header-key">{k}</span>
          <span class="net-header-value">{v}</span>
        </>
      ))}
    </div>
  );
}

function PayloadTab({ entry, body }: { entry: NetworkEntry; body: Uint8Array | undefined }) {
  if (!body || body.length === 0) {
    return <div class="net-empty-inline">{entry.inFlight ? 'No request payload captured yet' : 'No request payload'}</div>;
  }
  return (
    <BodyViewer
      body={body}
      contentType={entry.contentType}
      url={entry.url}
      direction="request"
    />
  );
}

function ResponseTab({ entry, body }: { entry: NetworkEntry; body: Uint8Array | undefined }) {
  if (!body || body.length === 0) {
    return <div class="net-empty-inline">{entry.inFlight ? 'No response body captured yet' : 'No response body'}{entry.routeAction === 'aborted' ? ' (aborted)' : ''}</div>;
  }
  return (
    <BodyViewer
      body={body}
      contentType={entry.contentType}
      url={entry.url}
      direction="response"
    />
  );
}

function BodyViewer({ body, contentType, url, direction }: {
  body: Uint8Array
  contentType: string
  url: string
  direction: 'request' | 'response'
}) {
  // gRPC/protobuf bodies are binary, so decode them structurally rather than
  // rendering bytes as text. Attempted for any body that either declares a
  // protobuf content type or simply turns out to be decodable — gRPC-Web and
  // some proxies mislabel the type, and a successful decode is strong evidence
  // on its own (see `decodeBodyForDisplay`).
  const decoded = useMemo(() => {
    if (body.length === 0) return null;
    if (isJsonContentType(contentType)) return null;
    if (!isProtobufContentType(contentType) && !looksBinary(body)) return null;
    return decodeBodyForDisplay(body, { url, direction });
  }, [body, contentType, url, direction]);

  // Text view of the bytes, non-fatal so a partially-binary body still shows
  // whatever text it contains rather than failing outright.
  const text = useMemo(() => new TextDecoder().decode(body), [body]);

  const canPretty = isJsonContentType(contentType);
  const [pretty, setPretty] = useState(canPretty);
  const [showDecoded, setShowDecoded] = useState(true);
  // Pretty-print is up to ~2 MiB of JSON.parse + JSON.stringify — keep it
  // out of the render path so toggling other state (tab switches, window
  // resizes) doesn't redo the work.
  const display = useMemo(() => {
    if (decoded && showDecoded) return decoded.text;
    return pretty && canPretty ? prettyJson(text).text : text;
  }, [decoded, showDecoded, pretty, canPretty, text]);

  const label = decoded && showDecoded
    ? decoded.label
    : shortenContentType(contentType) || 'text';

  return (
    <>
      <div class="net-body-toolbar">
        <span class="net-body-info" data-testid="net-body-info">{label} · {formatSize(body.length)}</span>
        {decoded && (
          <button
            class={`net-toggle${showDecoded ? ' active' : ''}`}
            // Carries a testid because its label is not unique: the JSON
            // pretty-print toggle below also reads "Raw" while pretty is on,
            // and the two are indistinguishable by accessible name.
            data-testid="net-decode-toggle"
            onClick={() => setShowDecoded(d => !d)}
          >
            {showDecoded ? 'Raw' : 'Decode'}
          </button>
        )}
        {canPretty && (
          <button
            class={`net-toggle${pretty ? ' active' : ''}`}
            onClick={() => setPretty(p => !p)}
          >
            {pretty ? 'Raw' : 'Pretty'}
          </button>
        )}
      </div>
      <pre class="net-body-block">{display}</pre>
    </>
  );
}

/** Cheap check for "this is not text": a NUL byte, or a 0xFF that cannot start
 * a UTF-8 sequence. Used only to decide whether attempting a protobuf decode is
 * worthwhile for a body whose content type doesn't declare one. */
function looksBinary(body: Uint8Array): boolean {
  const limit = Math.min(body.length, 512);
  for (let i = 0; i < limit; i++) {
    const b = body[i];
    if (b === 0x00 || b === 0xff) return true;
  }
  return false;
}

function TimingTab({ entry, extent }: { entry: NetworkEntry; extent: { min: number; max: number } }) {
  const total = extent.max - extent.min || 1;
  const startedAt = observedStart(entry) - extent.min;
  const rows = [
    { label: 'Queued', left: 0, width: (startedAt / total) * 100, value: `${formatDuration(startedAt)} waited` },
    { label: startedBeforeTest(entry) ? 'Observed' : 'Request', left: (startedAt / total) * 100, width: (observedDuration(entry) / total) * 100, value: entryDuration(entry) },
  ];
  return (
    <>
      <div class="net-detail-section">
        <div class="net-detail-section-title">Timing</div>
        <div class="net-timing">
          {rows.map((r, i) => (
            <div key={i} class="net-timing-row">
              <span class="net-timing-label">{r.label}</span>
              <div class="net-timing-track">
                <div class="net-timing-bar" style={{ left: `${r.left}%`, width: `${Math.max(r.width, 0.5)}%` }} />
              </div>
              <span class="net-timing-value">{r.value}</span>
            </div>
          ))}
        </div>
      </div>
      <div class="net-detail-section">
        <div class="net-detail-section-title">Breakdown</div>
        <div class="net-summary-grid">
          {startedBeforeTest(entry) ? <>
            <span class="net-summary-key">Request started</span>
            <span class="net-summary-value">{new Date(entry.startTime).toISOString()}</span>
            <span class="net-summary-key">{entry.inFlight ? 'Stream age' : 'Total request duration'}</span>
            <span class="net-summary-value">{streamAge(entry)}</span>
            <span class="net-summary-key">Observed during this test</span>
            <span class="net-summary-value">{formatDuration(observedDuration(entry))}</span>
          </> : <>
            <span class="net-summary-key">Started</span>
            <span class="net-summary-value">{formatDuration(startedAt)} after first request</span>
            <span class="net-summary-key">Duration</span>
            <span class="net-summary-value">{entryDuration(entry)}</span>
          </>}
          <span class="net-summary-key">{entry.inFlight ? 'Snapshot taken' : 'Finished'}</span>
          <span class="net-summary-value">{startedBeforeTest(entry) ? new Date(entry.endTime).toISOString() : `${formatDuration(entry.endTime - extent.min)} after first request`}</span>
        </div>
      </div>
    </>
  );
}
