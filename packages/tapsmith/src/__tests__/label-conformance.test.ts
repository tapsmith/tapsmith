import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { ANDROID_LABEL_FIELD_ROLES, IOS_LABEL_FIELD_TYPES } from '../trace-viewer/components/hierarchy-utils.js';
import { IOS_DESCRIBED_CHOICE_ROLES } from '../roles.js';
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
 * The Android agent's ElementFinder replays the Android cases (agent
 * LocatorConformanceTest). It also follows a labelling view (labeledBy),
 * which the dump does not carry, so no case here uses one. The field lists
 * themselves are pinned to both agents' sources below; the Android classes of
 * each role, by roles.test.ts.
 */

interface Case {
  why: string
  platform: 'ios' | 'android'
  /** iOS element type name, or Android class name. */
  type: string
  label?: string
  title?: string
  contentDesc?: string
  /** iOS: the accessibility value, where React Native describes a generic view's role ("checkbox, unchecked"). */
  value?: string
  /** Android: the text of the node's children, each a TextView. */
  childTexts?: string[]
  /** Android: the name a nameless control takes from its row (`tapsmith-name`, the agent's RowName.name). */
  rowName?: string
  /**
   * The row's title (`tapsmith-label`, the agent's RowName): on Android the
   * label of a control named by its row, on iOS the title of the settings
   * row whose texts UIKit joins into the control's label.
   */
  rowLabel?: string
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
  // A toggle is a switch (the switch role's other type), as every Android switch class is a getByLabel input (PILOT-697).
  { why: 'toggle', platform: 'ios', type: 'XCUIElementTypeToggle', label: 'Wi-Fi', query: 'Wi-Fi', matches: true },
  { why: 'RegExp on a toggle', platform: 'ios', type: 'XCUIElementTypeToggle', label: 'Wi-Fi', query: { source: '^wi-?fi$', flags: 'i' }, matches: true },
  { why: 'slider', platform: 'ios', type: 'XCUIElementTypeSlider', label: 'Volume', query: 'Volume', matches: true },
  { why: 'stepper', platform: 'ios', type: 'XCUIElementTypeStepper', label: 'Quantity', query: 'Quantity', matches: true },
  { why: 'picker', platform: 'ios', type: 'XCUIElementTypePicker', label: 'Country', query: 'Country', matches: true },
  { why: 'check box', platform: 'ios', type: 'XCUIElementTypeCheckBox', label: 'Remember me', query: 'Remember me', matches: true },
  { why: 'radio button', platform: 'ios', type: 'XCUIElementTypeRadioButton', label: 'Express', query: 'Express', matches: true },
  { why: 'a search field is not a getByLabel input', platform: 'ios', type: 'XCUIElementTypeSearchField', label: 'Search', query: 'Search', matches: false },
  { why: 'a button is not an input', platform: 'ios', type: 'XCUIElementTypeButton', label: 'Email', query: 'Email', matches: false },
  { why: 'static text is not an input', platform: 'ios', type: 'XCUIElementTypeStaticText', label: 'Email', query: 'Email', matches: false },
  { why: 'a generic view is not an input', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Email', query: 'Email', matches: false },
  // iOS: React Native's checkbox and radio are generic views it describes in their value ("checkbox, unchecked"),
  // inputs as Android's CheckBox and RadioButton classes are.
  { why: 'React Native checkbox', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Toggle Buy oat milk', value: 'checkbox, unchecked', query: 'Toggle Buy oat milk', matches: true },
  { why: 'React Native checked checkbox', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Toggle Buy oat milk', value: 'checkbox, checked', query: 'Toggle Buy oat milk', matches: true },
  { why: 'React Native radio button', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Small', value: 'radio button, unchecked', query: 'Small', matches: true },
  { why: 'RegExp on a React Native checkbox', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Toggle Buy oat milk', value: 'checkbox, unchecked', query: { source: 'oat milk$', flags: '' }, matches: true },
  { why: 'a React Native checkbox is compared whole', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Toggle Buy oat milk', value: 'checkbox, unchecked', query: 'Buy oat milk', matches: false },
  { why: 'a React Native combo box is not an input', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Country', value: 'combo box', query: 'Country', matches: false },
  { why: 'a React Native alert is not an input', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Saved', value: 'alert', query: 'Saved', matches: false },
  { why: 'only the value\'s lead part describes the role', platform: 'ios', type: 'XCUIElementTypeOther', label: 'Plan', value: 'Basic, checkbox', query: 'Plan', matches: false },
  { why: 'a button described as a checkbox is still a button', platform: 'ios', type: 'XCUIElementTypeButton', label: 'Remember me', value: 'checkbox, unchecked', query: 'Remember me', matches: false },
  // iOS: React Native appends an empty multi-line input's placeholder to its label ("Notes Notes" while empty).
  { why: 'an empty React Native multi-line input whose placeholder repeats its label', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Multiline input Multiline input', query: 'Multiline input', matches: true },
  { why: 'one word, repeated', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes Notes', query: 'Notes', matches: true },
  { why: 'the repeated label whole still names it', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes Notes', query: 'Notes Notes', matches: true },
  { why: 'RegExp tests the label without its repeat', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes Notes', query: { source: '^notes$', flags: 'i' }, matches: true },
  { why: 'another placeholder is not stripped', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes Add a note', query: 'Notes', matches: false },
  { why: 'a single-line field is never repeated', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Notes Notes', query: 'Notes', matches: false },
  { why: 'an odd repeat is no repeat', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Notes Notes Notes', query: 'Notes', matches: false },
  // iOS: the name is the label or the title, compared whole and whitespace-normalized.
  { why: 'the title names the input too', platform: 'ios', type: 'XCUIElementTypeTextField', label: '', title: 'Email', query: 'Email', matches: true },
  { why: 'NBSP in the label is a space', platform: 'ios', type: 'XCUIElementTypeTextField', label: `Full${NBSP}name`, query: 'Full name', matches: true },
  { why: 'padding in the query is ignored', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Full name', query: ' Full  name ', matches: true },
  { why: 'a line break in the label is a space', platform: 'ios', type: 'XCUIElementTypeTextView', label: 'Delivery\nnotes', query: 'Delivery notes', matches: true },
  { why: 'a string is compared whole', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email address', query: 'Email', matches: false },
  { why: 'a string is case-sensitive', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email', query: 'email', matches: false },
  { why: 'no label, no match', platform: 'ios', type: 'XCUIElementTypeTextField', label: '', query: 'Email', matches: false },
  { why: 'an empty query is no label criterion, so it matches nothing', platform: 'ios', type: 'XCUIElementTypeTextField', label: '', query: '', matches: false },
  { why: 'a whitespace query equals an empty name', platform: 'ios', type: 'XCUIElementTypeTextField', label: 'Email', query: ' ', matches: true },
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
  // A UIKit settings row's switch, which UIKit labels with the row's texts joined by ", ", is labelled by the row's title too.
  { why: "a settings row's title labels its switch", platform: 'ios', type: 'XCUIElementTypeSwitch', label: 'Wi-Fi, Join known networks', rowLabel: 'Wi-Fi', query: 'Wi-Fi', matches: true },
  { why: "a settings row switch's whole label still labels it", platform: 'ios', type: 'XCUIElementTypeSwitch', label: 'Wi-Fi, Join known networks', rowLabel: 'Wi-Fi', query: 'Wi-Fi, Join known networks', matches: true },
  { why: "a settings row's subtitle is no label", platform: 'ios', type: 'XCUIElementTypeSwitch', label: 'Wi-Fi, Join known networks', rowLabel: 'Wi-Fi', query: 'Join known networks', matches: false },
  { why: "RegExp tests a settings row's title", platform: 'ios', type: 'XCUIElementTypeSwitch', label: 'Personal Hotspot, Off', rowLabel: 'Personal Hotspot', query: { source: '^personal hotspot$', flags: 'i' }, matches: true },

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
  { why: 'an empty query matches nothing', platform: 'android', type: 'android.widget.EditText', contentDesc: 'Email', query: '', matches: false },
  { why: 'RegExp tests the raw content-desc', platform: 'android', type: 'android.widget.EditText', contentDesc: 'E-mail', query: { source: '^e-?mail$', flags: 'i' }, matches: true },
  { why: 'RegExp on a Button', platform: 'android', type: 'android.widget.Button', contentDesc: 'Save', query: { source: 'Save', flags: '' }, matches: false },
  // Android: a text field's child names it (a Compose TextField's label); another input's child does not.
  { why: "a text field's child text is its label", platform: 'android', type: 'android.widget.EditText', childTexts: ['Email'], query: 'Email', matches: true },
  { why: 'any one child, whole', platform: 'android', type: 'android.widget.EditText', childTexts: ['Email', 'Required'], query: 'Required', matches: true },
  { why: 'children are not joined', platform: 'android', type: 'android.widget.EditText', childTexts: ['Email', 'Required'], query: 'Email Required', matches: false },
  { why: 'RegExp tests a child text', platform: 'android', type: 'android.widget.EditText', childTexts: ['E-mail'], query: { source: '^e-?mail$', flags: 'i' }, matches: true },
  { why: "a Spinner's child (its selected value) is no label", platform: 'android', type: 'android.widget.Spinner', childTexts: ['Canada'], query: 'Canada', matches: false },
  // An androidx Preference's unnamed switch or checkbox is labelled by its row's title.
  { why: "a row's title labels its unnamed switch", platform: 'android', type: 'android.widget.Switch', rowName: 'Full black Use full black for the dark theme', rowLabel: 'Full black', query: 'Full black', matches: true },
  { why: "a row's summary is no label", platform: 'android', type: 'android.widget.Switch', rowName: 'Full black Use full black for the dark theme', rowLabel: 'Full black', query: 'Use full black for the dark theme', matches: false },
  { why: "a row's whole name is no label", platform: 'android', type: 'android.widget.Switch', rowName: 'Full black Use full black for the dark theme', rowLabel: 'Full black', query: 'Full black Use full black for the dark theme', matches: false },
  { why: "RegExp tests a row's title", platform: 'android', type: 'android.widget.CheckBox', rowName: 'Wi-Fi only', rowLabel: 'Wi-Fi only', query: { source: '^wi-fi', flags: 'i' }, matches: true },
];

/** The case's element as a hierarchy node, the way each agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  const attrs: Record<string, string> = c.platform === 'ios'
    ? { type: c.type, label: c.label ?? '', identifier: '', value: c.value ?? '' }
    : { class: c.type, text: '', 'resource-id': '' };
  if (c.title !== undefined) attrs.title = c.title;
  if (c.contentDesc !== undefined) attrs['content-desc'] = c.contentDesc;
  if (c.rowName !== undefined) attrs['tapsmith-name'] = c.rowName;
  if (c.rowLabel !== undefined) attrs['tapsmith-label'] = c.rowLabel;
  const children = (c.childTexts ?? []).map((text): HierarchyNode => ({
    tagName: 'node',
    attributes: new Map(Object.entries({ class: 'android.widget.TextView', text, 'resource-id': '' })),
    children: [],
    depth: 1,
  }));
  return { tagName: c.platform === 'ios' ? c.type : 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 };
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
      'by the TypeScript playground matcher, the iOS agent\'s LabelMatchTests and the Android agent\'s LocatorConformanceTest.',
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
    const root = nodeFor(c);
    expect(findMatchingNodes([root], parsed!).includes(root)).toBe(c.matches);
  });

  it('the agents\' fixture is the current table', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_LABEL_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });
});

describe('getByLabel fields match the agents\' sources (PILOT-666)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');
  const between = (source: string, start: string, end: string): string => {
    const from = source.indexOf(start);
    expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
    return source.slice(from, source.indexOf(end, from + start.length));
  };

  it('Android: the roles whose classes labelInputClassPattern walks', () => {
    const block = between(read('agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt'),
      'private val labelInputClassPattern', 'Pattern.compile');
    const roles = [...block.matchAll(/roleClassMap\["(\w+)"\]/g)].map((m) => m[1]);
    expect(roles.length).toBeGreaterThan(0);
    expect([...roles].sort()).toEqual([...ANDROID_LABEL_FIELD_ROLES].sort());
  });

  it('iOS: LabelMatch.inputTypes', () => {
    const block = between(between(read('ios-agent/TapsmithAgent/LabelMatch.swift'), 'static let inputTypes', ']'), '= [', ']');
    const types = [...block.matchAll(/\.(\w+)/g)]
      .map((m) => `XCUIElementType${m[1][0].toUpperCase()}${m[1].slice(1)}`);
    expect(types.length).toBeGreaterThan(0);
    expect([...types].sort()).toEqual([...IOS_LABEL_FIELD_TYPES].sort());
  });

  it('iOS: LabelMatch.describedChoiceRoles', () => {
    const block = between(read('ios-agent/TapsmithAgent/LabelMatch.swift'), 'static let describedChoiceRoles', '\n');
    const roles = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
    expect(roles.length).toBeGreaterThan(0);
    expect([...roles].sort()).toEqual([...IOS_DESCRIBED_CHOICE_ROLES].sort());
  });
});
