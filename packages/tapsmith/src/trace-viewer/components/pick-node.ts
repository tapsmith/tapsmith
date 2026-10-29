/**
 * Picking an element on a screenshot or the live mirror: which node a point lands on, and hover bounds. Geometry and
 * selector generation only — this module must not match locators, so the
 * live picker can use it; the offline trace playground adds its own
 * suggestion ranking in selector-pick.ts.
 */

import type { HierarchyNode, Bounds } from './hierarchy-utils.js';
import { getNodeBounds, hitTest } from './hierarchy-utils.js';
import { findBetterDescendant, hasGoodSelectors } from './selector-generation.js';
import { isHooksMarkerCarrier, isNonAppSubtree } from './non-app-nodes.js';

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

/**
 * The element a pick at (x, y) lands on: the smallest node under the point,
 * promoted to a descendant (or an overlapping sibling of a leaf) that has a
 * meaningful selector, e.g. the textfield inside a wrapper View. Geometry and
 * selector generation only — no matching — so the live picker can use it and
 * ask the device which locator finds the node.
 */
export function pickNodeAt(
  roots: HierarchyNode[],
  clickX: number,
  clickY: number,
): { node: HierarchyNode; bounds: Bounds } | null {
  const hitNode = hitTest(roots, clickX, clickY);
  if (!hitNode) return null;
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
          // Never promote to what no locator matches (the hooks marker).
          if (sibling === hitNode || isNonAppSubtree(sibling) || isHooksMarkerCarrier(sibling)) continue;
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
  return bounds ? { node: betterNode, bounds } : null;
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
  // What a click here picks, promotion included: a click on an unnamed row
  // picks the named text inside it, so the hover must show that text, not
  // the row. The promotion depends only on the node under the pointer, so it
  // is worked out once per node, not on every mousemove.
  const hit = hitTest(roots, x, y);
  if (!hit) return null;
  if (!hoverPicks.has(hit)) hoverPicks.set(hit, pickNodeAt(roots, x, y)?.bounds ?? null);
  return hoverPicks.get(hit) ?? null;
}

/** The bounds a pick takes, per node under the pointer (a tree's nodes are never mutated). */
const hoverPicks = new WeakMap<HierarchyNode, Bounds | null>();
