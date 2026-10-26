import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { IOS_NAME_ONLY_TYPES, IOS_VALUE_TEXT_TYPES } from '../ios-text-content.js';
import { escapeJsString } from '../js-string-escape.js';
import { translateRegex } from '../text-regex.js';

/**
 * iOS getByText conformance (PILOT-794): which of a node's label, title and
 * value are its text content, and how a getByText query matches them. The
 * offline trace playground matches with a TypeScript copy of the iOS agent's
 * TextContent rule; each case below is one node (with its container's label)
 * and one query, with the agent's answer. The TypeScript matcher is checked
 * against them here, and the agent's TextContent replays the same cases from
 * `fixtures/text-content-conformance.json` (ios-agent/Tests/TextContentTests).
 * Regenerate the fixture after changing a case with
 * `UPDATE_TEXT_CONTENT_FIXTURE=1 npx vitest run src/__tests__/text-content-conformance.test.ts`.
 *
 * The innermost rule (a match that contains another match is dropped) needs a
 * tree: it is tested below on the TypeScript side, and on devices by
 * e2e/native-ios/text-content.native.ts and e2e/tests/text-content.test.ts.
 */

interface Case {
  why: string
  /** iOS element type name. */
  type: string
  label?: string
  title?: string
  value?: string
  /** The nearest labelled ancestor's label. */
  container?: string
  /** exact: getByText(q, { exact: true }); substring: getByText(q); or a RegExp as source + flags. */
  query: { exact: string } | { substring: string } | { source: string; flags: string }
  matches: boolean
}

const T = {
  text: 'XCUIElementTypeStaticText',
  button: 'XCUIElementTypeButton',
  switch: 'XCUIElementTypeSwitch',
  toggle: 'XCUIElementTypeToggle',
  slider: 'XCUIElementTypeSlider',
  stepper: 'XCUIElementTypeStepper',
  field: 'XCUIElementTypeTextField',
  secure: 'XCUIElementTypeSecureTextField',
  textView: 'XCUIElementTypeTextView',
  search: 'XCUIElementTypeSearchField',
  other: 'XCUIElementTypeOther',
  alert: 'XCUIElementTypeAlert',
  cell: 'XCUIElementTypeCell',
  link: 'XCUIElementTypeLink',
  progress: 'XCUIElementTypeProgressIndicator',
  wheel: 'XCUIElementTypePickerWheel',
} as const;

const CASES: Case[] = [
  // Labels are text content…
  { why: 'static text by its label', type: T.text, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: true },
  { why: 'a button by its label', type: T.button, label: 'Sign In', query: { exact: 'Sign In' }, matches: true },
  { why: 'an alert by its title label', type: T.alert, label: 'Delete file?', query: { exact: 'Delete file?' }, matches: true },
  { why: 'a generic view by its label', type: T.other, label: 'Card', query: { exact: 'Card' }, matches: true },
  { why: 'a text field by its label', type: T.field, label: 'Full name', query: { substring: 'full name' }, matches: true },
  { why: 'a title is text content', type: T.button, label: '', title: 'Save', query: { exact: 'Save' }, matches: true },
  // …except a control's, which is only its accessible name.
  { why: 'a switch is not text by its name', type: T.switch, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  { why: 'a toggle is not text by its name', type: T.toggle, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  { why: 'a slider is not text by its name', type: T.slider, label: 'Volume', query: { exact: 'Volume' }, matches: false },
  { why: 'a stepper is not text by its name', type: T.stepper, label: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  { why: 'nor by substring', type: T.stepper, label: 'Quantity: 1', query: { substring: 'quantity' }, matches: false },
  { why: 'nor by RegExp', type: T.stepper, label: 'Quantity: 1', query: { source: '^Quantity: \\d+$', flags: '' }, matches: false },
  { why: 'nor a control by its title', type: T.switch, label: '', title: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  // Values are text content only where they are the text on screen.
  { why: "a switch's value is not text", type: T.switch, label: '', value: '1', query: { exact: '1' }, matches: false },
  { why: "a stepper's value is not text", type: T.stepper, label: 'Quantity: 1', value: '1', query: { exact: '1' }, matches: false },
  { why: "a slider's value is not text", type: T.slider, label: 'Volume', value: '50%', query: { substring: '50' }, matches: false },
  { why: "a button's value is not text", type: T.button, label: 'Increment', value: '1', query: { exact: '1' }, matches: false },
  { why: 'an accessibilityValue is not text', type: T.other, label: 'Upload progress', value: '65%', query: { exact: '65%' }, matches: false },
  { why: "a progress indicator's value is not text", type: T.progress, label: 'Loading', value: '40%', query: { source: '%', flags: '' }, matches: false },
  { why: "a link's value (its URL) is not text", type: T.link, label: 'Docs', value: 'https://example.com', query: { substring: 'example' }, matches: false },
  { why: "a text field's typed value is text", type: T.field, label: '', value: 'nick', query: { substring: 'nick' }, matches: true },
  { why: "a text field's value, exactly", type: T.field, label: 'Email', value: 'ada@example.com', query: { exact: 'ada@example.com' }, matches: true },
  { why: "a secure field's value", type: T.secure, label: 'Password', value: '••••', query: { exact: '••••' }, matches: true },
  { why: "a text view's value", type: T.textView, label: 'Notes', value: 'Buy milk', query: { source: 'milk', flags: '' }, matches: true },
  { why: "a search field's value", type: T.search, label: 'Search', value: 'cats', query: { exact: 'cats' }, matches: true },
  { why: "static text's value", type: T.text, label: '', value: 'Hello', query: { exact: 'Hello' }, matches: true },
  { why: "a picker wheel's selected row is its value", type: T.wheel, label: '', value: 'Medium', query: { exact: 'Medium' }, matches: true },
  { why: 'a picker wheel by substring', type: T.wheel, label: '', value: 'Medium', query: { substring: 'med' }, matches: true },
  // A label read without the prefix it repeats from its container.
  { why: "a stepper button's label without the stepper's", type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  { why: 'nor by substring', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { substring: 'quantity' }, matches: false },
  { why: 'nor by RegExp', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { source: '^Quantity', flags: '' }, matches: false },
  { why: 'its own part still matches', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { exact: 'Increment' }, matches: true },
  { why: 'without its container, a joined child matches', type: T.button, label: 'Quantity: 1, Increment', query: { exact: 'Quantity: 1' }, matches: true },
  { why: 'a label equal to its container is kept', type: T.text, label: 'Item 3', container: 'Item 3', query: { exact: 'Item 3' }, matches: true },
  { why: 'a label that only starts like its container is kept', type: T.text, label: 'Quantity: 10', container: 'Quantity: 1', query: { exact: 'Quantity: 10' }, matches: true },
  { why: 'the container prefix compares whitespace-normalized', type: T.button, label: 'Quantity:\u00a01, Increment', container: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  // React Native joins a touchable's child texts into its label with ", ".
  { why: 'a joined first child', type: T.other, label: 'Login Form, Text inputs, buttons', query: { exact: 'Login Form' }, matches: true },
  { why: 'a joined middle child', type: T.other, label: 'A, B, C', query: { exact: 'B' }, matches: true },
  { why: 'a joined last child', type: T.other, label: 'Login Form, Text inputs', query: { exact: 'Text inputs' }, matches: true },
  { why: 'part of a child is no exact match', type: T.other, label: 'Login Form, Text inputs', query: { exact: 'Login' }, matches: false },
  // iOS drops trailing punctuation from some labels.
  { why: 'a label without the trailing "?"', type: T.button, label: 'Forgot password', query: { exact: 'Forgot password?' }, matches: true },
  { why: 'trailing punctuation only', type: T.button, label: 'Forgot password', query: { exact: 'Forgot' }, matches: false },
  // Whitespace and case, as before (PILOT-510, PILOT-522).
  { why: 'NBSP is a space', type: T.text, label: 'Welcome to\u00a0Expo', query: { exact: 'Welcome to Expo' }, matches: true },
  { why: 'exact is case-sensitive', type: T.text, label: 'GET STARTED', query: { exact: 'get started' }, matches: false },
  { why: 'substring ignores case', type: T.text, label: 'GET STARTED', query: { substring: 'get started' }, matches: true },
  { why: 'a RegExp tests the raw label', type: T.text, label: 'Line one\nLine two', query: { source: '^Line two$', flags: 'm' }, matches: true },
];

/** The case's node as the iOS agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  const attrs: Record<string, string> = { type: c.type, label: c.label ?? '', identifier: '', value: c.value ?? '' };
  if (c.title !== undefined) attrs.title = c.title;
  return { tagName: c.type, attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
}

/** The node inside a container labelled `c.container`, when it has one. */
function treeFor(c: Case): HierarchyNode {
  const node = nodeFor(c);
  if (c.container === undefined) return node;
  return {
    tagName: T.other,
    attributes: new Map(Object.entries({ type: T.other, label: c.container, identifier: '', value: '' })),
    children: [{ ...node, depth: 1 }],
    depth: 0,
  };
}

function codeFor(c: Case): string {
  if ('exact' in c.query) return `device.getByText("${escapeJsString(c.query.exact)}", { exact: true })`;
  if ('substring' in c.query) return `device.getByText("${escapeJsString(c.query.substring)}")`;
  return `device.getByText(/${c.query.source}/${c.query.flags})`;
}

const FIXTURE = fileURLToPath(new URL('./fixtures/text-content-conformance.json', import.meta.url));

function buildFixture() {
  return {
    comment:
      'Generated by packages/tapsmith/src/__tests__/text-content-conformance.test.ts (PILOT-794). One iOS node, its ' +
      'container\'s label and one getByText query per case, with the agent\'s answer; a RegExp query carries the SDK ' +
      'translation the agent compiles. Replayed by the TypeScript playground matcher and the iOS agent\'s TextContentTests.',
    cases: CASES.map((c) => ({
      ...c,
      query: 'source' in c.query ? { ...c.query, ...translateRegex(c.query.source, c.query.flags) } : c.query,
    })),
  };
}

function node(type: string, label: string, children: HierarchyNode[] = [], extra: Record<string, string> = {}): HierarchyNode {
  return {
    tagName: type,
    attributes: new Map(Object.entries({ type, label, identifier: '', value: '', ...extra })),
    children,
    depth: 0,
  };
}

function matchTypes(root: HierarchyNode, code: string): string[] {
  const parsed = parseSelectorString(code);
  expect(parsed).not.toBeNull();
  return findMatchingNodes([root], parsed!).map((n) => `${n.attributes.get('type')}:${n.attributes.get('label')}`);
}

describe('iOS getByText conformance (PILOT-794)', () => {
  it.each(CASES)('$why → $matches', (c) => {
    const parsed = parseSelectorString(codeFor(c));
    expect(parsed).not.toBeNull();
    const matched = findMatchingNodes([treeFor(c)], parsed!).filter((n) => n.attributes.get('type') === c.type);
    expect(matched.length).toBe(c.matches ? 1 : 0);
  });

  it('the agent\'s fixture is the current table', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_TEXT_CONTENT_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });
});

describe('iOS getByText keeps the innermost match (PILOT-794)', () => {
  // A SwiftUI Form Toggle: the row is a switch labelled like the static text
  // it holds, with the knob (an unlabelled switch) beside it.
  const toggle = node(T.other, '', [
    node(T.switch, 'Dark Mode', [node(T.text, 'Dark Mode'), node(T.switch, '', [], { value: '0' })], { value: '0' }),
  ]);
  // A NavigationLink row: a button holding its text and a chevron.
  const link = node(T.cell, '', [node(T.button, 'Item 3', [node(T.text, 'Item 3'), node('XCUIElementTypeImage', '')])]);
  // A SwiftUI Stepper: its text beside it, its buttons inside it.
  const stepper = node(T.other, '', [
    node(T.text, 'Quantity: 1'),
    node(T.stepper, 'Quantity: 1', [
      node(T.button, 'Quantity: 1, Decrement', [], { value: '1' }),
      node(T.button, 'Quantity: 1, Increment', [], { value: '1' }),
    ], { value: '1' }),
  ]);
  const alert = node(T.alert, 'Delete file?', [node(T.other, '', [node(T.text, 'Delete file?'), node(T.text, 'This cannot be undone.')])]);

  it('a Toggle row gives way to its text', () => {
    expect(matchTypes(toggle, 'device.getByText("Dark Mode", { exact: true })')).toEqual([`${T.text}:Dark Mode`]);
    expect(matchTypes(toggle, 'device.getByText("dark")')).toEqual([`${T.text}:Dark Mode`]);
  });

  it('a NavigationLink gives way to its text', () => {
    expect(matchTypes(link, 'device.getByText("Item 3", { exact: true })')).toEqual([`${T.text}:Item 3`]);
    expect(matchTypes(link, 'device.getByText(/^Item \\d$/)')).toEqual([`${T.text}:Item 3`]);
  });

  it('an alert gives way to its title text', () => {
    expect(matchTypes(alert, 'device.getByText("Delete file?", { exact: true })')).toEqual([`${T.text}:Delete file?`]);
  });

  it('a Stepper matches by neither its name, its buttons nor its value', () => {
    expect(matchTypes(stepper, 'device.getByText("Quantity: 1", { exact: true })')).toEqual([`${T.text}:Quantity: 1`]);
    expect(matchTypes(stepper, 'device.getByText(/^Quantity: \\d+$/)')).toEqual([`${T.text}:Quantity: 1`]);
    expect(matchTypes(stepper, 'device.getByText("1", { exact: true })')).toEqual([]);
  });

  it('a generic wrapper gives way to a generic descendant, too', () => {
    const wrapper = node(T.other, 'Settings, General', [node(T.other, 'General')]);
    expect(matchTypes(wrapper, 'device.getByText("General", { exact: true })')).toEqual([`${T.other}:General`]);
  });

  it('a same-target duplicate keeps its outer, attribute-carrying copy (PILOT-226)', () => {
    const bounds = { bounds: '[16,100][200,140]' };
    const pair = node(T.other, '', [
      node(T.text, 'Test Screens', [node(T.text, 'Test Screens', [], bounds)], { ...bounds, identifier: 'title', 'tapsmith-role': 'heading' }),
    ]);
    const matched = findMatchingNodes([pair], parseSelectorString('device.getByText("Test Screens", { exact: true })')!);
    expect(matched).toHaveLength(1);
    expect(matched[0].attributes.get('identifier')).toBe('title');
    // A generic wrapper of a native control with the same label and bounds gives way to it.
    const wrapper = node(T.other, 'Submit', [node(T.button, 'Submit', [], bounds)], bounds);
    expect(matchTypes(wrapper, 'device.getByText("Submit", { exact: true })')).toEqual([`${T.button}:Submit`]);
    // A container with other bounds still gives way.
    const row = node(T.button, 'Test Screens', [node(T.text, 'Test Screens', [], bounds)], { bounds: '[0,90][400,150]' });
    expect(matchTypes(row, 'device.getByText("Test Screens", { exact: true })')).toEqual([`${T.text}:Test Screens`]);
  });

  it('siblings are both kept', () => {
    const siblings = node(T.other, '', [node(T.text, 'Save'), node(T.button, 'Save')]);
    expect(matchTypes(siblings, 'device.getByText("Save", { exact: true })')).toEqual([`${T.text}:Save`, `${T.button}:Save`]);
  });

  it('only getByText: getByRole still finds the Toggle row', () => {
    expect(matchTypes(toggle, 'device.getByRole("switch", { name: "Dark Mode" })')).toEqual([`${T.switch}:Dark Mode`]);
  });

  it("the application's name is no container label", () => {
    const app = node('XCUIElementTypeApplication', 'Notes', [node(T.button, 'Notes, Add')]);
    expect(matchTypes(app, 'device.getByText("Notes", { exact: true })')).toEqual([`${T.button}:Notes, Add`]);
  });
});

describe('iOS text-content types match the agent\'s source (PILOT-794)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const source = readFileSync(path.join(repoRoot, 'ios-agent/TapsmithAgent/TextContent.swift'), 'utf8');
  const typesOf = (name: string): string[] => {
    const from = source.indexOf(`static let ${name}`);
    expect(from, `${name} not found`).toBeGreaterThanOrEqual(0);
    const block = source.slice(source.indexOf('= [', from), source.indexOf(']', from));
    return [...block.matchAll(/\.(\w+)/g)].map((m) => `XCUIElementType${m[1][0].toUpperCase()}${m[1].slice(1)}`).sort();
  };

  it('nameOnlyTypes', () => {
    expect(typesOf('nameOnlyTypes')).toEqual([...IOS_NAME_ONLY_TYPES].sort());
  });

  it('valueTextTypes', () => {
    // Less the raw `XCUIElementType(<n>)` spelling older dumps carry.
    expect(typesOf('valueTextTypes')).toEqual([...IOS_VALUE_TEXT_TYPES].filter((t) => !t.includes('(')).sort());
  });
});
