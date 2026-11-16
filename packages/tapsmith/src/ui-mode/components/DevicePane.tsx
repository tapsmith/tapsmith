/**
 * DevicePane — dedicated device mirror pane with multi-worker support.
 *
 * Single device: shows DeviceMirror directly.
 * Several devices (several workers, or a `use.devices` worker whose group
 * has several members): device tabs (All + one per device) with status dots.
 *   - Per-device tab: single DeviceMirror for that worker's device.
 *   - "All" tab: grid of every device of every worker.
 */

import type { RefObject } from 'preact';
import { useRef, useEffect } from 'preact/hooks';
import { Lock, LockOpen, Focus } from 'lucide-preact';
import type { WorkerInfo, WorkerDeviceInfo, ClientMessage, DevicePlatform } from '../ui-protocol.js';
import { inferDevicePlatform, inferDeviceFormFactor } from '../ui-protocol.js';
import type { Bounds } from '../../trace-viewer/components/hierarchy-utils.js';
import { DeviceMirror } from './DeviceMirror.js';
import { DeviceFrame } from './DeviceFrame.js';
import { useDeviceInteraction } from '../hooks/use-device-interaction.js';
import { nextTabIndex, focusSibling } from '../tabstrip.js';

interface DevicePaneProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
  workers: WorkerInfo[]
  selectedWorkerId: number
  deviceViewMode: 'all' | number
  /** Which device of the selected worker's group the single view mirrors (0 = primary). */
  mirrorDeviceIndex: number
  onSelectDeviceView: (mode: 'all' | number, deviceIndex?: number) => void
  registerCanvas: (workerId: number, canvas: HTMLCanvasElement, deviceIndex?: number) => void
  unregisterCanvas: (workerId: number, deviceIndex?: number) => void
  /** Single-view mirror is starting and hasn't painted its first frame yet. */
  mirrorLoading: boolean
  platform?: 'android' | 'ios'
  interactive: boolean
  /** The mirrored device's lock (the header toggle; the single view). */
  locked: boolean
  force: boolean
  /** One "All" grid tile's lock: each follows its own worker's run (PILOT-1179). */
  tileLock: (workerId: number) => { interactive: boolean, force: boolean }
  onToggleLock: () => void
  send: (msg: ClientMessage) => void
  /** Element pick mode on the live mirror (single-mirror view only). */
  pickMode: boolean
  onTogglePick: () => void
  pickAvailable: boolean
  /** A test runs on the mirrored device and the mirror is locked: picking waits for it. */
  pickPaused: boolean
  pickDpr: number
  pickHoverBounds: Bounds | null
  pickMatchBounds: Bounds[]
  onPickPoint: (point: { x: number; y: number }) => void
  onPickHover: (point: { x: number; y: number } | null) => void
}

const DOT_CLASS: Record<WorkerInfo['status'], string> = {
  idle: 'idle',
  running: 'running',
  done: 'done',
  initializing: 'initializing',
  error: 'error',
};

/**
 * One mirrorable device: a worker's primary, or a member of its group. The
 * pane's tabs and grid are built from these, so a two-user worker shows two.
 */
export interface DeviceView {
  workerId: number
  deviceIndex: number
  /** Tab / tile label: the worker's display name, plus the member name for groups. */
  label: string
  deviceSerial: string
  platform?: DevicePlatform
  devicePixelRatio?: number
  status: WorkerInfo['status']
}

/** Flatten the workers into device views, primary first within each group. */
export function deviceViewsOf(workers: WorkerInfo[]): DeviceView[] {
  const views: DeviceView[] = [];
  for (const w of workers) {
    const devices: WorkerDeviceInfo[] = w.devices && w.devices.length > 0
      ? w.devices
      : [{ index: 0, name: 'device-1', deviceSerial: w.deviceSerial, displayName: w.displayName, platform: w.platform, devicePixelRatio: w.devicePixelRatio }];
    const group = devices.length > 1;
    for (const d of devices) {
      views.push({
        workerId: w.workerId,
        deviceIndex: d.index,
        label: group ? `${w.displayName} · ${d.name}` : w.displayName,
        deviceSerial: d.deviceSerial,
        platform: d.platform ?? w.platform,
        devicePixelRatio: d.devicePixelRatio ?? w.devicePixelRatio,
        status: w.status,
      });
    }
  }
  return views;
}

/** Canvas ref callback for the "All" grid — registers/unregisters with multi-mirror hook. */
function WorkerCanvas({ workerId, deviceIndex, label, deviceSerial, connected, registerCanvas, unregisterCanvas, platform, interactive, force, send }: {
  workerId: number
  deviceIndex: number
  label: string
  deviceSerial: string
  connected: boolean
  registerCanvas: (id: number, canvas: HTMLCanvasElement, deviceIndex?: number) => void
  unregisterCanvas: (id: number, deviceIndex?: number) => void
  platform?: DevicePlatform
  interactive: boolean
  force: boolean
  send: (msg: ClientMessage) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const framePlatform = platform ?? inferDevicePlatform(label, deviceSerial);
  const frameFormFactor = inferDeviceFormFactor({ hints: [label, deviceSerial] });
  const interaction = useDeviceInteraction({ send, enabled: interactive, force, workerId, deviceIndex });

  // Register this tile's canvas with the screenshot mirror.
  useEffect(() => {
    if (ref.current) {
      registerCanvas(workerId, ref.current, deviceIndex);
    }
    return () => unregisterCanvas(workerId, deviceIndex);
  }, [workerId, deviceIndex, registerCanvas, unregisterCanvas]);

  return (
    <div class="device-body-item">
      <div class="device-body-label">{label}</div>
      <div class="dm-viewport">
        {!connected && (
          <div class="dm-overlay">
            <div class="dm-placeholder">
              <svg class="dm-phone-icon" viewBox="0 0 56 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="52" height="92" rx="8" stroke="currentColor" stroke-width="2.5" />
                <rect x="8" y="14" width="40" height="64" rx="2" fill="currentColor" opacity="0.08" />
                <rect x="22" y="84" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
                <circle cx="28" cy="8" r="2" fill="currentColor" opacity="0.2" />
              </svg>
              <div class="dm-placeholder-text">Waiting for device</div>
              <div class="dm-placeholder-dots">
                <span class="dm-dot" />
                <span class="dm-dot" />
                <span class="dm-dot" />
              </div>
            </div>
          </div>
        )}
        <DeviceFrame platform={framePlatform} formFactor={frameFormFactor}>
          <canvas
            ref={ref}
            aria-label={`Device screen mirror — ${label}`}
            class={`dm-canvas ${interactive ? 'interactive' : 'locked'}`}
            tabIndex={interactive ? 0 : -1}
            onPointerDown={interactive ? interaction.onPointerDown : undefined}
            onPointerMove={interactive ? interaction.onPointerMove : undefined}
            onPointerUp={interactive ? interaction.onPointerUp : undefined}
            onPointerCancel={interactive ? interaction.onPointerCancel : undefined}
            onKeyDown={interactive ? interaction.onKeyDown : undefined}
          />
        </DeviceFrame>
      </div>
    </div>
  );
}

export function DevicePane({
  canvasRef,
  connected,
  workers,
  selectedWorkerId,
  deviceViewMode,
  mirrorDeviceIndex,
  onSelectDeviceView,
  registerCanvas,
  unregisterCanvas,
  mirrorLoading,
  platform,
  interactive,
  locked,
  force,
  tileLock,
  onToggleLock,
  send,
  pickMode,
  onTogglePick,
  pickAvailable,
  pickPaused,
  pickDpr,
  pickHoverBounds,
  pickMatchBounds,
  onPickPoint,
  onPickHover,
}: DevicePaneProps) {
  const views = deviceViewsOf(workers);
  const hasWorkers = views.length > 1;
  const mirroredWorkerId = typeof deviceViewMode === 'number' ? deviceViewMode : selectedWorkerId;
  const selectedView = views.find((v) => v.workerId === mirroredWorkerId && v.deviceIndex === mirrorDeviceIndex)
    ?? views.find((v) => v.workerId === mirroredWorkerId);
  const mirrorPlatform = selectedView
    ? (selectedView.platform ?? inferDevicePlatform(selectedView.label, selectedView.deviceSerial) ?? platform)
    : platform;
  const mirrorFormFactor = inferDeviceFormFactor({
    hints: selectedView ? [selectedView.label, selectedView.deviceSerial] : [],
  });

  // Left/Right move between the All tab and the per-device tabs; Home/End jump
  // to the ends. Additive: these are real buttons and stay individually
  // tabbable (see tabstrip.ts).
  const tabTargets: Array<'all' | DeviceView> = ['all', ...views];
  const handleWorkerTabKey = (e: KeyboardEvent, index: number) => {
    const next = nextTabIndex(e.key, index, tabTargets.length);
    if (next === null) return;
    e.preventDefault();
    const target = tabTargets[next];
    if (target === 'all') onSelectDeviceView('all');
    else onSelectDeviceView(target.workerId, target.deviceIndex);
    focusSibling(e, next);
  };
  const viewId = (v: DeviceView): string => `device-view-${v.workerId}-${v.deviceIndex}`;
  const isViewSelected = (v: DeviceView): boolean =>
    deviceViewMode === v.workerId && v.deviceIndex === mirrorDeviceIndex;

  return (
    <div class="device-col" role="region" aria-label="Live device mirror">
      <div class="device-head">
        <span class="device-head-title">Live device mirror</span>
        <span class="device-head-meta">
          <span class="dot running" />
        </span>
        {/* Always-visible lock toggle. Off (interactive) by default; auto-locks
            while a run is active, but the user can lock/unlock at any time. An
            explicit lock sticks past the run; an unlock-override is per-run. */}
        <button
          type="button"
          class={`mirror-lock-toggle ${locked ? 'locked' : 'unlocked'}`}
          onClick={onToggleLock}
          aria-label={locked ? 'Interaction locked — click to unlock' : 'Interaction unlocked — click to lock'}
          title={locked ? 'Interaction locked — click to unlock' : 'Interaction unlocked — click to lock'}
        >
          {locked ? <Lock size={15} aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}
        </button>
        {/* Element picker for the live mirror — click an element to get a
            locator in the Locator tab. Single-mirror view only. */}
        <button
          type="button"
          class={`mirror-pick-toggle ${pickMode ? 'active' : ''}`}
          onClick={onTogglePick}
          disabled={!pickAvailable}
          aria-label={pickMode ? 'Picking element — click to cancel' : 'Pick an element to get a locator'}
          title={!pickAvailable && deviceViewMode === 'all' && workers.length > 1
            ? 'Select a device tab to pick'
            : pickPaused
              ? 'Locked while a test runs on this device. Unlock it to pick anyway, or pick from the trace\'s screenshot.'
              : pickMode ? 'Picking element — click to cancel' : 'Pick an element to get a locator'}
        >
          <Focus size={15} aria-hidden="true" />
        </button>
      </div>

      {hasWorkers && (
        <div class="worker-tabs" role="tablist" aria-label="Device views">
          <button
            class={`worker-tab ${deviceViewMode === 'all' ? 'active' : ''}`}
            id="device-view-all"
            role="tab"
            aria-selected={deviceViewMode === 'all'}
            aria-controls="device-tabpanel"
            onClick={() => onSelectDeviceView('all')}
            onKeyDown={(e) => handleWorkerTabKey(e, 0)}
          >
            All
          </button>
          {views.map((v, i) => (
            <button
              key={`${v.workerId}:${v.deviceIndex}`}
              class={`worker-tab ${isViewSelected(v) ? 'active' : ''}`}
              id={viewId(v)}
              role="tab"
              aria-selected={isViewSelected(v)}
              aria-controls="device-tabpanel"
              onClick={() => onSelectDeviceView(v.workerId, v.deviceIndex)}
              onKeyDown={(e) => handleWorkerTabKey(e, i + 1)}
              title={`${v.label} (${v.deviceSerial}) — ${v.status}`}
            >
              <span class={`dot ${connected ? DOT_CLASS[v.status] : 'error'}`} />
              {v.label}
            </button>
          ))}
        </div>
      )}

      <div
        id="device-tabpanel"
        role={hasWorkers ? 'tabpanel' : undefined}
        aria-labelledby={hasWorkers
          ? (deviceViewMode === 'all' ? 'device-view-all' : selectedView ? viewId(selectedView) : undefined)
          : undefined}
        class="device-pane-body"
      >
        {deviceViewMode === 'all' && hasWorkers ? (
          <div class="device-pane-grid">
            {views.map((v) => (
              <WorkerCanvas
                key={`${v.workerId}:${v.deviceIndex}`}
                workerId={v.workerId}
                deviceIndex={v.deviceIndex}
                label={v.label}
                deviceSerial={v.deviceSerial}
                connected={connected}
                registerCanvas={registerCanvas}
                unregisterCanvas={unregisterCanvas}
                platform={v.platform}
                {...tileLock(v.workerId)}
                send={send}
              />
            ))}
          </div>
        ) : (
          <DeviceMirror
            canvasRef={canvasRef}
            connected={connected}
            loading={mirrorLoading}
            platform={mirrorPlatform}
            formFactor={mirrorFormFactor}
            interactive={interactive}
            force={force}
            workerId={mirroredWorkerId}
            deviceIndex={mirrorDeviceIndex}
            send={send}
            pickMode={pickMode}
            pickDpr={pickDpr}
            pickHoverBounds={pickHoverBounds}
            pickMatchBounds={pickMatchBounds}
            onPickPoint={onPickPoint}
            onPickHover={onPickHover}
          />
        )}
      </div>
    </div>
  );
}
