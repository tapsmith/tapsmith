/**
 * useCanvasAspect — the width÷height of the frame a mirror canvas is showing.
 *
 * Both mirror hooks (use-screen-mirror.ts) resize the canvas's backing store
 * to each decoded frame's dimensions, which sets its `width`/`height`
 * attributes. Watching those attributes gives the live frame shape without
 * re-rendering on every frame: React state only changes when the shape does
 * (a rotation, a different device). Undefined until a frame has set them — a
 * fresh canvas's default 300×150 is not a device screen.
 *
 * The canvas must stay the same element for the component's lifetime
 * (DeviceFrame keeps its DOM stable across bezel switches for this reason).
 */

import type { RefObject } from 'preact';
import { useState, useEffect } from 'preact/hooks';

function readAspect(canvas: HTMLCanvasElement): number | undefined {
  if (!canvas.hasAttribute('width') || !canvas.hasAttribute('height')) return undefined;
  const { width, height } = canvas;
  return width > 0 && height > 0 ? width / height : undefined;
}

export function useCanvasAspect(canvasRef: RefObject<HTMLCanvasElement>): number | undefined {
  const [aspect, setAspect] = useState<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => setAspect(readAspect(canvas));
    update();
    const mo = new MutationObserver(update);
    mo.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    return () => mo.disconnect();
  }, [canvasRef]);

  return aspect;
}
