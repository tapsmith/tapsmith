import "./fonts.css";
import { render, type JSX } from "preact";
import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "preact/hooks";
import { unzipSync } from "fflate";
import type {
  AnyTraceEvent,
  ActionTraceEvent,
  AssertionTraceEvent,
  TraceMetadata,
  NetworkEntry,
} from "../trace/types.js";
import { sortEventsByStartTime } from "../trace/sort-events.js";
import { ActionsPanel } from "./components/ActionsPanel.js";
import { ScreenshotPanel } from "./components/ScreenshotPanel.js";
import { DetailTabs } from "./components/DetailTabs.js";
import { TimelineFilmstrip } from "./components/TimelineFilmstrip.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { TopBar, type Theme } from "./components/TopBar.js";
import {
  LocatorTab,
  computeSelectorHighlights,
  handlePickFromScreenshot,
  handleHoverFromScreenshot,
} from "./components/LocatorPlayground.js";
import { parseHierarchyXml } from "./components/hierarchy-utils.js";
import { resolveActionHierarchy } from "../ui-mode/hooks/use-trace-data.js";
import {
  actingDevice,
  frameIndexForDevice,
  hierarchyForDeviceFrame,
  nextFrameIndexForDevice,
  type DeviceGroupView,
  isMultiDevice,
  laneStripMinHeight,
} from "./components/device-frames.js";
import type { HierarchyNode, Bounds } from "./components/hierarchy-utils.js";
import { traceViewerStyles } from "./styles/trace-viewer.css.js";

// ─── Types ───

export interface TraceData {
  metadata: TraceMetadata;
  events: AnyTraceEvent[];
  screenshots: Map<string, string>;
  hierarchies: Map<string, string>;
  sources: Map<string, string>;
  network: NetworkEntry[];
  networkBodies: Map<string, Uint8Array>;
}

// ─── Zip Loader ───

async function loadTraceFromUrl(url: string): Promise<TraceData> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to load trace: HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  return parseTraceZip(buf);
}

async function loadTraceFromFile(file: File): Promise<TraceData> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return parseTraceZip(buf);
}

function parseTraceZip(buf: Uint8Array): TraceData {
  const files = unzipSync(buf);
  const decoder = new TextDecoder();

  const metadataRaw = files["metadata.json"];
  if (!metadataRaw) throw new Error("Invalid trace: missing metadata.json");
  let metadata: TraceMetadata;
  try {
    metadata = JSON.parse(decoder.decode(metadataRaw));
  } catch (e) {
    throw new Error(`Failed to parse metadata.json: ${e instanceof Error ? e.message : String(e)}`);
  }

  const traceRaw = files["trace.json"];
  const rawEvents: AnyTraceEvent[] = traceRaw
    ? decoder
        .decode(traceRaw)
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    : [];
  const events = synthesizeWallDurations(rawEvents, metadata);

  const screenshots = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith("screenshots/") && name.endsWith(".png")) {
      screenshots.set(
        name,
        URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: "image/png" })),
      );
    }
  }

  const hierarchies = new Map<string, string>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith("hierarchy/") && name.endsWith(".xml")) {
      hierarchies.set(name, decoder.decode(data));
    }
  }

  const sources = new Map<string, string>();
  const sourcesRaw = files["sources.json"];
  if (sourcesRaw) {
    try {
      const parsed = JSON.parse(decoder.decode(sourcesRaw)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [p, content] of Object.entries(parsed)) {
          if (typeof content === "string") sources.set(p, content);
        }
      }
    } catch {
      // Ignore malformed sources.json — Source tab will show "not captured".
    }
  }

  const networkRaw = files["network.json"];
  const network: NetworkEntry[] = networkRaw
    ? decoder
        .decode(networkRaw)
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    : [];

  const networkBodies = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith("network/")) {
      // Kept as bytes: binary bodies (gRPC/protobuf) cannot survive a
      // UTF-8 decode, and the Network tab needs the originals to decode them.
      networkBodies.set(name, data as Uint8Array);
    }
  }

  return {
    metadata,
    events,
    screenshots,
    hierarchies,
    sources,
    network,
    networkBodies,
  };
}

function synthesizeWallDurations(events: AnyTraceEvent[], metadata: TraceMetadata): AnyTraceEvent[] {
  if (events.length === 0 || metadata.startTime <= 0) return events;
  if (events.every((event) =>
    (event.type !== "action" && event.type !== "assertion") ||
    (event.wallDuration !== undefined && event.startTime !== undefined && event.endTime !== undefined)
  )) {
    return events;
  }

  let boundary = metadata.startTime;
  let lastTimedIndex = -1;
  let changed = false;
  const next = events.map((event, index): AnyTraceEvent => {
    if (event.type !== "action" && event.type !== "assertion") return event;
    const duration = Math.max(0, event.duration ?? 0);
    const completedAt = event.endTime ?? event.timestamp;
    const startedAt = event.startTime ?? Math.max(metadata.startTime, completedAt - duration);
    const wallDuration = event.wallDuration ?? Math.max(0, completedAt - boundary);
    const gapBefore = event.gapBefore ?? Math.max(0, startedAt - boundary);
    boundary = Math.max(boundary, completedAt);
    lastTimedIndex = index;
    changed = true;
    return { ...event, startTime: startedAt, endTime: completedAt, wallDuration, gapBefore };
  });

  if (lastTimedIndex !== -1 && metadata.endTime > boundary) {
    const last = next[lastTimedIndex];
    if (last.type === "action" || last.type === "assertion") {
      const trailing = metadata.endTime - boundary;
      next[lastTimedIndex] = {
        ...last,
        wallDuration: (last.wallDuration ?? last.duration) + trailing,
        trailingTime: (last.trailingTime ?? 0) + trailing,
      };
    }
  }

  return changed ? next : events;
}

// ─── Platform Inference ───

function inferPlatform(metadata: TraceMetadata): "android" | "ios" | undefined {
  if (!metadata.device) return undefined;
  const text = [metadata.device.serial, metadata.device.model, metadata.project]
    .filter(Boolean)
    .join(" ");
  if (/ios|iphone|ipad|simulator/i.test(text)) return "ios";
  if (/android|emulator-|pixel|nexus|galaxy|generic_phone|avd/i.test(text))
    return "android";
  // iOS UDIDs: standard UUID (simulators), 40-char hex, or 8-16 hex (physical)
  if (
    /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$|^[0-9A-F]{40}$|^[0-9A-F]{8}-[0-9A-F]{16}$/i.test(
      metadata.device.serial,
    )
  )
    return "ios";
  return undefined;
}

// ─── App ───

// ─── Theme ───

function getResolvedTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme) {
  const resolved = getResolvedTheme(theme);
  document.documentElement.setAttribute("data-theme", resolved);
}

function App() {
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinnedIndex, setPinnedIndex] = useState(0);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [hierarchyHighlight, setHierarchyHighlight] = useState<{
    left: number;
    top: number;
    right: number;
    bottom: number;
  } | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [selectorText, setSelectorText] = useState("");
  const [pickedNode, setPickedNode] = useState<HierarchyNode | null>(null);
  const [hoverBounds, setHoverBounds] = useState<Bounds | null>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem("tapsmith-trace-theme");
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  });
  const selectedIndex = hoveredIndex ?? pinnedIndex;
  const loadIdRef = useRef(0);

  // Revoke blob URLs from previous trace when loading a new one
  useEffect(() => {
    return () => {
      if (trace) {
        for (const url of trace.screenshots.values()) {
          try { URL.revokeObjectURL(url); } catch { /* already revoked */ }
        }
      }
    };
  }, [trace]);

  // Apply theme on mount and changes
  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("tapsmith-trace-theme", theme);
  }, [theme]);

  // Listen for system theme changes when in system mode
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (theme === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const traceUrl = params.get("trace");
    if (traceUrl) {
      setLoading(true);
      loadTraceFromUrl(traceUrl)
        .then((data) => {
          setTrace(data);
          setLoading(false);
          const actionParam = params.get("action");
          if (actionParam) {
            const idx = parseInt(actionParam, 10);
            if (!isNaN(idx)) setPinnedIndex(idx);
          }
        })
        .catch((err) => {
          setError(err.message);
          setLoading(false);
        });
    }
  }, []);

  // Selecting a different action keeps the pick and selector text — the
  // suggestions and match highlights re-evaluate against the new action's
  // hierarchy (always-current semantics, matching UI mode's live mirror).
  // Only per-tree transients are cleared.
  useEffect(() => {
    if (trace) {
      const url = new URL(location.href);
      url.searchParams.set("action", String(selectedIndex));
      history.replaceState(null, "", url.toString());
      setHierarchyHighlight(null);
      setHoverBounds(null);
    }
  }, [selectedIndex, trace]);

  // Sort events by start time (timestamp - duration) so concurrent actions
  // appear in the order they actually started, not the order they completed.
  const sortedEvents = useMemo(
    () => (trace ? sortEventsByStartTime(trace.events) : []),
    [trace],
  );
  const actionEvents = useMemo(
    () =>
      sortedEvents.filter(
        (e): e is ActionTraceEvent | AssertionTraceEvent =>
          (e.type === "action" || e.type === "assertion") &&
          !("action" in e && e.action === "__final_screenshot"),
      ),
    [sortedEvents],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setPinnedIndex((i) => Math.min(i + 1, actionEvents.length - 1));
        setHoveredIndex(null);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setPinnedIndex((i) => Math.max(i - 1, 0));
        setHoveredIndex(null);
      }
    },
    [actionEvents.length],
  );

  useEffect(() => {
    if (!trace) return;
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [trace, handleKeyDown]);

  const handleFileDrop = (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      const id = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      loadTraceFromFile(file)
        .then((data) => {
          if (loadIdRef.current !== id) return;
          setTrace(data);
          setLoading(false);
        })
        .catch((err) => {
          if (loadIdRef.current !== id) return;
          setError(err.message);
          setLoading(false);
        });
    }
  };

  const handleFileInput = (e: Event) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (file) {
      const id = ++loadIdRef.current;
      setLoading(true);
      setError(null);
      loadTraceFromFile(file)
        .then((data) => {
          if (loadIdRef.current !== id) return;
          setTrace(data);
          setLoading(false);
        })
        .catch((err) => {
          if (loadIdRef.current !== id) return;
          setError(err.message);
          setLoading(false);
        });
    }
  };

  if (loading) {
    return (
      <div class="full-layout">
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen">
          <div class="spinner" />
          <p>Loading trace...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div class="full-layout">
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen" role="alert" data-testid="load-error">
          <h2 style={{ color: "var(--color-error)" }}>Failed to load trace</h2>
          <p style={{ color: "var(--color-text-muted)" }} data-testid="load-error-detail">{error}</p>
          <label class="file-picker-btn">
            Choose a trace file
            <input type="file" accept=".zip" onChange={handleFileInput} />
          </label>
        </div>
      </div>
    );
  }

  if (!trace) {
    return (
      <div
        class="full-layout"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleFileDrop}
      >
        <TopBar metadata={null} theme={theme} onThemeChange={setTheme} />
        <div class="empty-screen">
          <div class="drop-content" data-testid="trace-drop-zone">
            <div class="logo">Tapsmith</div>
            <h1>Trace Viewer</h1>
            <p>
              Drop a <code>.zip</code> trace file here
            </p>
            <p class="or">or</p>
            <label class="file-picker-btn">
              Select file
              <input type="file" accept=".zip" onChange={handleFileInput} />
            </label>
            <p class="privacy-note">
              Trace Viewer is a client-side app. Your data stays in your
              browser.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Resizable panel sizes — persisted in localStorage
  const [leftWidth, setLeftWidth] = useState(() => parseInt(localStorage.getItem('tapsmith-tv-left') || '280', 10) || 280);
  const [filmstripHeight, setFilmstripHeight] = useState(() => parseInt(localStorage.getItem('tapsmith-tv-filmstrip') || '130', 10) || 130);
  const [rightWidth, setRightWidth] = useState(() => parseInt(localStorage.getItem('tapsmith-tv-right') || '580', 10) || 580);

  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem('tapsmith-tv-left', String(leftWidth));
      localStorage.setItem('tapsmith-tv-filmstrip', String(filmstripHeight));
      localStorage.setItem('tapsmith-tv-right', String(rightWidth));
    }, 300);
    return () => clearTimeout(timer);
  }, [leftWidth, filmstripHeight, rightWidth]);

  const handleLeftResize = useCallback((delta: number) => {
    const max = Math.max(180, window.innerWidth - 500);
    setLeftWidth((w) => Math.max(180, Math.min(max, w + delta)));
  }, []);

  const handleFilmstripResize = useCallback((delta: number) => {
    setFilmstripHeight((h) => Math.max(60, Math.min(300, h + delta)));
  }, []);
  // A multi-device trace needs room for every lane; the drag height still persists.
  const shownFilmstripHeight = Math.max(
    filmstripHeight,
    isMultiDevice(trace.metadata) ? laneStripMinHeight(trace.metadata.devices!.length) : 0,
  );

  const handleRightResize = useCallback((delta: number) => {
    setRightWidth((w) =>
      Math.max(260, Math.min(window.innerWidth - 400, w - delta)),
    );
  }, []);

  const selectedEvent = actionEvents[selectedIndex];

  // Multi-device traces (`use.devices`): every event names the device that
  // produced it, and each device has its own pixel ratio, platform and
  // terminal screenshot. Single-device traces fall back to `metadata.device`.
  const groupDevices = trace.metadata.devices && trace.metadata.devices.length > 1
    ? trace.metadata.devices
    : undefined;
  // The pane the user last clicked (picking, Locator tab). Reset whenever the
  // selection moves so each step opens on the device that acted.
  const [activeDeviceOverride, setActiveDeviceOverride] = useState<string | undefined>(undefined);
  useEffect(() => { setActiveDeviceOverride(undefined); }, [selectedIndex]);
  const group = useMemo<DeviceGroupView | undefined>(() => {
    if (!groupDevices) return undefined;
    const base = { devices: groupDevices };
    const acting = actingDevice(base, selectedEvent);
    const override = activeDeviceOverride && groupDevices.some((d) => d.name === activeDeviceOverride)
      ? activeDeviceOverride
      : undefined;
    return {
      devices: groupDevices,
      actionEvents,
      actionCount: trace.metadata.actionCount,
      hierarchies: trace.hierarchies,
      activeDevice: override ?? acting,
      onActiveDeviceChange: setActiveDeviceOverride,
    };
  }, [groupDevices, actionEvents, trace.metadata.actionCount, trace.hierarchies, selectedEvent, activeDeviceOverride]);
  const selectedDevice = useMemo(() => {
    if (!group) return trace.metadata.device;
    return group.devices.find((d) => d.name === group.activeDevice) ?? trace.metadata.device;
  }, [group, trace.metadata.device]);
  const platform = selectedDevice?.platform ?? inferPlatform(trace.metadata);
  // "After" = the next capture on the *same* device; the next action overall
  // may belong to the other user. Falls back to that device's terminal
  // screenshot, which the runner records per device in group order.
  const afterActionIndex = useMemo(() => {
    if (!group || !selectedEvent) return undefined;
    return nextFrameIndexForDevice(group, actingDevice(group, selectedEvent), selectedEvent.actionIndex);
  }, [group, selectedEvent]);

  // Which screenshot moment the ScreenshotPanel is displaying — the selector
  // playground must bind to the hierarchy captured at that same moment, or
  // picks on a before-screenshot would hit-test the after-hierarchy.
  const [screenshotVariant, setScreenshotVariant] = useState<'before' | 'after'>('before');

  // Hierarchy for the current action (used by locator playground) — resolved
  // to depict the same moment as the displayed screenshot, borrowing for
  // actions that capture none (network family). PILOT-302.
  const currentHierarchy = useMemo(() => {
    if (!trace || !selectedEvent) return undefined;
    // A non-acting pane is bound to its own device's frame, not the step's.
    if (group && group.activeDevice && group.activeDevice !== actingDevice(group, selectedEvent)) {
      const frame = frameIndexForDevice(group, group.activeDevice, selectedEvent.actionIndex, screenshotVariant);
      const xml = hierarchyForDeviceFrame(group, frame);
      return xml ? { xml } : undefined;
    }
    return resolveActionHierarchy(trace.hierarchies, trace.screenshots, selectedEvent.actionIndex, screenshotVariant);
  }, [trace, selectedEvent, screenshotVariant, group]);

  // Keyed on the xml string, not the wrapper object, so an unchanged tree is
  // never re-parsed just because the wrapper was recomputed.
  const currentHierarchyXml = currentHierarchy?.xml;
  const currentRoots = useMemo(
    () => (currentHierarchyXml ? parseHierarchyXml(currentHierarchyXml) : []),
    [currentHierarchyXml],
  );

  // Match overlay bounds, derived so they always reflect the hierarchy of the
  // displayed action/screenshot (never pushed through state, never stale).
  const selectorHighlights = useMemo(
    () => computeSelectorHighlights(currentRoots, selectorText),
    [currentRoots, selectorText],
  );

  const dpr = selectedDevice?.devicePixelRatio ?? 1;

  const handleScreenshotClick = useCallback(
    (point: { x: number; y: number }) => {
      if (!pickMode || currentRoots.length === 0) return;
      const result = handlePickFromScreenshot(
        currentRoots,
        point.x / dpr,
        point.y / dpr,
      );
      if (result) {
        setSelectorText(result.selector);
        setPickedNode(result.node);
        setPickMode(false);
        setHoverBounds(null);
      }
    },
    [pickMode, currentRoots, dpr],
  );

  const handlePickToggle = useCallback(() => {
    setPickMode((p) => !p);
    setHoverBounds(null);
  }, []);

  const handleScreenshotHover = useCallback(
    (point: { x: number; y: number } | null) => {
      if (!pickMode || currentRoots.length === 0 || !point) {
        setHoverBounds(null);
        return;
      }
      setHoverBounds(
        handleHoverFromScreenshot(currentRoots, point.x / dpr, point.y / dpr),
      );
    },
    [pickMode, currentRoots, dpr],
  );

  return (
    <div class="viewer">
      <TopBar
        metadata={trace.metadata}
        theme={theme}
        onThemeChange={setTheme}
      />
      {/* Top: Timeline (resizable) */}
      <div
        style={
          {
            height: `${shownFilmstripHeight}px`,
            flexShrink: 0,
            "--filmstrip-h": `${shownFilmstripHeight}px`,
          } as JSX.CSSProperties
        }
      >
        <TimelineFilmstrip
          events={actionEvents}
          screenshots={trace.screenshots}
          metadata={trace.metadata}
          selectedIndex={selectedIndex}
          onSelect={setPinnedIndex}
          nodeType="test"
          hasTrace={actionEvents.length > 0}
        />
      </div>
      <ResizeHandle direction="vertical" onResize={handleFilmstripResize} />
      {/* Main: Actions | Screenshot | Detail Tabs */}
      <div class="middle-row">
        <div style={{ width: `${leftWidth}px`, flexShrink: 0 }}>
          <ActionsPanel
            events={sortedEvents}
            actionEvents={actionEvents}
            selectedIndex={selectedIndex}
            pinnedIndex={pinnedIndex}
            onHover={setHoveredIndex}
            onPin={setPinnedIndex}
            metadata={trace.metadata}
            showMetadata={true}
          />
        </div>
        <ResizeHandle direction="horizontal" onResize={handleLeftResize} />
        <ScreenshotPanel
          event={selectedEvent}
          screenshots={trace.screenshots}
          highlightBounds={hierarchyHighlight}
          selectorHighlights={selectorHighlights}
          hoverBounds={hoverBounds}
          onScreenshotClick={pickMode ? handleScreenshotClick : undefined}
          onScreenshotHover={pickMode ? handleScreenshotHover : undefined}
          pickMode={pickMode}
          onPickModeToggle={handlePickToggle}
          hierarchyBorrowedFromStep={currentHierarchy?.borrowedFromStep}
          pickUnavailable={!!selectedEvent && currentRoots.length === 0}
          onDisplayedVariantChange={setScreenshotVariant}
          devicePixelRatio={selectedDevice?.devicePixelRatio}
          afterActionIndex={afterActionIndex}
          group={group}
          nodeType="test"
          hasTrace={true}
          testName={trace.metadata.testName}
          testStatus={trace.metadata.testStatus}
          platform={platform}
        />
        <ResizeHandle direction="horizontal" onResize={handleRightResize} />
        <div
          class="detail-col"
          style={{ width: `${rightWidth}px`, flexShrink: 0 }}
        >
          <DetailTabs
            event={selectedEvent}
            events={trace.events}
            hierarchies={trace.hierarchies}
            sources={trace.sources}
            metadata={trace.metadata}
            networkEntries={trace.network}
            networkBodies={trace.networkBodies}
            onHierarchyNodeSelect={setHierarchyHighlight}
            pickMode={pickMode}
            group={group}
            screenshotVariant={screenshotVariant}
            locatorTab={

              <LocatorTab
                hierarchyXml={currentHierarchyXml}
                pickedNode={pickedNode}
                selector={selectorText}
                onSelectorChange={setSelectorText}
              />
            }
          />
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───

const style = document.createElement("style");
style.textContent = traceViewerStyles;
document.head.appendChild(style);

// Apply theme on initial load (before first render)
(() => {
  const stored = localStorage.getItem("tapsmith-trace-theme");
  const theme =
    stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  document.documentElement.setAttribute("data-theme", resolved);
})();

// ─── Render ───

render(<App />, document.getElementById("app")!);
