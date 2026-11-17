/**
 * DeviceMirror — canvas-based live device screen mirror.
 *
 * Renders PNG screenshots received via WebSocket binary frames onto a
 * <canvas> element. In pick mode, pointer gestures are not forwarded to the
 * device; instead clicks/hovers are mapped to hierarchy logical points for
 * element picking.
 */

import type { RefObject } from 'preact';
import { useRef, useCallback, useEffect } from 'preact/hooks';
import { useDeviceInteraction } from '../hooks/use-device-interaction.js';
import { useCanvasAspect } from '../hooks/use-canvas-aspect.js';
import type { ClientMessage, DevicePlatform } from '../ui-protocol.js';
import type { Bounds } from '../../trace-viewer/components/hierarchy-utils.js';
import { DeviceFrame } from './DeviceFrame.js';
import { MirrorPickOverlay } from './MirrorPickOverlay.js';
import { mirrorPointToLogical } from './mirror-coords.js';

interface DeviceMirrorProps {
  canvasRef: RefObject<HTMLCanvasElement>
  connected: boolean
  /** True while the selected device's mirror is starting and hasn't painted a
   * frame yet — shows the loading placeholder instead of a black canvas. */
  loading?: boolean
  platform?: DevicePlatform
  /** Device name / serial, for the bezel's phone-vs-tablet choice. */
  deviceHints: Array<string | undefined>
  interactive: boolean
  force: boolean
  workerId: number
  /** Which device of the worker's group is mirrored (0 = primary). */
  deviceIndex?: number
  send: (msg: ClientMessage) => void
  /** Element pick mode — clicks pick an element instead of tapping the device. */
  pickMode?: boolean
  /** Device pixel ratio of the mirrored worker (hierarchy bounds are logical points). */
  pickDpr?: number
  pickHoverBounds?: Bounds | null
  pickMatchBounds?: Bounds[]
  onPickPoint?: (point: { x: number; y: number }) => void
  onPickHover?: (point: { x: number; y: number } | null) => void
}

const NO_BOUNDS: Bounds[] = [];

export function DeviceMirror({ canvasRef, connected, loading, platform, deviceHints, interactive, force, workerId, deviceIndex = 0, send, pickMode, pickDpr, pickHoverBounds, pickMatchBounds, onPickPoint, onPickHover }: DeviceMirrorProps) {
  const interaction = useDeviceInteraction({ send, enabled: interactive && !pickMode, force, workerId, deviceIndex });
  // The live frame's shape picks the bezel, so a rotation switches it.
  const contentAspect = useCanvasAspect(canvasRef);

  // Hover hit-tests are coalesced to one per animation frame (mousemove can
  // fire faster than the display refreshes). The callback is read through a
  // ref so a queued frame can't fire a stale closure — onPickHover's identity
  // changes with every live hierarchy refresh (same pattern as optsRef in
  // use-device-interaction.ts).
  const pendingHover = useRef<{ x: number; y: number } | null>(null);
  const hoverRafId = useRef<number | null>(null);
  const onPickHoverRef = useRef(onPickHover);
  onPickHoverRef.current = onPickHover;
  const toLogical = useCallback((e: MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return mirrorPointToLogical(
      e.clientX, e.clientY, canvas.getBoundingClientRect(),
      canvas.width, canvas.height, pickDpr || 1,
    );
  }, [canvasRef, pickDpr]);

  const handlePickClick = useCallback((e: MouseEvent) => {
    const point = toLogical(e);
    if (point) onPickPoint?.(point);
  }, [toLogical, onPickPoint]);

  const flushHover = useCallback(() => {
    hoverRafId.current = null;
    onPickHoverRef.current?.(pendingHover.current);
  }, []);

  const handlePickMove = useCallback((e: MouseEvent) => {
    pendingHover.current = toLogical(e);
    if (hoverRafId.current == null) hoverRafId.current = requestAnimationFrame(flushHover);
  }, [toLogical, flushHover]);

  const handlePickLeave = useCallback(() => {
    pendingHover.current = null;
    if (hoverRafId.current != null) { cancelAnimationFrame(hoverRafId.current); hoverRafId.current = null; }
    onPickHoverRef.current?.(null);
  }, []);

  useEffect(() => () => {
    if (hoverRafId.current != null) cancelAnimationFrame(hoverRafId.current);
  }, []);

  // Pick handlers replace the gesture handlers entirely while picking, so a
  // pick click can never be forwarded to the device as a tap. Picking is
  // deliberately not gated on `interactive` — it is read-only, so it works
  // even while the mirror is locked during a run.
  const gesturesEnabled = interactive && !pickMode;
  return (
    <div class="device-mirror">
      <div class="dm-viewport">
        {(!connected || loading) && (
          <div class="dm-overlay">
            <div class="dm-placeholder" role="status">
              <svg class="dm-phone-icon" viewBox="0 0 56 96" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="2" width="52" height="92" rx="8" stroke="currentColor" stroke-width="2.5" />
                <rect x="8" y="14" width="40" height="64" rx="2" fill="currentColor" opacity="0.08" />
                <rect x="22" y="84" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
                <circle cx="28" cy="8" r="2" fill="currentColor" opacity="0.2" />
              </svg>
              <div class="dm-placeholder-text" data-testid="mirror-status">{connected ? 'Starting mirror…' : 'Waiting for device'}</div>
              {!connected && <div class="dm-placeholder-hint" data-testid="mirror-status-hint">Connect a device or start a test run</div>}
              <div class="dm-placeholder-dots">
                <span class="dm-dot" />
                <span class="dm-dot" />
                <span class="dm-dot" />
              </div>
            </div>
          </div>
        )}
        <DeviceFrame platform={platform} hints={deviceHints} contentAspect={contentAspect} heightBound>
          <canvas
            ref={canvasRef}
            aria-label="Device screen mirror"
            class={`dm-canvas ${pickMode ? 'pick-mode' : interactive ? 'interactive' : 'locked'}`}
            tabIndex={gesturesEnabled ? 0 : -1}
            onPointerDown={gesturesEnabled ? interaction.onPointerDown : undefined}
            onPointerMove={gesturesEnabled ? interaction.onPointerMove : undefined}
            onPointerUp={gesturesEnabled ? interaction.onPointerUp : undefined}
            onPointerCancel={gesturesEnabled ? interaction.onPointerCancel : undefined}
            onKeyDown={gesturesEnabled ? interaction.onKeyDown : undefined}
            onClick={pickMode ? handlePickClick : undefined}
            onMouseMove={pickMode ? handlePickMove : undefined}
            onMouseLeave={pickMode ? handlePickLeave : undefined}
          />
          {(pickMode || (pickMatchBounds?.length ?? 0) > 0) && (
            <MirrorPickOverlay
              canvasRef={canvasRef}
              dpr={pickDpr || 1}
              hoverBounds={pickMode ? (pickHoverBounds ?? null) : null}
              matchBounds={pickMatchBounds ?? NO_BOUNDS}
            />
          )}
        </DeviceFrame>
      </div>
    </div>
  );
}
