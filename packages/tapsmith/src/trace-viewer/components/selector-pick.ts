/**
 * Screenshot pick handler for the offline trace playground (PILOT-226): the
 * picked node and the top suggestion ranked against the recorded hierarchy.
 *
 * Plain TS (no JSX) so the logic is unit-testable under the non-JSX
 * tsconfig; LocatorPlayground.tsx re-exports for its UI consumers.
 */

import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { generateSelectors, generateBestSelector } from './selector-generation.js';
import { disambiguateSelectors } from './selector-uniqueness.js';
import { pickNodeAt } from './pick-node.js';

export { isWebViewOverlayPending, handleHoverFromScreenshot } from './pick-node.js';

export function handlePickFromScreenshot(
  roots: HierarchyNode[],
  clickX: number,
  clickY: number,
): { node: HierarchyNode; selector: string; bounds: Bounds } | null {
  const picked = pickNodeAt(roots, clickX, clickY);
  if (!picked) return null;
  // Pre-fill with the same disambiguated top suggestion the list shows —
  // generateBestSelector alone can be ambiguous (.first()/.nth() missing)
  // and would immediately trip the strict-mode warning.
  const best = disambiguateSelectors(roots, picked.node, generateSelectors(picked.node))
    .find((s) => !s.label.includes('may not match'));
  return { ...picked, selector: best?.code ?? generateBestSelector(picked.node) };
}
