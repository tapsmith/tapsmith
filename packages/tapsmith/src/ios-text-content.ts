// ─── iOS text content (PILOT-794) ───
//
// Which iOS element types' label and value are what getByText reads — the iOS
// agent's TextContent.swift sets, which text-content-conformance.test.ts pins
// to that source. The trace viewer's offline matcher
// (trace-viewer/components/text-content.ts) and the strict-mode locator
// suggestions share them.

/** Controls whose label is their accessible name, not text on screen (getByLabel / getByRole find them). */
export const IOS_NAME_ONLY_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeSwitch',
  'XCUIElementTypeToggle',
  'XCUIElementTypeSlider',
  'XCUIElementTypeStepper',
]);

/** Element types whose value is the text they show. */
export const IOS_VALUE_TEXT_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeStaticText',
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeTextView',
  'XCUIElementTypeSearchField',
]);
