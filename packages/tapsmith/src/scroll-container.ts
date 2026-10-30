/**
 * Where `scrollIntoView()` swipes: inside the scroll container that holds its
 * element, picked from a UI hierarchy dump, so a swipe cannot start outside a
 * dialog (and dismiss it) or on a header above the list (and move nothing).
 * Espresso's `scrollTo()` and Compose's `performScrollTo()` scroll the
 * element's parent container the same way.
 *
 * - When the element's frame is known (iOS lists off-screen elements), the
 *   container is its nearest scrollable ancestor that shows on screen.
 * - Otherwise (Android lists only on-screen elements), it is the largest
 *   scrollable on screen in the topmost app window — a dialog's or a popup's
 *   window is smaller than the activity's it lies over — leaving out one that
 *   a later scrollable (drawn over it) covers at its centre.
 *
 * The region is the container's bounds clipped to the screen and its window,
 * less a keyboard or system bar that covers one of its edges. `undefined`
 * when nothing on screen scrolls: the caller swipes the screen.
 */

import { parseHierarchyXml, type HierarchyNode } from './trace-viewer/components/hierarchy-utils.js';

export interface Rect { left: number; top: number; right: number; bottom: number }

/** iOS element types that scroll (Android marks its own `scrollable="true"`). */
const IOS_SCROLL_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeScrollView',
  'XCUIElementTypeTable',
  'XCUIElementTypeCollectionView',
  'XCUIElementTypeWebView',
]);

/** The smallest region worth swiping in, either way (pixels on Android, points on iOS). */
const MIN_REGION = 48;

/** How far an element's frame may be from its dump bounds: both are rounded. */
const FRAME_TOLERANCE = 1;

const BOUNDS_RE = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;

interface Entry {
  node: HierarchyNode;
  parent?: Entry;
  bounds?: Rect;
  /** The top-level bounded element it belongs to: an Android window, or iOS's application. */
  window?: Entry;
  /** In a subtree no locator matches: a keyboard, a system bar, a non-app window. */
  nonApp: boolean;
  /** Document order: a later element is drawn over an earlier one. */
  order: number;
}

/**
 * @param target - The element's frame, when the tree reports one.
 * @param previous - The region the last swipe used. When `target` matches
 *   nothing in the dump (the element was still moving between the read of its
 *   frame and the dump), that region is kept while it is still a scrollable's
 *   region on screen, rather than falling back to the largest scrollable.
 */
export function scrollRegion(xml: string, target?: Rect, previous?: Rect): Rect | undefined {
  const entries: Entry[] = [];
  const walk = (node: HierarchyNode, parent: Entry | undefined) => {
    const b = BOUNDS_RE.exec(node.attributes.get('bounds') ?? '');
    const entry: Entry = {
      node,
      parent,
      bounds: b ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] } : undefined,
      nonApp: (parent?.nonApp ?? false) || node.attributes.get('tapsmith-non-app') === 'true',
      order: entries.length,
    };
    entries.push(entry);
    for (const child of node.children) walk(child, entry);
  };
  for (const root of parseHierarchyXml(xml)) walk(root, undefined);

  // The windows: the shallowest elements with bounds. The screen is their union.
  const bounded = entries.filter((e) => e.bounds);
  if (bounded.length === 0) return undefined;
  const topDepth = Math.min(...bounded.map((e) => e.node.depth));
  const windows = bounded.filter((e) => e.node.depth === topDepth);
  const screen = windows.map((e) => e.bounds!).reduce(union);
  for (const e of entries) {
    let w: Entry | undefined = e;
    while (w && !windows.includes(w)) w = w.parent;
    e.window = w;
  }

  // What covers the app at an edge: a keyboard, the status or navigation bar.
  const covers = entries
    .filter((e) => e.bounds && e.nonApp && !e.parent?.nonApp)
    .map((e) => e.bounds!);

  const region = (e: Entry): Rect | undefined => {
    if (!e.bounds || e.nonApp || !isScrollable(e.node)) return undefined;
    let r = intersect(e.bounds, screen);
    if (r && e.window?.bounds) r = intersect(r, e.window.bounds);
    // A scroll view clips its content, so a nested scrollable shows only
    // where its scrolling ancestors do (iOS frames are not clipped).
    for (let a = e.parent; r && a; a = a.parent) {
      if (a.bounds && !a.nonApp && isScrollable(a.node)) r = intersect(r, a.bounds);
    }
    if (!r) return undefined;
    for (const c of covers) r = trimEdge(r, c);
    return r.right - r.left >= MIN_REGION && r.bottom - r.top >= MIN_REGION ? r : undefined;
  };

  const candidates = entries.flatMap((e) => {
    const r = region(e);
    return r ? [{ e, r }] : [];
  });

  if (target) {
    const self = entries.filter((e) => !e.nonApp && e.bounds && sameFrame(e.bounds, target)).at(-1);
    for (let a = self?.parent; a; a = a.parent) {
      const r = region(a);
      if (r) return r;
    }
    if (!self && previous && candidates.some((c) => sameFrame(c.r, previous))) return previous;
  }

  if (candidates.length === 0) return undefined;

  // The topmost app window: the smallest that has a scrollable.
  const windowArea = (e: Entry) => (e.window?.bounds ? area(intersect(e.window.bounds, screen)) : Infinity);
  const top = Math.min(...candidates.map((c) => windowArea(c.e)));
  const inTop = candidates.filter((c) => windowArea(c.e) === top);
  const shown = inTop.filter((c) => !inTop.some((d) =>
    d.e.order > c.e.order && !isAncestor(c.e, d.e) && contains(d.r, centre(c.r))));
  return (shown.length ? shown : inTop).reduce((best, c) => (area(c.r) > area(best.r) ? c : best)).r;
}

function isScrollable(node: HierarchyNode): boolean {
  if (node.attributes.get('scrollable') === 'true') return true;
  return IOS_SCROLL_TYPES.has(node.attributes.get('type') ?? node.tagName);
}

function isAncestor(a: Entry, of: Entry): boolean {
  for (let p = of.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

function sameFrame(a: Rect, b: Rect): boolean {
  return Math.abs(a.left - b.left) <= FRAME_TOLERANCE && Math.abs(a.top - b.top) <= FRAME_TOLERANCE &&
    Math.abs(a.right - b.right) <= FRAME_TOLERANCE && Math.abs(a.bottom - b.bottom) <= FRAME_TOLERANCE;
}

function union(a: Rect, b: Rect): Rect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right > r.left && r.bottom > r.top ? r : undefined;
}

function area(r: Rect | undefined): number {
  return r ? (r.right - r.left) * (r.bottom - r.top) : 0;
}

function centre(r: Rect): { x: number; y: number } {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

function contains(r: Rect, p: { x: number; y: number }): boolean {
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

/**
 * `r` less `c` when `c` covers one whole edge of it (a keyboard across the
 * bottom of a list, a status bar across its top); unchanged otherwise.
 */
function trimEdge(r: Rect, c: Rect): Rect {
  if (!intersect(r, c)) return r;
  if (c.left <= r.left && c.right >= r.right) {
    if (c.top <= r.top) return { ...r, top: Math.min(r.bottom, Math.max(r.top, c.bottom)) };
    if (c.bottom >= r.bottom) return { ...r, bottom: Math.max(r.top, Math.min(r.bottom, c.top)) };
  }
  if (c.top <= r.top && c.bottom >= r.bottom) {
    if (c.left <= r.left) return { ...r, left: Math.min(r.right, Math.max(r.left, c.right)) };
    if (c.right >= r.right) return { ...r, right: Math.max(r.left, Math.min(r.right, c.left)) };
  }
  return r;
}
