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
  return pickScrollRegion(xml, target, previous).region;
}

/** Which scrollable a swipe runs in, and why that one. */
export interface ScrollRegionPick {
  region?: Rect;
  /**
   * `'holds'` when the region is the nearest scrollable holding `target`,
   * `'ancestor'` when it is a farther one (the nearest is too small or off
   * screen),
   * `'previous'` when `previous` was kept because `target` matched nothing,
   * and `'largest'` when it is the largest scrollable on screen, which may
   * not hold the element at all.
   */
  source?: 'holds' | 'ancestor' | 'previous' | 'largest';
}

/** {@link scrollRegion}, saying also how the region was chosen. */
export function pickScrollRegion(xml: string, target?: Rect, previous?: Rect): ScrollRegionPick {
  const scan = scanScrollables(xml);
  if (!scan) return {};
  const { entries, screen, region, candidates } = scan;

  if (target) {
    const self = entries.filter((e) => !e.nonApp && e.bounds && sameFrame(e.bounds, target)).at(-1);
    // The nearest scrollable around the element holds it; a farther one
    // used because the nearest is too small or off screen only contains it,
    // and may not scroll the way the element lies.
    let nearest = true;
    for (let a = self?.parent; a; a = a.parent) {
      const r = region(a);
      if (r) return { region: r, source: nearest ? 'holds' : 'ancestor' };
      if (isScrollable(a.node) && !a.nonApp) nearest = false;
    }
    if (!self && previous && candidates.some((c) => sameFrame(c.r, previous))) {
      return { region: previous, source: 'previous' };
    }
  }

  if (candidates.length === 0) return {};

  // The topmost app window: the smallest that has a scrollable.
  const windowArea = (e: Entry) => (e.window?.bounds ? area(intersect(e.window.bounds, screen)) : Infinity);
  const top = Math.min(...candidates.map((c) => windowArea(c.e)));
  const inTop = candidates.filter((c) => windowArea(c.e) === top);
  const shown = inTop.filter((c) => !inTop.some((d) =>
    d.e.order > c.e.order && !isAncestor(c.e, d.e) && contains(d.r, centre(c.r))));
  const largest = (shown.length ? shown : inTop).reduce((best, c) => (area(c.r) > area(best.r) ? c : best)).r;
  return { region: largest, source: 'largest' };
}

/**
 * The part of the scroll container holding `target` where its content shows,
 * and the axes that container scrolls along: its region less a bar drawn over
 * one of its edges — a tab bar, toolbar or header the app lays over the list,
 * that content scrolls under. `undefined` when `target` matches nothing in the
 * dump or no scrollable holds it.
 *
 * The container is the nearest scrollable around the element that can bring
 * it in: one the element lies inside, or one it reaches past along an axis
 * that scrollable scrolls on. A nearer one too small to swipe in, or reached
 * past only along an axis it does not scroll on (a carousel row below the
 * list that holds it), gives way to the next one out. So a slow sideways drag
 * never runs in a list that scrolls only up and down, where it is the edge
 * swipe that pops the screen.
 *
 * A bar is an app element drawn over the container, outside it, that lies
 * across its top or bottom edge: at least half its width, at most a third of
 * its height, and with something named in it (a label, an id, text). That
 * leaves out what is drawn over the whole screen without hiding anything: a
 * React Native wrapper view, an empty toolbar host, a pointer-events-none
 * marker. Drawn over it means after it in the tree, or a UIKit bar in the
 * same screen (a navigation bar a table scrolls under is listed first); not
 * the bars of a screen a sheet is presented over.
 */
export function visibleRegionOf(xml: string, target: Rect): VisibleRegion | undefined {
  const scan = scanScrollables(xml);
  if (!scan) return undefined;
  const { entries, region } = scan;
  const self = entries.filter((e) => !e.nonApp && e.bounds && sameFrame(e.bounds, target)).at(-1);
  if (!self) return undefined;
  for (let a = self.parent; a; a = a.parent) {
    if (!isScrollable(a.node) || a.nonApp) continue;
    const container = region(a);
    if (!container) continue;
    // Judged without the element itself: one sticking out past the side of
    // a list that scrolls up and down does not make it scroll sideways.
    const horizontal = scrollsAlong(a, entries, 'horizontal', { except: self });
    const view: VisibleRegion = {
      region: trimBars(a, container, self, entries),
      horizontal,
      // An iOS scroll view, table or collection view scrolls up and down
      // unless what is in it shows it scrolls only sideways (a carousel): it
      // lists only what shows, so the row reaching past its edge may be the
      // only one, and content that ends behind a tab bar the list runs under
      // reaches past nothing. A sideways nudge still needs content past a side.
      vertical: scrollsAlong(a, entries, 'vertical', { except: self }) || (a.node.attributes.get('scrollable') !== 'true' && !horizontal),
    };
    if (outsideRegion(target, view.region, view) || !outsideRegion(target, view.region)) return view;
  }
  return undefined;
}

/** `container`, the region of the scrollable `list`, less the bars drawn over its top or bottom edge. */
function trimBars(list: Entry, container: Rect, self: Entry, entries: readonly Entry[]): Rect {
  const height = container.bottom - container.top;
  const width = container.right - container.left;
  const middle = container.top + height / 2;
  const bars = entries.filter((c) => {
    const b = c.bounds;
    if (!b || c.nonApp || isAncestor(list, c) || isAncestor(c, list) || isAncestor(c, self)) return false;
    // Another window (an Android activity's bottom navigation under a
    // dialog's list) is drawn under the list or beside it, whatever the order.
    if (c.window !== list.window) return false;
    if (c.order <= list.order && !sameScreenUIKitBar(c, list)) return false;
    return b.bottom - b.top <= height / 3 && named(c, entries);
  });
  // Trimmed until nothing more trims it: a bar stacked on another (a mini
  // player above a tab bar) reaches the edge only once the outer one is taken
  // off, whichever the tree lists first. Each pass that goes on trims at
  // least one bar off for good, so there are at most as many as bars.
  let r = container;
  for (let pass = 0; pass <= bars.length; pass++) {
    const before = r;
    for (const c of bars) {
      const b = c.bounds!;
      const across = intersect(b, r);
      if (!across || across.right - across.left < width / 2) continue;
      const h = b.bottom - b.top;
      if (b.top > middle && b.bottom >= r.bottom - h) {
        if (b.top - r.top >= MIN_REGION && b.top < r.bottom) r = { ...r, bottom: b.top };
      } else if (b.bottom < middle && b.top <= r.top + h) {
        if (r.bottom - b.bottom >= MIN_REGION && b.bottom > r.top) r = { ...r, top: b.bottom };
      }
    }
    if (r === before) break;
  }
  return r;
}

/**
 * Whether `c` is a UIKit bar drawn over the content of its own container,
 * which holds `list`: XCUITest lists a navigation bar before the table that
 * scrolls under it. Not one whose container is the window or the
 * application, which hold everything, including a sheet presented over the
 * bar's screen (the agent's occlusion check draws the same line).
 */
function sameScreenUIKitBar(c: Entry, list: Entry): boolean {
  if (!IOS_BAR_TYPES.has(c.node.attributes.get('type') ?? c.node.tagName)) return false;
  const container = c.parent;
  const type = container?.node.attributes.get('type') ?? container?.node.tagName;
  if (!container || type === 'XCUIElementTypeWindow' || type === 'XCUIElementTypeApplication') return false;
  return isAncestor(container, list);
}

/** {@link visibleRegionOf}'s answer: the region, and the axes its scrollable has content to scroll along. */
export interface VisibleRegion {
  region: Rect;
  vertical: boolean;
  horizontal: boolean;
}

/** UIKit bars, drawn over the content of their container whatever their place in the tree. */
const IOS_BAR_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeNavigationBar',
  'XCUIElementTypeTabBar',
  'XCUIElementTypeToolbar',
]);

/** Attributes that name an element, on either platform. */
const NAME_ATTRIBUTES = ['label', 'identifier', 'text', 'content-desc', 'resource-id'] as const;

/** Whether `e` or something in it is named: an element worth drawing, not an empty wrapper. */
function named(e: Entry, entries: readonly Entry[]): boolean {
  const has = (x: Entry) => NAME_ATTRIBUTES.some((a) => (x.node.attributes.get(a) ?? '') !== '');
  if (e.node.attributes.get('tapsmith-empty-bar-host') === 'true') return false;
  return has(e) || entries.some((d) => !d.nonApp && isAncestor(e, d) && has(d));
}

/**
 * The way to scroll to bring `frame` inside `region`, when it reaches past
 * one of its edges: `"down"` for one below it, `"up"` above,
 * then `"right"` and `"left"` likewise. `undefined` when it is inside, or
 * reaches past both edges of an axis (it cannot fit any better), and only
 * along the `axes` its container scrolls on. iOS frames
 * are not clipped, so an element below its list, behind a tab bar, reaches
 * past the list's bottom edge; Android clips them to the list.
 */
export function outsideRegion(
  frame: Rect,
  region: Rect,
  axes: { vertical: boolean; horizontal: boolean } = { vertical: true, horizontal: true },
): 'up' | 'down' | 'left' | 'right' | undefined {
  const past = (start: number, end: number, regionStart: number, regionEnd: number, back: 'up' | 'left', on: 'down' | 'right') => {
    const before = start < regionStart - EDGE_SLACK;
    const after = end > regionEnd + EDGE_SLACK;
    return before === after ? undefined : before ? back : on;
  };
  return (axes.vertical ? past(frame.top, frame.bottom, region.top, region.bottom, 'up', 'down') : undefined) ??
    (axes.horizontal ? past(frame.left, frame.right, region.left, region.right, 'left', 'right') : undefined);
}

/** How far past a region's edge a frame may reach and still count as inside it: rounding, and an iOS bounce settling. */
const EDGE_SLACK = 4;

interface ScrollScan {
  entries: Entry[];
  /** The union of the windows. */
  screen: Rect;
  /** An element's scroll region, if it is a scrollable worth swiping in. */
  region: (e: Entry) => Rect | undefined;
  /** Every scrollable worth swiping in, with its region. */
  candidates: Array<{ e: Entry; r: Rect }>;
}

/** The dump's elements and its scrollables; `undefined` when nothing in it has bounds. */
function scanScrollables(xml: string): ScrollScan | undefined {
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

  return { entries, screen, region, candidates };
}

/**
 * Whether a swipe along `axis` in the scrollable at `region` had content to
 * scroll, so that the swipe moving nothing means the content is at its end.
 * Only the scrollable the swipe ran in counts (a chip bar or carousel beside
 * a list still loading has nothing to do with it), and not when it is seen
 * to lie across the swipe: a horizontal list cannot move up and down.
 *
 * - Android marks a view `scrollable` only while its content overflows it.
 *   It counts unless its class (a `HorizontalScrollView`, a pager, a
 *   `ScrollView`) or the way its children lie (spread over more columns than
 *   rows, or the other way) says it scrolls the other way.
 * - An iOS scroll view, table or collection view is one by type, so it
 *   counts only when something in it reaches past its frame along the axis
 *   (iOS frames are not clipped): an empty table, a scroll view holding just
 *   a spinner, or a carousel swiped up and down does not.
 *
 * `false` when nothing on screen scrolls, or no scrollable is at `region`:
 * a screen still loading its content, or one with nothing to scroll at all.
 * Without a `region` (the swipe crossed the screen), `false`.
 */
export function hasScrollableContent(xml: string, region: Rect | undefined, axis: 'vertical' | 'horizontal'): boolean {
  if (!region) return false;
  const scan = scanScrollables(xml);
  if (!scan) return false;
  // The region a swipe ran in is one of these scrollables' regions, as
  // computed here or (an Android step's) by the agent, which may round or
  // trim an edge differently: then the one under its centre.
  let swiped = scan.candidates.filter(({ r }) => sameFrame(r, region));
  if (swiped.length === 0) swiped = scan.candidates.filter(({ r }) => contains(r, centre(region)));
  return swiped.some(({ e }) => scrollsAlong(e, scan.entries, axis));
}

/**
 * Whether the scrollable `e` has content to scroll along `axis`, as
 * {@link hasScrollableContent} judges it. With `own`, only its own content
 * counts: not `own.except` (the element being judged) and what is in it, nor
 * what is inside a scrollable nested in `e` (a carousel's cards past the side
 * of the list that holds it scroll with the carousel, not the list).
 */
function scrollsAlong(e: Entry, entries: readonly Entry[], axis: 'vertical' | 'horizontal', own?: { except: Entry }): boolean {
  if (e.node.attributes.get('scrollable') === 'true') {
    const along = layoutAxis(e, entries);
    return along === undefined || along === axis;
  }
  const f = e.bounds;
  if (!f) return false;
  const nested = (d: Entry): boolean => {
    for (let p = d.parent; p && p !== e; p = p.parent) if (isScrollable(p.node) && !p.nonApp) return true;
    return false;
  };
  return entries.some((d) => {
    if (d.nonApp || !d.bounds || !isAncestor(e, d)) return false;
    if (own && (d === own.except || isAncestor(own.except, d) || nested(d))) return false;
    const b = d.bounds;
    return axis === 'vertical'
      ? b.top < f.top - FRAME_TOLERANCE || b.bottom > f.bottom + FRAME_TOLERANCE
      : b.left < f.left - FRAME_TOLERANCE || b.right > f.right + FRAME_TOLERANCE;
  });
}

/** Android scroll views whose class says which way they scroll. */
const ANDROID_HORIZONTAL_CLASSES: ReadonlySet<string> = new Set([
  'android.widget.HorizontalScrollView',
  'androidx.viewpager.widget.ViewPager',
  'android.support.v4.view.ViewPager',
]);
const ANDROID_VERTICAL_CLASSES: ReadonlySet<string> = new Set([
  'android.widget.ScrollView',
  'androidx.core.widget.NestedScrollView',
  'android.widget.ListView',
  'android.widget.ExpandableListView',
  'android.widget.GridView',
]);

/**
 * The axis an Android scrollable lays its content along, when its class or
 * its children say: children spread over more distinct tops than lefts (a
 * list, a grid, a chat's bubbles at both edges) lie vertically, over more
 * lefts than tops (a chip bar) horizontally. `undefined` when it cannot be
 * told (one child, as many rows as columns).
 */
function layoutAxis(e: Entry, entries: readonly Entry[]): 'vertical' | 'horizontal' | undefined {
  const cls = e.node.attributes.get('class') ?? '';
  if (ANDROID_HORIZONTAL_CLASSES.has(cls)) return 'horizontal';
  if (ANDROID_VERTICAL_CLASSES.has(cls)) return 'vertical';
  // A ViewPager2 scrolls through the RecyclerView inside it.
  if (e.parent?.node.attributes.get('class') === 'androidx.viewpager2.widget.ViewPager2') return 'horizontal';
  const kids = entries.filter((c) => c.parent === e && c.bounds && c.bounds.right > c.bounds.left && c.bounds.bottom > c.bounds.top);
  const tops = distinct(kids.map((c) => c.bounds!.top));
  const lefts = distinct(kids.map((c) => c.bounds!.left));
  if (tops > lefts) return 'vertical';
  if (lefts > tops) return 'horizontal';
  return undefined;
}

/** How many different values, counting those within rounding of each other as one. */
function distinct(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  let n = 0;
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] - sorted[i - 1] > FRAME_TOLERANCE) n++;
  return n;
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
