/**
 * MirrorPickOverlay — element highlights for the live mirror's pick mode.
 *
 * Sits as a sibling of the mirror canvas inside DeviceFrame (all frame
 * variants provide a positioned container) and draws the hovered element
 * (green) and current selector matches (purple) over the canvas, mapping
 * hierarchy logical points → CSS px via logicalBoundsToMirrorCss.
 */

import type { RefObject } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import type { Bounds } from '../../trace-viewer/components/hierarchy-utils.js';
import { logicalBoundsToMirrorCss } from './mirror-coords.js';

// ─── Injected Styles ───

const OVERLAY_STYLES = `
  .mp-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
  .mp-rect-hover { position: absolute; border: 2px solid var(--color-success, #4ec9b0); background: rgba(78,201,176,0.15); border-radius: 2px; }
  .mp-rect-match { position: absolute; border: 2px solid #c084fc; background: rgba(192,132,252,0.18); border-radius: 2px; }
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.textContent = OVERLAY_STYLES;
  document.head.appendChild(el);
}

// ─── Component ───

interface Geometry {
  /** Canvas CSS box offset relative to the overlay's own box. */
  dx: number
  dy: number
  cssWidth: number
  cssHeight: number
  /** Canvas backing-store dims = last frame's device pixels. */
  frameWidth: number
  frameHeight: number
}

interface MirrorPickOverlayProps {
  canvasRef: RefObject<HTMLCanvasElement>
  /** Device pixel ratio of the mirrored worker (iOS scale; Android 1). */
  dpr: number
  hoverBounds: Bounds | null
  matchBounds: Bounds[]
}

export function MirrorPickOverlay({ canvasRef, dpr, hoverBounds, matchBounds }: MirrorPickOverlayProps) {
  injectStyles();

  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);

  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overlayEl) return;
    const canvasRect = canvas.getBoundingClientRect();
    const overlayRect = overlayEl.getBoundingClientRect();
    setGeometry({
      dx: canvasRect.left - overlayRect.left,
      dy: canvasRect.top - overlayRect.top,
      cssWidth: canvasRect.width,
      cssHeight: canvasRect.height,
      frameWidth: canvas.width,
      frameHeight: canvas.height,
    });
  }, [canvasRef, overlayEl]);

  // Track canvas/container resizes (bezel refit, rotation, panel resize).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !overlayEl) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    ro.observe(overlayEl);
    return () => ro.disconnect();
  }, [canvasRef, overlayEl, measure]);

  // Re-measure when the highlights change — cheap, and keeps the mapping
  // correct if layout shifted without a resize (e.g. worker tabs toggling).
  useEffect(() => {
    measure();
  }, [hoverBounds, matchBounds, measure]);

  const toStyle = (bounds: Bounds): Record<string, string> => {
    if (!geometry) return { display: 'none' };
    const rect = logicalBoundsToMirrorCss(
      bounds, geometry.cssWidth, geometry.cssHeight,
      geometry.frameWidth, geometry.frameHeight, dpr,
    );
    return {
      left: `${geometry.dx + rect.left}px`,
      top: `${geometry.dy + rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    };
  };

  return (
    <div class="mp-overlay" ref={setOverlayEl}>
      {matchBounds.map((b, i) => (
        <div key={i} class="mp-rect-match" style={toStyle(b)} />
      ))}
      {hoverBounds && <div class="mp-rect-hover" data-testid="mirror-pick-hover" style={toStyle(hoverBounds)} />}
    </div>
  );
}
