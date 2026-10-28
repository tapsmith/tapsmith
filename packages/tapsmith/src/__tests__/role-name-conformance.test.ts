import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { ANDROID_EDIT_TEXT_CLASSES, IOS_PLACEHOLDER_NAMED_TYPES } from '../accessible-name.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { escapeJsString } from '../js-string-escape.js';
import { translateRegex } from '../text-regex.js';

/**
 * getByRole name conformance for a text field's placeholder (PILOT-834).
 * Playwright names an input with no label by its placeholder; so do the
 * agents: an iOS text input whose label and title are empty is named by its
 * placeholderValue, an Android EditText with no content-desc and no text but
 * its typed value by its hint. A labelled field stays named by its label
 * alone — the placeholder is a fallback, not another name.
 *
 * Each case is one element and one getByRole query, with the agent's answer.
 * The TypeScript playground matcher is checked here, and the iOS agent's
 * RoleName replays the iOS cases from `fixtures/role-name-conformance.json`
 * (ios-agent/Tests/RoleNameTests). The Android rule is pinned by the agent's
 * TextMatchTest. Regenerate the fixture after changing a case with
 * `UPDATE_ROLE_NAME_FIXTURE=1 npx vitest run src/__tests__/role-name-conformance.test.ts`.
 */

interface Case {
  why: string
  platform: 'ios' | 'android'
  /** iOS element type name, or Android class name. */
  type: string
  role: string
  label?: string
  title?: string
  placeholder?: string
  contentDesc?: string
  /** Android: the node's text (an empty EditText reports its hint here). */
  text?: string
  /** A string name, or a RegExp as source + flags. */
  name: string | { source: string; flags: string }
  exact?: boolean
  matches: boolean
}

const CASES: Case[] = [
  // iOS: a SwiftUI TextField("Title", text:) has an empty label and the text as its placeholder.
  { why: 'a label-less field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Title', name: 'Title', matches: true },
  { why: 'a placeholder name is a case-insensitive substring', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Email address', name: 'email', matches: true },
  { why: 'exact compares the placeholder whole', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Title', name: 'Title', exact: true, matches: true },
  { why: 'exact is case-sensitive on the placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Title', name: 'title', exact: true, matches: false },
  { why: 'exact does not split a placeholder at ", "', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'City, State', name: 'City', exact: true, matches: false },
  { why: 'a RegExp tests the placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Title', name: { source: '^tit', flags: 'i' }, matches: true },
  { why: 'a secure field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeSecureTextField', role: 'textfield', label: '', placeholder: 'Password', name: 'Password', matches: true },
  { why: 'a search field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeSearchField', role: 'searchfield', label: '', placeholder: 'Search', name: 'Search', matches: true },
  { why: 'a whitespace-only label is no label', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: ' ', placeholder: 'Title', name: 'Title', matches: true },
  { why: 'NBSP in the placeholder is a space', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: 'Full name', name: 'Full name', exact: true, matches: true },
  { why: 'a labelled field is not named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: 'example', matches: false },
  { why: 'a labelled field is still named by its label', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: 'Email', matches: true },
  { why: 'a RegExp does not test a labelled field\'s placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: { source: 'example', flags: '' }, matches: false },
  { why: 'a titled field is not named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', title: 'Email', placeholder: 'Your email', name: 'Your', matches: false },
  { why: 'no label, title or placeholder, no name', platform: 'ios', type: 'XCUIElementTypeTextField', role: 'textfield', label: '', placeholder: '', name: 'Title', matches: false },
  { why: 'a button is not named by a placeholder', platform: 'ios', type: 'XCUIElementTypeButton', role: 'button', label: '', placeholder: 'Go', name: 'Go', matches: false },

  // Android: an empty EditText reports its hint as its text; a typed one keeps the hint as its name.
  { why: 'an empty EditText is named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'Email', placeholder: 'Email', name: 'Email', matches: true },
  { why: 'a typed EditText is still named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'sam@example.com', placeholder: 'Email', name: 'Email', matches: true },
  { why: 'a typed EditText\'s hint is a case-insensitive substring', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'x', placeholder: 'Email address', name: 'email', matches: true },
  { why: 'a RegExp tests a typed EditText\'s hint', platform: 'android', type: 'com.google.android.material.textfield.TextInputEditText', role: 'textfield', text: 'x', placeholder: 'Email', name: { source: '^e', flags: 'i' }, matches: true },
  { why: 'a described EditText is not named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: 'Email', text: 'x', placeholder: 'Phone', name: 'Phone', matches: false },
  { why: 'a typed value is still not a substring name', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'email me later', placeholder: 'Notes', name: 'email', matches: false },
];

/** The case's element as a hierarchy node, the way each agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  const attrs: Record<string, string> = c.platform === 'ios'
    ? { type: c.type, label: c.label ?? '', identifier: '', value: '', placeholderValue: c.placeholder ?? '' }
    : { class: c.type, text: c.text ?? '', 'resource-id': '', hint: c.placeholder ?? '' };
  if (c.title !== undefined) attrs.title = c.title;
  if (c.contentDesc !== undefined) attrs['content-desc'] = c.contentDesc;
  return { tagName: c.platform === 'ios' ? c.type : 'node', attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
}

function codeFor(c: Case): string {
  const name = typeof c.name === 'string' ? `"${escapeJsString(c.name)}"` : `/${c.name.source}/${c.name.flags}`;
  return `device.getByRole("${c.role}", { name: ${name}${c.exact ? ', exact: true' : ''} })`;
}

const FIXTURE = fileURLToPath(new URL('./fixtures/role-name-conformance.json', import.meta.url));

function buildFixture() {
  return {
    comment:
      'Generated by packages/tapsmith/src/__tests__/role-name-conformance.test.ts (PILOT-834). One element and one ' +
      'getByRole name per case, with the agent\'s answer; a RegExp name carries the SDK translation the agents compile. ' +
      'Replayed by the TypeScript playground matcher and the iOS agent\'s RoleNameTests.',
    cases: CASES.map((c) => ({
      ...c,
      name: typeof c.name === 'string' ? c.name : { ...c.name, ...translateRegex(c.name.source, c.name.flags) },
    })),
  };
}

describe('getByRole name falls back to the placeholder (PILOT-834)', () => {
  it.each(CASES)('$platform $why → $matches', (c) => {
    const parsed = parseSelectorString(codeFor(c));
    expect(parsed).not.toBeNull();
    expect(findMatchingNodes([nodeFor(c)], parsed!).length).toBe(c.matches ? 1 : 0);
  });

  it('the agents\' fixture is the current table', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_ROLE_NAME_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('Android: the hint-named classes are EDIT_TEXT_HINT_CLASS_PATTERN', () => {
    const source = readFileSync(path.join(repoRoot, 'agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt'), 'utf8');
    const from = source.indexOf('val EDIT_TEXT_HINT_CLASS_PATTERN');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = source.slice(source.indexOf('listOf(', from), source.indexOf(').joinToString', from));
    const classes = [...block.matchAll(/"([\w.]+)"/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);
    expect([...classes].sort()).toEqual([...ANDROID_EDIT_TEXT_CLASSES].sort());
  });

  it('iOS: the placeholder-named types are RoleName.placeholderNamedTypes', () => {
    const source = readFileSync(path.join(repoRoot, 'ios-agent/TapsmithAgent/RoleName.swift'), 'utf8');
    const from = source.indexOf('static let placeholderNamedTypes');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = source.slice(source.indexOf('[', from), source.indexOf(']', from));
    const types = [...block.matchAll(/\.(\w+)/g)]
      .map((m) => `XCUIElementType${m[1][0].toUpperCase()}${m[1].slice(1)}`);
    expect(types.length).toBeGreaterThan(0);
    expect([...types].sort()).toEqual([...IOS_PLACEHOLDER_NAMED_TYPES].sort());
  });
});
