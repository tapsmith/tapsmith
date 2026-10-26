import type { ElementInfo } from '../grpc-client.js';

/** Format ElementInfo bounds in the hierarchy-XML style: [l,t][r,b]. */
export function formatBounds(bounds: ElementInfo['bounds']): string {
  if (!bounds) return '';
  return `[${bounds.left},${bounds.top}][${bounds.right},${bounds.bottom}]`;
}
