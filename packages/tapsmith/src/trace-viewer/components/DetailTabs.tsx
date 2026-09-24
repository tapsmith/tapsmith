import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { usePersistedString } from '../../ui-mode/hooks/use-persisted-state.js';
import type { ComponentChildren } from 'preact';
import { AlertTriangle } from 'lucide-preact';
import { buildCodeSnippet, formatCodeSnippetPlain } from '../../trace/code-frame.js';
import type { ActionTraceEvent, AssertionTraceEvent, AnyTraceEvent, ConsoleTraceEvent, TraceMetadata, NetworkEntry, ConsoleLevel, SourceLocation } from '../../trace/types.js';
import { resolveSourceView } from './source-view-utils.js';
import { HierarchyTree } from './HierarchyTree.js';
import type { Bounds } from './HierarchyTree.js';
import { NetworkTab } from './NetworkTab.js';
import { actingDevice, deviceNamesFor, deviceTagStyle, frameIndexForDevice, hierarchyForDeviceFrame, type DeviceGroupView } from './device-frames.js';
import { parseSelectorParts } from './ActionsPanel.js';

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  hierarchies: Map<string, string>
  sources: Map<string, string>
  metadata: TraceMetadata
  networkEntries: NetworkEntry[]
  networkBodies: Map<string, Uint8Array>
  onHierarchyNodeSelect?: (bounds: Bounds | null) => void
  locatorTab?: ComponentChildren
  pickMode?: boolean
  /**
   * Source line to highlight when there is no selected event (e.g. previewing
   * a test that hasn't run yet). Ignored once a real event drives the view.
   */
  previewHighlight?: SourceLocation
  /** A multi-device trace's group — drives the per-device console/network filters and the hierarchy toggle. */
  group?: DeviceGroupView
  /**
   * The stage the screenshot panel is showing (`before` unless the After tab
   * is active). The hierarchy toggle picks a non-acting device's frame the
   * same way its pane does, so tree and screenshot describe the same moment.
   */
  screenshotVariant?: 'before' | 'after'
}


type DetailTab = 'call' | 'log' | 'console' | 'source' | 'hierarchy' | 'locator' | 'errors' | 'network'

/**
 * The device an event ran on. Single-device traces have one; a `use.devices`
 * trace names it on the event and describes each in `metadata.devices`.
 */
function deviceForEvent(
  metadata: TraceMetadata,
  event: { deviceId?: string },
): TraceMetadata['device'] | undefined {
  const group = metadata.devices && metadata.devices.length > 1 ? metadata.devices : undefined;
  if (!group) return metadata.device;
  return group.find((d) => d.name === event.deviceId) ?? metadata.device;
}

/** Whether any device's capture went through the host-wide macOS system proxy. */
function capturedHostWide(metadata: TraceMetadata | undefined): boolean {
  if (!metadata) return false;
  const devices = [...(metadata.devices ?? []), metadata.device].filter(Boolean);
  return devices.some((d) => d.networkCaptureRoute === 'ios-system-proxy');
}

/**
 * The Call tab's "Device" line. The group name (`alice`) leads only when the
 * test declared a group: a single-device run still records one (`device-1`)
 * so its events have a `deviceId`, but that name is the runner's, not the
 * author's, and showing it read as a device the user never configured.
 */
function deviceLine(metadata: TraceMetadata, event: { deviceId?: string }): string | undefined {
  const d = deviceForEvent(metadata, event);
  if (!d?.serial) return undefined;
  const grouped = metadata.devices !== undefined && metadata.devices.length > 1;
  return [grouped ? d.name : undefined, d.model, d.serial].filter(Boolean).join(' · ');
}

export function DetailTabs({ event, events, hierarchies, sources, metadata, networkEntries, networkBodies, onHierarchyNodeSelect, locatorTab, pickMode, previewHighlight, group, screenshotVariant }: Props) {

  const testError = metadata.error;
  // Device names of a multi-device trace, for the per-device filters.
  const deviceNames = useMemo(
    () => (metadata.devices && metadata.devices.length > 1 ? deviceNamesFor(metadata, networkEntries) : []),
    [metadata, networkEntries],
  );
  const [tab, setTab] = usePersistedString('tapsmith-detail-tab', 'call') as [DetailTab, (v: DetailTab) => void];

  const hasActionError = event && (
    (event.type === 'action' && !event.success) ||
    (event.type === 'assertion' && !event.passed)
  );
  const hasError = hasActionError || !!testError;

  // Auto-switch to errors tab when test fails and no specific action is selected
  const prevTestError = useRef(testError);
  useEffect(() => {
    if (testError && !prevTestError.current && !event) {
      setTab('errors');
    }
    prevTestError.current = testError;
  }, [testError, event]);

  // Auto-switch to locator tab when pick mode is enabled
  useEffect(() => {
    if (pickMode && locatorTab) setTab('locator');
  }, [pickMode, locatorTab]);

  // Memoize: DetailTabs re-renders on every selected-event change, and
  // `events` can be large for long tests. Filtering + the dedupe check is
  // cheap per-element but adds up when it runs on every hover.
  const consoleEvents = useMemo(
    () => events.filter((e): e is ConsoleTraceEvent => e.type === 'console'),
    [events],
  );
  const failedEventsForCount = useMemo(
    () => events.filter((e): e is ActionTraceEvent | AssertionTraceEvent =>
      (e.type === 'action' && !(e as ActionTraceEvent).success) ||
      (e.type === 'assertion' && !(e as AssertionTraceEvent).passed),
    ),
    [events],
  );
  // The test-level error is usually just the failing assertion's message, so
  // don't double-count it when ErrorsTab would dedupe it visually.
  const failedCount = useMemo(() => {
    const testErrorIsDuplicate = !!testError
      && failedEventsForCount.some((ev) => ev.error && testError.includes(ev.error));
    return failedEventsForCount.length + (testError && !testErrorIsDuplicate ? 1 : 0);
  }, [failedEventsForCount, testError]);

  // The tab strip is keyboard-operable: Left/Right move between tabs and
  // Home/End jump to the ends, matching how a tab strip is expected to behave.
  //
  // Every tab stays in the tab order (tabIndex 0) rather than using APG's
  // roving-tabindex pattern. The other tab strips in the app are plain buttons
  // and so are already individually tabbable; adopting roving here would make
  // Tab skip the whole group, changing behaviour that already works for
  // keyboard users. Arrow keys are additive.
  const visibleTabs: Array<{
    value: DetailTab
    label: string
    extra?: ComponentChildren
    extraClass?: string
  }> = [
    { value: 'call', label: 'Call' },
    { value: 'log', label: 'Log' },
    {
      value: 'console',
      label: 'Console',
      extra: consoleEvents.length > 0 ? <span class="detail-tab-dot" data-testid="console-tab-dot" /> : undefined,
    },
    { value: 'source', label: 'Source' },
    { value: 'hierarchy', label: 'Hierarchy' },
    ...(locatorTab ? [{ value: 'locator' as DetailTab, label: 'Locator' }] : []),
    {
      value: 'network',
      label: 'Network',
      extra: networkEntries.length > 0 ? <span class="ct">{networkEntries.length}</span> : undefined,
    },
    {
      value: 'errors',
      label: 'Errors',
      extra: failedCount > 0 ? <span class="ct">{failedCount}</span> : undefined,
      extraClass: hasError ? ' has-error' : undefined,
    },
  ];

  // The persisted tab can name one that isn't currently rendered — `locatorTab`
  // is optional, and the pick-mode effect selects 'locator'. Falling back keeps
  // aria-labelledby pointing at a real tab and the panel from rendering blank.
  const activeTab = visibleTabs.some((t) => t.value === tab) ? tab : 'call';

  const handleTabKeyDown = (e: KeyboardEvent, value: DetailTab) => {
    const index = visibleTabs.findIndex((t) => t.value === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (index + 1) % visibleTabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + visibleTabs.length) % visibleTabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = visibleTabs.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      // A div is not a button, so activation has to be wired up by hand.
      e.preventDefault();
      setTab(value);
      return;
    } else return;

    e.preventDefault();
    setTab(visibleTabs[next].value);
    // Follow focus, or the next arrow press would move from the old position.
    // Selected by role rather than child index: `next` indexes visibleTabs, and
    // the two would silently diverge if anything else were added to the bar.
    const bar = (e.currentTarget as HTMLElement).parentElement;
    const target = bar?.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined;
    target?.focus();
  };

  return (
    <div class="detail-panel">
      <div class="detail-tabs-bar" role="tablist" aria-label="Trace details">
        {visibleTabs.map(({ value, label, extra, extraClass }) => (
          <div
            key={value}
            id={`detail-tab-${value}`}
            class={`detail-tab vtab${activeTab === value ? ' active' : ''}${extraClass ?? ''}`}
            role="tab"
            aria-selected={activeTab === value}
            aria-controls="detail-tabpanel"
            tabIndex={0}
            onClick={() => setTab(value)}
            onKeyDown={(e) => handleTabKeyDown(e, value)}
          >
            {label}{extra}
          </div>
        ))}
      </div>
      {testError && tab !== 'errors' && (
        <div class="test-error-banner" onClick={() => setTab('errors')}>
          <span class="test-error-banner-icon">✕</span>
          <span class="test-error-banner-text">{testError}</span>
        </div>
      )}
      <div
        id="detail-tabpanel"
        role="tabpanel"
        aria-labelledby={`detail-tab-${activeTab}`}
        class={`detail-content${activeTab === 'hierarchy' || activeTab === 'source' || activeTab === 'network' || activeTab === 'locator' || activeTab === 'console' ? ' detail-content-flush' : ''}`}
      >
        {activeTab === 'call' && <CallTab event={event} metadata={metadata} />}
        {activeTab === 'log' && <LogTab event={event} />}
        {activeTab === 'console' && <ConsoleTab event={event} events={consoleEvents} metadata={metadata} deviceNames={deviceNames} />}
        {activeTab === 'source' && <SourceTab event={event} sources={sources} previewHighlight={previewHighlight} />}
        {activeTab === 'hierarchy' && <HierarchyTabWrapper event={event} hierarchies={hierarchies} onNodeSelect={onHierarchyNodeSelect} group={group} screenshotVariant={screenshotVariant} />}

        {activeTab === 'locator' && locatorTab}
        {activeTab === 'network' && <NetworkTab networkCaptureEnabled={metadata?.traceConfig?.network} entries={networkEntries} bodies={networkBodies} deviceNames={deviceNames} hostWideCapture={capturedHostWide(metadata)} />}
        {activeTab === 'errors' && <ErrorsTab event={event} events={events} testError={testError} sources={sources} metadata={metadata} />}
      </div>
    </div>
  );
}

// ─── Call Tab ───

function formatSelectorForCall(sel: string | undefined): ComponentChildren {
  if (!sel) return null;
  const parts = parseSelectorParts(sel);
  if (!parts) return <span class="call-value mono">{sel}</span>;
  if (parts.optionKey) {
    return (
      <span class="call-value mono">
        <span class="sel-fn">{parts.fn}</span>({'{ '}<span class="sel-fn">{parts.optionKey}</span>{': '}<span class="sel-val">"{parts.args[0]}"</span>{' }'})
      </span>
    );
  }
  return (
    <span class="call-value mono">
      <span class="sel-fn">{parts.fn}</span>({parts.args.map((a, i) => <span key={i}>{i > 0 && ', '}<span class="sel-val">"{a}"</span></span>)})
    </span>
  );
}

function CallTab({ event, metadata }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; metadata: TraceMetadata }) {
  if (!event) return <div class="no-content" data-testid="no-content">No action selected</div>;
  const wallDuration = event.wallDuration ?? event.duration;

  if (event.type === 'action') {
    return (
      <div class="call-grid" data-testid="call-grid">
        <span class="call-label">Action</span>
        <span class="call-value">{event.action}</span>
        {event.selector && <>
          <span class="call-label">Locator</span>
          {formatSelectorForCall(event.selector)}
        </>}
        {event.inputValue !== undefined && <>
          <span class="call-label">Input</span>
          <span class="call-value mono">"{event.inputValue}"</span>
        </>}
        <span class="call-label">Wall time</span>
        <span class="call-value mono">{wallDuration}ms</span>
        {wallDuration !== event.duration && <>
          <span class="call-label">Action time</span>
          <span class="call-value mono">{event.duration}ms</span>
        </>}
        {event.gapBefore !== undefined && event.gapBefore > 0 && <>
          <span class="call-label">Gap before</span>
          <span class="call-value mono">{event.gapBefore}ms</span>
        </>}
        <span class="call-label">Status</span>
        <span class={`call-value ${event.success ? 'success' : 'error'}`}>
          {event.success ? 'passed' : 'failed'}
        </span>
        {(() => {
          const line = deviceLine(metadata, event);
          return line ? <>
            <span class="call-label">Device</span>
            <span class="call-value">{line}</span>
          </> : null;
        })()}
        {event.sourceLocation && <>
          <span class="call-label">Source</span>
          <span class="call-value mono">{event.sourceLocation.file}:{event.sourceLocation.line}</span>
        </>}
        {event.error && <>
          <span class="call-label">Error</span>
          <span class="call-value error">{event.error}</span>
        </>}
      </div>
    );
  }

  return (
    <div class="call-grid" data-testid="call-grid">
      <span class="call-label">Action</span>
      <span class="call-value">{event.assertion}</span>
      {event.selector && <>
        <span class="call-label">Locator</span>
        {formatSelectorForCall(event.selector)}
      </>}
      <span class="call-label">Wait strategy</span>
      <span class="call-value">element to {event.assertion.replace('toBe', 'become ').replace('toHave', 'have ')} (auto-wait)</span>
      {event.expected !== undefined && <>
        <span class="call-label">Expected</span>
        <span class="call-value mono">{event.expected}</span>
      </>}
      {event.actual !== undefined && <>
        <span class="call-label">Received</span>
        <span class="call-value mono">{event.actual}</span>
      </>}
      <span class="call-label">Timeout</span>
      <span class="call-value mono">{event.duration}ms</span>
      <span class="call-label">Elapsed</span>
      <span class={`call-value mono ${event.passed ? '' : 'error'}`}>
        {event.duration}ms{!event.passed ? ' (timed out)' : ''} — {event.attempts} attempt{event.attempts !== 1 ? 's' : ''}
      </span>
      {wallDuration !== event.duration && <>
        <span class="call-label">Wall time</span>
        <span class="call-value mono">{wallDuration}ms</span>
      </>}
      {event.gapBefore !== undefined && event.gapBefore > 0 && <>
        <span class="call-label">Gap before</span>
        <span class="call-value mono">{event.gapBefore}ms</span>
      </>}
      {(() => {
        const line = deviceLine(metadata, event);
        return line ? <>
          <span class="call-label">Device</span>
          <span class="call-value">{line}</span>
        </> : null;
      })()}
      {event.sourceLocation && <>
        <span class="call-label">Source</span>
        <span class="call-value mono">{event.sourceLocation.file}:{event.sourceLocation.line}</span>
      </>}
      {event.error && <>
        <span class="call-label">Error</span>
        <span class="call-value error">{event.error}</span>
      </>}
    </div>
  );
}

// ─── Log Tab (internal action log) ───

function LogTab({ event }: { event: ActionTraceEvent | AssertionTraceEvent | undefined }) {
  if (!event) return <div class="no-content" data-testid="no-content">No action selected</div>;

  const log = event.type === 'action' ? event.log : undefined;

  if (!log || log.length === 0) {
    return <div class="no-content" data-testid="no-content">No internal log for this action</div>;
  }

  return (
    <div>
      {log.map((entry, i) => (
        <div key={i} class="log-entry" data-testid="log-entry">
          <span class="log-message">{entry}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Console Tab ───

/** `all`, a source, or — in a multi-device trace — a device name. */
type SourceFilter = string
type ConsoleTimeMode = 'relative' | 'absolute'
type ConsoleSortColumn = 'time' | 'level' | 'source' | 'device' | 'message'
type ConsoleSortDirection = 'asc' | 'desc'

interface ConsoleColumn { key: ConsoleSortColumn; label: string; class: string }

const CONSOLE_COLUMNS: ConsoleColumn[] = [
  { key: 'time', label: 'Time', class: 'log-time' },
  { key: 'level', label: 'Level', class: 'log-level' },
  { key: 'source', label: 'Source', class: 'log-source' },
  { key: 'message', label: 'Message', class: 'log-message' },
];

/** Only present on a multi-device trace, where the rows carry a device pill. */
const CONSOLE_DEVICE_COLUMN: ConsoleColumn = { key: 'device', label: 'Device', class: 'log-device-col' };

const LEVEL_ORDER: ConsoleLevel[] = ['error', 'warn', 'info', 'log', 'debug'];

/**
 * Offset of a console entry from the start of the test, e.g. `+1.234s`.
 * Fixed three decimals keep the column aligned in the monospace list.
 */
function formatConsoleOffset(ms: number): string {
  const clamped = Math.max(0, ms);
  return `+${(clamped / 1000).toFixed(3)}s`;
}

/** Absolute wall-clock time with millisecond precision. */
function formatConsoleWallClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function ConsoleTab({ event, events: consoleEvents, metadata, deviceNames = [] }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; events: ConsoleTraceEvent[]; metadata: TraceMetadata; deviceNames?: string[] }) {
  const [search, setSearch] = useState('');
  // Offsets are relative to the test start. UI mode never has one: the SPA is
  // not told when a test began (`ui-mode/main.tsx` builds its live metadata with
  // `startTime: 0`), so it always falls back to the earliest console entry.
  // Offsets there are therefore relative to the first log line, which is what
  // `docs/trace-viewer.md` documents. The filmstrip has the same no-start-time
  // problem and takes the same fallback, but it also clamps a *present*
  // `startTime` against its earliest event; console entries are stamped on
  // ingestion and so never precede the test start, which is why this doesn't.
  const timeBase = useMemo(() => {
    if (metadata.startTime > 0) return metadata.startTime;
    let min = Infinity;
    for (const e of consoleEvents) if (e.timestamp < min) min = e.timestamp;
    return min === Infinity ? 0 : min;
  }, [metadata.startTime, consoleEvents]);
  const [levelFilter, setLevelFilter] = useState<Set<ConsoleLevel>>(new Set(LEVEL_ORDER));
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [scopeToAction, setScopeToAction] = useState(false);
  // Read back through a validating narrow rather than a cast: a stale or
  // hand-edited storage value would otherwise match neither pill, leaving both
  // unlit while the list silently rendered wall-clock times.
  const [storedTimeMode, setTimeMode] = usePersistedString('tapsmith-console-time', 'relative');
  const timeMode: ConsoleTimeMode = storedTimeMode === 'absolute' ? 'absolute' : 'relative';
  const [sortColumn, setSortColumn] = useState<ConsoleSortColumn>('time');
  const [sortDirection, setSortDirection] = useState<ConsoleSortDirection>('asc');

  const presentSources = useMemo(() => {
    const s = new Set<SourceFilter>();
    for (const e of consoleEvents) s.add(e.source as SourceFilter);
    return s;
  }, [consoleEvents]);
  // A multi-device trace tags device and daemon lines with the device that
  // produced them; one pill per device narrows the list to that device.
  const presentDevices = useMemo(() => {
    const present = new Set<string>();
    for (const e of consoleEvents) if (e.deviceId) present.add(e.deviceId);
    return deviceNames.filter((n) => present.has(n));
  }, [consoleEvents, deviceNames]);
  const showSourceFilter = presentSources.size > 1 || presentDevices.length > 1;
  const showDevices = deviceNames.length > 1;
  const columns = useMemo(() => {
    if (!showDevices) return CONSOLE_COLUMNS;
    const at = CONSOLE_COLUMNS.findIndex(c => c.key === 'message');
    return [...CONSOLE_COLUMNS.slice(0, at), CONSOLE_DEVICE_COLUMN, ...CONSOLE_COLUMNS.slice(at)];
  }, [showDevices]);

  // Sorting by a column that just disappeared (a live UI-mode session dropping
  // back to one device) would leave the list ordered by an invisible key.
  useEffect(() => {
    if (!showDevices && sortColumn === 'device') {
      setSortColumn('time');
      setSortDirection('asc');
    }
  }, [showDevices, sortColumn]);

  // If the active source filter is no longer present (e.g. switching to an
  // event with no daemon logs), reset to 'all' so the tab isn't confusingly empty.
  useEffect(() => {
    if (sourceFilter !== 'all' && !presentSources.has(sourceFilter) && !presentDevices.includes(sourceFilter)) {
      setSourceFilter('all');
    }
  }, [presentSources, presentDevices, sourceFilter]);

  const filtered = useMemo(() => {
    const lf = search.toLowerCase();
    const result = consoleEvents.filter(e => {
      if (!levelFilter.has(e.level as ConsoleLevel)) return false;
      if (sourceFilter !== 'all') {
        const byDevice = presentDevices.includes(sourceFilter);
        if (byDevice ? e.deviceId !== sourceFilter : e.source !== sourceFilter) return false;
      }
      if (scopeToAction && event && Math.abs(e.actionIndex - event.actionIndex) > 1) return false;
      if (lf && !e.message.toLowerCase().includes(lf)) return false;
      return true;
    });
    // Array.prototype.sort is stable, so entries that tie on the chosen column
    // keep their chronological order — sorting by level still reads as a log.
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortColumn) {
        case 'time': cmp = a.timestamp - b.timestamp; break;
        // Severity order, not alphabetical: error < warn < info < log < debug.
        case 'level': cmp = LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level); break;
        case 'source': cmp = a.source.localeCompare(b.source); break;
        case 'device': cmp = (a.deviceId ?? '').localeCompare(b.deviceId ?? ''); break;
        case 'message': cmp = a.message.localeCompare(b.message); break;
      }
      return sortDirection === 'asc' ? cmp : -cmp;
    });
    return result;
  }, [consoleEvents, search, levelFilter, sourceFilter, presentDevices, scopeToAction, event, sortColumn, sortDirection]);

  const handleSort = (col: ConsoleSortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(col);
      setSortDirection('asc');
    }
  };

  const toggleLevel = (level: ConsoleLevel) => {
    setLevelFilter(prev => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  if (consoleEvents.length === 0) return <div class="no-content" data-testid="no-content">No console output recorded</div>;

  return (
    <div class="con-container">
      <div class="con-toolbar">
        <input
          class="con-search"
          type="text"
          aria-label="Filter console output"
          placeholder="Filter logs…"
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        <div class="con-pills">
          {LEVEL_ORDER.map(level => (
            <button
              key={level}
              class={`con-pill level-${level}${levelFilter.has(level) ? ' active' : ''}`}
              onClick={() => toggleLevel(level)}
            >{level}</button>
          ))}
        </div>
        {showSourceFilter && (
          <>
            <div class="con-pill-sep" />
            <div class="con-pills" role="group" aria-label="Filter by source">
              {(['all', 'test', 'device', 'daemon'] as SourceFilter[])
                .filter(s => s === 'all' || presentSources.has(s))
                .map(s => (
                  <button
                    key={s}
                    class={`con-pill${sourceFilter === s ? ' active' : ''}`}
                    aria-pressed={sourceFilter === s}
                    onClick={() => setSourceFilter(s)}
                  >{s}</button>
                ))}
              {presentDevices.length > 1 && presentDevices.map((name) => (
                <button
                  key={`device-${name}`}
                  class={`con-pill con-pill-device${sourceFilter === name ? ' active' : ''}`}
                  style={deviceTagStyle({ devices: metadata.devices ?? [] }, name)}
                  aria-pressed={sourceFilter === name}
                  data-testid="console-device-pill"
                  onClick={() => setSourceFilter(name)}
                >{name}</button>
              ))}
            </div>
          </>
        )}
        <div class="con-pill-sep" />
        <div class="con-pills" role="group" aria-label="Timestamp format">
          {(['relative', 'absolute'] as ConsoleTimeMode[]).map(m => (
            <button
              key={m}
              class={`con-pill${timeMode === m ? ' active' : ''}`}
              aria-pressed={timeMode === m}
              onClick={() => setTimeMode(m)}
            >{m}</button>
          ))}
        </div>
        {event && (
          <>
            <div class="con-pill-sep" />
            <button
              class={`con-pill${scopeToAction ? ' active' : ''}`}
              onClick={() => setScopeToAction(prev => !prev)}
            >current action</button>
          </>
        )}
      </div>
      <div class="log-entry con-header" role="group" aria-label="Sort console output">
        {columns.map(col => (
          <button
            key={col.key}
            class={`con-th ${col.class}${sortColumn === col.key ? ' active' : ''}`}
            aria-pressed={sortColumn === col.key}
            data-sort-direction={sortColumn === col.key ? sortDirection : undefined}
            onClick={() => handleSort(col.key)}
          >
            {col.label}
            {sortColumn === col.key && <span class="con-sort-indicator">{sortDirection === 'asc' ? '\u25B2' : '\u25BC'}</span>}
          </button>
        ))}
      </div>
      <div class="con-list" role="log" aria-label="Console output">
        {filtered.length === 0
          ? <div class="no-content" data-testid="no-content">No matching log entries</div>
          : filtered.map((ev, i) => (
            <div key={i} class="log-entry" data-testid="log-entry">
              <span
                class="log-time"
                data-testid="log-time"
                title={timeMode === 'relative' ? formatConsoleWallClock(ev.timestamp) : formatConsoleOffset(ev.timestamp - timeBase)}
              >{timeMode === 'relative' ? formatConsoleOffset(ev.timestamp - timeBase) : formatConsoleWallClock(ev.timestamp)}</span>
              <span class={`log-level ${ev.level}`}>{ev.level}</span>
              <span class="log-source">{ev.source}</span>
              {showDevices && (
                // The cell renders even for an untagged line (test output), so
                // the Message column stays under its heading on every row.
                <span class="log-device-cell">
                  {ev.deviceId
                    ? <span class="action-device-tag log-device" data-testid="log-device" style={deviceTagStyle({ devices: metadata.devices ?? [] }, ev.deviceId)}>{ev.deviceId}</span>
                    : <span class="log-device-none">—</span>}
                </span>
              )}
              <span class="log-message" data-testid="log-message">{ev.message}</span>
            </div>
          ))
        }
      </div>
    </div>
  );
}

// ─── Source Tab ───

interface SourceToken {
  text: string
  type: 'keyword' | 'string' | 'comment' | 'number' | 'plain'
}

const KEYWORDS = new Set([
  'import', 'from', 'export', 'const', 'let', 'var', 'async', 'await',
  'function', 'return', 'if', 'else', 'try', 'catch', 'throw', 'new',
  'typeof', 'describe', 'test', 'expect', 'beforeEach', 'afterEach',
]);

function tokenizeLine(line: string, inBlockComment: boolean): { tokens: SourceToken[]; inBlockComment: boolean } {
  const tokens: SourceToken[] = [];
  let remaining = line;
  let blockComment = inBlockComment;

  // If we're inside a block comment from a previous line, consume until we find */
  if (blockComment) {
    const endIdx = remaining.indexOf('*/');
    if (endIdx === -1) {
      tokens.push({ text: remaining, type: 'comment' });
      return { tokens, inBlockComment: true };
    }
    tokens.push({ text: remaining.slice(0, endIdx + 2), type: 'comment' });
    remaining = remaining.slice(endIdx + 2);
    blockComment = false;
  }

  while (remaining.length > 0) {
    // Line comment
    if (remaining.startsWith('//')) {
      tokens.push({ text: remaining, type: 'comment' });
      remaining = '';
      break;
    }

    // Block comment start
    if (remaining.startsWith('/*')) {
      const endIdx = remaining.indexOf('*/', 2);
      if (endIdx === -1) {
        tokens.push({ text: remaining, type: 'comment' });
        remaining = '';
        blockComment = true;
        break;
      }
      tokens.push({ text: remaining.slice(0, endIdx + 2), type: 'comment' });
      remaining = remaining.slice(endIdx + 2);
      continue;
    }

    // Single-quoted string
    if (remaining[0] === "'") {
      const match = remaining.match(/^'(?:[^'\\]|\\.)*'/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Double-quoted string
    if (remaining[0] === '"') {
      const match = remaining.match(/^"(?:[^"\\]|\\.)*"/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Template literal (basic - no nesting)
    if (remaining[0] === '`') {
      const match = remaining.match(/^`(?:[^`\\]|\\.)*`/);
      if (match) {
        tokens.push({ text: match[0], type: 'string' });
        remaining = remaining.slice(match[0].length);
        continue;
      }
    }

    // Number
    const numMatch = remaining.match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+\.?\d*(?:[eE][+-]?\d+)?)(?!\w)/);
    if (numMatch && (tokens.length === 0 || /[^a-zA-Z_$]$/.test(tokens[tokens.length - 1].text))) {
      tokens.push({ text: numMatch[0], type: 'number' });
      remaining = remaining.slice(numMatch[0].length);
      continue;
    }

    // Keyword or identifier
    const wordMatch = remaining.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/);
    if (wordMatch) {
      const word = wordMatch[0];
      const type = KEYWORDS.has(word) ? 'keyword' : 'plain';
      tokens.push({ text: word, type });
      remaining = remaining.slice(word.length);
      continue;
    }

    // Any other character
    // Collect consecutive non-special characters as plain text
    const plainMatch = remaining.match(/^[^a-zA-Z_$'"`/0-9]+/);
    if (plainMatch) {
      tokens.push({ text: plainMatch[0], type: 'plain' });
      remaining = remaining.slice(plainMatch[0].length);
    } else {
      tokens.push({ text: remaining[0], type: 'plain' });
      remaining = remaining.slice(1);
    }
  }

  return { tokens, inBlockComment: blockComment };
}

const TOKEN_COLORS: Record<SourceToken['type'], string | undefined> = {
  keyword: 'var(--color-keyword)',
  string: 'var(--color-string)',
  comment: 'var(--color-text-faint)',
  number: 'var(--color-number)',
  plain: undefined,
};

function StackTraceView({ stack, selected, onSelect }: { stack: SourceLocation[]; selected: number; onSelect: (i: number) => void }) {
  return (
    <div class="source-stack">
      <div class="source-stack-title">Call stack</div>
      {stack.map((frame, i) => frame?.file && (
        <div
          key={i}
          class={`source-stack-frame${i === selected ? ' selected' : ''}`}
          title={`${frame.file}:${frame.line}`}
          role="button"
          tabIndex={0}
          onClick={() => onSelect(i)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(i); } }}
        >
          <span class="source-stack-file">{frame.file?.replace(/\\/g, '/').split('/').pop() ?? ''}</span>
          <span class="source-stack-line">:{frame.line}</span>
        </div>
      ))}
    </div>
  );
}

function SourceTab({ event, sources, previewHighlight }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; sources: Map<string, string>; previewHighlight?: SourceLocation }) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const [selectedFrame, setSelectedFrame] = useState(0);

  // With no event (e.g. previewing a test before it runs) fall back to the
  // preview highlight so the test's `test(...)` line is still highlighted.
  const stack = event?.stack ?? (event?.sourceLocation ? [event.sourceLocation] : previewHighlight ? [previewHighlight] : []);
  const eventKey = event ? `${event.type}-${event.actionIndex}` : 'none';
  useEffect(() => { setSelectedFrame(0); }, [eventKey]);

  // Guard against a one-render window where selectedFrame is stale (out of
  // bounds) right after switching to an event with a shorter stack, before the
  // reset effect runs — otherwise resolveSourceView would briefly show nothing.
  const activeFrame = selectedFrame < stack.length ? selectedFrame : 0;

  const { filename, content, highlightLine } = resolveSourceView(stack, sources, activeFrame, !!event);

  useEffect(() => {
    // Instant (not smooth) scroll: in a trace viewer the user steps through
    // actions rapidly, and smooth scrolling lags/bounces behind the clicks.
    highlightRef.current?.scrollIntoView({ block: 'center' });
  }, [highlightLine, filename]);

  const showStack = stack.length > 1;

  if (content === undefined) {
    return (
      <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
        <div class="source-main">
          <div class="no-content" data-testid="no-content">
            {filename ? `Source not captured for ${filename.replace(/\\/g, '/').split('/').pop()}` : 'No source files in trace'}
          </div>
        </div>
        {showStack && <StackTraceView stack={stack} selected={activeFrame} onSelect={setSelectedFrame} />}
      </div>
    );
  }

  const lines = content.split('\n');
  let inBlockComment = false;
  const tokenizedLines: SourceToken[][] = [];
  for (const line of lines) {
    const result = tokenizeLine(line, inBlockComment);
    tokenizedLines.push(result.tokens);
    inBlockComment = result.inBlockComment;
  }

  return (
    <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
      <div class="source-main">
        <div class="source-filename" data-testid="source-filename">{filename}</div>
        <div class="source-code">
          {/* aria-current marks the line the selected action came from: the
              current item in the set of lines, which is what a screen reader
              should hear rather than an unremarked colour change. */}
          {tokenizedLines.map((tokens, i) => (
            <div
              key={i}
              ref={highlightLine === i + 1 ? highlightRef : undefined}
              class={`source-line${highlightLine === i + 1 ? ' highlight' : ''}`}
              aria-current={highlightLine === i + 1 ? 'true' : undefined}
              data-testid="source-line"
              data-line={i + 1}
            >
              <span class="source-line-number">{i + 1}</span>
              <span class="source-line-content">
                {tokens.length === 0
                  ? '\u200b'
                  : tokens.map((token, j) => {
                      const color = TOKEN_COLORS[token.type];
                      return color
                        ? <span key={j} style={{ color }}>{token.text}</span>
                        : <span key={j}>{token.text}</span>;
                    })}
              </span>
            </div>
          ))}
        </div>
      </div>
      {showStack && <StackTraceView stack={stack} selected={activeFrame} onSelect={setSelectedFrame} />}
    </div>
  );
}

// ─── Hierarchy Tab ───

function HierarchyTabWrapper({ event, hierarchies, onNodeSelect, group, screenshotVariant = 'before' }: {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  hierarchies: Map<string, string>
  onNodeSelect?: (bounds: Bounds | null) => void
  group?: DeviceGroupView
  screenshotVariant?: 'before' | 'after'
}) {

  // Multi-device: default to the pane the viewer has active (the acting device
  // unless the user clicked another pane); the toggle views a different
  // device's tree at the frame its pane displays.
  const multi = !!group && group.devices.length > 1;
  const defaultDevice = multi ? (group!.activeDevice ?? actingDevice(group!, event)) : undefined;
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const eventKey = event ? `${event.type}-${event.actionIndex}-${defaultDevice ?? ''}` : 'none';
  useEffect(() => { setChosen(undefined); }, [eventKey]);
  const shownDevice = multi && chosen && group!.devices.some((d) => d.name === chosen) ? chosen : defaultDevice;

  if (!event || hierarchies.size === 0) return <div class="no-content" data-testid="no-content">No view hierarchy available</div>;

  let xml: string | undefined;
  if (multi && shownDevice && shownDevice !== actingDevice(group!, event)) {
    xml = hierarchyForDeviceFrame(group!, frameIndexForDevice(group!, shownDevice, event.actionIndex, screenshotVariant));

  } else {
    const pad = String(event.actionIndex).padStart(3, '0');
    const afterKey = `hierarchy/action-${pad}-after.xml`;
    const beforeKey = `hierarchy/action-${pad}-before.xml`;
    xml = hierarchies.get(afterKey) ?? hierarchies.get(beforeKey);
  }

  const toggle = multi ? (
    <div class="hier-device-toggle" role="group" aria-label="Hierarchy device">
      {group!.devices.map((d) => (
        <button
          key={d.name}
          class={`con-pill con-pill-device${shownDevice === d.name ? ' active' : ''}`}
          style={deviceTagStyle(group!, d.name ?? '')}
          aria-pressed={shownDevice === d.name}
          data-testid="hierarchy-device-pill"
          onClick={() => setChosen(d.name)}
        >{d.name}</button>
      ))}
    </div>
  ) : null;

  if (!xml) {
    return (
      <div>
        {toggle}
        <div class="no-content" data-testid="no-content">No hierarchy snapshot for this action</div>
      </div>
    );
  }

  return (
    <div class={multi ? 'hier-with-toggle' : undefined}>
      {toggle}
      <HierarchyTree xml={xml} onNodeSelect={onNodeSelect} />
    </div>
  );
}

// ─── Errors Tab ───

function errorTitle(ev: ActionTraceEvent | AssertionTraceEvent): string {
  if (ev.type === 'assertion') {
    return `Error: expect(locator).${ev.assertion}() failed`;
  }
  return `Error: ${ev.action}() failed`;
}

function buildCodeFrame(sources: Map<string, string>, loc: { file: string; line: number } | undefined): string | null {
  if (!loc || sources.size === 0) return null;
  const basename = loc.file.split('/').pop()!;
  const content = sources.get(loc.file) ?? sources.get(basename);
  if (!content) return null;
  const snippet = buildCodeSnippet(content, loc.line);
  return formatCodeSnippetPlain(snippet);
}

function ErrorsTab({ event, events, testError, sources, metadata }: {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  events: AnyTraceEvent[]
  testError?: string
  sources: Map<string, string>
  metadata: TraceMetadata
}) {
  // On a multi-device trace each entry names whose screen it failed on.
  const group = metadata.devices && metadata.devices.length > 1 ? { devices: metadata.devices } : undefined;
  const failedEvents = events.filter((e): e is ActionTraceEvent | AssertionTraceEvent =>
    (e.type === 'action' && !(e as ActionTraceEvent).success) ||
    (e.type === 'assertion' && !(e as AssertionTraceEvent).passed),
  );

  // The test-level error is usually the message of the failing assertion, so
  // suppress it when a matching failed event exists (mirrors Playwright, which
  // shows one error block per failure rather than duplicating at the bottom).
  const showTestError = testError
    && !failedEvents.some((ev) => ev.error && testError.includes(ev.error));

  if (failedEvents.length === 0 && !testError) return <div class="no-content" data-testid="no-content">No errors</div>;

  return (
    <div class="error-block">
      {failedEvents.map((ev, i) => (
        <ErrorEntry
          key={i}
          ev={ev}
          isSelected={!!event && event.actionIndex === ev.actionIndex && event.type === ev.type}
          sources={sources}
          group={group}
        />
      ))}
      {showTestError && (
        <div class="error-entry" data-testid="error-entry">
          <div class="error-title"><AlertTriangle size={14} class="error-title-icon" />Test Error</div>
          <div class="error-message">{testError}</div>
        </div>
      )}
    </div>
  );
}

function ErrorEntry({ ev, isSelected, sources, group }: {
  ev: ActionTraceEvent | AssertionTraceEvent
  isSelected: boolean
  sources: Map<string, string>
  group?: Pick<DeviceGroupView, 'devices'>
}) {
  const title = errorTitle(ev);
  const log = ev.type === 'action' ? ev.log : undefined;
  const stack = ev.type === 'action' ? ev.errorStack : undefined;
  const isAssertion = ev.type === 'assertion';
  const codeFrame = buildCodeFrame(sources, ev.sourceLocation);

  const errorLines: string[] = [];
  if (ev.error) errorLines.push(ev.error);
  if (codeFrame) { errorLines.push(''); errorLines.push(codeFrame); }

  const hasGrid = ev.selector || (isAssertion && (ev.expected !== undefined || ev.actual !== undefined));

  return (
    <div class={`error-entry${isSelected ? ' error-entry-selected' : ''}`} data-testid="error-entry">
      <div class="error-title">
        <AlertTriangle size={14} class="error-title-icon" />{title}
        {group && ev.deviceId && (
          <span class="action-device-tag" data-testid="error-device" style={deviceTagStyle(group, ev.deviceId)} title={`Failed on ${ev.deviceId}`}>{ev.deviceId}</span>
        )}
      </div>

      {hasGrid && (
        <div class="error-grid">
          {ev.selector && <>
            <div class="error-grid-key">Locator</div>
            {formatSelectorForCall(ev.selector)}
          </>}
          {isAssertion && ev.expected !== undefined && <>
            <div class="error-grid-key">Expected</div>
            <div class="error-grid-value expected">{ev.expected}</div>
          </>}
          {isAssertion && ev.actual !== undefined && <>
            <div class="error-grid-key">Received</div>
            <div class="error-grid-value received">{ev.actual}</div>
          </>}
        </div>
      )}

      {errorLines.length > 0 && (
        <pre class="error-detail-block">{errorLines.join('\n')}</pre>
      )}

      {log && log.length > 0 && (
        <details class="error-stack-details">
          <summary>Call log</summary>
          <ul class="error-log-list">
            {log.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </details>
      )}

      {stack && (
        <details class="error-stack-details">
          <summary>Stack trace</summary>
          <pre class="error-stack">{stack}</pre>
        </details>
      )}
    </div>
  );
}
