import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks';
import { Focus, Download, Camera, LoaderCircle, CircleDot, Play, Layers, ListTree } from 'lucide-preact';
import type { ActionTraceEvent, AssertionTraceEvent } from '../../trace/types.js';
import type { ContainerSummary } from '../types.js';
import { findNearestScreenshot } from '../../ui-mode/hooks/use-trace-data.js';
import { inferDeviceFormFactor } from '../../ui-mode/ui-protocol.js';
import { selectDeviceFrame, screenWindowStyle, screenMaskStyle } from '../../ui-mode/assets/bezels/frames.js';
import {
  actingDevice,
  frameIndexForDevice,
  nextFrameIndexForDevice,
  screenshotForFrame,
  deviceHue,
  type DeviceGroupView,
} from './device-frames.js';

// ─── Injected Styles ───

const SCREENSHOT_STYLES = `
  .screenshot-zoom-label { margin-left: auto; padding: 6px 12px; color: var(--color-text-muted); font-size: 11px; }
  .viewer-pick-note { color: var(--color-text-muted); font-size: 11px; font-style: italic; white-space: nowrap; }
  .screenshot-image-wrapper { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  .screenshot-image-wrapper > img,
  .screenshot-image-wrapper .dm-frame:not(.dm-skin-ios):not(.dm-skin-android):not(.dm-frame-img) > img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 8px; }
  .screenshot-image-wrapper .dm-skin-ios > img,
  .screenshot-image-wrapper .dm-skin-android > img { max-width: 100%; object-fit: contain; border-radius: calc(var(--bezel-radius) - var(--bezel)); }
  .bounds-overlay { position: absolute; z-index: 4; pointer-events: none; border-radius: 8px; overflow: hidden; }
  .bounds-rect { position: absolute; border: 2px solid var(--color-accent); background: rgba(79,193,255,0.15); border-radius: 2px; }
  .bounds-rect-hierarchy { position: absolute; border: 2px solid var(--color-success); background: rgba(78,201,176,0.15); border-radius: 2px; }
  .bounds-rect-selector { position: absolute; border: 2px solid #c084fc; background: rgba(192,132,252,0.18); border-radius: 2px; }
  .bounds-point { position: absolute; width: 16px; height: 16px; margin-left: -8px; margin-top: -8px; border-radius: 50%; background: rgba(255,80,80,0.5); border: 2px solid #ff5050; box-shadow: 0 0 8px rgba(255,80,80,0.4); }
  .screenshot-panes { display: flex; align-items: stretch; justify-content: center; gap: 12px; width: 100%; height: 100%; min-height: 0; }
  .screenshot-pane { flex: 1 1 0; min-width: 0; min-height: 0; display: flex; flex-direction: column; border: 1px solid transparent; border-radius: 10px; padding: 4px; cursor: pointer; }
  .screenshot-pane.acting { border-color: oklch(0.7 0.14 var(--device-h, var(--accent-h, 57))); }
  .screenshot-pane.active:not(.acting) { border-color: var(--color-text-muted, #888); border-style: dashed; }
  .screenshot-pane-label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--color-text-muted, #888); padding: 0 4px 4px; }
  .screenshot-pane-label .action-device-tag { margin-left: 0; }
  .screenshot-pane-label .screenshot-pane-role { font-style: italic; }
  .screenshot-pane-body { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
  .screenshot-pane-body .screenshot-image-wrapper { height: 100%; }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = SCREENSHOT_STYLES;
  document.head.appendChild(el);
}

// ─── Types ───

interface Props {
  event: ActionTraceEvent | AssertionTraceEvent | undefined
  screenshots: Map<string, string>
  highlightBounds?: { left: number; top: number; right: number; bottom: number } | null
  selectorHighlights?: { left: number; top: number; right: number; bottom: number }[]
  hoverBounds?: { left: number; top: number; right: number; bottom: number } | null
  onScreenshotClick?: (point: { x: number; y: number }) => void
  onScreenshotHover?: (point: { x: number; y: number } | null) => void
  pickMode?: boolean
  onPickModeToggle?: () => void
  /** Set when the locator playground is hit-testing a hierarchy borrowed
   * from an earlier step because this action captured none (network-family
   * actions). Value is the source step's actionIndex; rendered as an honest
   * note next to the pick controls. */
  hierarchyBorrowedFromStep?: number
  /** Disables the Pick button (with an explanatory tooltip) — picking cannot
   * work because no hierarchy matches the displayed screenshot, even after
   * falling back to earlier steps. */
  pickUnavailable?: boolean
  /** Reports whether the displayed screenshot is the before- or after-state of
   * the action, so the host can bind the locator playground to the hierarchy
   * captured at the same moment (picking on a before-screenshot must not
   * hit-test the after-hierarchy — the action may have changed the screen). */
  onDisplayedVariantChange?: (variant: 'before' | 'after') => void
  /** Device pixel ratio — bounds are in logical points, screenshots in pixels. */
  devicePixelRatio?: number
  /**
   * Action index whose before-screenshot shows the state *after* this event.
   * Defaults to the next index; a multi-device trace passes the next capture
   * on the same device instead.
   */
  afterActionIndex?: number
  /**
   * A multi-device trace: one pane per device, side by side. The acting
   * device's pane shows the stages as usual; the others show their state at
   * the same moment. Absent for single-device traces.
   */
  group?: DeviceGroupView
  testName?: string
  testStatus?: string
  onDownloadTrace?: () => void
  onDownloadVideo?: () => void
  hasTrace?: boolean
  onRunTest?: () => void
  isTestPending?: boolean
  platform?: 'android' | 'ios'
  nodeType?: 'test' | 'suite' | 'file' | 'project'
  containerSummary?: ContainerSummary
  onRunContainer?: () => void
}

type ScreenshotTab = 'before' | 'after' | 'action'

interface NaturalSize {
  width: number
  height: number
}

interface RenderedSize {
  width: number
  height: number
  left: number
  top: number
}

// Before / Action / After stages of a captured screenshot.
const STAGE_TABS: Array<{ value: 'action' | 'before' | 'after'; label: string }> = [
  { value: 'action', label: 'Action' },
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
];

/**
 * Keyboard operation for the stage strip: Left/Right move between stages,
 * Home/End jump to the ends, Enter/Space activate.
 *
 * Every tab stays in the tab order rather than using APG's roving tabindex —
 * see the note in DetailTabs.tsx for why.
 */
function handleStageKeyDown(
  e: KeyboardEvent,
  index: number,
  setTab: (v: 'action' | 'before' | 'after') => void,
): void {
  let next = -1;
  if (e.key === 'ArrowRight') next = (index + 1) % STAGE_TABS.length;
  else if (e.key === 'ArrowLeft') next = (index - 1 + STAGE_TABS.length) % STAGE_TABS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = STAGE_TABS.length - 1;
  else if (e.key === 'Enter' || e.key === ' ') {
    // A div is not a button, so activation has to be wired up by hand.
    e.preventDefault();
    setTab(STAGE_TABS[index].value);
    return;
  } else return;

  e.preventDefault();
  setTab(STAGE_TABS[next].value);
  // Follow focus, or the next arrow press would move from the old position.
  // Selected by role rather than child index: `next` indexes STAGE_TABS, and the
  // two would silently diverge if anything else were added to the strip.
  const strip = (e.currentTarget as HTMLElement).parentElement;
  (strip?.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined)?.focus();
}

export function ScreenshotPanel({ event, screenshots, highlightBounds, selectorHighlights, hoverBounds, onScreenshotClick, onScreenshotHover, pickMode, onPickModeToggle, hierarchyBorrowedFromStep, pickUnavailable, onDisplayedVariantChange, devicePixelRatio, afterActionIndex, group, testName, testStatus, onDownloadTrace, onDownloadVideo, hasTrace, onRunTest, isTestPending, platform, nodeType, containerSummary, onRunContainer }: Props) {
  injectStyles();

  const [tab, setTab] = useState<ScreenshotTab>('action');

  // Which screenshots exist for the selected event (also used by the render
  // body below — kept up here so the displayed-variant effect can run before
  // the early returns).
  const shotUrls = useMemo(() => {
    if (!event) return null;
    if (group && group.devices.length > 1) {
      // Multi-device: the acting device's own frame, and its next capture —
      // the other panes resolve their frames per device below.
      const acting = actingDevice(group, event);
      return {
        beforeUrl: screenshotForFrame(screenshots, event.actionIndex),
        afterUrl: screenshotForFrame(screenshots, nextFrameIndexForDevice(group, acting, event.actionIndex)),
      };
    }
    const pad = String(event.actionIndex).padStart(3, '0');
    const beforeUrl = screenshots.get(`screenshots/action-${pad}-before.png`)
      ?? findNearestScreenshot(screenshots, event.actionIndex);
    // "After" = the next action's before-screenshot (screen state after this action).
    // This avoids capturing 2 screenshots per action through the agent. In a
    // multi-device trace the host names the next capture on the same device.
    const nextPad = String(afterActionIndex ?? event.actionIndex + 1).padStart(3, '0');
    const afterUrl = screenshots.get(`screenshots/action-${nextPad}-before.png`)
      ?? screenshots.get(`screenshots/action-${pad}-after.png`); // fallback for legacy traces
    return { beforeUrl, afterUrl };
  }, [event, screenshots, afterActionIndex, group]);

  // Mirrors the currentUrl resolution below: which moment does the displayed
  // screenshot show? Reported to the host so the locator playground binds to
  // the hierarchy captured at the same moment.
  const displayedVariant: 'before' | 'after' = useMemo(() => {
    if (!event || !shotUrls) return 'before';
    const hasBefore = !!shotUrls.beforeUrl;
    const hasAfter = !!shotUrls.afterUrl;
    if (tab === 'before') return hasBefore ? 'before' : 'after';
    if (tab === 'after') return hasAfter ? 'after' : 'before';
    // 'action' tab: assertions show the after-state, actions the before-state.
    if (event.type === 'assertion') return hasAfter ? 'after' : 'before';
    return hasBefore ? 'before' : 'after';
  }, [event, shotUrls, tab]);

  useEffect(() => {
    if (event) onDisplayedVariantChange?.(displayedVariant);
  }, [event, displayedVariant, onDisplayedVariantChange]);
  const [scale, setScale] = useState(1);
  // Kept in sync on every render so callbacks (ResizeObserver,
  // updateRenderedSize) read the committed scale without re-subscribing.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);
  const [renderedSize, setRenderedSize] = useState<RenderedSize | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const updateRenderedSize = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;

    const wrapper = wrapperRef.current;
    const imgRect = img.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    // getBoundingClientRect returns post-transform coordinates, but the
    // overlay is inside the scaled wrapper and needs pre-transform offsets.
    const s = scaleRef.current || 1;
    setRenderedSize({
      width: img.clientWidth,
      height: img.clientHeight,
      left: wrapperRect ? (imgRect.left - wrapperRect.left) / s : 0,
      top: wrapperRect ? (imgRect.top - wrapperRect.top) / s : 0,
    });
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => {
      setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
      updateRenderedSize();
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [event, tab, updateRenderedSize]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    updateRenderedSize();
    const ro = new ResizeObserver(updateRenderedSize);
    ro.observe(img);
    return () => ro.disconnect();
  }, [event, tab, updateRenderedSize]);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale(prev => {
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        return Math.max(0.5, Math.min(5, prev + delta));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Re-measure after the scale transform has been committed to the DOM —
  // measuring inside the state setter would read pre-commit geometry.
  useEffect(() => {
    updateRenderedSize();
  }, [scale, updateRenderedSize]);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      updateRenderedSize();
    }
    const wrapper = wrapperRef.current;
    if (wrapper) {
      setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
    }
  }, [updateRenderedSize]);

  const toNaturalCoords = useCallback((e: MouseEvent): { x: number; y: number } | null => {
    if (!imgRef.current || !naturalSize) return null;
    const img = imgRef.current;
    const rect = img.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    return {
      x: Math.round(clickX * (naturalSize.width / rect.width)),
      y: Math.round(clickY * (naturalSize.height / rect.height)),
    };
  }, [naturalSize]);

  const handleImageClick = useCallback((e: MouseEvent) => {
    if (!onScreenshotClick) return;
    const point = toNaturalCoords(e);
    if (point) onScreenshotClick(point);
  }, [onScreenshotClick, toNaturalCoords]);

  const handleImageMouseMove = useCallback((e: MouseEvent) => {
    if (!onScreenshotHover) return;
    const point = toNaturalCoords(e);
    onScreenshotHover(point);
  }, [onScreenshotHover, toNaturalCoords]);

  const handleImageMouseLeave = useCallback(() => {
    onScreenshotHover?.(null);
  }, [onScreenshotHover]);

  // ─── Nothing selected ───

  if (!nodeType) {
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty" data-testid="viewer-empty">
            <div class="viewer-empty-icon"><ListTree size={20} /></div>
            <div class="viewer-empty-title">No test selected</div>
            <div class="viewer-empty-sub">Select a test from the sidebar to view its trace.</div>
          </div>
        </div>
      </div>
    );
  }

  // ─── Container selected (suite / file / project) ───

  if (nodeType !== 'test' && containerSummary) {
    const { totalTests, passed, failed, running, skipped, idle } = containerSummary;
    const isContainerPending = isTestPending || running > 0;
    const parts: preact.JSX.Element[] = [];
    if (passed > 0) parts.push(<span class="summary-stat passed"><span class="summary-dot" />{passed} passed</span>);
    if (failed > 0) parts.push(<span class="summary-stat failed"><span class="summary-dot" />{failed} failed</span>);
    if (running > 0) parts.push(<span class="summary-stat running"><span class="summary-dot" />{running} running</span>);
    if (skipped > 0) parts.push(<span class="summary-stat skipped"><span class="summary-dot" />{skipped} skipped</span>);
    if (idle > 0) parts.push(<span class="summary-stat idle"><span class="summary-dot" />{idle} not run</span>);
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty" data-testid="viewer-empty">
            <div class="viewer-empty-icon"><Layers size={20} /></div>
            <div class="viewer-empty-title">{containerSummary.name}</div>
            <div class="viewer-empty-sub">{totalTests} {totalTests === 1 ? 'test' : 'tests'} in this {nodeType === 'suite' ? 'suite' : nodeType}</div>
            {parts.length > 0 && <div class="viewer-empty-summary">{parts}</div>}
            {onRunContainer && (
              <button class="viewer-empty-cta" onClick={onRunContainer} disabled={isContainerPending}>
                {isContainerPending
                  ? <><LoaderCircle size={12} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
                  : <><Play size={12} /> Run {totalTests} {totalTests === 1 ? 'test' : 'tests'}</>}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Test selected, no trace yet ───

  if (hasTrace === false && testStatus !== 'passed' && testStatus !== 'failed') {
    const state = testStatus === 'running' ? 'running'
      : testStatus === 'skipped' ? 'skipped'
      : 'idle';
    return (
      <div class="screenshot-panel">
        <div class="viewer-head">
          <div class="viewer-head-meta">
            {testStatus && (
              <span class={`te-status-icon ${testStatus === 'passed' ? 'passed' : testStatus === 'failed' ? 'failed' : ''}`}>
                {testStatus === 'passed' ? '✓' : testStatus === 'failed' ? '✗' : '○'}
              </span>
            )}
            {testName && <span class="viewer-head-title" data-testid="viewer-title">{testName}</span>}
          </div>
          <div class="viewer-head-actions">
            {onPickModeToggle && (
              <button class="viewer-pick-btn" disabled title="Pick element">
                <Focus size={12} /> Pick
              </button>
            )}
          </div>
        </div>
        <div class="screenshot-container viewer-body has-grid">
          <div class="viewer-empty" data-testid="viewer-empty">
            <div class="viewer-empty-icon">
              {state === 'running'
                ? <LoaderCircle size={20} style={{ animation: 'spin 1.1s linear infinite' }} />
                : state === 'skipped'
                  ? <CircleDot size={20} />
                  : <Camera size={20} />}
            </div>
            <div class="viewer-empty-title">
              {state === 'running' ? 'Running test…'
                : state === 'skipped' ? 'Test skipped'
                : 'No screenshot'}
            </div>
            <div class="viewer-empty-sub">
              {state === 'running' ? 'Screenshots will appear as actions are captured.'
                : state === 'skipped' ? 'This test was skipped on the last run.'
                : 'Run this test to capture a trace.'}
            </div>
            {state === 'idle' && onRunTest && (
              <button class="viewer-empty-cta" onClick={onRunTest} disabled={isTestPending}>
                {isTestPending
                  ? <><LoaderCircle size={12} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
                  : <><Play size={12} /> Run this test</>}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!event) {
    return (
      <div class="screenshot-panel">
        <div class="screenshot-container">
          <div class="screenshot-empty" data-testid="screenshot-empty">Select an action to view screenshots</div>
        </div>
      </div>
    );
  }

  const { beforeUrl, afterUrl } = shotUrls ?? { beforeUrl: undefined, afterUrl: undefined };

  const hasBefore = !!beforeUrl;
  const hasAfter = !!afterUrl;

  const header = (
    <div class="viewer-head">
      <div class="viewer-head-meta">
        {testStatus && (
          <span class={`te-status-icon ${testStatus === 'passed' ? 'passed' : testStatus === 'failed' ? 'failed' : ''}`}>
            {testStatus === 'passed' ? '✓' : testStatus === 'failed' ? '✗' : '○'}
          </span>
        )}
        {testName && <span class="viewer-head-title" data-testid="viewer-title">{testName}</span>}
      </div>
      <div class="viewer-head-actions">
        {hierarchyBorrowedFromStep !== undefined && (
          // Not gated on pickMode: the Locator tab evaluates selectors
          // against the same borrowed tree, so the disclosure applies
          // whenever this action is selected.
          <span
            class="viewer-pick-note"
            data-testid="pick-note"
            title="This step captured no view hierarchy — element data comes from the same step as the displayed screenshot."
          >
            {event && hierarchyBorrowedFromStep === event.actionIndex - 1
              ? 'Hierarchy from the previous step'
              : 'Hierarchy from an earlier step'}
          </span>
        )}
        {onPickModeToggle && (
          <button
            class={`viewer-pick-btn ${pickMode ? 'active' : ''}`}
            onClick={onPickModeToggle}
            // Disabled only when inactive: an active Pick button must stay
            // clickable as the exit, or selecting a no-hierarchy action
            // mid-pick would strand the user in pick mode.
            disabled={!!pickUnavailable && !pickMode}
            title={pickMode ? 'Exit pick mode'
              : pickUnavailable ? 'No view hierarchy captured yet — pick from a device action instead'
              : 'Pick element'}
          >
            <Focus size={12} /> {pickMode ? 'Picking…' : 'Pick'}
          </button>
        )}
        {onDownloadTrace && (
          <button class="viewer-download-btn" onClick={onDownloadTrace} title="Download trace ZIP">
            <Download size={12} /> Trace
          </button>
        )}
        {onDownloadVideo && (
          <button class="viewer-download-btn" onClick={onDownloadVideo} title="Download video">
            <Download size={12} /> Video
          </button>
        )}
        {scale !== 1 && (
          <div class="screenshot-zoom-label">{Math.round(scale * 100)}%</div>
        )}
      </div>
    </div>
  );

  const stageTabs = (hasBefore && hasAfter) && (
    <div class="screenshot-tab-float" role="tablist" aria-label="Screenshot stage">
      {STAGE_TABS.map(({ value, label }, i) => (
        <div
          key={value}
          id={`screenshot-stage-${value}`}
          class={`screenshot-tab${tab === value ? ' active' : ''}`}
          role="tab"
          aria-selected={tab === value}
          aria-controls="screenshot-tabpanel"
          tabIndex={0}
          onClick={() => setTab(value)}
          onKeyDown={(e) => handleStageKeyDown(e, i, setTab)}
        >
          {label}
        </div>
      ))}
    </div>
  );

  // ─── Multi-device: one pane per device, side by side ───

  if (group && group.devices.length > 1) {
    const acting = actingDevice(group, event);
    const active = group.activeDevice ?? acting;
    const bounds = event.bounds;
    const point = event.type === 'action' ? event.point : undefined;
    return (
      <div class="screenshot-panel">
        {header}
        <div ref={containerRef} class="screenshot-container viewer-body has-grid" style={{ position: 'relative' }}>
          {stageTabs}
          <div
            class="screenshot-panes"
            data-testid="screenshot-panes"
            id={hasBefore && hasAfter ? 'screenshot-tabpanel' : undefined}
            role={hasBefore && hasAfter ? 'tabpanel' : undefined}
            aria-labelledby={hasBefore && hasAfter ? `screenshot-stage-${tab}` : undefined}
          >
            {group.devices.map((d) => {
              const name = d.name ?? '';
              const isActing = name === acting;
              const isActive = name === active;
              // Every pane depicts the moment the acting pane displays: for a
              // "before" moment the others show their latest capture at or
              // before the step, for "after" their next capture past it.
              const frameIndex = frameIndexForDevice(group, name, event.actionIndex, displayedVariant);
              const url = screenshotForFrame(screenshots, frameIndex);
              return (
                <ScreenshotDevicePane
                  key={name}
                  name={name}
                  hue={deviceHue(group, name)}
                  acting={isActing}
                  active={isActive}
                  url={url}
                  stage={tab}
                  platform={d.platform ?? platform}
                  devicePixelRatio={d.devicePixelRatio}
                  bounds={isActing && tab === 'action' ? bounds : undefined}
                  point={isActing && tab === 'action' ? point : undefined}
                  highlightBounds={isActive ? highlightBounds : undefined}
                  hoverBounds={isActive ? hoverBounds : undefined}
                  selectorHighlights={isActive ? selectorHighlights : undefined}
                  pickMode={!!pickMode}
                  onActivate={() => group.onActiveDeviceChange?.(name)}
                  onPickPoint={isActive && pickMode ? onScreenshotClick : undefined}
                  onPickHover={isActive && pickMode ? onScreenshotHover : undefined}
                  scale={scale}
                />
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // The "Action" tab shows the screenshot that best represents the moment
  // the action happened. For taps/swipes that's the BEFORE screenshot (you
  // want to see where the touch landed). For assertions it's the AFTER
  // screenshot — the assertion resolved when the expected state appeared,
  // so the "before" state (often still loading) is the wrong frame to show.
  const isAssertion = event.type === 'assertion';
  let currentUrl: string | undefined;
  if (tab === 'before') currentUrl = beforeUrl;
  else if (tab === 'after') currentUrl = afterUrl ?? beforeUrl;
  else currentUrl = isAssertion ? (afterUrl ?? beforeUrl) : beforeUrl;

  // If selected tab has no screenshot, fall back
  if (!currentUrl) {
    currentUrl = afterUrl ?? beforeUrl;
  }

  const frameStyle = (() => {
    if (!platform || !naturalSize || !viewportSize) return undefined;

    const screenshotAspectRatio = naturalSize.width / naturalSize.height;
    const maxFrameHeight = Math.max(0, viewportSize.height);
    if (!Number.isFinite(screenshotAspectRatio) || screenshotAspectRatio <= 0 || maxFrameHeight <= 0) {
      return undefined;
    }

    const metrics = platform === 'ios'
      ? { inlineInsetRatio: 0.06, blockInsetRatio: 0.06 }
      : { inlineInsetRatio: 0.04, blockInsetRatio: 0.045 };
    const screenWidthRatio = 1 - metrics.inlineInsetRatio;
    const frameHeightRatio = screenWidthRatio / screenshotAspectRatio + metrics.blockInsetRatio;
    const frameWidth = Math.min(viewportSize.width, maxFrameHeight / frameHeightRatio);
    const screenHeight = frameWidth * screenWidthRatio / screenshotAspectRatio;

    return {
      width: `${frameWidth.toFixed(2)}px`,
      '--screen-max-height': `${screenHeight.toFixed(2)}px`,
    };
  })();

  const bounds = (event.type === 'action' || event.type === 'assertion') ? event.bounds : undefined;
  const point = event.type === 'action' ? event.point : undefined;
  // Show bounds + point overlay only on the "action" tab
  const showOverlay = tab === 'action' && (!!bounds || !!point);

  // Once the screenshot has loaded we know its aspect ratio; a photographic
  // bezel.fit frame is used for phone-shaped screens, the CSS bezel otherwise
  // (tablets, square / odd ratios). Phones never flip (the frame is chosen on
  // first paint and confirmed on load); tablets fall back to CSS after load.
  const contentAspect = naturalSize ? naturalSize.width / naturalSize.height : undefined;
  const imageFrame = platform ? selectDeviceFrame({ platform, contentAspect }) : undefined;
  const formFactor = inferDeviceFormFactor({ aspectRatio: contentAspect });

  // Size the frame box in JS from the measured wrapper, so it fits by width AND
  // height (this panel is often wide-and-short, unlike the tall mirror column,
  // and container-query height isn't reliable here). Mirrors the CSS-skin
  // `frameStyle` approach above.
  const imageFrameStyle = (() => {
    if (!imageFrame) return undefined;
    const style: Record<string, string> = { '--dm-fa': String(imageFrame.frameAspect) };
    if (viewportSize && viewportSize.width > 0 && viewportSize.height > 0) {
      const width = Math.min(viewportSize.width, viewportSize.height * imageFrame.frameAspect);
      style.width = `${width.toFixed(2)}px`;
    }
    return style;
  })();

  const screenshotImg = (
    <img
      ref={imgRef}
      src={currentUrl}
      alt={`Screenshot ${tab}`}
      onLoad={handleImageLoad}
      onClick={handleImageClick}
      onMouseMove={handleImageMouseMove}
      onMouseLeave={handleImageMouseLeave}
      style={onScreenshotClick ? { cursor: 'crosshair' } : undefined}
    />
  );

  let framedScreenshot: preact.JSX.Element;
  if (imageFrame) {
    framedScreenshot = (
      <div class="dm-frame dm-frame-img" style={imageFrameStyle}>
        <div class="dm-frame-screen" style={screenMaskStyle(imageFrame)}>
          <div class="dm-frame-screen-rect" style={screenWindowStyle(imageFrame)}>
            {screenshotImg}
          </div>
        </div>
        <img class="dm-frame-png" src={imageFrame.src} alt="" aria-hidden="true" draggable={false} />
      </div>
    );
  } else if (platform) {
    framedScreenshot = (
      <div class="screenshot-device-frame" style={frameStyle}>
        <div class={`dm-frame dm-skin-${platform} dm-skin-${formFactor}`}>
          {screenshotImg}
        </div>
      </div>
    );
  } else {
    framedScreenshot = screenshotImg;
  }

  return (
    <div class="screenshot-panel">
      {header}
      <div ref={containerRef} class="screenshot-container viewer-body has-grid" style={{ position: 'relative' }}>
        {stageTabs}
        {currentUrl ? (
          <div
            ref={wrapperRef}
            // Gated on the same condition as the tablist above: with only one
            // screenshot there are no stage tabs, so a tabpanel here would be
            // orphaned and aria-labelledby would point at nothing.
            id={hasBefore && hasAfter ? 'screenshot-tabpanel' : undefined}
            role={hasBefore && hasAfter ? 'tabpanel' : undefined}
            aria-labelledby={hasBefore && hasAfter ? `screenshot-stage-${tab}` : undefined}
            class="screenshot-image-wrapper"
            style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}
          >
            {framedScreenshot}
            {showOverlay && naturalSize && renderedSize && (
              <BoundsOverlay
                bounds={bounds}
                point={point}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {highlightBounds && naturalSize && renderedSize && (
              <HierarchyHighlightOverlay
                bounds={highlightBounds}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {hoverBounds && naturalSize && renderedSize && (
              <HierarchyHighlightOverlay
                bounds={hoverBounds}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
            {selectorHighlights && selectorHighlights.length > 0 && naturalSize && renderedSize && (
              <SelectorHighlightOverlay
                boundsList={selectorHighlights}
                naturalSize={naturalSize}
                renderedWidth={renderedSize.width}
                renderedHeight={renderedSize.height}
                renderedLeft={renderedSize.left}
                renderedTop={renderedSize.top}
                devicePixelRatio={devicePixelRatio}
              />
            )}
          </div>
        ) : (
          <div class="screenshot-empty" data-testid="screenshot-empty">No screenshot available for this action</div>
        )}
      </div>
    </div>
  );
}

// ─── Device pane (multi-device traces) ───

interface ScreenshotDevicePaneProps {
  name: string
  /** The device's tag hue (see `deviceHue`), tinting its badge and acting border. */
  hue: number
  acting: boolean
  active: boolean
  url: string | undefined
  stage: ScreenshotTab
  platform?: 'android' | 'ios'
  devicePixelRatio?: number
  bounds?: { left: number; top: number; right: number; bottom: number }
  point?: { x: number; y: number }
  highlightBounds?: { left: number; top: number; right: number; bottom: number } | null
  hoverBounds?: { left: number; top: number; right: number; bottom: number } | null
  selectorHighlights?: { left: number; top: number; right: number; bottom: number }[]
  pickMode: boolean
  /** Make this pane the active device (Locator / Hierarchy tabs follow it). */
  onActivate: () => void
  /** Pick on this pane — set only for the active pane while picking. */
  onPickPoint?: (point: { x: number; y: number }) => void
  onPickHover?: (point: { x: number; y: number } | null) => void
  scale: number
}

/**
 * One device of a multi-device trace: its frame in its own bezel, with the
 * overlays scaled by its own pixel ratio. Self-contained measurement so any
 * number of panes can sit side by side. A click on an inactive pane makes it
 * active (a pick then lands on the next click); the active pane hit-tests.
 */
function ScreenshotDevicePane({
  name, hue, acting, active, url, stage, platform, devicePixelRatio, bounds, point,
  highlightBounds, hoverBounds, selectorHighlights, pickMode, onActivate, onPickPoint, onPickHover, scale,
}: ScreenshotDevicePaneProps) {
  const [naturalSize, setNaturalSize] = useState<NaturalSize | null>(null);
  const [renderedSize, setRenderedSize] = useState<RenderedSize | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const updateRenderedSize = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const wrapper = wrapperRef.current;
    const imgRect = img.getBoundingClientRect();
    const wrapperRect = wrapper?.getBoundingClientRect();
    const s = scaleRef.current || 1;
    setRenderedSize({
      width: img.clientWidth,
      height: img.clientHeight,
      left: wrapperRect ? (imgRect.left - wrapperRect.left) / s : 0,
      top: wrapperRect ? (imgRect.top - wrapperRect.top) / s : 0,
    });
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => {
      setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
      updateRenderedSize();
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    return () => ro.disconnect();
  }, [url, stage, updateRenderedSize]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    updateRenderedSize();
    const ro = new ResizeObserver(updateRenderedSize);
    ro.observe(img);
    return () => ro.disconnect();
  }, [url, stage, updateRenderedSize]);

  useEffect(() => { updateRenderedSize(); }, [scale, updateRenderedSize]);

  const handleImageLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
      updateRenderedSize();
    }
    const wrapper = wrapperRef.current;
    if (wrapper) setViewportSize({ width: wrapper.clientWidth, height: wrapper.clientHeight });
  }, [updateRenderedSize]);

  const toNaturalCoords = useCallback((e: MouseEvent): { x: number; y: number } | null => {
    if (!imgRef.current || !naturalSize) return null;
    const rect = imgRef.current.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * (naturalSize.width / rect.width)),
      y: Math.round((e.clientY - rect.top) * (naturalSize.height / rect.height)),
    };
  }, [naturalSize]);

  const handleClick = useCallback((e: MouseEvent) => {
    if (!active) {
      // First click on another device's pane only moves the focus there —
      // picking against a tree the user has not yet seen highlighted would
      // resolve a locator on a screen they did not mean.
      onActivate();
      return;
    }
    if (!onPickPoint) return;
    const p = toNaturalCoords(e);
    if (p) onPickPoint(p);
  }, [active, onActivate, onPickPoint, toNaturalCoords]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!onPickHover) return;
    onPickHover(toNaturalCoords(e));
  }, [onPickHover, toNaturalCoords]);

  const handleMouseLeave = useCallback(() => { onPickHover?.(null); }, [onPickHover]);

  const contentAspect = naturalSize ? naturalSize.width / naturalSize.height : undefined;
  const imageFrame = platform ? selectDeviceFrame({ platform, contentAspect }) : undefined;
  const formFactor = inferDeviceFormFactor({ aspectRatio: contentAspect });
  const imageFrameStyle = (() => {
    if (!imageFrame) return undefined;
    const style: Record<string, string> = { '--dm-fa': String(imageFrame.frameAspect) };
    if (viewportSize && viewportSize.width > 0 && viewportSize.height > 0) {
      const width = Math.min(viewportSize.width, viewportSize.height * imageFrame.frameAspect);
      style.width = `${width.toFixed(2)}px`;
    }
    return style;
  })();
  const cssFrameStyle = (() => {
    if (!platform || !naturalSize || !viewportSize) return undefined;
    const aspect = naturalSize.width / naturalSize.height;
    if (!Number.isFinite(aspect) || aspect <= 0 || viewportSize.height <= 0) return undefined;
    const metrics = platform === 'ios'
      ? { inlineInsetRatio: 0.06, blockInsetRatio: 0.06 }
      : { inlineInsetRatio: 0.04, blockInsetRatio: 0.045 };
    const screenWidthRatio = 1 - metrics.inlineInsetRatio;
    const frameHeightRatio = screenWidthRatio / aspect + metrics.blockInsetRatio;
    const frameWidth = Math.min(viewportSize.width, viewportSize.height / frameHeightRatio);
    const screenHeight = frameWidth * screenWidthRatio / aspect;
    return { width: `${frameWidth.toFixed(2)}px`, '--screen-max-height': `${screenHeight.toFixed(2)}px` };
  })();

  const img = url ? (
    <img
      ref={imgRef}
      src={url}
      alt={`Screenshot ${stage} — ${name}`}
      onLoad={handleImageLoad}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={pickMode && active ? { cursor: 'crosshair' } : undefined}
    />
  ) : null;

  let framed: preact.JSX.Element | null = img;
  if (img && imageFrame) {
    framed = (
      <div class="dm-frame dm-frame-img" style={imageFrameStyle}>
        <div class="dm-frame-screen" style={screenMaskStyle(imageFrame)}>
          <div class="dm-frame-screen-rect" style={screenWindowStyle(imageFrame)}>{img}</div>
        </div>
        <img class="dm-frame-png" src={imageFrame.src} alt="" aria-hidden="true" draggable={false} />
      </div>
    );
  } else if (img && platform) {
    framed = (
      <div class="screenshot-device-frame" style={cssFrameStyle}>
        <div class={`dm-frame dm-skin-${platform} dm-skin-${formFactor}`}>{img}</div>
      </div>
    );
  }

  const overlayGeometry = naturalSize && renderedSize
    ? {
      naturalSize,
      renderedWidth: renderedSize.width,
      renderedHeight: renderedSize.height,
      renderedLeft: renderedSize.left,
      renderedTop: renderedSize.top,
      devicePixelRatio,
    }
    : null;

  return (
    <div
      class={`screenshot-pane${acting ? ' acting' : ''}${active ? ' active' : ''}`}
      style={{ '--device-h': String(hue) }}
      data-testid="screenshot-pane"
      data-device={name}
      data-acting={acting}
      data-active={active}
      onClick={active ? undefined : onActivate}
    >
      <div class="screenshot-pane-label">
        <span class="action-device-tag">{name}</span>
        {acting && <span class="screenshot-pane-role" data-testid="screenshot-pane-role">acting</span>}
        {!acting && active && <span class="screenshot-pane-role" data-testid="screenshot-pane-role">selected</span>}
      </div>
      <div class="screenshot-pane-body">
        {framed ? (
          <div
            ref={wrapperRef}
            class="screenshot-image-wrapper"
            style={scale !== 1 ? { transform: `scale(${scale})`, transformOrigin: 'center center' } : undefined}
          >
            {framed}
            {(bounds || point) && overlayGeometry && (
              <BoundsOverlay bounds={bounds} point={point} {...overlayGeometry} />
            )}
            {highlightBounds && overlayGeometry && (
              <HierarchyHighlightOverlay bounds={highlightBounds} {...overlayGeometry} />
            )}
            {hoverBounds && overlayGeometry && (
              <HierarchyHighlightOverlay bounds={hoverBounds} {...overlayGeometry} />
            )}
            {selectorHighlights && selectorHighlights.length > 0 && overlayGeometry && (
              <SelectorHighlightOverlay boundsList={selectorHighlights} {...overlayGeometry} />
            )}
          </div>
        ) : (
          <div class="screenshot-empty" data-testid="screenshot-empty">No screenshot for {name}</div>
        )}
      </div>
    </div>
  );
}

// ─── Bounds Overlay ───

interface BoundsOverlayProps {
  bounds?: { left: number; top: number; right: number; bottom: number }
  point?: { x: number; y: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function BoundsOverlay({ bounds, point, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: BoundsOverlayProps) {
  if (!bounds && !point) return null;

  // Bounds are in logical points; screenshots are in pixels.
  // Multiply by devicePixelRatio to convert points → pixels before scaling.
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      {bounds && (
        <div
          class="bounds-rect"
          style={{
            left: `${bounds.left * scaleX}px`,
            top: `${bounds.top * scaleY}px`,
            width: `${(bounds.right - bounds.left) * scaleX}px`,
            height: `${(bounds.bottom - bounds.top) * scaleY}px`,
          }}
        />
      )}
      {point && (
        <div
          class="bounds-point"
          style={{
            left: `${point.x * scaleX}px`,
            top: `${point.y * scaleY}px`,
          }}
        />
      )}
    </div>
  );
}

// ─── Hierarchy Highlight Overlay ───

interface HierarchyHighlightProps {
  bounds: { left: number; top: number; right: number; bottom: number }
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function HierarchyHighlightOverlay({ bounds, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: HierarchyHighlightProps) {
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      <div
        class="bounds-rect-hierarchy"
        style={{
          left: `${bounds.left * scaleX}px`,
          top: `${bounds.top * scaleY}px`,
          width: `${(bounds.right - bounds.left) * scaleX}px`,
          height: `${(bounds.bottom - bounds.top) * scaleY}px`,
        }}
      />
    </div>
  );
}

// ─── Selector Highlight Overlay (multiple bounds) ───

interface SelectorHighlightProps {
  boundsList: { left: number; top: number; right: number; bottom: number }[]
  naturalSize: NaturalSize
  renderedWidth: number
  renderedHeight: number
  renderedLeft: number
  renderedTop: number
  devicePixelRatio?: number
}

function SelectorHighlightOverlay({ boundsList, naturalSize, renderedWidth, renderedHeight, renderedLeft, renderedTop, devicePixelRatio }: SelectorHighlightProps) {
  const dpr = devicePixelRatio ?? 1;
  const scaleX = renderedWidth / naturalSize.width * dpr;
  const scaleY = renderedHeight / naturalSize.height * dpr;

  return (
    <div
      class="bounds-overlay"
      style={{
        width: `${renderedWidth}px`,
        height: `${renderedHeight}px`,
        left: `${renderedLeft}px`,
        top: `${renderedTop}px`,
      }}
    >
      {boundsList.map((bounds, i) => (
        <div
          key={i}
          class="bounds-rect-selector"
          style={{
            left: `${bounds.left * scaleX}px`,
            top: `${bounds.top * scaleY}px`,
            width: `${(bounds.right - bounds.left) * scaleX}px`,
            height: `${(bounds.bottom - bounds.top) * scaleY}px`,
          }}
        />
      ))}
    </div>
  );
}
