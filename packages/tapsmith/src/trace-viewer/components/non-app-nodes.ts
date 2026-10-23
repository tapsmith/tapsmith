import type { HierarchyNode } from './hierarchy-utils.js';
import { HOOKS_MARKER_PREFIX } from '../../hooks-marker.js';

// ─── Nodes no locator matches (PILOT-756, PILOT-830) ───
//
// Not everything in a hierarchy dump is the app's. No user locator matches:
//
// - iOS: the application element (its label is the app's name) and anything
//   inside the software keyboard (keys, and its return and globe buttons). An
//   input accessory toolbar above the keyboard is the app's, and matches.
// - Android: the windows the agent marks `tapsmith-non-app="true"` — the
//   input method, and System UI's bars (the status and navigation bars:
//   bar-shaped System UI windows neither focused nor active; a pulled-down
//   notification shade and a heads-up notification match).
// - Both: the @tapsmith/react-native hooks marker, which exists only for
//   Tapsmith to read from the dump.
//
// The agents apply the same rule: ios-agent NonAppElements.swift and the
// Android agent's NonAppNodes.kt. This is the trace viewer's copy.

/** The iOS element type names, as the agent writes them and as traces recorded before it named them did. */
const IOS_APPLICATION_TYPES: ReadonlySet<string> = new Set(['XCUIElementTypeApplication', 'XCUIElementType(2)']);
const IOS_KEYBOARD_TYPES: ReadonlySet<string> = new Set(['XCUIElementTypeKeyboard', 'XCUIElementType(19)']);

/** The text attributes a hooks marker can carry: Android text / content-desc, iOS label / title / value. */
const MARKER_TEXT_ATTRIBUTES = ['text', 'content-desc', 'label', 'title', 'value'] as const;

function iosType(node: HierarchyNode): string | undefined {
  if (node.attributes.has('class')) return undefined;
  return node.attributes.get('type') ?? node.tagName;
}

/** Whether `text` is a @tapsmith/react-native hooks marker. */
export function isHooksMarkerText(text: string | undefined): boolean {
  return text !== undefined && text.startsWith(HOOKS_MARKER_PREFIX);
}

/** Whether the node is a hooks marker (either copy: older package versions also drew a visible one). */
export function isHooksMarkerNode(node: HierarchyNode): boolean {
  return MARKER_TEXT_ATTRIBUTES.some((key) => isHooksMarkerText(node.attributes.get(key)));
}

/**
 * Whether the node is a hooks marker or only wraps one: the screen-sized,
 * invisible carrier view the package draws the marker in. Never what a pick
 * on the screen means.
 */
export function isHooksMarkerCarrier(node: HierarchyNode): boolean {
  if (isHooksMarkerNode(node)) return true;
  if (node.children.length === 0) return false;
  if (MARKER_TEXT_ATTRIBUTES.some((key) => node.attributes.get(key))) return false;
  return node.children.every(isHooksMarkerCarrier);
}

/** Whether no locator matches this node itself (its descendants still can). */
export function isNonAppNode(node: HierarchyNode): boolean {
  const type = iosType(node);
  return (type !== undefined && IOS_APPLICATION_TYPES.has(type)) || isHooksMarkerNode(node);
}

/** Whether no locator matches this node or anything inside it. */
export function isNonAppSubtree(node: HierarchyNode): boolean {
  if (node.attributes.get('tapsmith-non-app') === 'true') return true;
  const type = iosType(node);
  return type !== undefined && IOS_KEYBOARD_TYPES.has(type);
}
