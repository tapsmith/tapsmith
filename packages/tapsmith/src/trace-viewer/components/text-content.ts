import type { HierarchyNode } from './hierarchy-utils.js';
import { IOS_NAME_ONLY_TYPES, iosTextValue } from '../../ios-text-content.js';

// ─── iOS text content for getByText (PILOT-794) ───
//
// What getByText reads on an iOS node, the stand-in for Playwright's text
// content. The iOS agent's rule (ios-agent/TapsmithAgent/TextContent.swift);
// this is the offline trace playground's copy, and
// text-content-conformance.test.ts pins the two together.
//
// - A label or title is text content, except on a control whose label is only
//   its accessible name (IOS_NAME_ONLY_TYPES, ios-text-content.ts).
// - A value is text content only where it is the text on screen
//   (IOS_VALUE_TEXT_TYPES). A text input's typed value is not, as an
//   `<input>`'s value is not in Playwright; the placeholder an empty field
//   shows as its value still is (iosTextValue, PILOT-1417).
// - A label that starts with its nearest labelled ancestor's label and ", " is
//   read without that prefix (a SwiftUI Stepper's "Quantity: 1, Increment").
// - An exact match on one ", "-joined part of a label isn't one when the
//   node's table row shows that part as a static text outside the node
//   (UIKit's edit-mode Remove/Reorder controls, PILOT-1374).
// - Innermost: a getByText match that contains another match is dropped
//   (findMatchingNodes), and so is a generic wrapper that only echoes a
//   name-only descendant's label on its bounds (an RN image, PILOT-1366).

/** An iOS node's label, title and value as text content: each empty when it isn't. */
export interface IosTexts {
  label: string
  title: string
  value: string
}

/** Collapse whitespace runs (JavaScript's `\s`) to one space and trim, as the agents compare text. */
function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `label` without the ", "-joined prefix it repeats from its container's label. */
export function ownLabel(label: string, containerLabel: string): string {
  const container = normalize(containerLabel);
  if (container === '') return label;
  const normalized = normalize(label);
  const prefix = `${container}, `;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : label;
}

/** The node's text content. `containerLabel` is its nearest app ancestor's non-empty label. */
export function iosTexts(node: HierarchyNode, containerLabel: string): IosTexts {
  const type = node.attributes.get('type') ?? node.tagName;
  const nameOnly = IOS_NAME_ONLY_TYPES.has(type);
  return {
    label: nameOnly ? '' : ownLabel(node.attributes.get('label') ?? '', containerLabel),
    title: nameOnly ? '' : node.attributes.get('title') ?? '',
    value: iosTextValue(type, node.attributes.get('value') ?? '', node.attributes.get('placeholderValue') ?? ''),
  };
}

/** Whether `query` is one of the child texts iOS joined with ", " into `label` (or the whole label). */
function containsChildText(label: string, query: string): boolean {
  const l = normalize(label);
  const q = normalize(query);
  return l === q || l.startsWith(`${q}, `) || l.endsWith(`, ${q}`) || l.includes(`, ${q}, `);
}

/**
 * getByText(string, { exact: true }) on iOS: literal, like the substring form.
 * A ", "-joined part of the label or title matches, except one the node's
 * table row shows as a static text of its own (`rowShowsQuery`):
 * UIKit labels a row's edit-mode Remove and Reorder controls with the row's
 * texts joined after a verb, a name for the row, not their text.
 */
export function iosTextMatchesExact(texts: IosTexts, query: string, rowShowsQuery = false): boolean {
  const q = normalize(query);
  if ([texts.label, texts.title, texts.value].some((t) => normalize(t) === q)) return true;
  if (rowShowsQuery) return false;
  return containsChildText(texts.label, query) || containsChildText(texts.title, query);
}

/** How many static texts in the subtree at `node` (itself included) have the label `query`, whitespace-normalized. */
export function iosStaticTextCount(node: HierarchyNode, query: string): number {
  const q = normalize(query);
  const own = (node.attributes.get('type') ?? node.tagName) === 'XCUIElementTypeStaticText'
    && normalize(node.attributes.get('label') ?? '') === q ? 1 : 0;
  return node.children.reduce((n, child) => n + iosStaticTextCount(child, query), own);
}

/** getByText(string) on iOS: a case-insensitive substring of the label, title or value. */
export function iosTextMatchesSubstring(texts: IosTexts, query: string): boolean {
  const q = normalize(query).toLowerCase();
  return [texts.label, texts.title, texts.value].some((t) => normalize(t).toLowerCase().includes(q));
}

/** getByText(RegExp) on iOS: tested against the raw label, title or value. */
export function iosTextMatchesRegex(texts: IosTexts, re: RegExp): boolean {
  return [texts.label, texts.title, texts.value].some((t) => re.test(t));
}
