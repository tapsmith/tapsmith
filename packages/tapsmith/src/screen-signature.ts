/**
 * What a UI hierarchy dump shows on screen, as a string to compare: two dumps
 * with equal signatures show the same thing (PILOT-929).
 *
 * `scrollIntoView()` compares the screen before and after a swipe to see
 * whether the swipe moved anything. A whole dump will not do: iOS also lists
 * elements that are off the screen, and a UITableView keeps its recycled
 * cells in the tree above the screen and relabels them as it scrolls, so the
 * dump keeps changing at the end of a table. So every element whose bounds
 * lie entirely outside the screen is left out. The screen is the union of the
 * bounds of the shallowest elements that have bounds: iOS's `Application`,
 * or Android's one node per window. Elements without bounds are kept. A dump
 * where no element has bounds is compared whole.
 */

interface Rect { left: number; top: number; right: number; bottom: number }

// A tag, its attributes, and whether it closes. Tag names as both agents
// write them, including the iOS agent's `XCUIElementType(2)` for an element
// type it has no name for.
const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*(?:\(\d+\))?)((?:\s+[\w:.-]+=(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
// The bounds attribute both agents write: `[left,top][right,bottom]`. iOS
// frames above or left of the screen have negative coordinates.
const BOUNDS_RE = /\sbounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/;

export function onScreenSignature(xml: string): string {
  const elements: Array<{ depth: number; tag: string; bounds?: Rect }> = [];
  let depth = 0;
  for (const m of xml.matchAll(TAG_RE)) {
    if (m[1] === '/') {
      depth--;
      continue;
    }
    const b = BOUNDS_RE.exec(m[3]);
    elements.push({
      depth,
      tag: m[2] + m[3],
      bounds: b ? { left: +b[1], top: +b[2], right: +b[3], bottom: +b[4] } : undefined,
    });
    if (m[4] !== '/') depth++;
  }

  const bounded = elements.filter((e) => e.bounds);
  if (bounded.length === 0) return xml;
  const topDepth = Math.min(...bounded.map((e) => e.depth));
  const screen = bounded
    .filter((e) => e.depth === topDepth)
    .map((e) => e.bounds!)
    .reduce((a, b) => ({
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    }));

  return elements
    .filter((e) => !e.bounds || (
      e.bounds.right > screen.left && e.bounds.left < screen.right &&
      e.bounds.bottom > screen.top && e.bounds.top < screen.bottom
    ))
    .map((e) => `${e.depth} ${e.tag}`)
    .join('\n');
}
