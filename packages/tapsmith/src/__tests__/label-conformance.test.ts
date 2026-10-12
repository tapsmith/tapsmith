import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { escapeJsString } from '../js-string-escape.js';
import { translateRegex } from '../text-regex.js';

/**
 * getByLabel conformance (PILOT-666). The locator playground and the MCP
 * snapshot validate suggestions with a TypeScript copy of the agents' matching
 * rules, so a difference between the two shows a count, or suggests a
 * locator, that the device does not agree with. Each case below is one
 * element and one getByLabel query, with the agent's answer. The TypeScript
 * matcher is checked against them here, and the iOS agent's LabelMatch
 * replays the same cases from `fixtures/label-conformance.json`
 * (ios-agent/Tests/LabelMatchTests). Regenerate the fixture after changing a
 * case with `UPDATE_LABEL_FIXTURE=1 npx vitest run src/__tests__/label-conformance.test.ts`.
 *
 * The Android agent's rule (an input class, named by its content-desc) is
 * replayed here only; its class list is pinned to the agent by roles.test.ts.
 */

interface Case {
  why: string
  platform: 'ios' | 'android'
  /** iOS element type name, or Android class name. */
  type: string
  label?: string
  title?: string
  contentDesc?: string
  /** A string query, or a RegExp as source + flags. */
  query: string | { source: string; flags: string }
  matches: boolean
}

const NBSP = ' ';

const CASES: Case[] = [
  // iOS: the input types getByLabel finds, by element type.
  { why: 'text field', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email', query: 'Email', matches: true },
  { why: 'secure text field', platform: 'ios', type: 'XCUIElementTypeSecureTextField', label: 'Password', query: 'Password', matches: true },
  { why: 'multi-line text view', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes', query: 'Notes', matches: true },
  { why: 'switch', platform: 'ios', type: 'XCUIElementTypeSwitch', label: 'Dark Mode', query: 'Dark Mode', matches: true },
  { why: 'slider', platform: 'ios', type: 'XCUIElementTypeSlider', label: 'Volume', query: 'Volume', matches: true },
  { why: 'stepper', platform: 'ios', type: 'XCUIElementTypeStepper', label: 'Quantity', query: 'Quantity', matches: true },
  { why: 'picker', platform: 'ios', type: 'XCUIElementTypePicker', label: 'Country', query: 'Country', matches: true },
  { why: 'check box', platform: 'ios', type: 'XCUIElementTypeCheckBox', label: 'Remember me', query: 'Remember me', matches: true },
  { why: 'radio button', platform: 'ios', type: 'XCUIElementTypeRadioButton', label: 'Express', query: 'Express', matches: true },
  { why: 'a search field is not a getByLabel input', platform: 'ios', type: 'XCUIElementTypeSearchField', label: 'Search', query: 'Search', matches: false },
  { why: 'a button is not an input', platform: 'ios', type: 'XCUIElementTypeButton', label: 'Email', query: 'Email', matches: false },
  { why: 'static text is not an input', platform: 'ios', type: 'XCUIElementTypeStaticText', label: 'Email', query: 'Email', matches: false },
  { why: 'a generic view is not an input', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Email', query: 'Email', matches: false },
  // iOS: the name is the label or the title, compared whole and whitespace-normalized.
  { why: 'the title names the input too', platform: 'ios', type: 'XCUIElementTypeTextField', label: '', title: 'Email', query: 'Email', matches: true },
  { why: 'NBSP in the label is a space', platform: 'ios', type: 'XCUIElementTypeTextField', label: `Full${NBSP}name`, query: 'Full name', matches: true },
  { why: 'padding in the query is ignored', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Full name', query: ' Full  name ', matches: true },
  { why: 'a line break in the label is a space', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Delivery\nnotes', query: 'Delivery notes', matches: true },
  { why: 'a string is compared whole', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email address', query: 'Email', matches: false },
  { why: 'a string is case-sensitive', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email', query: 'email', matches: false },
  { why: 'no label, no match', platform: 'ios', type: 'XCUIElementTypeTextField', label: '', query: 'Email', matches: false },
  // iOS: a RegExp tests the raw label or title.
  { why: 'RegExp with the i flag', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'E-mail', query: { source: '^e-?mail$', flags: 'i' }, matches: true },
  { why: 'RegExp \\s covers NBSP', platform: 'ios', type: 'XCUIElementTypeTextField', label: `Full${NBSP}name`, query: { source: 'Full\\sname', flags: '' }, matches: true },
  { why: 'RegExp anchors see the raw line break', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Delivery\nnotes', query: { source: '^Delivery notes$', flags: '' }, matches: false },
  { why: 'RegExp m flag anchors each line', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Delivery\nnotes', query: { source: '^notes$', flags: 'm' }, matches: true },
  { why: 'RegExp tests the title', platform: 'ios', type: 'XCUIElementTypeSwitch', label: '', title: 'Dark Mode', query: { source: 'dark', flags: 'i' }, matches: true },
  { why: 'RegExp on a search field', platform: 'ios', type: 'XCUIElementTypeSearchField', label: 'Search', query: { source: 'Search', flags: '' }, matches: false },
  { why: 'RegExp on a button', platform: 'ios', type: 'XCUIElementTypeButton', label: 'Save', query: { source: 'Save', flags: '' }, matches: false },
  { why: 'RegExp substring', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Your email', query: { source: 'email', flags: '' }, matches: true },
  { why: 'RegExp not found', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Your email', query: { source: 'phone', flags: '' }, matches: false },

  // Android: the classes of the agent's label roles, named by content-desc.
  { why: 'EditText', platform: 'android', type: 'android.widget.EditText', contentDesc: 'Email', query: 'Email', matches: true },
  { why: 'Material text input', platform: 'android', type: 'com.google.android.material.textfield.TextInputEditText', contentDesc: 'Email', query: 'Email', matches: true },
  { why: 'CheckBox', platform: 'android', type: 'android.widget.CheckBox', contentDesc: 'Remember me', query: 'Remember me', matches: true },
  { why: 'Switch', platform: 'android', type: 'android.widget.Switch', contentDesc: 'Dark Mode', query: 'Dark Mode', matches: true },
  { why: 'RadioButton', platform: 'android', type: 'android.widget.RadioButton', contentDesc: 'Express', query: 'Express', matches: true },
  { why: 'SeekBar', platform: 'android', type: 'android.widget.SeekBar', contentDesc: 'Volume', query: 'Volume', matches: true },
  { why: 'Spinner', platform: 'android', type: 'android.widget.Spinner', contentDesc: 'Country', query: 'Country', matches: true },
  { why: 'a SearchView is not a getByLabel input', platform: 'android', type: 'android.widget.SearchView', contentDesc: 'Search', query: 'Search', matches: false },
  { why: 'a Button is not an input', platform: 'android', type: 'android.widget.Button', contentDesc: 'Email', query: 'Email', matches: false },
  { why: 'a ViewGroup is not an input', platform: 'android', type: 'android.view.ViewGroup', contentDesc: 'Email', query: 'Email', matches: false },
  { why: 'NBSP in the content-desc is a space', platform: 'android', type: 'android.widget.EditText', contentDesc: `Full${NBSP}name`, query: 'Full name', matches: true },
  { why: 'a string is compared whole', platform: 'android', type: 'android.widget.EditText', contentDesc: 'Email address', query: 'Email', matches: false },
  { why: 'no content-desc, no match', platform: 'android', type: 'android.widget.EditText', query: 'Email', matches: false },
  { why: 'RegExp tests the raw content-desc', platform: 'android', type: 'android.widget.EditText', contentDesc: 'E-mail', query: { source: '^e-?mail$', flags: 'i' }, matches: true },
  { why: 'RegExp on a Button', platform: 'android', type: 'android.widget.Button', contentDesc: 'Save', query: { source: 'Save', flags: '' }, matches: false },
];

/** The case's element as a hierarchy node, the way each agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  const attrs: Record<string, string> = c.platform === 'ios'
    ? { type: c.type, label: c.label ?? '', identifier: '', value: '' }
    : { class: c.type, text: '', 'resource-id': '' };
  if (c.title !== undefined) attrs.title = c.title;
  if (c.contentDesc !== undefined) attrs['content-desc'] = c.contentDesc;
  return { tagName: c.platform === 'ios' ? c.type : 'node', attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
}

function codeFor(c: Case): string {
  if (typeof c.query === 'string') return `device.getByLabel("${escapeJsString(c.query)}")`;
  return `device.getByLabel(/${c.query.source}/${c.query.flags})`;
}

const FIXTURE = fileURLToPath(new URL('./fixtures/label-conformance.json', import.meta.url));

function buildFixture() {
  return {
    comment:
      'Generated by packages/tapsmith/src/__tests__/label-conformance.test.ts (PILOT-666). One element and one getByLabel ' +
      'query per case, with the agent\'s answer; a RegExp query carries the SDK translation the agents compile. Replayed ' +
      'by the TypeScript playground matcher and the iOS agent\'s LabelMatchTests.',
    cases: CASES.map((c) => ({
      ...c,
      query: typeof c.query === 'string' ? c.query : { ...c.query, ...translateRegex(c.query.source, c.query.flags) },
    })),
  };
}

describe('getByLabel conformance (PILOT-666)', () => {
  it.each(CASES)('$platform $why → $matches', (c) => {
    const parsed = parseSelectorString(codeFor(c));
    expect(parsed).not.toBeNull();
    expect(findMatchingNodes([nodeFor(c)], parsed!).length).toBe(c.matches ? 1 : 0);
  });

  it('the agents\' fixture is the current table', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_LABEL_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });
});
