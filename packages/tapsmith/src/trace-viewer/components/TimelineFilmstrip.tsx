import { useRef, useEffect, useState } from 'preact/hooks';
import { LoaderCircle, Play } from 'lucide-preact';
import type { ActionTraceEvent, AssertionTraceEvent, TraceMetadata } from '../../trace/types.js';
import type { ContainerSummary } from '../types.js';
import { findNearestScreenshot } from '../../ui-mode/hooks/use-trace-data.js';
import { actingDevice, deviceTagStyle, isMultiDevice } from './device-frames.js';

// ─── Injected Styles ───

const TIMELINE_STYLES = `
  .timeline-item { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
  .timeline-item .timeline-time-label { position: static; transform: none; font-size: 9px; color: #555; white-space: nowrap; }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = TIMELINE_STYLES;
  document.head.appendChild(el);
}

// ─── Types ───

interface Props {
  events: (ActionTraceEvent | AssertionTraceEvent)[]
  screenshots: Map<string, string>
  metadata: TraceMetadata
  selectedIndex: number
  onSelect: (index: number) => void
  hasTrace?: boolean
  onRunTest?: () => void
  isTestPending?: boolean
  nodeType?: 'test' | 'suite' | 'file' | 'project'
  containerSummary?: ContainerSummary
  onRunContainer?: () => void
}

function hasValue(map: Map<string, string>, value: string): boolean {
  for (const v of map.values()) if (v === value) return true;
  return false;
}

function formatRelativeTime(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${sign}${abs}ms`;
  const seconds = abs / 1000;
  if (seconds < 10) return `${sign}${seconds.toFixed(1)}s`;
  return `${sign}${Math.round(seconds)}s`;
}

export function TimelineFilmstrip({ events, screenshots, metadata, selectedIndex, onSelect, hasTrace, onRunTest, isTestPending, nodeType, containerSummary, onRunContainer }: Props) {
  injectStyles();

  const selectedRef = useRef<HTMLElement>(null);
  // A frame with no screenshot shows a placeholder the shape of the
  // screenshots around it (a tablet or a landscape phone is not 9:19.5): the
  // first thumbnail's shape once one loads, the device's recorded screen
  // size before that. Kept per test and per run: UI mode reuses this
  // component as the viewed test changes (the next test, or the same test in
  // another project, may be another device's) and when a test re-runs (the
  // device may have turned). UI mode's startTime is 0, so the run is told
  // apart by the measured thumbnail still being among the screenshots: a
  // re-run's screenshots are new URLs, and streaming ones keep the old.
  const testKey = `${metadata.project ?? ''}|${metadata.testFile ?? ''}|${metadata.testName ?? ''}|${metadata.startTime}`;
  const [loadedThumb, setLoadedThumb] = useState<{ key: string; src: string; aspect: number } | undefined>(undefined);
  const thumbAspect = loadedThumb?.key === testKey && hasValue(screenshots, loadedThumb.src) ? loadedThumb.aspect : undefined;
  const res = metadata.device.screenResolution;
  const placeholderAspect = thumbAspect
    ?? (res && res.width > 0 && res.height > 0 ? res.width / res.height : undefined);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [selectedIndex]);

  const statusClass = metadata.testStatus === 'passed' ? 'passed'
    : metadata.testStatus === 'failed' ? 'failed'
    : metadata.testStatus === 'running' ? 'running'
    : 'idle';
  const statusIcon = metadata.testStatus === 'passed' ? '\u2713'
    : metadata.testStatus === 'failed' ? '\u2717'
    : '\u25CB';

  // \u2500\u2500\u2500 Nothing selected \u2500\u2500\u2500

  if (!nodeType) {
    return (
      <div class="film-empty" data-state="idle">
        <span class="film-empty-dot" />
        <span class="film-empty-text">No test selected</span>
      </div>
    );
  }

  // \u2500\u2500\u2500 Container selected (suite / file / project) \u2500\u2500\u2500

  if (nodeType !== 'test' && containerSummary) {
    const { totalTests, running } = containerSummary;
    const isContainerPending = isTestPending || running > 0;
    const parts: string[] = [];
    if (containerSummary.passed > 0) parts.push(`${containerSummary.passed} passed`);
    if (containerSummary.failed > 0) parts.push(`${containerSummary.failed} failed`);
    if (containerSummary.running > 0) parts.push(`${containerSummary.running} running`);
    if (containerSummary.idle > 0) parts.push(`${containerSummary.idle} not run`);
    const label = `${containerSummary.name} \u00B7 ${totalTests} ${totalTests === 1 ? 'test' : 'tests'}${parts.length ? ` \u00B7 ${parts.join(', ')}` : ''}`;
    return (
      <div class="film-empty" data-state={running > 0 ? 'running' : 'idle'}>
        {running > 0
          ? <LoaderCircle size={13} class="film-empty-icon" style={{ animation: 'spin 1.1s linear infinite' }} />
          : <span class="film-empty-dot" />}
        <span class="film-empty-text">{label}</span>
        {onRunContainer && (
          <button class="film-empty-cta" onClick={onRunContainer} disabled={isContainerPending}>
            {isContainerPending
              ? <><LoaderCircle size={10} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
              : <><Play size={10} /> Run {totalTests} {totalTests === 1 ? 'test' : 'tests'}</>}
          </button>
        )}
      </div>
    );
  }

  // \u2500\u2500\u2500 Test selected, no trace yet \u2500\u2500\u2500

  if (hasTrace === false && metadata.testStatus !== 'passed' && metadata.testStatus !== 'failed') {
    const state = metadata.testStatus === 'running' ? 'running'
      : metadata.testStatus === 'skipped' ? 'skipped'
      : 'idle';
    return (
      <div class="film-empty" data-state={state}>
        {state === 'running'
          ? <LoaderCircle size={13} class="film-empty-icon" style={{ animation: 'spin 1.1s linear infinite' }} />
          : <span class="film-empty-dot" />}
        <span class="film-empty-text">
          {state === 'running' ? 'Running test\u2026'
            : state === 'skipped' ? 'Skipped'
            : 'Not run yet'}
        </span>
        {state !== 'running' && state !== 'skipped' && onRunTest && (
          <button class="film-empty-cta" onClick={onRunTest} disabled={isTestPending}>
            {isTestPending
              ? <><LoaderCircle size={10} style={{ animation: 'spin 1.1s linear infinite' }} /> Running…</>
              : <><Play size={10} /> Run this test</>}
          </button>
        )}
      </div>
    );
  }

  // Anchor the strip at the earliest thing in it, not the test's start: the
  // runner replays inherited scope setup (the file-entry app reset, beforeAll
  // hooks) into every test's trace, and for every test after the first that
  // setup ran before the test began. Measured from the test start those
  // frames read as negative offsets, which look like a clock error.
  // Labels are placed by `timestamp`, so it must count towards the anchor: a
  // synthesized `startTime` is clamped up to the test start and would hide a
  // completion that predates it.
  const earliestEvent = events.reduce<number | undefined>((min, e) => {
    const t = Math.min(e.timestamp, e.startTime ?? e.timestamp);
    return min === undefined || t < min ? t : min;
  }, undefined);
  const firstTimestamp = metadata.startTime > 0 && earliestEvent !== undefined
    ? Math.min(metadata.startTime, earliestEvent)
    : metadata.startTime > 0
      ? metadata.startTime
      : earliestEvent ?? 0;
  const hasTestName = !!metadata.testName;
  const hasDeviceSerial = !!metadata.device.serial;
  const fileName = metadata.testFile ? metadata.testFile.split('/').pop() : undefined;
  const breadcrumb = [metadata.project, fileName].filter(Boolean).join(' \u203a ');

  const renderFrame = (event: ActionTraceEvent | AssertionTraceEvent, i: number, withLabel = true): preact.JSX.Element => {
    const pad = String(event.actionIndex).padStart(3, '0');
    const afterKey = `screenshots/action-${pad}-after.png`;
    const beforeKey = `screenshots/action-${pad}-before.png`;
    const url = screenshots.get(afterKey) ?? screenshots.get(beforeKey)
      ?? findNearestScreenshot(screenshots, event.actionIndex);
    const isSelected = i === selectedIndex;
    const isFailed = event.type === 'action' ? !event.success : !event.passed;
    const relativeTime = formatRelativeTime(event.timestamp - firstTimestamp);

    return (
      <div key={i} class={`timeline-item film-frame${isFailed ? ' failed' : ''}${isSelected ? ' active' : ''}`} data-testid="film-frame">
        {url ? (
          <img
            ref={isSelected ? selectedRef as preact.RefObject<HTMLImageElement> : undefined}
            class={`timeline-thumb film-thumb${isSelected ? ' selected' : ''}${isFailed ? ' failed' : ''}`}
            src={url}
            onClick={() => onSelect(i)}
            onLoad={thumbAspect === undefined ? (e) => {
              const img = e.currentTarget as HTMLImageElement;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) setLoadedThumb({ key: testKey, src: url, aspect: img.naturalWidth / img.naturalHeight });
            } : undefined}
          />
        ) : (
          <div
            ref={isSelected ? selectedRef as preact.RefObject<HTMLDivElement> : undefined}
            class={`timeline-placeholder film-thumb${isSelected ? ' selected' : ''}`}
            style={placeholderAspect ? { aspectRatio: String(placeholderAspect) } : undefined}
            onClick={() => onSelect(i)}
          >
            {i + 1}
          </div>
        )}
        {withLabel && <div class="timeline-time-label film-label" data-testid="film-label">{relativeTime}</div>}
      </div>
    );
  };

  // One lane per device: the same chronological strip, split by the device
  // that acted, so a two-user conversation reads as two rows. Every lane lays
  // its frames on the same columns and one shared axis below carries the
  // offsets, so the rows read as a single timeline. The acting device's lane
  // is lit and the others dimmed, matching the screenshot pane's "acting" badge.
  const renderLanes = (): preact.JSX.Element => {
    const group = { devices: metadata.devices! };
    const selected = events[selectedIndex];
    const acting = selected ? actingDevice(group, selected) : undefined;
    return (
      <div class={`film-lanes${acting ? ' has-acting' : ''}`} data-testid="film-lanes" style={{ '--lane-count': String(group.devices.length) }}>
        {group.devices.map((d) => {
          const name = d.name ?? '';
          const isActing = name === acting;
          const tooltip = [d.model, d.serial].filter(Boolean).join(' \u00b7 ');
          return (
            <div class={`film-lane${isActing ? ' acting' : ''}`} data-testid="film-lane" data-device={name} data-acting={isActing} style={deviceTagStyle(group, name)} key={name}>
              <div class="film-lane-label">
                <span class="action-device-tag" data-testid="film-lane-label" title={tooltip || undefined}>{name}</span>
              </div>
              <div class="timeline-inner film-lane-inner">
                {events.map((event, i) => (
                  actingDevice(group, event) === name
                    ? renderFrame(event, i, false)
                    : <div key={i} class="timeline-item film-gap" aria-hidden="true" />
                ))}
              </div>
            </div>
          );
        })}
        <div class="film-axis" data-testid="film-axis">
          <div class="film-axis-spacer" />
          <div class="film-axis-inner">
            {events.map((event, i) => (
              <div key={i} class={`film-label film-axis-label${i === selectedIndex ? ' active' : ''}`} data-testid="film-label">
                {formatRelativeTime(event.timestamp - firstTimestamp)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div class="timeline">
      <div class="timeline-meta" data-testid="timeline-meta">
        {hasTestName
          ? <span class={`test-status ${statusClass}`}>{statusIcon} {breadcrumb ? <>{breadcrumb}{' \u203a '}</> : null}{metadata.testName}</span>
          : <span class="test-status">No test selected</span>}
        {hasTestName && metadata.testStatus !== 'running' && metadata.testStatus !== 'idle' && (
          <span>{' \u00b7 '}{metadata.testDuration}ms</span>
        )}
        {metadata.devices && metadata.devices.length > 1
          ? <>{' \u00b7 '}{metadata.devices.map((d) => d.name ?? d.serial).join(' + ')}</>
          : hasDeviceSerial && <>{' \u00b7 '}{metadata.device.model || metadata.device.serial}</>}
      </div>
      {isMultiDevice(metadata) ? renderLanes() : (
        <div class="timeline-inner">
          {events.map((event, i) => renderFrame(event, i))}
        </div>
      )}
    </div>
  );
}
