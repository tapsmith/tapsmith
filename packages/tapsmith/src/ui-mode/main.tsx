import { traceKey, parseTraceKey, TraceIdentityRegistry } from './trace-identity.js';
import { mergeNetworkBodies } from './network-bodies.js';
import './fonts.css';
import { render } from 'preact';
import { useState, useCallback, useMemo, useRef, useEffect } from 'preact/hooks';
import type { ServerMessage, ClientMessage, TestTreeNode, WorkerInfo, DeviceActivityMessage, UIPreferences } from './ui-protocol.js';
import { inferDevicePlatform, DEFAULT_UI_PREFERENCES, type DevicePlatform } from './ui-protocol.js';
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata, TraceDeviceInfo, SourceLocation } from '../trace/types.js';
import { actingDevice, frameIndexForDevice, hierarchyForDeviceFrame, isMultiDevice, laneStripMinHeight, type DeviceGroupView } from '../trace-viewer/components/device-frames.js';
import { sortEventsByStartTime } from '../trace/sort-events.js';
import { useWebSocket } from './hooks/use-websocket.js';
import {
  useTraceData,
  base64ToBlobUrl,
  base64ToBytes,
  revokeTraceScreenshots,
  reconcileTraceWallDuration,
  emptyTraceData,
  resolveActionHierarchy,
  getOrCreateTrace,
  EMPTY_MAP,
  EMPTY_BYTES_MAP,
  EMPTY_EVENTS,
  EMPTY_ACTION_EVENTS,
  EMPTY_NETWORK,
  type TestTraceData,
  type InFlightAction,
} from './hooks/use-trace-data.js';
import { useScreenMirror, useMultiScreenMirror } from './hooks/use-screen-mirror.js';
import { useTestTree } from './hooks/use-test-tree.js';
import { useRunTimer } from './hooks/use-run-timer.js';
import { usePersistedJSON } from './hooks/use-persisted-state.js';
import { resolveShortcut } from './keyboard-shortcuts.js';
import { Layout } from './components/Layout.js';
import { TestExplorer } from './components/TestExplorer.js';
import { RunControls, type Theme } from './components/RunControls.js';
import { DevicePane, deviceViewsOf } from './components/DevicePane.js';
import { DeviceActivityPanel } from './components/DeviceActivityPanel.js';
// Trace viewer components — reused for live trace display
import { ActionsPanel } from '../trace-viewer/components/ActionsPanel.js';
import { ScreenshotPanel } from '../trace-viewer/components/ScreenshotPanel.js';
import { DetailTabs } from '../trace-viewer/components/DetailTabs.js';
import { findTestDeclarationLine, findSuiteDeclarationLine } from '../trace-viewer/components/source-view-utils.js';
import { TimelineFilmstrip } from '../trace-viewer/components/TimelineFilmstrip.js';
import { LocatorTab, computeSelectorHighlights, handlePickFromScreenshot, handleHoverFromScreenshot, isWebViewOverlayPending } from '../trace-viewer/components/LocatorPlayground.js';
import { parseHierarchyXml } from '../trace-viewer/components/hierarchy-utils.js';
import type { HierarchyNode, Bounds } from '../trace-viewer/components/hierarchy-utils.js';
import { uiModeStyles } from './styles/ui-mode.css.js';
import type { ContainerSummary } from '../trace-viewer/types.js';

type ElementBounds = { left: number; top: number; right: number; bottom: number }

// Stable empty array — selector match highlights for the surface the current
// selector source does NOT belong to (avoids re-render churn).
const EMPTY_BOUNDS: Bounds[] = [];

function getResolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', getResolvedTheme(theme));
  document.body?.removeAttribute('data-theme');
}

function lastBoundsFrom(actionEvents: readonly (ActionTraceEvent | AssertionTraceEvent)[]): ElementBounds | undefined {
  for (let i = actionEvents.length - 1; i >= 0; i--) {
    if (actionEvents[i].bounds) return actionEvents[i].bounds;
  }
}

function buildContainerSummary(node: TestTreeNode): ContainerSummary {
  const counts = { passed: 0, failed: 0, running: 0, skipped: 0, idle: 0 };
  function walk(n: TestTreeNode) {
    if (n.type === 'test') {
      if (n.status === 'passed') counts.passed++;
      else if (n.status === 'failed') counts.failed++;
      else if (n.status === 'running') counts.running++;
      else if (n.status === 'skipped') counts.skipped++;
      else counts.idle++;
    }
    n.children?.forEach(walk);
  }
  node.children?.forEach(walk);
  const totalTests = counts.passed + counts.failed + counts.running + counts.skipped + counts.idle;
  return { name: node.name, nodeType: node.type as 'suite' | 'file' | 'project', totalTests, ...counts };
}

// ─── App ───

// Extract the project name from a tree node id, or undefined if the id has
// no project prefix. The name is used as-is: the server only builds project
// nodes for projects the config declared, and tags trace events with the
// same names, so a node named "default" is a real project. Stripping that
// name here mismatched the trace lookup key and left the Actions tab empty
// for every test in it. Mirrors the server's `project::<name>::<rest>` id
// construction via indexOf, so names containing a single ':' survive.
function extractProject(id: string): string | undefined {
  if (!id.startsWith('project::')) return undefined;
  const afterProject = id.slice('project::'.length);
  const sep = afterProject.indexOf('::');
  return sep === -1 ? afterProject : afterProject.slice(0, sep);
}

function App() {
  const [connected, setConnected] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [deviceSerial, setDeviceSerial] = useState('');
  const [deviceDpr, setDeviceDpr] = useState<number | undefined>();
  const [devicePlatform, setDevicePlatform] = useState<'android' | 'ios' | undefined>();
  const [deviceIsEmulator, setDeviceIsEmulator] = useState(false);
  const [tapsmithVersion, setTapsmithVersion] = useState('');
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem('tapsmith-ui-theme');
    return (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  });

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem('tapsmith-ui-theme', theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (theme === 'system') applyTheme('system');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Multi-worker state
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  // Live slow-device-action progress per worker during preflight resets
  // (e.g. "Clearing app data (com.foo)…") — enriches the Actions panel's
  // waiting state (PILOT-232).
  const [runProgress, setRunProgress] = useState<Map<number, string>>(new Map());
  /** Maps trace key → workerId that ran it. */
  const testWorkerMapRef = useRef<Map<string, number>>(new Map());
  /**
   * Devices each test's run drove (trace key → count), from `test-start`.
   * A worker holds its target's largest group, so a single-device project's
   * test on a group worker must not open the idle members' panes. State, not
   * a ref: the viewed test's panes re-derive when its run starts.
   */
  const [testDeviceCounts, setTestDeviceCounts] = useState<Map<string, number>>(() => new Map());
  /**
   * Hook-event index bookkeeping, per trace key. afterAll hooks run on a
   * fresh collector whose actionIndex restarts at 0, which would collide
   * with the test's own indices — same actionIndex means clobbered
   * screenshot/hierarchy keys and a mis-targeted auto-pin.
   *
   * - maxActionIndexRef: highest actionIndex seen (post-shift), INCLUDING
   *   internal markers like __final_screenshot — their screenshot keys
   *   occupy an index slot that shifted hook events must not reuse.
   * - rowCountRef: number of visible (non-internal, completed) rows — the
   *   positional index space that the ActionsPanel, pinning, and
   *   `actionEvents[selectedIndex]` all use.
   * - hookShiftRef: set on an attribution-only test-start. `offset` (max
   *   any + 1) shifts hook events past every reserved slot; `pinDelta`
   *   (offset − row count) converts a shifted actionIndex back to its
   *   positional row index, which trails it by the number of reserved
   *   non-row slots below.
   */
  const maxActionIndexRef = useRef<Map<string, number>>(new Map());
  const rowCountRef = useRef<Map<string, number>>(new Map());
  const hookShiftRef = useRef<Map<string, { offset: number; pinDelta: number }>>(new Map());
  /**
   * Auto-follow control for multi-worker mode.
   * - 'auto': follow the latest test start (single-worker behavior)
   * - 'worker:N': only follow tests from worker N
   * - 'manual': user clicked a test — stop auto-following
   */
  const autoFollowRef = useRef<'auto' | `worker:${number}` | 'manual'>('auto');

  const { testTraces, setTestTraces, activeTestRef, pendingSourcesRef } = useTraceData();
  // Pre-run source preview: keyed by normalised absolute path (forward slashes).
  const [previewSources, setPreviewSources] = useState<Map<string, string>>(new Map());
  // Tracks which paths have already been requested to avoid duplicate sends.
  const requestedSourcesRef = useRef<Set<string>>(new Set());
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const selectedIndex = hoveredIndex ?? pinnedIndex;

  // Locator playground state. Picks can come from two surfaces — the trace
  // screenshot viewer and the live device mirror. `pickTarget` is the surface
  // currently armed for picking (mutually exclusive by construction);
  // `selectorSource` is the hierarchy the Locator tab is bound to, which
  // persists after the pick lands so suggestions/match highlights keep
  // operating on the right tree and render on the right surface.
  const [hierarchyHighlight, setHierarchyHighlight] = useState<Bounds | null>(null);
  const [pickTarget, setPickTarget] = useState<'screenshot' | 'mirror' | null>(null);
  const [selectorSource, setSelectorSource] = useState<'trace' | 'live'>('trace');
  const [selectorText, setSelectorText] = useState('');
  const [pickedNode, setPickedNode] = useState<HierarchyNode | null>(null);
  const [hoverBounds, setHoverBounds] = useState<Bounds | null>(null);
  // Live mirror pick state: hierarchy snapshot fetched over the WebSocket,
  // refreshed every second while a pick is armed or the Locator tab is
  // live-bound with a selector (see liveHierarchyInUse below).
  const [liveHierarchyXml, setLiveHierarchyXml] = useState<string | null>(null);
  const [mirrorHoverBounds, setMirrorHoverBounds] = useState<Bounds | null>(null);

  // Device pane state
  const [selectedWorkerId, setSelectedWorkerId] = useState(0);
  const [deviceViewMode, setDeviceViewMode] = usePersistedJSON<'all' | number>('tapsmith-device-view', 'all');
  // Single-view mirror loading: true from when a device is selected until its
  // first frame paints (so we show the loading placeholder instead of a black
  // canvas during warmup). Cleared in handleScreenFrame.
  const [mirrorLoading, setMirrorLoading] = useState(false);
  const firstFrameRef = useRef(false);
  // Re-arm the loading placeholder whenever the mirrored single device changes
  // (a fresh device must repaint before we hide the placeholder). The grid uses
  // its own per-tile placeholder, so this only applies to the single view.
  useEffect(() => {
    firstFrameRef.current = false;
    setMirrorLoading(connected && deviceViewMode !== 'all');
  }, [deviceViewMode, selectedWorkerId, connected]);
  // Worker shown in the single-mirror view — the target for live element picks.
  const mirrorWorkerId = typeof deviceViewMode === 'number' ? deviceViewMode : selectedWorkerId;
  // Which device of that worker's group (a `use.devices` worker has several).
  const [mirrorDeviceIndex, setMirrorDeviceIndex] = useState(0);
  // Refs for the stable handleMessage callback (same pattern as deviceViewModeRef).
  const mirrorWorkerIdRef = useRef(mirrorWorkerId);
  mirrorWorkerIdRef.current = mirrorWorkerId;
  const mirrorDeviceIndexRef = useRef(mirrorDeviceIndex);
  mirrorDeviceIndexRef.current = mirrorDeviceIndex;

  // MCP state
  const [mcpUrl, setMcpUrl] = useState<string | undefined>();
  const [mcpClientName, setMcpClientName] = useState<string | undefined>();
  const [mcpClientVersion, setMcpClientVersion] = useState<string | undefined>();
  const [mcpClients, setMcpClients] = useState<{ name: string; version: string }[]>([]);
  const [mcpToolCalls, setMcpToolCalls] = useState<import('./ui-protocol.js').McpToolCallMessage[]>([]);
  const [mcpPanelOpen, setMcpPanelOpen] = usePersistedJSON<boolean>('tapsmith-mcp-panel', false);
  // Device activity outside traced tests (background preparation, mirror
  // gestures, recycles) — shares the feed with MCP tool calls.
  const [deviceActivity, setDeviceActivity] = useState<DeviceActivityMessage[]>([]);
  // Preferences the server acts on. The client owns persistence (localStorage,
  // like the run-deps toggle) and pushes them on connect; the server echoes
  // the merged value back so every client agrees.
  const [preferences, setPreferences] = useState<UIPreferences>(() => {
    try {
      const raw = localStorage.getItem('tapsmith-ui-preferences');
      return raw ? { ...DEFAULT_UI_PREFERENCES, ...JSON.parse(raw) } : DEFAULT_UI_PREFERENCES;
    } catch {
      return DEFAULT_UI_PREFERENCES;
    }
  });
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  // Error banner state — auto-dismisses after 8s or on click
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const showError = useCallback((msg: string) => {
    clearTimeout(errorTimerRef.current);
    setErrorMessage(msg);
    errorTimerRef.current = setTimeout(() => setErrorMessage(null), 8000);
  }, []);
  useEffect(() => () => clearTimeout(errorTimerRef.current), []);

  // Info banner state (e.g. "Run stopped") — same lifecycle, neutral styling
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const infoTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const showInfo = useCallback((msg: string) => {
    clearTimeout(infoTimerRef.current);
    setInfoMessage(msg);
    infoTimerRef.current = setTimeout(() => setInfoMessage(null), 8000);
  }, []);
  useEffect(() => () => clearTimeout(infoTimerRef.current), []);

  // "Run deps first" toggle — persisted in localStorage
  const [runDepsFirst, setRunDepsFirst] = useState(() => {
    return localStorage.getItem('tapsmith-ui-run-deps') === 'true';
  });
  const runDepsRef = useRef(runDepsFirst);

  const { runElapsed, startRunTimer, stopRunTimer } = useRunTimer();

  const tree = useTestTree(isRunning);
  // Ref to tree methods so handleMessage doesn't depend on the tree object
  // (which is recreated each render), preventing useCallback churn.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const { canvasRef, handleBinaryFrame } = useScreenMirror();
  const { registerCanvas, unregisterCanvas, handleBinaryFrame: handleMultiBinaryFrame } = useMultiScreenMirror();

  // Whether any project has dependencies (controls visibility of the toggle)
  const hasProjectDeps = useMemo(() => {
    return tree.allFiles.some((node) =>
      node.type === 'project' && node.dependencies && node.dependencies.length > 0,
    );
  }, [tree.allFiles]);

  // Tree node ids look like "<filePath>::<fullName>" or, when running a
  // multi-project config, "project::<projectName>::<filePath>::<fullName>".
  // Strip the project prefix before splitting so file/test extraction works
  // for both shapes.
  const stripProjectPrefix = (id: string): string => {
    if (!id.startsWith('project::')) return id;
    // Skip past "project::<name>::"
    const afterProject = id.slice('project::'.length);
    const sep = afterProject.indexOf('::');
    return sep === -1 ? afterProject : afterProject.slice(sep + 2);
  };

  const traceIdentitiesRef = useRef(new TraceIdentityRegistry());

  // Get the currently viewed test's trace data.
  // Only show trace data when a test is explicitly selected in the tree.
  const viewedTestName = useMemo(() => {
    if (tree.selectedTestId) {
      const stripped = stripProjectPrefix(tree.selectedTestId);
      const sep = stripped.indexOf('::');
      if (sep !== -1) {
        return stripped.slice(sep + 2);
      }
    }
    return null;
  }, [tree.selectedTestId]);

  const viewedTestFile = useMemo(() => {
    if (tree.selectedTestId) {
      const stripped = stripProjectPrefix(tree.selectedTestId);
      const sep = stripped.indexOf('::');
      if (sep !== -1) {
        return stripped.slice(0, sep);
      }
    }
    return '';
  }, [tree.selectedTestId]);

  // Find the viewed test node in the tree for duration/status
  const viewedTestNode = useMemo(() => {
    if (!tree.selectedTestId) return undefined;
    function find(nodes: TestTreeNode[]): TestTreeNode | undefined {
      for (const n of nodes) {
        if (n.id === tree.selectedTestId) return n;
        if (n.children) {
          const found = find(n.children);
          if (found) return found;
        }
      }
    }
    return find(tree.allFiles);
  }, [tree.selectedTestId, tree.allFiles]);

  const viewedTestProject = useMemo(
    () => (tree.selectedTestId ? extractProject(tree.selectedTestId) : undefined),
    [tree.selectedTestId],
  );
  const viewedTraceKey = viewedTestName ? traceKey(viewedTestProject, viewedTestName, viewedTestFile) : null;
  const viewedTraceKeyRef = useRef(viewedTraceKey);
  viewedTraceKeyRef.current = viewedTraceKey;
  const currentTrace = viewedTraceKey && viewedTestNode?.type === 'test' ? testTraces.get(viewedTraceKey) : undefined;
  // Sort by start time (timestamp - duration) so concurrent actions
  // (e.g. route handlers firing during a tap) appear in start-time order
  // rather than completion order.
  const traceEvents = useMemo(
    () => (currentTrace?.events ? sortEventsByStartTime(currentTrace.events) : EMPTY_EVENTS),
    [currentTrace?.events],
  );
  const actionEvents = useMemo(
    () => (currentTrace?.actionEvents
      ? sortEventsByStartTime(currentTrace.actionEvents)
      : EMPTY_ACTION_EVENTS),
    [currentTrace?.actionEvents],
  );
  const screenshots = currentTrace?.screenshots ?? EMPTY_MAP;
  const hierarchies = currentTrace?.hierarchies ?? EMPTY_MAP;
  // Resolve the single previewed source string outside useMemo (a plain O(1)
  // Map.get) so the 1-entry Map below is only reallocated when the key or its
  // content actually changes — not on every previewSources mutation.
  // Preview the source file for any test-bearing node: a file (no highlight),
  // a suite (highlight its `describe(...)`), or a test (highlight its `test(...)`).
  const previewable = viewedTestNode?.type === 'file'
    || viewedTestNode?.type === 'suite'
    || viewedTestNode?.type === 'test';
  const previewKey = previewable && viewedTestNode?.filePath
    ? viewedTestNode.filePath.replace(/\\/g, '/')
    : undefined;
  const previewContent = previewKey !== undefined ? previewSources.get(previewKey) : undefined;
  const previewSourcesForView = useMemo(() => {
    return previewKey !== undefined && previewContent !== undefined
      ? new Map([[previewKey, previewContent]])
      : EMPTY_MAP;
  }, [previewKey, previewContent]);
  // For a live trace, merge the session-wide previewSources (every streamed
  // source) under the trace's own snapshot. Sources are path-keyed with
  // identical on-disk content, so the union resolves any file the selected
  // step's call stack references — including files streamed by other workers
  // during parallel runs — instead of copying the map into every trace on
  // every 'source' message. Pre-run (no trace) keeps the scoped 1-file view.
  const sources = useMemo(() => {
    if (!currentTrace) return previewSourcesForView;
    if (previewSources.size === 0) return currentTrace.sources;
    // Build on previewSources, then let the trace's own snapshot win on key
    // collisions — same precedence as a spread merge, without allocating the
    // intermediate arrays a spread of both maps would create.
    const merged = new Map(previewSources);
    for (const [path, content] of currentTrace.sources) merged.set(path, content);
    return merged;
  }, [currentTrace, previewSources, previewSourcesForView]);
  // Pre-run preview: highlight the selected node's declaration line in its
  // source file — `test(...)` for a test, `describe(...)` for a suite. A file
  // node shows the source with nothing highlighted. Skipped once a trace
  // exists (events drive the view).
  const previewHighlight = useMemo<SourceLocation | undefined>(() => {
    if (currentTrace || previewKey === undefined || previewContent === undefined) return undefined;
    const line = viewedTestNode?.type === 'test'
      ? findTestDeclarationLine(previewContent, viewedTestNode.name)
      : viewedTestNode?.type === 'suite'
        ? findSuiteDeclarationLine(previewContent, viewedTestNode.name)
        : undefined;
    return line !== undefined ? { file: previewKey, line } : undefined;
  }, [currentTrace, previewKey, previewContent, viewedTestNode]);
  const networkEntries = currentTrace?.network ?? EMPTY_NETWORK;
  const networkBodies = currentTrace?.networkBodies ?? EMPTY_BYTES_MAP;
  const viewedTestWorker = (() => {
    if (!viewedTraceKey) return undefined;
    const workerId = testWorkerMapRef.current.get(viewedTraceKey);
    if (workerId == null) return undefined;
    return workers.find((worker) => worker.workerId === workerId);
  })();

  // Metadata for trace viewer components
  const testDeviceSerial = useMemo(() => {
    if (viewedTestWorker) {
      return viewedTestWorker.displayName || viewedTestWorker.deviceSerial;
    }
    // Multi-worker runs: don't fall back to the global deviceSerial — it
    // holds the first worker's serial from the initial `device-info` event,
    // which is almost never the worker that ran the viewed test. Returning
    // empty hides the label rather than labelling the filmstrip with a
    // sibling worker's name. Single-worker runs have no ambiguity.
    return workers.length > 1 ? '' : deviceSerial;
  }, [viewedTestWorker, workers.length, deviceSerial]);

  // DPR for the worker that ran the viewed test — not the currently selected
  // device-mirror tab. Multi-worker mode mixes platforms (iOS @2/3x +
  // Android @1x), so a single global value would mis-scale bounds whenever
  // the viewed trace and the visible mirror belong to different workers.
  const viewedTestDpr = useMemo(() => {
    if (viewedTestWorker) {
      return viewedTestWorker.devicePixelRatio;
    }
    return deviceDpr;
  }, [viewedTestWorker, deviceDpr]);

  const viewedTestPlatform = useMemo<DevicePlatform | undefined>(() => {
    if (viewedTestWorker) {
      return viewedTestWorker.platform
        ?? inferDevicePlatform(viewedTestWorker.displayName, viewedTestWorker.deviceSerial, viewedTestProject);
    }
    return inferDevicePlatform(viewedTestProject, testDeviceSerial) ?? devicePlatform;
  }, [viewedTestWorker, viewedTestProject, testDeviceSerial, devicePlatform]);

  const viewedIsolation = currentTrace?.isolation;
  // A `use.devices` worker: the trace's device group, as a packaged archive
  // would list it, so the live view gets the same side-by-side panes and
  // device filters as the standalone viewer.
  const viewedGroupDevices = useMemo<TraceDeviceInfo[] | undefined>(() => {
    const all = viewedTestWorker?.devices;
    const count = viewedTraceKey ? testDeviceCounts.get(viewedTraceKey) : undefined;
    const devices = all && count !== undefined ? all.slice(0, count) : all;
    if (!devices || devices.length < 2) return undefined;
    return devices.map((d) => ({
      name: d.name,
      serial: d.deviceSerial,
      model: d.displayName,
      platform: d.platform,
      devicePixelRatio: d.devicePixelRatio,
      isEmulator: d.isEmulator ?? false,
    }));
  }, [viewedTestWorker, viewedTraceKey, testDeviceCounts]);
  // The collector's action count — where the runner's terminal screenshots
  // start (`actionCount + ordinal`, see device-frames.ts) — is one past the
  // highest index the test's own steps used. The visible row count falls
  // short of it whenever an index was spent without a row: a beforeAll
  // offset, an attempt fenced mid-action, or the step still in flight; a
  // group's non-acting pane would then resolve its terminal frame to
  // another device's, or to none. Hook events re-tagged after the test
  // (hookShiftRef) sit past the terminal frames and are left out.
  const liveActionCount = useMemo(() => {
    const hookOffset = viewedTraceKey ? hookShiftRef.current.get(viewedTraceKey)?.offset : undefined;
    const own = (index: number) => hookOffset === undefined || index < hookOffset;
    let highest = -1;
    for (const e of actionEvents) if (own(e.actionIndex)) highest = Math.max(highest, e.actionIndex);
    const inFlight = currentTrace?.inFlightAction;
    if (inFlight && own(inFlight.actionIndex)) highest = Math.max(highest, inFlight.actionIndex);
    return highest + 1;
  }, [actionEvents, currentTrace?.inFlightAction, viewedTraceKey]);
  const metadata = useMemo<TraceMetadata>(() => ({
    version: 1,
    tapsmithVersion,
    testFile: viewedTestFile,
    testName: viewedTestName ?? (isRunning ? 'Running...' : ''),
    testStatus: viewedTestNode?.status === 'failed' ? 'failed'
      : viewedTestNode?.status === 'running' ? 'running'
      : viewedTestNode?.status === 'skipped' ? 'skipped'
      : viewedTestNode?.status === 'passed' ? 'passed'
      : 'idle',
    testDuration: viewedTestNode?.duration ?? 0,
    startTime: 0,
    endTime: viewedTestNode?.duration ?? 0,
    device: {
      serial: testDeviceSerial,
      isEmulator: deviceIsEmulator,
      // Drives the Network tab's host-wide banner and the Metadata tab's
      // route row, as the packaged trace's metadata does.
      ...(currentTrace?.networkCaptureRoute ? { networkCaptureRoute: currentTrace.networkCaptureRoute } : {}),
    },
    traceConfig: { screenshots: true, snapshots: true, sources: true, network: currentTrace?.networkCaptureEnabled ?? true, deviceLogs: false, daemonLogs: false },
    actionCount: liveActionCount,
    screenshotCount: screenshots.size,
    error: viewedTestNode?.error,
    project: viewedTestProject,
    // The isolation this execution ran under, as the trace viewer shows it
    // from the packaged archive — resolved by the runner, not the declared
    // `auto`.
    appReset: viewedIsolation?.appReset,
    appResetScope: viewedIsolation?.appResetScope,
    appState: viewedIsolation?.appState,
    devices: viewedGroupDevices,
  }), [viewedTestName, viewedTestFile, viewedTestNode, viewedTestProject, isRunning, liveActionCount, screenshots.size, testDeviceSerial, deviceIsEmulator, tapsmithVersion, viewedIsolation, viewedGroupDevices, currentTrace?.networkCaptureEnabled, currentTrace?.networkCaptureRoute]);

  // Prefer a real completed event at this index; fall back to a synthesized
  // one from the in-flight slot so ScreenshotPanel can render the before-
  // screenshot (and overlay bounds, if any) while the action is running.
  const selectedEvent = useMemo<ActionTraceEvent | AssertionTraceEvent | undefined>(() => {
    const completed = actionEvents[selectedIndex];
    if (completed) return completed;
    const inFlight = currentTrace?.inFlightAction;
    // selectedIndex is positional; inFlight.actionIndex is the event's own
    // index, which runs ahead by pinDelta for shifted hook events (see
    // hookShiftRef). Convert before comparing.
    const inFlightPinDelta = viewedTraceKey
      ? (hookShiftRef.current.get(viewedTraceKey)?.pinDelta ?? 0)
      : 0;
    if (!inFlight || inFlight.actionIndex - inFlightPinDelta !== selectedIndex) return undefined;
    if (inFlight.kind === 'action') {
      return {
        type: 'action',
        actionIndex: inFlight.actionIndex,
        timestamp: inFlight.startedAt,
        category: inFlight.category,
        action: inFlight.label,
        selector: inFlight.selector,
        duration: 0,
        success: true,
        bounds: inFlight.bounds,
        point: inFlight.point,
        hasScreenshotBefore: inFlight.hasScreenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: inFlight.hasHierarchyBefore,
        hasHierarchyAfter: false,
        stack: inFlight.stack,
        sourceLocation: inFlight.sourceLocation,
      } satisfies ActionTraceEvent;
    }
    return {
      type: 'assertion',
      actionIndex: inFlight.actionIndex,
      timestamp: inFlight.startedAt,
      assertion: inFlight.label,
      selector: inFlight.selector,
      passed: true,
      soft: false,
      negated: false,
      duration: 0,
      attempts: 0,
      bounds: inFlight.bounds,
      hasScreenshotBefore: inFlight.hasScreenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: inFlight.hasHierarchyBefore,
      hasHierarchyAfter: false,
      stack: inFlight.stack,
      sourceLocation: inFlight.sourceLocation,
    } satisfies AssertionTraceEvent;
  }, [actionEvents, selectedIndex, currentTrace?.inFlightAction]);

  // Which screenshot moment the ScreenshotPanel is displaying — the selector
  // playground must bind to the hierarchy captured at that same moment, or
  // picks on a before-screenshot would hit-test the after-hierarchy.
  const [screenshotVariant, setScreenshotVariant] = useState<'before' | 'after'>('before');

  // Multi-device: the pane the user last clicked (picking, Locator tab).
  // Reset whenever the selection moves so each step opens on its acting device.
  const [activeDeviceOverride, setActiveDeviceOverride] = useState<string | undefined>(undefined);
  useEffect(() => { setActiveDeviceOverride(undefined); }, [selectedIndex, viewedTraceKey]);
  const group = useMemo<DeviceGroupView | undefined>(() => {
    if (!viewedGroupDevices) return undefined;
    const acting = actingDevice({ devices: viewedGroupDevices }, selectedEvent);
    const override = activeDeviceOverride && viewedGroupDevices.some((d) => d.name === activeDeviceOverride)
      ? activeDeviceOverride
      : undefined;
    return {
      devices: viewedGroupDevices,
      actionEvents,
      actionCount: liveActionCount,
      hierarchies,
      activeDevice: override ?? acting,
      onActiveDeviceChange: setActiveDeviceOverride,
    };
  }, [viewedGroupDevices, actionEvents, liveActionCount, hierarchies, selectedEvent, activeDeviceOverride]);

  // Hierarchy for the current action (used by locator playground) — resolved
  // to depict the same moment as the displayed screenshot, borrowing for
  // actions that capture none (network family). PILOT-302.
  const currentHierarchy = useMemo(() => {
    if (!selectedEvent) return undefined;
    // A non-acting pane is bound to its own device's frame, not the step's.
    if (group && group.activeDevice && group.activeDevice !== actingDevice(group, selectedEvent)) {
      const frame = frameIndexForDevice(group, group.activeDevice, selectedEvent.actionIndex, screenshotVariant);
      const xml = hierarchyForDeviceFrame(group, frame);
      return xml ? { xml } : undefined;
    }
    return resolveActionHierarchy(hierarchies, screenshots, selectedEvent.actionIndex, screenshotVariant);
  }, [selectedEvent, hierarchies, screenshots, screenshotVariant, group]);

  // Keyed on the xml string, not the wrapper object: the trace maps are
  // rebuilt on every streamed message, and re-parsing a large tree per
  // message is jank the string key avoids.
  const currentHierarchyXml = currentHierarchy?.xml;
  const currentRoots = useMemo(
    () => currentHierarchyXml ? parseHierarchyXml(currentHierarchyXml) : [],
    [currentHierarchyXml],
  );

  const dpr = viewedTestDpr ?? 1;

  // Live-mirror hierarchy, parsed once per snapshot (same shape as currentRoots).
  const liveRoots = useMemo(
    () => liveHierarchyXml ? parseHierarchyXml(liveHierarchyXml) : [],
    [liveHierarchyXml],
  );

  // Match overlay bounds, derived from whichever hierarchy the Locator tab is
  // bound to. Derived rather than pushed up from LocatorTab so it stays
  // consistent with the tree even when the Locator tab isn't mounted.
  const selectorHighlights = useMemo(
    () => computeSelectorHighlights(selectorSource === 'live' ? liveRoots : currentRoots, selectorText),
    [selectorSource, liveRoots, currentRoots, selectorText],
  );

  const handleScreenshotClick = useCallback((point: { x: number; y: number }) => {
    if (pickTarget !== 'screenshot' || currentRoots.length === 0) return;
    const result = handlePickFromScreenshot(currentRoots, point.x / dpr, point.y / dpr);
    if (result) {
      setSelectorText(result.selector);
      setPickedNode(result.node);
      setPickTarget(null);
      setHoverBounds(null);
    }
  }, [pickTarget, currentRoots, dpr]);

  const handlePickToggle = useCallback(() => {
    setPickTarget(t => t === 'screenshot' ? null : 'screenshot');
    setSelectorSource('trace');
    setPickedNode(null);
    setHoverBounds(null);
    setMirrorHoverBounds(null);
  }, []);

  const handleScreenshotHover = useCallback((point: { x: number; y: number } | null) => {
    if (pickTarget !== 'screenshot' || currentRoots.length === 0 || !point) {
      setHoverBounds(null);
      return;
    }
    setHoverBounds(handleHoverFromScreenshot(currentRoots, point.x / dpr, point.y / dpr));
  }, [pickTarget, currentRoots, dpr]);

  // Selecting a different action re-binds the Locator tab to the trace
  // hierarchy of that step. The pick and selector text are kept — suggestions
  // and match highlights re-evaluate against the new step's tree (same
  // always-current semantics as the live mirror). Only per-tree transients
  // (hierarchy-tab selection, hover rects) are cleared.
  useEffect(() => {
    setHierarchyHighlight(null);
    setHoverBounds(null);
    setSelectorSource('trace');
    setMirrorHoverBounds(null);
  }, [selectedIndex]);

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'test-tree':
        traceIdentitiesRef.current.setTree(msg.files);
        treeRef.current.setTestTree(msg.files);
        break;
      case 'run-state':
        setIsRunning(msg.isRunning);
        if (msg.isRunning) {
          startRunTimer(msg.startedAt);
        } else {
          stopRunTimer();
        }
        break;
      case 'run-start':
        setIsRunning(true);
        setRunProgress(new Map());
        startRunTimer();
        // Scope trace clearing: single test > single file > all.
        // This preserves traces from other tests/files so clicking back
        // on them still shows their actions and status.
        if (msg.testFilter) {
          // Running a single test — clear only the trace for this exact
          // (project, file, test) tuple. Without the project scope we'd wipe the
          // sibling project's copy of the same test from a previous run.
          setTestTraces((prev) => {
            const targetKey = traceIdentitiesRef.current.resolve(msg.projectName, msg.testFilter!, msg.filePath);
            if (!targetKey) return prev;
            const old = prev.get(targetKey);
            if (!old) return prev;
            revokeTraceScreenshots(old);
            const next = new Map(prev);
            next.delete(targetKey);
            return next;
          });
        } else if (msg.filePath) {
          // Running a whole file — clear traces for that file, scoped to the
          // current project when one is set so the other project's traces
          // for the same file path stay intact.
          setTestTraces((prev) => {
            const next = new Map<string, TestTraceData>();
            for (const [k, data] of prev) {
              const matchesFile = data.filePath === msg.filePath;
              const matchesProject = !msg.projectName || parseTraceKey(k).projectName === msg.projectName;
              if (matchesFile && matchesProject) {
                revokeTraceScreenshots(data);
              } else {
                next.set(k, data);
              }
            }
            return next;
          });
        } else {
          // Running all files — revoke all blob URLs
          setTestTraces((prev) => {
            for (const data of prev.values()) revokeTraceScreenshots(data);
            return new Map();
          });
        }
        activeTestRef.current = null;

        // Mirror the optimistic pending pulse off the server's run-start, not
        // just the local play-click. A run triggered any other way — an MCP
        // agent calling tapsmith_run_tests, or this run started from a
        // different browser tab — never fires the client-side setPending, so
        // its target would jump straight from idle to 'running' with no
        // preflight feedback. setPendingForRun resolves the node by
        // filePath/fullName (not a reconstructed id) so it works even for the
        // "default" project, whose nodes are id-prefixed but whose run-start
        // reports projectName as undefined. Idempotent with the local click.
        if (msg.filePath) {
          treeRef.current.setPendingForRun(msg.filePath, msg.testFilter, msg.projectName);
        }

        pendingSourcesRef.current = new Map();
        setPinnedIndex(0);
        setHoveredIndex(null);
        if (!msg.filePath && !msg.testFilter) {
          // Full run — clear worker mappings
          testWorkerMapRef.current.clear();
        }
        autoFollowRef.current = 'auto';
        break;
      case 'run-end':
        setIsRunning(false);
        setIsStopping(false);
        setRunProgress(new Map());
        stopRunTimer();
        if (msg.status === 'stopped') {
          showInfo(msg.interrupted
            ? `Run stopped (${msg.interrupted} test${msg.interrupted === 1 ? '' : 's'} interrupted)`
            : 'Run stopped');
        } else if (msg.timeToFirstActionMs != null) {
          // The number users feel: how long before the first test did anything,
          // and whether the background preparation paid for it.
          const secs = `${(msg.timeToFirstActionMs / 1000).toFixed(1)}s`;
          const how = msg.preflight?.origin === 'prepared'
            ? 'device was prepared'
            : msg.preflight?.origin === 'inline'
              ? 'app reset ran inline'
              : msg.preflight?.origin === 'skipped'
                ? 'no app reset'
                : undefined;
          showInfo(`First action after ${secs}${how ? ` (${how})` : ''}`);
        }
        // Clear any tests/suites/files stuck in 'running' (e.g. after stop).
        treeRef.current.resetRunningStatuses();
        // Clear any in-flight slots that didn't receive a completed event
        // (e.g. run aborted mid-action) so spinners don't linger.
        setTestTraces((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [k, data] of prev) {
            if (data.inFlightAction != null) {
              next.set(k, { ...data, inFlightAction: null });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        break;
      case 'test-start': {
        const key = traceIdentitiesRef.current.register(msg.projectName, msg.fullName, msg.filePath);
        // Track which worker ran this test
        if (msg.workerId != null) {
          testWorkerMapRef.current.set(key, msg.workerId);
        }
        // Attribution-only re-tag: the runner points afterAll trace events
        // at the last test that ran — a test that has already ENDED. Only
        // redirect trace accumulation; don't flip the finished test back to
        // 'running' (run-end would then reset it to idle, losing its
        // pass/fail mark) and don't clear its accumulated trace actions.
        // The afterAll collector restarts actionIndex at 0, so shift its
        // events past the test's own indices (see hookShiftRef).
        if (msg.attributionOnly) {
          activeTestRef.current = key;
          const offset = (maxActionIndexRef.current.get(key) ?? -1) + 1;
          hookShiftRef.current.set(key, {
            offset,
            pinDelta: offset - (rowCountRef.current.get(key) ?? 0),
          });
          break;
        }
        maxActionIndexRef.current.delete(key);
        rowCountRef.current.delete(key);
        hookShiftRef.current.delete(key);
        setTestDeviceCounts((prev) => {
          if (prev.get(key) === msg.deviceCount) return prev;
          const next = new Map(prev);
          if (msg.deviceCount === undefined) next.delete(key);
          else next.set(key, msg.deviceCount);
          return next;
        });
        // Mark this test (and its parent describe/file) as running — scoped
        // to the project running it so a sibling project's copy of the same
        // file doesn't pulse blue too.
        treeRef.current.updateTestStatus(msg.fullName, msg.filePath, 'running', undefined, undefined, msg.projectName);

        // Track the active test for trace data accumulation, but don't
        // auto-select in the tree — only failures trigger auto-selection.
        activeTestRef.current = key;

        // Only reset pin if the user is viewing this test (or no test selected)
        if (!viewedTraceKeyRef.current || viewedTraceKeyRef.current === key) {
          setPinnedIndex(0);
          setHoveredIndex(null);
        }
        // Ensure trace data exists for this test, snapshotting its source file.
        // If trace data already exists (e.g. retry after infrastructure error
        // recovery), clear it so stale events from the failed attempt don't
        // accumulate alongside the retry's events.
        setTestTraces((prev) => {
          const existing = prev.get(key);
          if (existing) revokeTraceScreenshots(existing);
          const next = new Map(prev);
          const data = emptyTraceData(msg.filePath);
          data.isolation = msg.isolation;
          // Seed the test file from the pending pool (pre-run preview).
          const normalizedPath = msg.filePath.replace(/\\/g, '/');
          const sourceContent = pendingSourcesRef.current.get(normalizedPath);
          if (sourceContent) {
            data.sources = new Map([[normalizedPath, sourceContent]]);
          }
          next.set(key, data);
          return next;
        });
        break;
      }
      case 'test-status': {
        const statusKey = traceIdentitiesRef.current.register(msg.projectName, msg.fullName, msg.filePath);
        if (msg.workerId != null) {
          testWorkerMapRef.current.set(statusKey, msg.workerId);
        }
        treeRef.current.updateTestStatus(msg.fullName, msg.filePath, msg.status, msg.duration, msg.error, msg.projectName);
        // Single reducer: clear any stale in-flight slot AND store tracePath
        // (when present) in one render. Test end implies pre-flight done and
        // any spinner should clear; on reconnect we may have no entry yet
        // for this test, in which case stub one so the Download Trace
        // button can appear.
        setTestTraces((prev) => {
          const existing = prev.get(statusKey);
          const needsClear = existing?.inFlightAction != null;
          const hasPath = msg.tracePath || msg.videoPath;
          if (!existing && !hasPath) return prev;
          const data = existing ?? emptyTraceData(msg.filePath);
          const reconciled = reconcileTraceWallDuration(data, msg.duration);
          const needsReconcile = reconciled !== data;
          if (existing && !needsClear && !hasPath && !needsReconcile) return prev;
          const next = new Map(prev);
          next.set(statusKey, {
            ...reconciled,
            inFlightAction: null,
            ...(msg.tracePath ? { tracePath: msg.tracePath } : {}),
            ...(msg.videoPath ? { videoPath: msg.videoPath } : {}),
          });
          return next;
        });
        // Auto-expand tree path to failing test, select it, and pin the failing action
        if (msg.status === 'failed') {
          treeRef.current.expandPathTo(msg.fullName, msg.filePath, msg.projectName);
          // Tree IDs are scoped per-project (e.g. "project::android::") when
          // running multi-device configs, so use the same prefix here.
          const idPrefix = msg.projectName ? `project::${msg.projectName}::` : '';
          treeRef.current.setSelectedTestId(`${idPrefix}${msg.filePath}::${msg.fullName}`);
          autoFollowRef.current = 'manual';
          activeTestRef.current = statusKey;

          // Find the last failed action and pin it
          setTestTraces((prev) => {
            const trace = prev.get(statusKey);
            if (trace) {
              const failIdx = trace.actionEvents.findLastIndex((e) => (e.type === 'action' ? !e.success : !e.passed));
              if (failIdx !== -1) {
                setPinnedIndex(failIdx);
                setHoveredIndex(null);
              }
            }
            return prev;
          });
        }
        break;
      }
      case 'file-status':
        treeRef.current.updateFileStatus(msg.filePath, msg.status, msg.projectName);
        break;
      case 'trace-event': {
        const key = msg.testFullName
          ? traceIdentitiesRef.current.resolve(msg.projectName, msg.testFullName, msg.filePath)
          : (activeTestRef.current ?? '');
        if (!key) break;
        if (msg.workerId != null) {
          testWorkerMapRef.current.set(key, msg.workerId);
        }
        let ev = msg.event;
        // Events streamed after the test ended (afterAll hooks) come from a
        // fresh collector whose actionIndex restarts at 0. Shift them past
        // every index the test used — its rows AND reserved internal-marker
        // slots — so screenshot/hierarchy keys don't clobber the test's
        // captures (including the final screenshot's).
        const hookShift = hookShiftRef.current.get(key);
        if (hookShift && 'actionIndex' in ev) {
          ev = { ...ev, actionIndex: ev.actionIndex + hookShift.offset };
        }
        // Skip internal marker events from the visible event lists and from
        // auto-pin — their actionIndex is one past the last real event.
        const isInternal = ev.type === 'action' && ev.action === '__final_screenshot';
        const isStarted = msg.lifecycle === 'started';
        // Track the highest actionIndex seen — internal markers included —
        // and the visible row count. Both feed hookShiftRef (see its doc).
        if ((ev.type === 'action' || ev.type === 'assertion')
          && ev.actionIndex > (maxActionIndexRef.current.get(key) ?? -1)) {
          maxActionIndexRef.current.set(key, ev.actionIndex);
        }
        const isVisibleRow = !isInternal && (ev.type === 'action' || ev.type === 'assertion');
        if (isVisibleRow && !isStarted) {
          rowCountRef.current.set(key, (rowCountRef.current.get(key) ?? 0) + 1);
        }

        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(key, prev, parseTraceKey(key).filePath);

          // Always store before-screenshot/hierarchy at action-XXX-before so
          // the screenshot panel can display device state during execution.
          // Both 'started' and 'completed' carry the same before-capture, so
          // this runs identically for both branches.
          const screenshots = new Map(data.screenshots);
          const hierarchies = new Map(data.hierarchies);
          if (ev.type === 'action' || ev.type === 'assertion') {
            const pad = String(ev.actionIndex).padStart(3, '0');
            if (msg.screenshotBefore) {
              const k = `screenshots/action-${pad}-before.png`;
              const old = screenshots.get(k);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(k, base64ToBlobUrl(msg.screenshotBefore));
            }
            if (msg.screenshotAfter) {
              const k = `screenshots/action-${pad}-after.png`;
              const old = screenshots.get(k);
              if (old) try { URL.revokeObjectURL(old); } catch { /* already revoked */ }
              screenshots.set(k, base64ToBlobUrl(msg.screenshotAfter));
            }
            // No-screenshot actions (toBe assertions, query methods) are handled
            // at render time via findNearestScreenshot() — copying blob URLs
            // between map entries caused revocation of shared references.
            if (msg.hierarchyBefore) {
              hierarchies.set(`hierarchy/action-${pad}-before.xml`, msg.hierarchyBefore);
            }
            if (msg.hierarchyAfter) {
              hierarchies.set(`hierarchy/action-${pad}-after.xml`, msg.hierarchyAfter);
            }
          }

          // Started: set the in-flight slot, do NOT append to events/actionEvents.
          // The matching 'completed' event will land at the same actionIndex.
          if (isStarted && !isInternal && (ev.type === 'action' || ev.type === 'assertion')) {
            const inheritedBounds = ev.bounds ?? lastBoundsFrom(data.actionEvents);
            // ev is narrowed to ActionTraceEvent | AssertionTraceEvent here;
            // both have these flags (assertion's are optional, hence the ??).
            const hasShotBefore = !!ev.hasScreenshotBefore;
            const hasHierBefore = !!ev.hasHierarchyBefore;
            const inFlightAction: InFlightAction = ev.type === 'action'
              ? {
                  actionIndex: ev.actionIndex,
                  kind: 'action',
                  category: ev.category,
                  label: ev.action,
                  selector: ev.selector,
                  failed: false,
                  startedAt: ev.timestamp,
                  bounds: inheritedBounds,
                  point: ev.point,
                  hasScreenshotBefore: hasShotBefore,
                  hasHierarchyBefore: hasHierBefore,
                  stack: ev.stack,
                  sourceLocation: ev.sourceLocation,
                }
              : {
                  actionIndex: ev.actionIndex,
                  kind: 'assertion',
                  category: 'other',
                  label: ev.assertion,
                  selector: ev.selector,
                  failed: false,
                  startedAt: ev.timestamp,
                  bounds: inheritedBounds,
                  hasScreenshotBefore: hasShotBefore,
                  hasHierarchyBefore: hasHierBefore,
                  stack: ev.stack,
                  sourceLocation: ev.sourceLocation,
                };
            const next = new Map(map);
            next.set(key, { ...data, screenshots, hierarchies, inFlightAction });
            return next;
          }

          // Completed (or no lifecycle = legacy completed). Append event.
          // Inherit bounds from the most recent action when missing (e.g.
          // find() → toBe() chain where the assertion has no bounds of its own).
          let eventToStore = ev;
          if ((ev.type === 'assertion' || ev.type === 'action') && !ev.bounds) {
            const inherited = lastBoundsFrom(data.actionEvents);
            if (inherited) eventToStore = { ...ev, bounds: inherited };
          }
          const events = isInternal ? data.events : [...data.events, eventToStore];
          const actionEvents = (!isInternal && (eventToStore.type === 'action' || eventToStore.type === 'assertion'))
            ? [...data.actionEvents, eventToStore]
            : data.actionEvents;

          // Clear in-flight slot when the matching completion arrives.
          const inFlightAction = data.inFlightAction
            && (ev.type === 'action' || ev.type === 'assertion')
            && data.inFlightAction.actionIndex === ev.actionIndex
              ? null
              : data.inFlightAction;

          const next = new Map(map);
          next.set(key, { ...data, events, actionEvents, screenshots, hierarchies, inFlightAction });
          return next;
        });

        // Auto-pin to latest action, but only when viewing the running test.
        // Skip internal markers (e.g. __final_screenshot) — they never
        // become rows, so pinning to them leaves the UI with nothing
        // selected once the test ends.
        // Pin on both 'started' and 'completed' so the in-flight row is
        // highlighted while running, then stays selected after it lands.
        // Pinning is positional: for shifted hook events the actionIndex
        // runs ahead of the row position by the reserved-slot count, so
        // subtract pinDelta (0 for the test's own events).
        if (isVisibleRow && key === activeTestRef.current
          && (!viewedTraceKeyRef.current || viewedTraceKeyRef.current === key)) {
          setPinnedIndex(ev.actionIndex - (hookShift?.pinDelta ?? 0));
        }
        break;
      }
      case 'source':
        // Keep every streamed source in two session-wide, path-keyed stores:
        // pendingSourcesRef (snapshotted into a trace at its test-start) and
        // previewSources (merged in at read time — see the `sources` memo).
        // We deliberately DON'T copy the file into each trace's own map here:
        // that was O(traces) per message. Because sources are path-keyed with
        // identical on-disk content, the read-time merge resolves any file a
        // trace needs — including files streamed by other workers during
        // parallel runs — without the per-message fan-out.
        pendingSourcesRef.current.set(msg.path, msg.content);
        setPreviewSources((prev) => {
          if (prev.get(msg.path) === msg.content) return prev;
          const next = new Map(prev);
          next.set(msg.path, msg.content);
          return next;
        });
        break;
      case 'network': {
        const key = msg.testFullName
          ? traceIdentitiesRef.current.resolve(msg.projectName, msg.testFullName, msg.filePath)
          : (activeTestRef.current ?? '');
        if (!key) break;
        setTestTraces((prev) => {
          const { data, map } = getOrCreateTrace(key, prev, parseTraceKey(key).filePath);
          const updates = new Map<string, Uint8Array>();
          if (msg.bodies) {
            for (const [path, b64] of Object.entries(msg.bodies)) {
              updates.set(path, base64ToBytes(b64));
            }
          }
          const next = new Map(map);
          const networkBodies = mergeNetworkBodies(msg.entries, data.networkBodies, updates, msg.bodyMode === 'patch');
          next.set(key, {
            ...data, network: msg.entries, networkBodies,
            networkCaptureEnabled: msg.networkCaptureEnabled ?? data.networkCaptureEnabled,
            // `null` = this attempt captured no route: clear, so a retry never
            // keeps the previous attempt's. Absent (older workers) = keep.
            networkCaptureRoute: msg.networkCaptureRoute === undefined ? data.networkCaptureRoute : msg.networkCaptureRoute ?? undefined,
          });
          return next;
        });
        break;
      }
      case 'watch-event':
        if (msg.event === 'watch-enabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, true, msg.testFilter, msg.projectName);
        } else if (msg.event === 'watch-disabled') {
          treeRef.current.updateWatchEnabled(msg.filePath, false, msg.testFilter, msg.projectName);
        }
        break;
      case 'device-info': {
        setDeviceSerial(msg.serial);
        setDeviceIsEmulator(msg.isEmulator);
        if (msg.devicePixelRatio != null) setDeviceDpr(msg.devicePixelRatio);
        const platform = msg.platform ?? inferDevicePlatform(msg.serial, msg.model);
        if (platform) setDevicePlatform(platform);
        if (msg.tapsmithVersion) setTapsmithVersion(msg.tapsmithVersion);
        break;
      }
      case 'workers-info':
        setWorkers((prev) => msg.workers.map((w) => {
          const existing = prev.find((p) => p.workerId === w.workerId);
          return {
            ...w,
            displayName: w.displayName,
            status: existing?.status ?? ('idle' as const),
            passed: existing?.passed ?? 0,
            failed: existing?.failed ?? 0,
            skipped: existing?.skipped ?? 0,
            readiness: existing?.readiness,
            speculation: existing?.speculation,
          };
        }));
        break;
      case 'preferences':
        setPreferences(msg.preferences);
        break;
      case 'device-activity':
        setDeviceActivity((prev) => {
          const idx = prev.findIndex((e) => e.id === msg.id);
          const next = idx >= 0 ? prev.map((e, i) => (i === idx ? msg : e)) : [...prev, msg];
          return next.length > 200 ? next.slice(-200) : next;
        });
        break;
      case 'run-progress':
        setRunProgress((prev) => {
          const next = new Map(prev);
          if (msg.message) next.set(msg.workerId, msg.message);
          else next.delete(msg.workerId);
          return next;
        });
        break;
      case 'worker-status':
        setWorkers((prev) => {
          const idx = prev.findIndex((w) => w.workerId === msg.workerId);
          if (idx === -1) return prev;
          const next = [...prev];
          next[idx] = {
            ...next[idx],
            status: msg.status,
            currentFile: msg.currentFile,
            currentTest: msg.currentTest,
            passed: msg.passed,
            failed: msg.failed,
            skipped: msg.skipped,
            readiness: msg.readiness ?? next[idx].readiness,
            speculation: msg.speculation ?? next[idx].speculation,
            activeDeviceCount: msg.activeDeviceCount,
          };
          return next;
        });
        break;
      case 'hierarchy-update':
        // Live-mirror pick snapshot. The broadcast is fan-out (all clients),
        // so drop updates for a device we're no longer mirroring.
        if ((msg.workerId == null || msg.workerId === mirrorWorkerIdRef.current)
          && (msg.deviceIndex ?? 0) === mirrorDeviceIndexRef.current) {
          setLiveHierarchyXml(msg.xml);
        }
        break;
      case 'error':
        console.error('[Tapsmith UI]', msg.message);
        showError(msg.message);
        break;

      case 'mcp-status':
        setMcpUrl(msg.mcpUrl);
        setMcpClientName(msg.clientName);
        setMcpClientVersion(msg.clientVersion);
        setMcpClients(msg.clients ?? (msg.clientName ? [{ name: msg.clientName, version: msg.clientVersion ?? '' }] : []));
        break;

      case 'mcp-tool-call':
        setMcpToolCalls((prev) => {
          const next = [...prev, msg];
          return next.length > 200 ? next.slice(-200) : next;
        });
        break;
    }
  }, []);

  const handleConnectionChange = useCallback((isConnected: boolean) => {
    setConnected(isConnected);
  }, []);

  // Route binary frames to the appropriate mirror hook based on view mode.
  // Only use multi-mirror when in 'all' mode AND multiple workers exist.
  const deviceViewModeRef = useRef(deviceViewMode);
  deviceViewModeRef.current = deviceViewMode;
  // Every mirrorable device (a group worker contributes one per member).
  const deviceViewCount = deviceViewsOf(workers).length;
  const workersLenRef = useRef(deviceViewCount);
  workersLenRef.current = deviceViewCount;
  const handleScreenFrame = useCallback((data: ArrayBuffer) => {
    // First frame for the current device → hide the loading placeholder.
    if (!firstFrameRef.current) {
      firstFrameRef.current = true;
      setMirrorLoading(false);
    }
    // Screenshot frame → existing screen-mirror handler(s). The grid uses the
    // multi-mirror; everything else uses the single mirror.
    if (deviceViewModeRef.current === 'all' && workersLenRef.current > 1) {
      handleMultiBinaryFrame(data);
    } else {
      handleBinaryFrame(data);
    }
  }, [handleBinaryFrame, handleMultiBinaryFrame]);

  const { send } = useWebSocket({
    onMessage: handleMessage,
    onBinaryMessage: handleScreenFrame,
    onConnectionChange: handleConnectionChange,
  });

  // Interactive mirror lock preference:
  //   'auto' — locked only while the active worker is running (default)
  //   'on'   — user explicitly locked; stays locked even after the run ends
  //   'off'  — user unlocked during a run; resets to 'auto' when the run ends
  //            (so the next run auto-locks again)
  const [mirrorLockPref, setMirrorLockPref] = useState<'auto' | 'on' | 'off'>('auto');
  const activeWorker = workers.find((w) => w.workerId === selectedWorkerId);
  const runningOnActive = activeWorker ? activeWorker.status === 'running' : isRunning;
  // An unlock-override is per-run: once the run ends, fall back to 'auto'.
  // An explicit lock ('on') is sticky and survives the run ending.
  useEffect(() => {
    if (!runningOnActive && mirrorLockPref === 'off') setMirrorLockPref('auto');
  }, [runningOnActive, mirrorLockPref]);
  const mirrorLocked = mirrorLockPref === 'on'
    ? true
    : mirrorLockPref === 'off'
      ? false
      : runningOnActive;
  const mirrorInteractive = !mirrorLocked;

  // ─── Live mirror element pick ───

  // DPR of the mirrored device — NOT viewedTestDpr (that's the worker of the
  // viewed trace, which can be a different device in multi-worker mode). A
  // group worker's members each carry their own.
  const mirrorWorker = workers.find((w) => w.workerId === mirrorWorkerId);
  const mirrorDpr = mirrorWorker?.devices?.find((d) => d.index === mirrorDeviceIndex)?.devicePixelRatio
    ?? mirrorWorker?.devicePixelRatio
    ?? deviceDpr ?? 1;

  // A pick inside a WebView whose DOM overlay hasn't arrived yet (the server
  // connects to the WebView on demand — takes a moment) is held here instead
  // of finalizing against the native web-content projection. Resolved when a
  // snapshot with the overlay lands, or by the timer at the deadline — the
  // timer matters because identical snapshots don't re-trigger the effect.
  const pendingMirrorPickRef = useRef<{ x: number; y: number; deadline: number } | null>(null);
  const pendingPickTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const clearPendingMirrorPick = useCallback(() => {
    pendingMirrorPickRef.current = null;
    clearTimeout(pendingPickTimerRef.current);
  }, []);
  useEffect(() => () => clearTimeout(pendingPickTimerRef.current), []);

  const handleMirrorPickToggle = useCallback(() => {
    clearPendingMirrorPick();
    if (pickTarget === 'mirror') {
      setPickTarget(null);
    } else {
      // Arming: bind the Locator tab to the live hierarchy and start fresh.
      setSelectorSource('live');
      setPickedNode(null);
      setSelectorText('');
      setHoverBounds(null);
      setPickTarget('mirror');
    }
    setMirrorHoverBounds(null);
  }, [pickTarget, clearPendingMirrorPick]);

  const handleMirrorPickHover = useCallback((point: { x: number; y: number } | null) => {
    if (!point || liveRoots.length === 0) {
      setMirrorHoverBounds(null);
      return;
    }
    // Coordinates arrive already in logical points (DeviceMirror divides by dpr).
    setMirrorHoverBounds(handleHoverFromScreenshot(liveRoots, point.x, point.y));
  }, [liveRoots]);

  const finalizeMirrorPick = useCallback((point: { x: number; y: number }) => {
    const result = handlePickFromScreenshot(liveRoots, point.x, point.y);
    if (result) {
      setSelectorText(result.selector);
      setPickedNode(result.node);
      setPickTarget(null);
      setMirrorHoverBounds(null);
      // selectorSource stays 'live': the panel keeps matching against the
      // live hierarchy and highlights render on the mirror.
    }
  }, [liveRoots]);
  // Latest finalizer for the deadline timer (finalizeMirrorPick's identity
  // changes with every live snapshot).
  const finalizeMirrorPickRef = useRef(finalizeMirrorPick);
  finalizeMirrorPickRef.current = finalizeMirrorPick;

  // Covers a stale-connection dump failure (~2s) plus a fresh reconnect that
  // has to probe past a dead webinspectord page (~5s) with margin.
  const WEBVIEW_PICK_WAIT_MS = 12_000;

  const handleMirrorPickPoint = useCallback((point: { x: number; y: number }) => {
    if (liveRoots.length === 0) return;
    if (isWebViewOverlayPending(liveRoots, point.x, point.y)) {
      // Pick mode stays armed; hierarchy polling continues. The deadline
      // timer guarantees the click resolves even if every subsequent
      // snapshot is identical (e.g. the WebView connect keeps failing).
      pendingMirrorPickRef.current = { x: point.x, y: point.y, deadline: Date.now() + WEBVIEW_PICK_WAIT_MS };
      clearTimeout(pendingPickTimerRef.current);
      pendingPickTimerRef.current = setTimeout(() => {
        const pending = pendingMirrorPickRef.current;
        if (!pending) return;
        pendingMirrorPickRef.current = null;
        finalizeMirrorPickRef.current(pending);
      }, WEBVIEW_PICK_WAIT_MS);
      return;
    }
    clearPendingMirrorPick();
    finalizeMirrorPick(point);
  }, [liveRoots, finalizeMirrorPick, clearPendingMirrorPick]);

  // Resolve a deferred WebView pick when a fresh snapshot arrives: finalize
  // once the overlay is present, or fall back to the native projection at the
  // deadline (WebView not inspectable) rather than swallowing the click.
  useEffect(() => {
    const pending = pendingMirrorPickRef.current;
    if (!pending || liveRoots.length === 0) return;
    if (!isWebViewOverlayPending(liveRoots, pending.x, pending.y) || Date.now() > pending.deadline) {
      clearPendingMirrorPick();
      finalizeMirrorPick(pending);
    }
  }, [liveRoots, finalizeMirrorPick, clearPendingMirrorPick]);

  // Explicit source toggle in the Locator tab. Picking still sets the source
  // implicitly (and clicking a trace action resets to 'trace'); this is the
  // manual override. The selector text and picked node are kept — suggestions
  // are attribute-matched, so they re-validate against the new tree.
  const handleSelectorSourceChange = useCallback((source: 'trace' | 'live') => {
    setSelectorSource(source);
    if (source === 'live' && !liveHierarchyXml) {
      send({ type: 'request-hierarchy', workerId: mirrorWorkerId, deviceIndex: mirrorDeviceIndex });
    }
  }, [liveHierarchyXml, mirrorWorkerId, mirrorDeviceIndex, send]);

  // Refresh the live hierarchy every second while it's in use: during a pick
  // session (hover hit-testing must track a changing screen) and while the
  // Locator tab is live-bound with a selector (so match highlights on the
  // mirror follow the device instead of going stale — matching is
  // attribute-based, so each fresh tree recomputes counts and bounds).
  // Depending on mirrorWorkerId also re-fetches when the user switches worker
  // tabs mid-pick.
  const liveHierarchyInUse = pickTarget === 'mirror'
    || (selectorSource === 'live' && selectorText.trim() !== '');
  useEffect(() => {
    if (!liveHierarchyInUse || !connected) return;
    send({ type: 'request-hierarchy', workerId: mirrorWorkerId, deviceIndex: mirrorDeviceIndex });
    const id = setInterval(() => {
      send({ type: 'request-hierarchy', workerId: mirrorWorkerId, deviceIndex: mirrorDeviceIndex });
    }, 1000);
    return () => clearInterval(id);
  }, [liveHierarchyInUse, connected, mirrorWorkerId, mirrorDeviceIndex, send]);

  // Switching the mirrored device invalidates the previous device's hierarchy
  // (bounds from one device must never highlight on another's mirror).
  const prevMirrorRef = useRef(`${mirrorWorkerId}:${mirrorDeviceIndex}`);
  useEffect(() => {
    const key = `${mirrorWorkerId}:${mirrorDeviceIndex}`;
    if (prevMirrorRef.current === key) return;
    prevMirrorRef.current = key;
    clearPendingMirrorPick();
    setLiveHierarchyXml(null);
    setMirrorHoverBounds(null);
  }, [mirrorWorkerId, mirrorDeviceIndex, clearPendingMirrorPick]);

  // A disconnect or a dead mirrored worker ends the pick session — there is
  // no device to fetch a fresh hierarchy from.
  useEffect(() => {
    if (!connected) {
      clearPendingMirrorPick();
      setPickTarget((t) => t === 'mirror' ? null : t);
      setLiveHierarchyXml(null);
      setMirrorHoverBounds(null);
    }
  }, [connected, clearPendingMirrorPick]);
  useEffect(() => {
    if (pickTarget !== 'mirror' || workers.length === 0) return;
    const worker = workers.find((w) => w.workerId === mirrorWorkerId);
    if (!worker || worker.status === 'error') {
      clearPendingMirrorPick();
      setPickTarget(null);
      setMirrorHoverBounds(null);
    }
  }, [pickTarget, workers, mirrorWorkerId, clearPendingMirrorPick]);

  const handleThemeChange = useCallback((newTheme: Theme) => {
    setTheme(newTheme);
  }, []);

  const handleSend = useCallback((msg: ClientMessage) => {
    // Inject runDeps flag when the toggle is on. Use the ref for the latest
    // value regardless of React batching (same pattern as activeTestRef).
    if (runDepsRef.current && (msg.type === 'run-file' || msg.type === 'run-test' || msg.type === 'run-project')) {
      send({ ...msg, runDeps: true });
    } else {
      send(msg);
    }
  }, [send]);

  // Wrap tree.setPending to also clear trace data for the node being run so
  // the Actions tab immediately shows the preflight "Waiting for first
  // action…" message instead of lingering actions from the previous run.
  // Without this, old actions stay visible until the server's run-start
  // broadcast arrives and clears the trace — a noticeable delay, especially
  // with multiple workers where ensureWorkersReady() adds latency.
  const handleSetPending = useCallback((nodeId: string) => {
    treeRef.current.setPending(nodeId);

    const projectName = extractProject(nodeId);
    const stripped = stripProjectPrefix(nodeId);
    const sep = stripped.indexOf('::');
    if (sep !== -1) {
      // Test or suite node — clear its specific trace
      const fullName = stripped.slice(sep + 2);
      const key = traceKey(projectName, fullName, stripped.slice(0, sep));
      setTestTraces((prev) => {
        const old = prev.get(key);
        if (!old) return prev;
        revokeTraceScreenshots(old);
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    } else {
      // File or project node — clear all traces for matching file
      setTestTraces((prev) => {
        let changed = false;
        const next = new Map<string, TestTraceData>();
        for (const [k, data] of prev) {
          const matchesFile = data.filePath === stripped;
          const matchesProject = !projectName || parseTraceKey(k).projectName === projectName;
          if (matchesFile && matchesProject) {
            revokeTraceScreenshots(data);
            changed = true;
          } else {
            next.set(k, data);
          }
        }
        return changed ? next : prev;
      });
    }
  }, [setTestTraces]);

  // Push stored preferences to the server on every (re)connect. A session
  // that never changed a preference stays silent — the server's defaults are
  // the same as ours, and nothing should go over the wire unprompted.
  useEffect(() => {
    if (!connected) return;
    let stored = false;
    try { stored = localStorage.getItem('tapsmith-ui-preferences') != null; } catch { /* ignore */ }
    if (stored) send({ type: 'set-preferences', preferences: preferencesRef.current });
  }, [connected, send]);

  const handleTogglePrepareBetweenRuns = useCallback(() => {
    setPreferences((prev) => {
      const next = { ...prev, prepareBetweenRuns: !prev.prepareBetweenRuns };
      try { localStorage.setItem('tapsmith-ui-preferences', JSON.stringify(next)); } catch { /* ignore */ }
      send({ type: 'set-preferences', preferences: { prepareBetweenRuns: next.prepareBetweenRuns } });
      return next;
    });
  }, [send]);

  const handleToggleRunDeps = useCallback(() => {
    setRunDepsFirst((prev) => {
      const next = !prev;
      runDepsRef.current = next;
      localStorage.setItem('tapsmith-ui-run-deps', String(next));
      return next;
    });
  }, []);

  // Auto-switch device mirror to the worker that ran the viewed test.
  // Only fires when the viewed test changes — manual mirror selections must
  // not be clobbered, so deviceViewMode is read via ref instead of as a dep.
  const lastSentWorkerRef = useRef<number | undefined>(undefined);
  const deviceViewModeRefForAutoSwitch = useRef(deviceViewMode);
  deviceViewModeRefForAutoSwitch.current = deviceViewMode;
  useEffect(() => {
    if (!viewedTraceKey || workers.length < 2) return;
    const wid = testWorkerMapRef.current.get(viewedTraceKey);
    if (wid != null && wid !== lastSentWorkerRef.current) {
      lastSentWorkerRef.current = wid;
      setSelectedWorkerId(wid);
      setMirrorDeviceIndex(0);
      const mode = deviceViewModeRefForAutoSwitch.current;
      if (mode !== 'all') setDeviceViewMode(wid);
      send({ type: 'select-worker-view', mode: mode === 'all' ? 'all' : wid, ...(mode === 'all' ? {} : { deviceIndex: 0 }) });
    }
  }, [viewedTraceKey, workers.length, send]);

  // Pin to the last action when viewing a completed test — whether the user
  // clicked it manually or the selection was restored on reconnect.  During
  // a live run auto-follow handles pinning via the trace-event handler, so
  // we only fire here when no run is in progress.
  useEffect(() => {
    if (viewedTraceKey && actionEvents.length > 0
      && (autoFollowRef.current === 'manual' || !isRunning)) {
      setPinnedIndex(actionEvents.length - 1);
      setHoveredIndex(null);
    }
  }, [viewedTraceKey, actionEvents.length, isRunning]);

  // Pre-run preview: when a file/suite/test is selected but not yet run, fetch
  // its source file from disk so the Source tab shows it (the matching
  // declaration line is highlighted for suites/tests; files show no highlight).
  useEffect(() => {
    if (!previewable) return;
    const filePath = viewedTestNode?.filePath;
    if (!filePath) return;
    const key = filePath.replace(/\\/g, '/');
    if (previewSources.has(key) || requestedSourcesRef.current.has(key)) return;
    requestedSourcesRef.current.add(key);
    send({ type: 'request-source', path: filePath });
  }, [previewable, viewedTestNode, previewSources, send]);

  const handleSelectDeviceView = useCallback((mode: 'all' | number, deviceIndex = 0) => {
    setDeviceViewMode(mode);
    if (typeof mode === 'number') {
      setSelectedWorkerId(mode);
      setMirrorDeviceIndex(deviceIndex);
      lastSentWorkerRef.current = mode;
    } else {
      // The "All" grid has no pick surface — end any live pick session.
      clearPendingMirrorPick();
      setPickTarget((t) => t === 'mirror' ? null : t);
      setMirrorHoverBounds(null);
    }
    send({ type: 'select-worker-view', mode, ...(typeof mode === 'number' ? { deviceIndex } : {}) });
  }, [send, clearPendingMirrorPick]);

  const handleActionPin = useCallback((index: number) => {
    setPinnedIndex(index);
  }, []);

  // ─── Keyboard shortcuts ───

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // resolveShortcut bails on Cmd/Ctrl/Alt chords (e.g. Cmd+Shift+R reload)
      // and on form-field focus, so a browser refresh never fires run-all.
      switch (resolveShortcut(e)) {
        case 'run-all':
          send({ type: 'run-all' });
          break;
        case 'run-failed':
          send({ type: 'run-failed' });
          break;
        case 'stop-run':
          send({ type: 'stop-run' });
          setIsStopping(true);
          break;
        case 'toggle-watch':
          send({ type: 'toggle-watch', filePath: 'all' });
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [send]);

  // ─── Download trace ───

  // Show an in-progress empty state in the Actions tab whenever the
  // currently-viewed test is pending (play clicked, server hasn't yet
  // confirmed the run started) or running but no action has streamed
  // yet. The test explorer tree pulses across exactly this same window;
  // this mirrors the visual on the Actions side so the panel doesn't
  // look frozen during the IPC dispatch + ESM import + hooks-before-
  // first-action gap.
  const preflightMessage = useMemo<string | undefined>(() => {
    if (!viewedTestNode || viewedTestNode.type !== 'test') return undefined;
    const isPending = tree.pendingIds.has(viewedTestNode.id);
    const isRunning = viewedTestNode.status === 'running';
    if (!isPending && !isRunning) return undefined;
    // When a slow device action is in flight (between-file preflight reset),
    // show what it's actually doing instead of the generic message (PILOT-232).
    // Prefer the worker that's running this test's file; fall back to any.
    if (runProgress.size > 0) {
      const fileBasename = viewedTestNode.filePath.replace(/\\/g, '/').split('/').pop();
      const matchingWorker = workers.find(
        (w) => w.currentFile && w.currentFile === fileBasename && runProgress.has(w.workerId),
      );
      const message = matchingWorker
        ? runProgress.get(matchingWorker.workerId)
        : runProgress.values().next().value;
      if (message) return message;
    }
    // Before the worker reports anything, its readiness says what the click
    // is waiting on: a background preparation still finishing, or nothing.
    const readiness = (workers.find((w) => w.status !== 'error')?.readiness);
    if (readiness?.state === 'preparing') {
      return `Preparing device (${readiness.detail ?? readiness.policy.mode})…`;
    }
    if (readiness?.state === 'ready') return 'Device ready — starting…';
    return 'Waiting for first action…';
  }, [viewedTestNode, tree.pendingIds, runProgress, workers]);

  const hasTrace = actionEvents.length > 0;
  const isTestPending = !!viewedTestNode && (tree.pendingIds.has(viewedTestNode.id) || viewedTestNode.status === 'running');

  const handleRunSelectedTest = useCallback(() => {
    if (!viewedTestNode || viewedTestNode.type !== 'test') return;
    handleSetPending(viewedTestNode.id);
    handleSend({ type: 'run-test', fullName: viewedTestNode.fullName, filePath: viewedTestNode.filePath, projectName: viewedTestProject });
  }, [viewedTestNode, viewedTestProject, handleSend, handleSetPending]);

  const containerSummary = useMemo<ContainerSummary | undefined>(() => {
    if (!viewedTestNode || viewedTestNode.type === 'test') return undefined;
    return buildContainerSummary(viewedTestNode);
  }, [viewedTestNode]);

  const handleRunContainer = useCallback(() => {
    if (!viewedTestNode || viewedTestNode.type === 'test') return;
    handleSetPending(viewedTestNode.id);
    if (viewedTestNode.type === 'project') {
      handleSend({ type: 'run-project', projectName: viewedTestNode.name });
    } else if (viewedTestNode.type === 'file') {
      handleSend({ type: 'run-file', filePath: viewedTestNode.filePath, projectName: viewedTestProject });
    } else {
      handleSend({ type: 'run-test', fullName: viewedTestNode.fullName, filePath: viewedTestNode.filePath, projectName: viewedTestProject });
    }
  }, [viewedTestNode, viewedTestProject, handleSend, handleSetPending]);

  const handleDownloadTrace = useCallback(async () => {
    if (!viewedTestName || !currentTrace?.tracePath) return;
    try {
      const resp = await fetch(`/trace/${encodeURIComponent(currentTrace.tracePath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trace-${viewedTestName.replace(/[^a-zA-Z0-9]+/g, '-')}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Tapsmith UI] Failed to download trace:', err);
      alert(`Failed to download trace: ${err instanceof Error ? err.message : err}`);
    }
  }, [viewedTestName, currentTrace]);

  const handleDownloadVideo = useCallback(async () => {
    if (!viewedTestName || !currentTrace?.videoPath) return;
    try {
      const resp = await fetch(`/video/${encodeURIComponent(currentTrace.videoPath)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `video-${viewedTestName.replace(/[^a-zA-Z0-9]+/g, '-')}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Tapsmith UI] Failed to download video:', err);
      alert(`Failed to download video: ${err instanceof Error ? err.message : err}`);
    }
  }, [viewedTestName, currentTrace]);

  const filmstripCollapsed = !viewedTestNode || viewedTestNode.type !== 'test' || (!hasTrace && metadata.testStatus !== 'passed' && metadata.testStatus !== 'failed');

  return (
    <Layout
      filmstripCollapsed={filmstripCollapsed}
      errorBanner={errorMessage ? (
        <div class="test-error-banner" role="alert" onClick={() => setErrorMessage(null)}>
          <span class="test-error-banner-icon" aria-hidden="true">!</span>
          <span class="test-error-banner-text" data-testid="run-notification">{errorMessage}</span>
        </div>
      ) : infoMessage ? (
        <div class="test-error-banner info" role="status" onClick={() => setInfoMessage(null)}>
          <span class="test-error-banner-icon" aria-hidden="true">■</span>
          <span class="test-error-banner-text" data-testid="run-notification">{infoMessage}</span>
        </div>
      ) : undefined}
      topBar={
        <RunControls
          connected={connected}
          isRunning={isRunning}
          deviceSerial={deviceSerial}
          counts={tree.counts}
          theme={theme}
          onThemeChange={handleThemeChange}
          onSend={handleSend}
          workers={workers}
          runElapsed={runElapsed}
          mcpClientName={mcpClientName}
          mcpClients={mcpClients}
          mcpPanelOpen={mcpPanelOpen}
          onToggleMcpPanel={() => setMcpPanelOpen(prev => !prev)}
          prepareBetweenRuns={preferences.prepareBetweenRuns}
          onTogglePrepareBetweenRuns={handleTogglePrepareBetweenRuns}
        />
      }
      testExplorer={
        <TestExplorer
          files={tree.files}
          expandedNodes={tree.expandedNodes}
          selectedTestId={tree.selectedTestId}
          nameFilter={tree.nameFilter}
          statusFilter={tree.statusFilter}
          counts={tree.counts}
          connected={connected}
          isRunning={isRunning}
          isStopping={isStopping}
          isWatching={tree.hasWatchedFiles}
          hasProjectDeps={hasProjectDeps}
          runDepsFirst={runDepsFirst}
          onToggleExpanded={tree.toggleExpanded}
          onExpandAll={tree.expandAll}
          onCollapseAll={tree.collapseAll}
          onSelectTest={useCallback((id: string | null) => {
            if (id != null) autoFollowRef.current = 'manual';
            tree.setSelectedTestId(id);
            // The selection is the server's best hint for what runs next, so
            // it can prepare the device for that file's isolation policy.
            const node = id ? findTreeNode(tree.files, id) : undefined;
            send({
              type: 'select-node',
              filePath: node && node.type !== 'project' ? node.filePath : undefined,
              projectName: node?.type === 'project' ? node.name : id ? extractProject(id) : undefined,
            });
          }, [tree, send])}
          onSetNameFilter={tree.setNameFilter}
          onSetStatusFilter={tree.setStatusFilter}
          onSend={handleSend}
          onStop={() => { send({ type: 'stop-run' }); setIsStopping(true); }}
          onToggleRunDeps={handleToggleRunDeps}
          pendingIds={tree.pendingIds}
          onSetPending={handleSetPending}
        />
      }
      filmstripMinHeight={hasTrace && isMultiDevice(metadata) ? laneStripMinHeight(metadata.devices!.length) : undefined}
      filmstrip={
        <TimelineFilmstrip
          events={actionEvents}
          screenshots={screenshots}
          metadata={metadata}
          selectedIndex={selectedIndex}
          onSelect={handleActionPin}
          hasTrace={hasTrace}
          onRunTest={handleRunSelectedTest}
          isTestPending={isTestPending}
          nodeType={viewedTestNode?.type}
          containerSummary={containerSummary}
          onRunContainer={handleRunContainer}
        />
      }
      actionsPanel={
        <ActionsPanel
          events={traceEvents}
          actionEvents={actionEvents}
          selectedIndex={selectedIndex}
          pinnedIndex={pinnedIndex}
          onHover={setHoveredIndex}
          onPin={handleActionPin}
          metadata={metadata}
          showMetadata={viewedTestNode?.type === 'test'}
          inFlightAction={currentTrace?.inFlightAction}
          preflightMessage={preflightMessage}
        />
      }
      screenshotPanel={
        <div class="ui-screen-area">
          <div class="ui-screen-content">
            <ScreenshotPanel
              event={selectedEvent}
              screenshots={screenshots}
              highlightBounds={hierarchyHighlight}
              selectorHighlights={selectorSource === 'trace' ? selectorHighlights : EMPTY_BOUNDS}
              hoverBounds={hoverBounds}
              onScreenshotClick={pickTarget === 'screenshot' ? handleScreenshotClick : undefined}
              onScreenshotHover={pickTarget === 'screenshot' ? handleScreenshotHover : undefined}
              nodeType={viewedTestNode?.type}
              containerSummary={containerSummary}
              onRunContainer={handleRunContainer}
              pickMode={pickTarget === 'screenshot'}
              onPickModeToggle={handlePickToggle}
              hierarchyBorrowedFromStep={currentHierarchy?.borrowedFromStep}
              pickUnavailable={!!selectedEvent && currentRoots.length === 0}
              onDisplayedVariantChange={setScreenshotVariant}
              devicePixelRatio={viewedTestDpr}
              group={group}
              testName={metadata.testName}
              testStatus={metadata.testStatus}
              onDownloadTrace={currentTrace?.tracePath ? handleDownloadTrace : undefined}
              onDownloadVideo={currentTrace?.videoPath ? handleDownloadVideo : undefined}
              hasTrace={hasTrace}
              onRunTest={handleRunSelectedTest}
              isTestPending={isTestPending}
              platform={viewedTestPlatform}
            />
          </div>
        </div>
      }
      devicePane={
        <DevicePane
          canvasRef={canvasRef}
          connected={connected}
          workers={workers}
          selectedWorkerId={selectedWorkerId}
          deviceViewMode={deviceViewMode}
          mirrorDeviceIndex={mirrorDeviceIndex}
          onSelectDeviceView={handleSelectDeviceView}
          registerCanvas={registerCanvas}
          unregisterCanvas={unregisterCanvas}
          mirrorLoading={mirrorLoading}
          platform={devicePlatform}
          interactive={mirrorInteractive}
          locked={mirrorLocked}
          force={runningOnActive && mirrorInteractive}
          onToggleLock={() => setMirrorLockPref(mirrorLocked ? 'off' : 'on')}
          send={send}
          pickMode={pickTarget === 'mirror'}
          onTogglePick={handleMirrorPickToggle}
          pickAvailable={connected && !mirrorLoading && !(deviceViewMode === 'all' && deviceViewCount > 1)}
          pickDpr={mirrorDpr}
          pickHoverBounds={mirrorHoverBounds}
          pickMatchBounds={selectorSource === 'live' ? selectorHighlights : EMPTY_BOUNDS}
          onPickPoint={handleMirrorPickPoint}
          onPickHover={handleMirrorPickHover}
        />
      }
      mcpPanel={mcpPanelOpen ? (
        <DeviceActivityPanel
          mcpUrl={mcpUrl}
          clientName={mcpClientName}
          clientVersion={mcpClientVersion}
          clients={mcpClients}
          toolCalls={mcpToolCalls}
          activity={deviceActivity}
          onClear={() => { setMcpToolCalls([]); setDeviceActivity([]); }}
        />
      ) : undefined}
      detailTabs={
        <DetailTabs
          event={selectedEvent}
          events={traceEvents}
          hierarchies={hierarchies}
          sources={sources}
          metadata={metadata}
          networkEntries={networkEntries}
          networkBodies={networkBodies}
          onHierarchyNodeSelect={setHierarchyHighlight}
          pickMode={pickTarget !== null}
          previewHighlight={previewHighlight}
          group={group}
          screenshotVariant={screenshotVariant}
          locatorTab={

            <LocatorTab
              hierarchyXml={selectorSource === 'live' ? (liveHierarchyXml ?? undefined) : currentHierarchyXml}
              pickedNode={pickedNode}
              selector={selectorText}
              onSelectorChange={setSelectorText}
              source={selectorSource}
              onSourceChange={handleSelectorSourceChange}
              liveSourceAvailable={connected}
            />
          }
        />
      }
    />
  );
}

// ─── Styles ───

const style = document.createElement('style');
style.textContent = uiModeStyles;
document.head.appendChild(style);

// ─── Theme (apply before first render) ───

function applyInitialTheme(): void {
  const stored = localStorage.getItem('tapsmith-ui-theme');
  const theme = (stored === 'light' || stored === 'dark' || stored === 'system') ? stored : 'system';
  applyTheme(theme);
}
applyInitialTheme();

// ─── Render ───

function findTreeNode(nodes: TestTreeNode[], id: string): TestTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findTreeNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

render(<App />, document.getElementById('app')!);
