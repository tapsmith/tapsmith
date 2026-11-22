// ─── iOS text content (PILOT-794) ───
//
// Which iOS element types' label and value are what getByText reads — the iOS
// agent's TextContent.swift sets, which text-content-conformance.test.ts pins
// to that source. The trace viewer's offline matcher
// (trace-viewer/components/text-content.ts) and the strict-mode locator
// suggestions share them.

// An image's label is its alt text (PILOT-1366).
/** Controls and images whose label is their accessible name, not text on screen (getByRole finds them; getByLabel the controls). */
export const IOS_NAME_ONLY_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeSwitch',
  'XCUIElementTypeToggle',
  'XCUIElementTypeSlider',
  'XCUIElementTypeStepper',
  'XCUIElementTypeImage',
]);

/** Element types whose value is the text they show (a picker wheel's selected row is only its value). */
export const IOS_VALUE_TEXT_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeStaticText',
  'XCUIElementTypePickerWheel',
  // A picker wheel as dumps recorded before the agent named it write it.
  'XCUIElementType(39)',
]);

/**
 * Text inputs, whose value is text only while it is the placeholder an empty
 * field shows: a typed value is no text, as an `<input>`'s value is not in
 * Playwright (an Android EditText's typed value is not either).
 */
export const IOS_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextView',
  'XCUIElementTypeSearchField',
]);

/**
 * Whether an iOS element is a text input, by its type and its role (the
 * dump's `tapsmith-role`, a found element's `role`): a text view that can't
 * be edited is text on screen, which the agent reports by a role other than
 * `textfield`.
 */
export function isIosTextInput(type: string, role: string | undefined): boolean {
  return IOS_TEXT_INPUT_TYPES.has(type) && (type !== 'XCUIElementTypeTextView' || role === 'textfield');
}

/**
 * The value an iOS node's text content holds: its value for a type whose
 * value is text (and a read-only text view), for a text input only the
 * placeholder it shows when empty (its value equals its placeholder), else ''.
 */
export function iosTextValue(type: string, role: string | undefined, value: string, placeholder: string): string {
  if (IOS_VALUE_TEXT_TYPES.has(type)) return value;
  if (isIosTextInput(type, role)) return value !== '' && value === placeholder ? value : '';
  if (type === 'XCUIElementTypeTextView') return value;
  return '';
}
