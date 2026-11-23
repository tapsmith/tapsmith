import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseHierarchyXml, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { IOS_NAME_ONLY_TYPES, IOS_TEXT_INPUT_TYPES, IOS_VALUE_TEXT_TYPES } from '../ios-text-content.js';
import { escapeJsString } from '../js-string-escape.js';
import { translateRegex } from '../text-regex.js';

/**
 * getByText conformance (PILOT-794, PILOT-707). On iOS: which of a node's
 * label, title and value are its text content, and how a getByText query
 * matches them. On Android: the node's text alone, as UIAutomator's walk
 * compares it. The offline trace playground matches with a TypeScript copy of
 * the agents' rules; each case below is one node (with, on iOS, its
 * container's label) and one query, with the agent's answer. The TypeScript
 * matcher is checked against them here, and the agents replay the same cases
 * from `fixtures/text-content-conformance.json`: the iOS agent's TextContent
 * (ios-agent/Tests/TextContentTests) and the Android agent's ElementFinder
 * (agent LocatorConformanceTest).
 * Regenerate the fixture after changing a case with
 * `UPDATE_TEXT_CONTENT_FIXTURE=1 npx vitest run src/__tests__/text-content-conformance.test.ts`.
 *
 * The innermost rule (a match that contains another match is dropped) needs a
 * tree: it is tested below on the TypeScript side, and on devices by
 * e2e/native-ios/text-content.native.ts and e2e/tests/text-content.test.ts.
 */

interface Case {
  why: string
  platform: 'ios' | 'android'
  /** iOS element type name, or Android class name. */
  type: string
  label?: string
  title?: string
  value?: string
  /** The nearest labelled ancestor's label. */
  container?: string
  /** iOS: the node is in a table row (a cell) beside static texts with these labels. */
  row?: string[]
  /** Android: the node's text (an empty EditText reports its hint here). */
  text?: string
  contentDesc?: string
  /** An editable field's placeholder: Android's hint, iOS's placeholderValue. */
  placeholder?: string
  /** iOS text view: false when it can't be edited (no text-entry trait; the dump's role is not textfield). */
  editable?: boolean
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
  image: 'XCUIElementTypeImage',
  wheel: 'XCUIElementTypePickerWheel',
} as const;

const A = {
  textView: 'android.widget.TextView',
  button: 'android.widget.Button',
  imageButton: 'android.widget.ImageButton',
  editText: 'android.widget.EditText',
  materialEditText: 'com.google.android.material.textfield.TextInputEditText',
  viewGroup: 'android.view.ViewGroup',
} as const;

const CASES: Case[] = [
  // Labels are text content…
  { why: 'static text by its label', platform: 'ios', type: T.text, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: true },
  { why: 'a button by its label', platform: 'ios', type: T.button, label: 'Sign In', query: { exact: 'Sign In' }, matches: true },
  { why: 'exact stays case-sensitive (iOS has no all-caps transform)', platform: 'ios', type: T.button, label: 'SIGN IN', query: { exact: 'Sign In' }, matches: false },
  { why: 'an alert by its title label', platform: 'ios', type: T.alert, label: 'Delete file?', query: { exact: 'Delete file?' }, matches: true },
  { why: 'a generic view by its label', platform: 'ios', type: T.other, label: 'Card', query: { exact: 'Card' }, matches: true },
  { why: 'a text field by its label', platform: 'ios', type: T.field, label: 'Full name', query: { substring: 'full name' }, matches: true },
  { why: 'a title is text content', platform: 'ios', type: T.button, label: '', title: 'Save', query: { exact: 'Save' }, matches: true },
  // …except a control's, which is only its accessible name.
  { why: 'a switch is not text by its name', platform: 'ios', type: T.switch, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  { why: 'a toggle is not text by its name', platform: 'ios', type: T.toggle, label: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  { why: 'a slider is not text by its name', platform: 'ios', type: T.slider, label: 'Volume', query: { exact: 'Volume' }, matches: false },
  { why: 'a stepper is not text by its name', platform: 'ios', type: T.stepper, label: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  { why: 'nor by substring', platform: 'ios', type: T.stepper, label: 'Quantity: 1', query: { substring: 'quantity' }, matches: false },
  { why: 'nor by RegExp', platform: 'ios', type: T.stepper, label: 'Quantity: 1', query: { source: '^Quantity: \\d+$', flags: '' }, matches: false },
  { why: 'nor a control by its title', platform: 'ios', type: T.switch, label: '', title: 'Dark Mode', query: { exact: 'Dark Mode' }, matches: false },
  // An image's label is its alt text, a name (getByRole('image', { name }),
  // getByLabel), never getByText's text: Playwright matches an <img alt> with
  // getByAltText, and Android a content description with getByText not at all
  // (PILOT-1366). A caption under a labelled image is one match.
  { why: 'an image is not text by its label', platform: 'ios', type: T.image, label: 'The Flower Girl', query: { exact: 'The Flower Girl' }, matches: false },
  { why: 'nor by substring', platform: 'ios', type: T.image, label: 'The Flower Girl', query: { substring: 'flower' }, matches: false },
  { why: 'nor by RegExp', platform: 'ios', type: T.image, label: 'The Flower Girl', query: { source: 'Flower', flags: '' }, matches: false },
  { why: 'nor an image by its title', platform: 'ios', type: T.image, label: '', title: 'The Flower Girl', query: { exact: 'The Flower Girl' }, matches: false },
  // A button's label is the only text it has, drawn or not: an icon button
  // can't be told from a text button, so both stay text.
  { why: 'an icon button by its label', platform: 'ios', type: T.button, label: 'Close', query: { exact: 'Close' }, matches: true },
  // Values are text content only where they are the text on screen.
  { why: "a switch's value is not text", platform: 'ios', type: T.switch, label: '', value: '1', query: { exact: '1' }, matches: false },
  { why: "a stepper's value is not text", platform: 'ios', type: T.stepper, label: 'Quantity: 1', value: '1', query: { exact: '1' }, matches: false },
  { why: "a slider's value is not text", platform: 'ios', type: T.slider, label: 'Volume', value: '50%', query: { substring: '50' }, matches: false },
  { why: "a button's value is not text", platform: 'ios', type: T.button, label: 'Increment', value: '1', query: { exact: '1' }, matches: false },
  { why: 'an accessibilityValue is not text', platform: 'ios', type: T.other, label: 'Upload progress', value: '65%', query: { exact: '65%' }, matches: false },
  { why: "a progress indicator's value is not text", platform: 'ios', type: T.progress, label: 'Loading', value: '40%', query: { source: '%', flags: '' }, matches: false },
  { why: "a link's value (its URL) is not text", platform: 'ios', type: T.link, label: 'Docs', value: 'https://example.com', query: { substring: 'example' }, matches: false },
  // A text input's typed value is no getByText text, as an <input>'s value is
  // not in Playwright and as on Android (PILOT-1417): a search result's text
  // typed into the search field must not find the field.
  { why: "a text field's typed value is not text", platform: 'ios', type: T.field, label: '', value: 'nick', placeholder: 'Nickname', query: { substring: 'nick' }, matches: false },
  { why: 'nor exactly', platform: 'ios', type: T.field, label: '', value: 'ada@example.com', placeholder: 'Email', query: { exact: 'ada@example.com' }, matches: false },
  { why: 'nor by RegExp', platform: 'ios', type: T.field, label: '', value: 'Apollo 11', placeholder: 'Search', query: { source: '^Apollo', flags: '' }, matches: false },
  { why: 'nor with no placeholder', platform: 'ios', type: T.field, label: '', value: 'Apollo 11', query: { exact: 'Apollo 11' }, matches: false },
  { why: "nor a secure field's", platform: 'ios', type: T.secure, label: 'Password', value: '••••', query: { exact: '••••' }, matches: false },
  { why: "nor a text view's", platform: 'ios', type: T.textView, label: 'Notes', value: 'Buy milk', query: { source: 'milk', flags: '' }, matches: false },
  { why: "nor a search field's", platform: 'ios', type: T.search, label: 'Search', value: 'cats', placeholder: 'Search', query: { exact: 'cats' }, matches: false },
  { why: "a labelled field's label is still text", platform: 'ios', type: T.field, label: 'Email', value: 'ada@example.com', placeholder: 'you@example.com', query: { exact: 'Email' }, matches: true },
  // An empty field shows its placeholder as its value, and that is its text,
  // as an empty Android EditText's hint is.
  { why: "an empty field's placeholder is its text", platform: 'ios', type: T.field, label: '', value: 'Search items...', placeholder: 'Search items...', query: { exact: 'Search items...' }, matches: true },
  { why: 'by substring too', platform: 'ios', type: T.search, label: '', value: 'Search', placeholder: 'Search', query: { substring: 'sea' }, matches: true },
  { why: 'and by RegExp', platform: 'ios', type: T.textView, label: '', value: 'Notes', placeholder: 'Notes', query: { source: '^Notes$', flags: '' }, matches: true },
  { why: 'a typed value equal to the placeholder reads as the placeholder', platform: 'ios', type: T.field, label: '', value: 'Email', placeholder: 'Email', query: { substring: 'mail' }, matches: true },
  { why: 'a placeholder is no text while a value is typed', platform: 'ios', type: T.field, label: '', value: 'ada', placeholder: 'Email', query: { exact: 'Email' }, matches: false },
  // A text view that can't be edited (terms copy, React Native's
  // <TextInput multiline editable={false} />) is text on screen, not an
  // input: its value stays text (PILOT-697 keeps it out of the textfield role).
  { why: "a read-only text view's value is text", platform: 'ios', type: T.textView, label: '', value: 'By signing up you agree to the Terms', editable: false, query: { substring: 'by signing up' }, matches: true },
  { why: 'exactly too', platform: 'ios', type: T.textView, label: '', value: 'Terms of Service', editable: false, query: { exact: 'Terms of Service' }, matches: true },
  { why: 'and by RegExp', platform: 'ios', type: T.textView, label: '', value: 'Terms of Service', editable: false, query: { source: '^Terms', flags: '' }, matches: true },
  // The value of a view that only looks like a field is still text.
  { why: "a static text's value beside a placeholder is text", platform: 'ios', type: T.text, label: '', value: 'Apollo 11', placeholder: 'Search', query: { exact: 'Apollo 11' }, matches: true },
  { why: "static text's value", platform: 'ios', type: T.text, label: '', value: 'Hello', query: { exact: 'Hello' }, matches: true },
  { why: "a picker wheel's selected row is its value", platform: 'ios', type: T.wheel, label: '', value: 'Medium', query: { exact: 'Medium' }, matches: true },
  { why: 'a picker wheel by substring', platform: 'ios', type: T.wheel, label: '', value: 'Medium', query: { substring: 'med' }, matches: true },
  // A label read without the prefix it repeats from its container.
  { why: "a stepper button's label without the stepper's", platform: 'ios', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  { why: 'nor by substring', platform: 'ios', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { substring: 'quantity' }, matches: false },
  { why: 'nor by RegExp', platform: 'ios', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { source: '^Quantity', flags: '' }, matches: false },
  { why: 'its own part still matches', platform: 'ios', type: T.button, label: 'Quantity: 1, Increment', container: 'Quantity: 1', query: { exact: 'Increment' }, matches: true },
  { why: 'without its container, a joined child matches', platform: 'ios', type: T.button, label: 'Quantity: 1, Increment', query: { exact: 'Quantity: 1' }, matches: true },
  { why: 'a label equal to its container is kept', platform: 'ios', type: T.text, label: 'Item 3', container: 'Item 3', query: { exact: 'Item 3' }, matches: true },
  { why: 'a label that only starts like its container is kept', platform: 'ios', type: T.text, label: 'Quantity: 10', container: 'Quantity: 1', query: { exact: 'Quantity: 10' }, matches: true },
  { why: 'the container prefix compares whitespace-normalized', platform: 'ios', type: T.button, label: 'Quantity:\u00a01, Increment', container: 'Quantity: 1', query: { exact: 'Quantity: 1' }, matches: false },
  // React Native joins a touchable's child texts into its label with ", ".
  { why: 'a joined first child', platform: 'ios', type: T.other, label: 'Login Form, Text inputs, buttons', query: { exact: 'Login Form' }, matches: true },
  { why: 'a joined middle child', platform: 'ios', type: T.other, label: 'A, B, C', query: { exact: 'B' }, matches: true },
  { why: 'a joined last child', platform: 'ios', type: T.other, label: 'Login Form, Text inputs', query: { exact: 'Text inputs' }, matches: true },
  { why: 'part of a child is no exact match', platform: 'ios', type: T.other, label: 'Login Form, Text inputs', query: { exact: 'Login' }, matches: false },
  // UIKit labels a row's edit-mode Remove and Reorder controls with the row's
  // texts joined after a verb: a part the row shows as a text of its own is
  // the row's text, not the control's (PILOT-1374).
  { why: "an edit-mode Remove button by its row's text", platform: 'ios', type: T.button, label: 'Remove A, 981 195, Alpha (a@example.com)', row: ['A', '981 195', 'Alpha (a@example.com)'], query: { exact: 'Alpha (a@example.com)' }, matches: false },
  { why: "an edit-mode Remove button by its row's middle text", platform: 'ios', type: T.button, label: 'Remove A, 981 195, Alpha (a@example.com)', row: ['A', '981 195', 'Alpha (a@example.com)'], query: { exact: '981 195' }, matches: false },
  { why: "an edit-mode Reorder button by its row's text", platform: 'ios', type: T.button, label: 'Reorder A, 981 195, Alpha (a@example.com)', row: ['A', '981 195', 'Alpha (a@example.com)'], query: { exact: 'Alpha (a@example.com)' }, matches: false },
  { why: 'a part the row shows compares whitespace-normalized', platform: 'ios', type: T.button, label: 'Remove A, Alpha (a@example.com)', row: ['A', 'Alpha\u00a0(a@example.com)'], query: { exact: 'Alpha (a@example.com)' }, matches: false },
  { why: "a title's part the row shows", platform: 'ios', type: T.button, label: '', title: 'Remove A, Alpha', row: ['A', 'Alpha'], query: { exact: 'Alpha' }, matches: false },
  { why: "an edit-mode button's own words still match", platform: 'ios', type: T.button, label: 'Remove A, 981 195, Alpha (a@example.com)', row: ['A', '981 195', 'Alpha (a@example.com)'], query: { exact: 'Remove A' }, matches: true },
  { why: 'a part its row does not show matches', platform: 'ios', type: T.other, label: 'Intro, Welcome to Expo', row: ['Intro'], query: { exact: 'Welcome to Expo' }, matches: true },
  { why: 'outside a row, every joined part matches', platform: 'ios', type: T.button, label: 'Remove A, 981 195, Alpha (a@example.com)', query: { exact: 'Alpha (a@example.com)' }, matches: true },
  { why: 'a whole label matches in a row that shows it', platform: 'ios', type: T.button, label: 'Buy', row: ['Buy'], query: { exact: 'Buy' }, matches: true },
  { why: 'by substring, an edit-mode button still matches', platform: 'ios', type: T.button, label: 'Remove A, 981 195, Alpha (a@example.com)', row: ['A', '981 195', 'Alpha (a@example.com)'], query: { substring: 'alpha' }, matches: true },
  // A label that lacks the text's trailing punctuation is not that text
  // (PILOT-880): a React Native touchable's accessibilityLabel hides the text
  // it wraps, and an alert's "Log out" button is not its "Log out?" title.
  // Exact and substring agree.
  { why: 'a label without the trailing "?"', platform: 'ios', type: T.link, label: 'Forgot password', query: { exact: 'Forgot password?' }, matches: false },
  { why: 'nor by substring', platform: 'ios', type: T.link, label: 'Forgot password', query: { substring: 'Forgot password?' }, matches: false },
  { why: 'the label is found by its own text', platform: 'ios', type: T.link, label: 'Forgot password', query: { substring: 'forgot password' }, matches: true },
  { why: 'a label with trailing punctuation the query lacks', platform: 'ios', type: T.button, label: 'Done!', query: { exact: 'Done' }, matches: false },
  { why: 'contains that query as a substring', platform: 'ios', type: T.button, label: 'Done!', query: { substring: 'done' }, matches: true },
  { why: 'a symbol is no stand-in for another', platform: 'ios', type: T.button, label: '👍', query: { substring: '👎' }, matches: false },
  { why: 'a query ending in symbols is literal', platform: 'ios', type: T.text, label: 'Music', query: { substring: 'C++' }, matches: false },
  { why: 'a query ending in "%" is literal', platform: 'ios', type: T.text, label: 'Volume 50', query: { substring: '50%' }, matches: false },
  { why: 'a query ending in "%" in the label', platform: 'ios', type: T.text, label: 'Volume 50%', query: { substring: '50%' }, matches: true },
  // A substring is literal: ICU pattern characters match only themselves.
  { why: 'a "?" in the label', platform: 'ios', type: T.text, label: 'Forgot password? Reset it', query: { substring: 'password? reset' }, matches: true },
  { why: '"?" is not optional', platform: 'ios', type: T.text, label: 'Ready', query: { substring: 'x?Ready' }, matches: false },
  { why: 'a "*" in the label', platform: 'ios', type: T.text, label: 'Rating: 5*', query: { substring: '5*' }, matches: true },
  { why: '"*" is not a repeat', platform: 'ios', type: T.text, label: 'aab', query: { substring: 'a*b' }, matches: false },
  { why: 'a "\\" in the label', platform: 'ios', type: T.text, label: 'C:\\Users\\ada', query: { substring: ':\\users' }, matches: true },
  { why: '"\\d" is not a digit class', platform: 'ios', type: T.text, label: 'a1', query: { substring: 'a\\d' }, matches: false },
  { why: 'a "[" in the label', platform: 'ios', type: T.text, label: 'Items [3]', query: { substring: '[3]' }, matches: true },
  { why: '"[...]" is not a character class', platform: 'ios', type: T.text, label: 'a', query: { substring: '[ab]' }, matches: false },
  { why: '"." is not any character', platform: 'ios', type: T.text, label: 'abc', query: { substring: 'a.c' }, matches: false },
  { why: 'exact is literal too', platform: 'ios', type: T.text, label: 'aab', query: { exact: 'a*b' }, matches: false },
  // Whitespace and case, as before (PILOT-510, PILOT-522).
  { why: 'NBSP is a space', platform: 'ios', type: T.text, label: 'Welcome to\u00a0Expo', query: { exact: 'Welcome to Expo' }, matches: true },
  { why: 'exact is case-sensitive', platform: 'ios', type: T.text, label: 'GET STARTED', query: { exact: 'get started' }, matches: false },
  { why: 'substring ignores case', platform: 'ios', type: T.text, label: 'GET STARTED', query: { substring: 'get started' }, matches: true },
  { why: 'a RegExp tests the raw label', platform: 'ios', type: T.text, label: 'Line one\nLine two', query: { source: '^Line two$', flags: 'm' }, matches: true },
  // ─── Android: the node's text, as UIAutomator's walk reads it ───
  { why: 'exact matches the whole text', platform: 'android', type: A.textView, text: 'Sign In', query: { exact: 'Sign In' }, matches: true },
  { why: 'exact is case-sensitive', platform: 'android', type: A.textView, text: 'Get Started', query: { exact: 'get started' }, matches: false },
  // Android's all-caps transform (textAllCaps: every AlertDialog button, React
  // Native's <Button>) reports the transformed text, so an exact query also
  // matches its upper-cased rendering, as Detox and Playwright match the text
  // before the transform.
  { why: 'exact matches the all-caps rendering', platform: 'android', type: A.button, text: 'YES, DELETE', query: { exact: 'Yes, delete' }, matches: true },
  { why: 'whatever case the query is in', platform: 'android', type: A.textView, text: 'GET STARTED', query: { exact: 'get started' }, matches: true },
  { why: 'whitespace-normalized', platform: 'android', type: A.button, text: 'YES,\u00a0DELETE', query: { exact: 'Yes,  delete' }, matches: true },
  { why: 'upper-cased without the device locale', platform: 'android', type: A.textView, text: 'STRASSE', query: { exact: 'Straße' }, matches: true },
  { why: 'but not a mixed-case text', platform: 'android', type: A.button, text: 'Yes, Delete', query: { exact: 'Yes, delete' }, matches: false },
  { why: 'nor a capitalized query of lower-case text', platform: 'android', type: A.textView, text: 'yes, delete', query: { exact: 'YES, DELETE' }, matches: false },
  { why: 'nor part of an all-caps text', platform: 'android', type: A.button, text: 'YES, DELETE', query: { exact: 'Yes' }, matches: false },
  { why: 'exact is not a substring', platform: 'android', type: A.textView, text: 'Sign In', query: { exact: 'Sign' }, matches: false },
  { why: 'substring ignores case', platform: 'android', type: A.textView, text: 'GET STARTED', query: { substring: 'get started' }, matches: true },
  { why: 'substring ignores non-ASCII case', platform: 'android', type: A.textView, text: 'ÉTÉ', query: { substring: 'été' }, matches: true },
  { why: 'NBSP is a space', platform: 'android', type: A.textView, text: 'Welcome to\u00a0Expo', query: { exact: 'Welcome to Expo' }, matches: true },
  { why: 'a line break is a space', platform: 'android', type: A.textView, text: 'Line one\nLine two', query: { exact: 'Line one Line two' }, matches: true },
  { why: 'padding in the text is ignored', platform: 'android', type: A.textView, text: '  Sign In ', query: { exact: 'Sign In' }, matches: true },
  { why: 'padding in the query is ignored', platform: 'android', type: A.textView, text: 'Sign In', query: { exact: ' Sign  In ' }, matches: true },
  { why: 'substring across a whitespace run', platform: 'android', type: A.textView, text: 'Welcome  to\u00a0Expo', query: { substring: 'to expo' }, matches: true },
  { why: 'a button by its text', platform: 'android', type: A.button, text: 'Save', query: { exact: 'Save' }, matches: true },
  // A text field's typed value is no getByText text, as an <input>'s value is
  // not in Playwright (PILOT-1404): a search result's text typed into the
  // search field must not find the field.
  { why: "a text field's typed value is not text", platform: 'android', type: A.editText, text: 'ada@example.com', placeholder: 'Email', query: { exact: 'ada@example.com' }, matches: false },
  { why: 'nor by substring', platform: 'android', type: A.editText, text: 'Apollo 11', placeholder: 'Search Wikipedia', query: { substring: 'apollo' }, matches: false },
  { why: 'nor by RegExp', platform: 'android', type: A.editText, text: 'Apollo 11', placeholder: 'Search Wikipedia', query: { source: '^Apollo', flags: '' }, matches: false },
  { why: 'nor with no hint', platform: 'android', type: A.editText, text: 'Apollo 11', query: { exact: 'Apollo 11' }, matches: false },
  { why: "nor a Material field's", platform: 'android', type: A.materialEditText, text: 'Apollo 11', placeholder: 'Search', query: { exact: 'Apollo 11' }, matches: false },
  { why: 'an empty field with no hint is no text, as any empty node', platform: 'android', type: A.editText, query: { source: '^$', flags: '' }, matches: true },
  // An empty EditText reports its hint as its text, and the walk compares that.
  { why: "an empty text field's hint is its text", platform: 'android', type: A.editText, text: 'Email', placeholder: 'Email', query: { exact: 'Email' }, matches: true },
  { why: 'by substring too', platform: 'android', type: A.editText, text: 'Search Wikipedia', placeholder: 'Search Wikipedia', query: { substring: 'search' }, matches: true },
  // A value equal to the hint reads as the hint, as getByRole's name reads it.
  { why: 'a typed value equal to the hint reads as the hint', platform: 'android', type: A.editText, text: 'Email', placeholder: 'Email', query: { substring: 'mail' }, matches: true },
  // The text of a view that only looks like a field is still text.
  { why: "a TextView's text is text", platform: 'android', type: A.textView, text: 'Apollo 11', placeholder: 'Search', query: { exact: 'Apollo 11' }, matches: true },
  // Unlike an iOS label, a content description is no getByText text on Android.
  { why: 'a content description is not text', platform: 'android', type: A.imageButton, contentDesc: 'Close', query: { exact: 'Close' }, matches: false },
  { why: 'nor by substring', platform: 'android', type: A.viewGroup, contentDesc: 'Login Form', query: { substring: 'login' }, matches: false },
  { why: 'nor by RegExp', platform: 'android', type: A.viewGroup, contentDesc: 'Login Form', query: { source: 'Login', flags: '' }, matches: false },
  // Unlike an iOS ", "-joined label, a text is compared whole.
  { why: 'a ", "-joined text is one text', platform: 'android', type: A.textView, text: 'Login Form, Text inputs', query: { exact: 'Text inputs' }, matches: false },
  { why: 'a text without the trailing "?"', platform: 'android', type: A.textView, text: 'Forgot password', query: { exact: 'Forgot password?' }, matches: false },
  { why: 'nor by substring', platform: 'android', type: A.textView, text: 'Forgot password', query: { substring: 'Forgot password?' }, matches: false },
  // A substring is literal: regex characters match only themselves.
  { why: 'a "?" in the text', platform: 'android', type: A.textView, text: 'Forgot password? Reset it', query: { substring: 'password? reset' }, matches: true },
  { why: '"?" is not optional', platform: 'android', type: A.textView, text: 'Ready', query: { substring: 'x?Ready' }, matches: false },
  { why: '"*" is not a repeat', platform: 'android', type: A.textView, text: 'aab', query: { substring: 'a*b' }, matches: false },
  { why: 'a "\\" in the text', platform: 'android', type: A.textView, text: 'C:\\Users\\ada', query: { substring: ':\\users' }, matches: true },
  { why: '"\\E" ends no quote', platform: 'android', type: A.textView, text: 'a\\Eb', query: { substring: 'a\\Eb' }, matches: true },
  { why: '"[...]" is not a character class', platform: 'android', type: A.textView, text: 'a', query: { substring: '[ab]' }, matches: false },
  { why: '"." is not any character', platform: 'android', type: A.textView, text: 'abc', query: { substring: 'a.c' }, matches: false },
  { why: 'exact is literal too', platform: 'android', type: A.textView, text: 'aab', query: { exact: 'a*b' }, matches: false },
  // A RegExp tests the raw text, anywhere in it.
  { why: 'a RegExp finds a part', platform: 'android', type: A.textView, text: 'Order #1234 shipped', query: { source: '#\\d+', flags: '' }, matches: true },
  { why: 'with the i flag', platform: 'android', type: A.textView, text: 'GET STARTED', query: { source: '^get', flags: 'i' }, matches: true },
  { why: 'without it, case counts', platform: 'android', type: A.textView, text: 'GET STARTED', query: { source: '^get', flags: '' }, matches: false },
  { why: 'anchors see the raw line break', platform: 'android', type: A.textView, text: 'Line one\nLine two', query: { source: '^Line two$', flags: '' }, matches: false },
  { why: 'the m flag anchors each line', platform: 'android', type: A.textView, text: 'Line one\nLine two', query: { source: '^Line two$', flags: 'm' }, matches: true },
  { why: 'the text is not normalized for a RegExp', platform: 'android', type: A.textView, text: 'Full\u00a0name', query: { source: '^Full name$', flags: '' }, matches: false },
  { why: '\\s covers NBSP', platform: 'android', type: A.textView, text: 'Full\u00a0name', query: { source: '^Full\\sname$', flags: '' }, matches: true },
  { why: 'a RegExp on no text', platform: 'android', type: A.viewGroup, query: { source: 'a', flags: '' }, matches: false },
];

/** The case's node as its agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  if (c.platform === 'android') {
    const attrs: Record<string, string> = { class: c.type, text: c.text ?? '', 'resource-id': '', 'content-desc': c.contentDesc ?? '' };
    if (c.placeholder !== undefined) attrs.hint = c.placeholder;
    return { tagName: 'node', attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
  }
  const attrs: Record<string, string> = { type: c.type, label: c.label ?? '', identifier: '', value: c.value ?? '' };
  if (c.title !== undefined) attrs.title = c.title;
  if (c.placeholder !== undefined) attrs.placeholderValue = c.placeholder;
  // The agent dumps an editable text view's role as textfield, a read-only one's as text (PILOT-697).
  if (c.type === T.textView) attrs['tapsmith-role'] = c.editable === false ? 'text' : 'textfield';
  return { tagName: c.type, attributes: new Map(Object.entries(attrs)), children: [], depth: 0 };
}

/**
 * The node in a table row beside `c.row`'s static texts, when it has them,
 * inside a container labelled `c.container`, when it has one.
 */
function treeFor(c: Case): HierarchyNode {
  let tree = nodeFor(c);
  if (c.row !== undefined) {
    const texts = c.row.map((label): HierarchyNode => ({
      tagName: T.text,
      attributes: new Map(Object.entries({ type: T.text, label, identifier: '', value: '' })),
      children: [],
      depth: 0,
    }));
    tree = {
      tagName: T.cell,
      attributes: new Map(Object.entries({ type: T.cell, label: '', identifier: '', value: '' })),
      children: [tree, ...texts],
      depth: 0,
    };
  }
  if (c.container === undefined) return tree;
  return {
    tagName: T.other,
    attributes: new Map(Object.entries({ type: T.other, label: c.container, identifier: '', value: '' })),
    children: [tree],
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
      'Generated by packages/tapsmith/src/__tests__/text-content-conformance.test.ts (PILOT-794, PILOT-707). One node ' +
      '(on iOS with its container\'s label and the static texts beside it in its table row) and one getByText query per case, with the agent\'s answer; a RegExp query ' +
      'carries the SDK translation the agents compile. Replayed by the TypeScript playground matcher, the iOS agent\'s ' +
      'TextContentTests and the Android agent\'s LocatorConformanceTest.',
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

describe('getByText conformance (PILOT-794, PILOT-707)', () => {
  it.each(CASES)('$platform $why → $matches', (c) => {
    const parsed = parseSelectorString(codeFor(c));
    expect(parsed).not.toBeNull();
    const matched = findMatchingNodes([treeFor(c)], parsed!)
      .filter((n) => (n.attributes.get('type') ?? n.attributes.get('class')) === c.type);
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
    // A button filling the same bounds as its text is kept: it carries the state.
    const button = node(T.button, 'Submit', [node(T.text, 'Submit', [], bounds)], { ...bounds, enabled: 'false' });
    const kept = findMatchingNodes([button], parseSelectorString('device.getByText("Submit", { exact: true })')!);
    expect(kept.map((n) => n.attributes.get('type'))).toEqual([T.button]);
    // A container with other bounds still gives way.
    const row = node(T.button, 'Test Screens', [node(T.text, 'Test Screens', [], bounds)], { bounds: '[0,90][400,150]' });
    expect(matchTypes(row, 'device.getByText("Test Screens", { exact: true })')).toEqual([`${T.text}:Test Screens`]);
  });

  it("a generic wrapper echoing an image's or a switch's name gives way to it (PILOT-1366)", () => {
    // React Native's <Image accessibilityLabel>: an Other over the Image, same label and bounds.
    const bounds = { bounds: '[16,518][64,566]' };
    const card = node(T.other, '', [
      node(T.other, 'The Flower Girl', [node(T.image, 'The Flower Girl', [], bounds)], bounds),
      node(T.text, 'The Flower Girl', [], { bounds: '[16,570][125,589]' }),
    ]);
    expect(matchTypes(card, 'device.getByText("The Flower Girl", { exact: true })')).toEqual([`${T.text}:The Flower Girl`]);
    expect(matchTypes(card, 'device.getByText("flower")')).toEqual([`${T.text}:The Flower Girl`]);
    expect(matchTypes(card, 'device.getByText(/^The Flower Girl$/)')).toEqual([`${T.text}:The Flower Girl`]);
    const sw = node(T.other, 'Wi-Fi', [node(T.switch, 'Wi-Fi', [], { ...bounds, value: '1' })], bounds);
    expect(matchTypes(sw, 'device.getByText("Wi-Fi", { exact: true })')).toEqual([]);
    // Other bounds: a container, still text.
    const container = node(T.other, 'The Flower Girl', [node(T.image, 'The Flower Girl', [], bounds)], { bounds: '[0,500][400,600]' });
    expect(matchTypes(container, 'device.getByText("The Flower Girl", { exact: true })')).toEqual([`${T.other}:The Flower Girl`]);
    // A labelled container around the echoing wrapper keeps its match: the
    // echo is no match, so it never takes the container's place.
    const echo = () => node(T.other, 'Avatar', [node(T.image, 'Avatar', [], bounds)], bounds);
    const padded = { bounds: '[0,500][400,600]' };
    expect(matchTypes(node(T.button, 'Avatar', [echo()], padded), 'device.getByText("Avatar", { exact: true })')).toEqual([`${T.button}:Avatar`]);
    expect(matchTypes(node(T.other, 'Avatar', [echo()], padded), 'device.getByText("Avatar", { exact: true })')).toEqual([`${T.other}:Avatar`]);
    expect(matchTypes(node(T.other, 'Gallery, Avatar', [echo()], padded), 'device.getByText("Avatar")')).toEqual([`${T.other}:Gallery, Avatar`]);
    // A button over its icon keeps its label as text.
    const button = node(T.button, 'Share', [node(T.image, 'Share', [], bounds)], bounds);
    expect(matchTypes(button, 'device.getByText("Share", { exact: true })')).toEqual([`${T.button}:Share`]);
    // getByRole still finds the image.
    expect(matchTypes(card, 'device.getByRole("image", { name: "The Flower Girl" })')).toEqual([`${T.image}:The Flower Girl`]);
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

describe('iOS getByText beside a React Native checkbox or radio', () => {
  // React Native's checkbox is a generic view it describes in its value, its
  // own texts hidden inside it: its label is the only copy of a text it
  // shows, and only a name when a match beside it (on its line) shows the text.
  const at = (left: number, top: number, right: number, bottom: number) => ({ bounds: `[${left},${top}][${right},${bottom}]` });
  const checkbox = (label: string, line: number, checked = false) =>
    node(T.other, label, [], { value: `checkbox, ${checked ? 'checked' : 'unchecked'}`, ...at(16, line + 16, 40, line + 40) });
  const row = (title: string, line: number) =>
    node(T.other, '', [checkbox(`Toggle ${title}`, line), node(T.link, title, [], at(52, line + 18, 300, line + 38))], at(0, line, 400, line + 56));
  const list = node(T.other, '', [row('Buy oat milk', 100), row('Walk the dog', 160)]);
  const radio = (size: string, line: number) => node(T.other, size, [], { value: 'radio button, unchecked', ...at(16, line, 386, line + 56) });

  it('a row\'s text beside a checkbox named after it is the text alone', () => {
    expect(matchTypes(list, 'device.getByText("Buy oat milk")')).toEqual([`${T.link}:Buy oat milk`]);
    expect(matchTypes(list, 'device.getByText("Buy oat milk", { exact: true })')).toEqual([`${T.link}:Buy oat milk`]);
    expect(matchTypes(list, 'device.getByText(/oat milk/)')).toEqual([`${T.link}:Buy oat milk`]);
  });

  it('a checkbox labelled with the very text beside it gives way to the text', () => {
    const same = node(T.other, '', [checkbox('Buy oat milk', 100, true), node(T.text, 'Buy oat milk', [], at(52, 118, 300, 138))]);
    expect(matchTypes(same, 'device.getByText("Buy oat milk", { exact: true })')).toEqual([`${T.text}:Buy oat milk`]);
  });

  it('a radio whose text is only inside it keeps the match', () => {
    const radios = node(T.other, '', [radio('Small', 500), radio('Medium', 560)]);
    expect(matchTypes(radios, 'device.getByText("Small", { exact: true })')).toEqual([`${T.other}:Small`]);
  });

  it('a radio keeps its match beside an unrelated text, as Android finds its text too', () => {
    const toggles = node(T.other, '', [
      node(T.other, '', [radio('Medium', 500), node(T.text, 'Size: medium', [], at(400, 518, 520, 538))]),
    ]);
    expect(matchTypes(toggles, 'device.getByText("Medium")')).toEqual([`${T.other}:Medium`, `${T.text}:Size: medium`]);
    expect(matchTypes(toggles, 'device.getByText(/medium/i)')).toEqual([`${T.other}:Medium`, `${T.text}:Size: medium`]);
  });

  it('a radio keeps its match when its text is shown elsewhere on the screen, not beside it', () => {
    const screen = node(T.other, '', [node(T.text, 'Medium', [], at(16, 80, 120, 100)), radio('Medium', 560)]);
    expect(matchTypes(screen, 'device.getByText("Medium", { exact: true })')).toEqual([`${T.text}:Medium`, `${T.other}:Medium`]);
    // A labelled row around the checkbox stays suppressed by it: the summary text isn't beside the checkbox.
    const wrapped = node(T.other, '', [
      node(T.text, 'Buy oat milk', [], at(16, 80, 200, 100)),
      node(T.other, 'Buy oat milk', [checkbox('Toggle Buy oat milk', 500)], at(0, 500, 400, 556)),
    ]);
    expect(matchTypes(wrapped, 'device.getByText("Buy oat milk")')).toEqual([`${T.text}:Buy oat milk`, `${T.other}:Toggle Buy oat milk`]);
  });

  it('a static text\'s value counts as the text it shows', () => {
    const valued = node(T.other, '', [checkbox('Toggle Buy oat milk', 100), node(T.text, '', [], { value: 'Buy oat milk', ...at(52, 118, 300, 138) })]);
    expect(matchTypes(valued, 'device.getByText("oat milk")')).toEqual([`${T.text}:`]);
  });

  it('a match with no bounds is beside nothing', () => {
    const unplaced = node(T.other, '', [checkbox('Toggle Buy oat milk', 100), node(T.link, 'Buy oat milk')]);
    expect(matchTypes(unplaced, 'device.getByText("oat milk")')).toEqual([`${T.other}:Toggle Buy oat milk`, `${T.link}:Buy oat milk`]);
  });

  it('when only checkboxes match, they are all kept', () => {
    expect(matchTypes(list, 'device.getByText("Toggle")')).toEqual([`${T.other}:Toggle Buy oat milk`, `${T.other}:Toggle Walk the dog`]);
  });

  it('nth() counts the matches left', () => {
    expect(matchTypes(list, 'device.getByText(/^(Toggle )?(Buy|Walk)/).nth(1)')).toEqual([`${T.link}:Walk the dog`]);
  });

  it('an undescribed generic view is no checkbox: its label stays text', () => {
    const plain = node(T.other, '', [node(T.other, 'Buy oat milk', [], at(16, 116, 40, 140)), node(T.link, 'Buy oat milk', [], at(52, 118, 300, 138))]);
    expect(matchTypes(plain, 'device.getByText("Buy oat milk", { exact: true })')).toEqual([`${T.other}:Buy oat milk`, `${T.link}:Buy oat milk`]);
  });

  it('getByLabel and getByRole still find the checkbox', () => {
    expect(matchTypes(list, 'device.getByLabel("Toggle Buy oat milk")')).toEqual([`${T.other}:Toggle Buy oat milk`]);
    expect(matchTypes(list, 'device.getByRole("checkbox", { name: "Buy oat milk" })')).toEqual([`${T.other}:Toggle Buy oat milk`]);
  });
});

describe("iOS getByText of a table row's text in edit mode (PILOT-1374)", () => {
  // A recorded UIKit table in edit mode: each row's Remove and Reorder
  // controls are labelled with the row's texts ("Remove A, 981 195, Alpha
  // (a@example.com)"), the same dump the agent's host tests replay.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const table = parseHierarchyXml(readFileSync(
    path.join(repoRoot, 'ios-agent/Tests/Fixtures/iphone-se-18.2/edit-mode-table.xml'), 'utf8',
  ));
  const matchesIn = (code: string) => findMatchingNodes(table, parseSelectorString(code)!)
    .map((n) => `${n.attributes.get('type')}:${n.attributes.get('label')}`);

  it("finds the row's static text, not the controls named by it", () => {
    expect(matchesIn('device.getByText("Alpha (a@example.com)", { exact: true })')).toEqual([`${T.text}:Alpha (a@example.com)`]);
    expect(matchesIn('device.getByText("981 195", { exact: true })')).toEqual(Array(3).fill(`${T.text}:981 195`));
    expect(matchesIn('device.getByText("A", { exact: true })')).toEqual([`${T.text}:A`]);
  });

  it('getByRole still finds the controls by their names', () => {
    expect(matchesIn('device.getByRole("button", { name: "Alpha (a@example.com)", exact: true })'))
      .toEqual([`${T.button}:Remove A, 981 195, Alpha (a@example.com)`, `${T.button}:Reorder A, 981 195, Alpha (a@example.com)`]);
  });

  it("a row's control holding the texts it joins gives way to them, as before", () => {
    const row = node(T.cell, '', [node(T.button, 'Alpha, Beta', [node(T.text, 'Alpha'), node(T.text, 'Beta')])]);
    expect(matchTypes(row, 'device.getByText("Alpha", { exact: true })')).toEqual([`${T.text}:Alpha`]);
    // Its own text inside it is no row text outside it.
    const merged = node(T.cell, '', [node(T.other, 'Alpha, Beta', [node(T.text, 'Alpha')])]);
    expect(matchTypes(merged, 'device.getByText("Beta", { exact: true })')).toEqual([`${T.other}:Alpha, Beta`]);
  });

  it('the nearest row decides', () => {
    // An outer row's text is not the inner row's.
    const nested = node(T.cell, '', [node(T.text, 'Alpha'), node(T.cell, '', [node(T.button, 'Remove Alpha, Alpha')])]);
    expect(matchTypes(nested, 'device.getByText("Alpha", { exact: true })'))
      .toEqual([`${T.text}:Alpha`, `${T.button}:Remove Alpha, Alpha`]);
    const inner = node(T.cell, '', [node(T.cell, '', [node(T.text, 'Alpha'), node(T.button, 'Remove Alpha, Alpha')])]);
    expect(matchTypes(inner, 'device.getByText("Alpha", { exact: true })')).toEqual([`${T.text}:Alpha`]);
  });

  it('outside a table row, a joined part still matches (React Native)', () => {
    const screen = node(T.other, '', [node(T.text, 'Welcome'), node(T.other, 'Intro, Welcome')]);
    expect(matchTypes(screen, 'device.getByText("Welcome", { exact: true })')).toEqual([`${T.text}:Welcome`, `${T.other}:Intro, Welcome`]);
  });
});

describe('iOS getByText is literal about trailing punctuation (PILOT-880)', () => {
  // A confirmation alert titled "Log out?" over the screen whose "Log out"
  // button opened it, and that screen once the alert is dismissed.
  const alert = node(T.other, '', [
    node(T.button, 'Log out'),
    node(T.alert, 'Log out?', [node(T.other, '', [node(T.text, 'Log out?'), node(T.button, 'Cancel'), node(T.button, 'Log out')])]),
  ]);
  const screen = node(T.other, '', [node(T.button, 'Log out')]);

  it('finds the alert title, not the buttons named like it', () => {
    expect(matchTypes(alert, 'device.getByText("Log out?")')).toEqual([`${T.text}:Log out?`]);
    expect(matchTypes(alert, 'device.getByText("Log out?", { exact: true })')).toEqual([`${T.text}:Log out?`]);
  });

  it('finds nothing once the alert is gone', () => {
    expect(matchTypes(screen, 'device.getByText("Log out?")')).toEqual([]);
    expect(matchTypes(screen, 'device.getByText("Log out?", { exact: true })')).toEqual([]);
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

  it('textInputTypes', () => {
    expect(typesOf('textInputTypes')).toEqual([...IOS_TEXT_INPUT_TYPES].sort());
  });
});
