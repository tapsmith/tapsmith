/**
 * Native role names for `getByRole()` and `toHaveRole()` (PILOT-556).
 *
 * Browser-safe (no Node imports): the trace viewer / UI-mode locator
 * playground imports it too, so a role the playground accepts is exactly one
 * a test can use.
 *
 * **Parity contract:** `NATIVE_ROLES` is the union of the Android agent's
 * `roleClassMap` keys and `TRAIT_ONLY_ROLES` (`agent/.../ElementFinder.kt`)
 * and the iOS agent's `RoleMapping.roleToElementTypes` keys, and
 * `ROLE_ALIASES` matches both agents' alias maps. `roles.test.ts` reads the
 * agents' sources and fails on drift; the role table in `docs/locators.md`
 * is pinned to this list by `role-docs.test.ts`.
 *
 * WebView locators (`webview.getByRole`) query DOM ARIA roles and are not
 * checked against this list.
 */

// ─── Role set ───

/** Canonical native role names, sorted. */
export const NATIVE_ROLES: readonly string[] = [
  'alert',
  'button',
  'checkbox',
  'combobox',
  'heading',
  'image',
  'link',
  'list',
  'listitem',
  'menu',
  'menubar',
  'menuitem',
  'progressbar',
  'radiobutton',
  'radiogroup',
  'scrollbar',
  'scrollview',
  'searchfield',
  'seekbar',
  'spinbutton',
  'spinner',
  'summary',
  'switch',
  'tab',
  'tablist',
  'text',
  'textfield',
  'timer',
  'toolbar',
];

/**
 * Cross-platform aliases: the React Native spelling → the canonical role.
 * Both agents normalize these the same way.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  header: 'heading',
  slider: 'seekbar',
  // React Native's spelling of the search field role. On Android RN
  // publishes nothing for it (the field is a plain EditText, so a
  // "textfield"); on iOS it is the search-field trait.
  search: 'searchfield',
  // React Native's and ARIA's spelling of a radio button (PILOT-664).
  radio: 'radiobutton',
};

/**
 * Playwright ARIA (and React Native) role names whose native counterpart has
 * another name, so a test ported from Playwright gets pointed at the right one.
 */
const ARIA_ROLE_HINTS: Readonly<Record<string, string>> = {
  textbox: 'textfield',
  img: 'image',
  searchbox: 'searchfield',
  // React Native's togglebutton is a button on both platforms, as an ARIA
  // toggle button is (PILOT-664).
  togglebutton: 'button',
};

/**
 * Android class names per role — the agent's `roleClassMap`
 * (`agent/.../ElementFinder.kt`), which `roles.test.ts` pins. Roles the agent
 * resolves only from an RN role description (`ANDROID_TRAIT_ONLY_ROLES`) have
 * none.
 */
export const ANDROID_ROLE_CLASSES: Readonly<Record<string, readonly string[]>> = {
  button: [
    'android.widget.Button',
    'android.widget.ImageButton',
    'android.widget.ToggleButton',
    'com.google.android.material.button.MaterialButton',
    'androidx.appcompat.widget.AppCompatButton',
  ],
  textfield: [
    'android.widget.EditText',
    'android.widget.AutoCompleteTextView',
    'com.google.android.material.textfield.TextInputEditText',
    'androidx.appcompat.widget.AppCompatEditText',
  ],
  checkbox: [
    'android.widget.CheckBox',
    'androidx.appcompat.widget.AppCompatCheckBox',
    'com.google.android.material.checkbox.MaterialCheckBox',
  ],
  switch: [
    'android.widget.Switch',
    'androidx.appcompat.widget.SwitchCompat',
    'com.google.android.material.switchmaterial.SwitchMaterial',
  ],
  image: [
    'android.widget.ImageView',
    'androidx.appcompat.widget.AppCompatImageView',
  ],
  text: [
    'android.widget.TextView',
    'androidx.appcompat.widget.AppCompatTextView',
    'com.google.android.material.textview.MaterialTextView',
  ],
  heading: ['android.widget.TextView'],
  link: ['android.widget.TextView'],
  list: [
    'android.widget.ListView',
    'android.widget.GridView',
    'androidx.recyclerview.widget.RecyclerView',
  ],
  listitem: [
    'android.widget.LinearLayout',
    'android.widget.RelativeLayout',
    'android.widget.FrameLayout',
  ],
  scrollview: [
    'android.widget.ScrollView',
    'android.widget.HorizontalScrollView',
    'androidx.core.widget.NestedScrollView',
  ],
  progressbar: [
    'android.widget.ProgressBar',
    'com.google.android.material.progressindicator.LinearProgressIndicator',
    'com.google.android.material.progressindicator.CircularProgressIndicator',
  ],
  seekbar: [
    'android.widget.SeekBar',
    'com.google.android.material.slider.Slider',
  ],
  radiobutton: [
    'android.widget.RadioButton',
    'androidx.appcompat.widget.AppCompatRadioButton',
    'com.google.android.material.radiobutton.MaterialRadioButton',
  ],
  spinner: [
    'android.widget.Spinner',
    'androidx.appcompat.widget.AppCompatSpinner',
  ],
  toolbar: [
    'android.widget.Toolbar',
    'androidx.appcompat.widget.Toolbar',
    'com.google.android.material.appbar.MaterialToolbar',
  ],
  tab: [
    'android.widget.TabWidget',
    'com.google.android.material.tabs.TabLayout',
  ],
  searchfield: [
    'android.widget.SearchView',
    'androidx.appcompat.widget.SearchView',
  ],
};

/**
 * Android roles the agent also resolves from a published role description
 * (React Native's `accessibilityRole`, Compose's `Role`) — the agent's
 * `DUAL_PATH_ROLES`, which `roles.test.ts` pins. A node with a description
 * matches only through it; one without falls back to the role's classes.
 * RN renders tab, progressbar and toolbar as a generic View with only a
 * description (PILOT-656).
 */
export const ANDROID_DUAL_PATH_ROLES: ReadonlySet<string> = new Set([
  'heading', 'link', 'image', 'searchfield', 'tab', 'progressbar', 'toolbar',
]);

/**
 * Android roles the agent resolves only from a role description (no class) —
 * the agent's `TRAIT_ONLY_ROLES`, which `roles.test.ts` pins. React Native
 * renders each as a generic android.view.View whose role description names
 * it ("Menu Item", "Timer"); PILOT-664 added the menu, radiogroup, scrollbar,
 * spinbutton, summary, tablist and timer families.
 */
export const ANDROID_TRAIT_ONLY_ROLES: ReadonlySet<string> = new Set([
  'alert', 'combobox', 'menu', 'menubar', 'menuitem', 'radiogroup', 'scrollbar', 'spinbutton', 'summary', 'tablist', 'timer',
]);

/**
 * iOS element types per role — the agent's `RoleMapping.roleToElementTypes`
 * without `.other` (a generic view, which the agent narrows by trait or name),
 * as the `XCUIElementType…` names hierarchy dumps use. `roles.test.ts` pins it.
 */
export const IOS_ROLE_TYPES: Readonly<Record<string, readonly string[]>> = {
  button: ['XCUIElementTypeButton'],
  textfield: ['XCUIElementTypeTextField', 'XCUIElementTypeSecureTextField'],
  checkbox: ['XCUIElementTypeCheckBox'],
  switch: ['XCUIElementTypeSwitch', 'XCUIElementTypeToggle'],
  image: ['XCUIElementTypeImage'],
  text: ['XCUIElementTypeStaticText'],
  heading: ['XCUIElementTypeStaticText'],
  link: ['XCUIElementTypeLink'],
  list: ['XCUIElementTypeTable', 'XCUIElementTypeCollectionView'],
  listitem: ['XCUIElementTypeCell'],
  scrollview: ['XCUIElementTypeScrollView'],
  progressbar: ['XCUIElementTypeProgressIndicator'],
  seekbar: ['XCUIElementTypeSlider'],
  radiobutton: ['XCUIElementTypeRadioButton'],
  spinner: ['XCUIElementTypePicker', 'XCUIElementTypeActivityIndicator'],
  toolbar: ['XCUIElementTypeToolbar'],
  tab: ['XCUIElementTypeTab', 'XCUIElementTypeTabBar'],
  searchfield: ['XCUIElementTypeSearchField'],
};

/**
 * The role descriptions React Native leads an iOS generic view's
 * accessibility value with ("checkbox, unchecked") — the agent's
 * `RoleMapping.otherRoleDescriptions`, which `roles.test.ts` pins. Each marks
 * the view as its role and as no other generic-view role.
 */
export const IOS_OTHER_ROLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  checkbox: 'checkbox',
  radiobutton: 'radio button',
  alert: 'alert',
  combobox: 'combo box',
};

/**
 * React Native's other iOS generic-view roles, which only a named query finds
 * — the agent's `RoleMapping.undescribedOtherRoles` (PILOT-664). RN's new
 * architecture publishes no description for them.
 */
export const IOS_UNDESCRIBED_OTHER_ROLES: ReadonlySet<string> = new Set([
  'menu', 'menubar', 'menuitem', 'radiogroup', 'scrollbar', 'spinbutton', 'summary', 'tablist', 'timer',
]);

const KNOWN = new Set(NATIVE_ROLES);

// ─── Helpers ───

/** Lowercase a role and resolve an alias to its canonical name. */
export function normalizeRole(role: string): string {
  const lower = role.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
}

/**
 * The error message for a role no element can have, or `null` when the role
 * is known. Matching is case-insensitive, like the agents.
 */
export function unknownRoleMessage(role: string): string | null {
  if (KNOWN.has(normalizeRole(role))) return null;
  const hint = ARIA_ROLE_HINTS[role.toLowerCase()];
  const aliases = Object.entries(ROLE_ALIASES).map(([alias, canonical]) => `${alias} → ${canonical}`).join(', ');
  return `Unknown role ${JSON.stringify(role)}.${hint ? ` Did you mean "${hint}"?` : ''} ` +
    `Supported: ${NATIVE_ROLES.join(', ')} (aliases: ${aliases}). ` +
    'For an element with no supported role, use getByText(), getByTestId() or getByDescription().';
}

/**
 * Throw when `role` is not a native role name. `what` names the API for the
 * TypeError a non-string gets (tests run through tsx are not type-checked).
 */
export function assertKnownRole(role: unknown, what: string): asserts role is string {
  if (typeof role !== 'string') {
    const got = role === null || role === undefined ? String(role) : `a ${typeof role}`;
    throw new TypeError(`${what} expects a role name string, got ${got}.`);
  }
  const message = unknownRoleMessage(role);
  if (message) throw new Error(message);
}

/**
 * Whether an iOS generic view (`XCUIElementTypeOther`) is `role` (canonical)
 * the way the agent's `RoleMapping.matches` decides it, or `undefined` for a
 * role it doesn't match this way. `value` is the view's accessibility value,
 * `traitRole` the role its traits give it (the dump's `tapsmith-role`), and
 * `named` whether the query has a name: a generic view no description marks
 * is then identified by that name (PILOT-608, PILOT-664).
 */
export function iosGenericViewHasRole(
  role: string,
  view: { value: string | undefined; traitRole: string; named: boolean },
): boolean | undefined {
  const own = IOS_OTHER_ROLE_DESCRIPTIONS[role];
  if (own === undefined && !IOS_UNDESCRIBED_OTHER_ROLES.has(role)) return undefined;
  const lead = view.value === undefined ? undefined : view.value.split(',')[0]!.trim().toLowerCase();
  if (lead !== undefined && Object.values(IOS_OTHER_ROLE_DESCRIPTIONS).includes(lead)) return lead === own;
  return view.named && view.traitRole === '';
}
