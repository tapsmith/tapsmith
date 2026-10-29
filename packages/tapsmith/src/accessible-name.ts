// ─── Placeholder Names (PILOT-834) ───

/**
 * The iOS element types whose getByRole name falls back to the placeholder
 * when their label and title are empty — the iOS agent's
 * `RoleName.placeholderNamedTypes`, pinned by role-conformance.test.ts.
 * Playwright names an input with no label by its placeholder; SwiftUI's
 * `TextField("Title", text:)` publishes an empty label and "Title" only as
 * its placeholder.
 */
export const IOS_PLACEHOLDER_NAMED_TYPES: ReadonlySet<string> = new Set([
  'XCUIElementTypeTextField',
  'XCUIElementTypeSecureTextField',
  'XCUIElementTypeSearchField',
  'XCUIElementTypeTextView',
]);

/** The Android agent's EDIT_TEXT_HINT_CLASS_PATTERN: the classes that carry a hint. */
export const ANDROID_EDIT_TEXT_CLASSES: ReadonlySet<string> = new Set([
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'com.google.android.material.textfield.TextInputEditText',
  'androidx.appcompat.widget.AppCompatEditText',
]);

/** Whether a class (Android) or element type (iOS) is a text input a placeholder can name. */
function isPlaceholderNamedClass(className: string): boolean {
  return IOS_PLACEHOLDER_NAMED_TYPES.has(className) || ANDROID_EDIT_TEXT_CLASSES.has(className);
}

/**
 * A found element's accessible name, as `toHaveAccessibleName` reads it: its
 * content description (iOS: label or title); else, for a text input, its
 * placeholder — a field's text is its typed value, not its name —
 * and for anything else, its text.
 */
export function elementAccessibleName(el: {
  className: string; contentDescription: string; text: string; hint: string;
}): string {
  if (el.contentDescription.trim()) return el.contentDescription;
  if (isPlaceholderNamedClass(el.className) && el.hint) return el.hint;
  return el.text;
}
