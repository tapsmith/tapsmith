import type { HierarchyNode } from './hierarchy-utils.js';
import { IOS_NAME_ONLY_TYPES, IOS_VALUE_TEXT_TYPES } from '../../ios-text-content.js';

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
//   (IOS_VALUE_TEXT_TYPES).
// - A label that starts with its nearest labelled ancestor's label and ", " is
//   read without that prefix (a SwiftUI Stepper's "Quantity: 1, Increment").
// - Innermost: a getByText match that contains another match is dropped
//   (findMatchingNodes).

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
    value: IOS_VALUE_TEXT_TYPES.has(type) ? node.attributes.get('value') ?? '' : '',
  };
}

/** Whether `query` is one of the child texts iOS joined with ", " into `label` (or the whole label). */
function containsChildText(label: string, query: string): boolean {
  const l = normalize(label);
  const q = normalize(query);
  return l === q || l.startsWith(`${q}, `) || l.endsWith(`, ${q}`) || l.includes(`, ${q}, `);
}

const TRAILING_PUNCTUATION = /[\p{P}\p{S}]+$/u;

/** Equal once trailing punctuation and symbols are dropped from both (iOS drops a "?" from a label). */
function equalIgnoringTrailingPunctuation(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  return a.replace(TRAILING_PUNCTUATION, '') === b.replace(TRAILING_PUNCTUATION, '');
}

/** getByText(string, { exact: true }) on iOS. */
export function iosTextMatchesExact(texts: IosTexts, query: string): boolean {
  const q = normalize(query);
  if ([texts.label, texts.title, texts.value].some((t) => normalize(t) === q)) return true;
  if (containsChildText(texts.label, query) || containsChildText(texts.title, query)) return true;
  return equalIgnoringTrailingPunctuation(normalize(texts.label), q);
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
