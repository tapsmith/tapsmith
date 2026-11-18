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

// ─── The iOS back button's name (PILOT-1260) ───

/**
 * The name the iOS agent gives the system back button (`BackButton`) when it
 * has no label or title — the agent's `RoleName.backButtonName`. The iPhone
 * Duo simulator publishes its back button with no label; VoiceOver reads a
 * back button with no title as "Back". A labelled one (the previous screen's
 * title, on other devices) is named by its label alone.
 */
export const IOS_BACK_BUTTON_NAME = 'Back';

/**
 * {@link IOS_BACK_BUTTON_NAME} when an iOS element is the system back button
 * with no label or title, else ''.
 */
export function iosBackButtonName(el: { type: string; identifier: string; label: string; title: string }): string {
  return el.type === 'XCUIElementTypeButton' && el.identifier === 'BackButton'
    && !el.label.trim() && !el.title.trim()
    ? IOS_BACK_BUTTON_NAME
    : '';
}

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
 * iOS element types whose text is their content, never their name: a table
 * row's text is joined from its descendants (PILOT-895), but the iOS agent
 * names an element by its label, title or placeholder only, as Playwright
 * names a listitem by its author alone.
 */
const IOS_CONTENT_NOT_NAME_TYPES: ReadonlySet<string> = new Set(['XCUIElementTypeCell']);

/**
 * A found element's accessible name, as `toHaveAccessibleName` reads it: its
 * content description (iOS: label or title); else, for a text input, its
 * placeholder — a field's text is its typed value, not its name —
 * for an unlabelled iOS back button "Back" ({@link iosBackButtonName}),
 * and for anything else but an iOS table row, its text.
 */
export function elementAccessibleName(el: {
  className: string; contentDescription: string; text: string; hint: string; resourceId: string;
}): string {
  if (el.contentDescription.trim()) return el.contentDescription;
  if (isPlaceholderNamedClass(el.className) && el.hint) return el.hint;
  if (IOS_CONTENT_NOT_NAME_TYPES.has(el.className)) return '';
  const back = iosBackButtonName({ type: el.className, identifier: el.resourceId, label: el.text, title: '' });
  return back || el.text;
}
