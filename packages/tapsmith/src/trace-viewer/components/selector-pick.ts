/**
 * Screenshot pick/hover handlers for the locator playground (PILOT-226).
 *
 * Plain TS (no JSX) so the logic is unit-testable under the non-JSX
 * tsconfig; LocatorPlayground.tsx re-exports for its UI consumers.
 */

import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { generateSelectors, generateBestSelector, findBetterDescendant, hasGoodSelectors } from './selector-generation.js';
import { getNodeBounds, hitTest } from './selector-matching.js';
import { disambiguateSelectors } from './selector-uniqueness.js';

function findParent(roots: HierarchyNode[], target: HierarchyNode): HierarchyNode | null {
  for (const root of roots) {
    const result = findParentWalk(root, target);
    if (result) return result;
  }
  return null;
}

function findParentWalk(node: HierarchyNode, target: HierarchyNode): HierarchyNode | null {
  for (const child of node.children) {
    if (child === target) return node;
    const result = findParentWalk(child, target);
    if (result) return result;
  }
  return null;
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// ─── Pick Handler (called from parent on screenshot click) ───

export function handlePickFromScreenshot(
  roots: HierarchyNode[],
  clickX: number,
  clickY: number,
): { node: HierarchyNode; selector: string; bounds: Bounds } | null {
  const hitNode = hitTest(roots, clickX, clickY);
  if (!hitNode) return null;
  // When the hit node is a generic container with only fallback selectors,
  // promote a descendant that has a meaningful selector (e.g. textfield
  // with placeholder inside a wrapper View). If the node is a leaf (no
  // children), check siblings with overlapping bounds instead.
  // A promoted node without parseable bounds would fail the whole pick even
  // though hitNode (found by bounds) is guaranteed to have them — only
  // promote nodes that can be highlighted.
  let betterNode = findBetterDescendant(hitNode);
  if (betterNode && !getNodeBounds(betterNode)) betterNode = null;
  if (!betterNode && hitNode.children.length === 0) {
    const hitBounds = getNodeBounds(hitNode);
    if (hitBounds) {
      const parent = findParent(roots, hitNode);
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === hitNode) continue;
          const sb = getNodeBounds(sibling);
          if (sb && boundsOverlap(hitBounds, sb)) {
            const found = findBetterDescendant(sibling) ?? (hasGoodSelectors(sibling) ? sibling : null);
            if (found && getNodeBounds(found)) { betterNode = found; break; }
          }
        }
      }
    }
  }
  if (!betterNode) betterNode = hitNode;
  const bounds = getNodeBounds(betterNode);
  if (!bounds) return null;
  // Pre-fill with the same disambiguated top suggestion the list shows —
  // generateBestSelector alone can be ambiguous (.first()/.nth() missing)
  // and would immediately trip the strict-mode warning.
  const best = disambiguateSelectors(roots, betterNode, generateSelectors(betterNode))
    .find((s) => !s.label.includes('may not match'));
  return { node: betterNode, selector: best?.code ?? generateBestSelector(betterNode), bounds };
}

// ─── WebView overlay detection (live mirror pick) ───

function isNativeWebViewContainer(node: HierarchyNode): boolean {
  // iOS: <XCUIElementTypeWebView …>. Android: <node class="android.webkit.WebView" …>.
  return node.tagName === 'XCUIElementTypeWebView'
    || (node.attributes.get('class') ?? '').includes('webkit.WebView');
}

/**
 * True when a pick at (x, y) landed on the native accessibility projection of
 * web content while the WebView DOM overlay is still missing from the tree —
 * i.e. the point is inside a native WebView container but no `webview="true"`
 * nodes exist. The live mirror uses this to defer finalizing the pick until
 * the next hierarchy snapshot carries the overlay (the server connects to the
 * WebView on demand, which takes a moment), so web-content picks yield
 * webview.* locators instead of native projections.
 */
export function isWebViewOverlayPending(roots: HierarchyNode[], x: number, y: number): boolean {
  let insideWebView = false;
  let hasOverlayAtPoint = false;
  const contains = (bounds: Bounds) =>
    x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  function walk(node: HierarchyNode) {
    const bounds = getNodeBounds(node);
    if (node.attributes.get('webview') === 'true') {
      // Only an overlay covering the pick point counts — with multiple
      // WebViews on screen, another WebView's overlay must not suppress
      // deferral for this one.
      // Keep walking: a child DOM node can contain the point even when its
      // parent's bounds don't (absolutely-positioned elements).
      if (bounds && contains(bounds)) hasOverlayAtPoint = true;
    } else if (!insideWebView && isNativeWebViewContainer(node) && bounds && contains(bounds)) {
      insideWebView = true;
    }
    node.children.forEach(walk);
  }
  roots.forEach(walk);
  return insideWebView && !hasOverlayAtPoint;
}

// ─── Hover Handler (called from parent on screenshot mousemove) ───

export function handleHoverFromScreenshot(
  roots: HierarchyNode[],
  x: number,
  y: number,
): Bounds | null {
  const node = hitTest(roots, x, y);
  if (!node) return null;
  return getNodeBounds(node);
}
