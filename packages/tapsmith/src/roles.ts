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

const NATIVE_ROLE_NAMES = [
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
] as const;

/** A canonical native role name, as `getByRole()` and `toHaveRole()` take it. */
export type NativeRole = typeof NATIVE_ROLE_NAMES[number];

/** Canonical native role names, sorted. */
export const NATIVE_ROLES: readonly string[] = NATIVE_ROLE_NAMES;

/**
 * Cross-platform aliases: the React Native spelling → the canonical role.
 * Both agents normalize these the same way.
 */
const ROLE_ALIAS_MAP = {
  header: 'heading',
  slider: 'seekbar',
  // React Native's spelling of the search field role. On Android RN
  // publishes nothing for it (the field is a plain EditText, so a
  // "textfield"); on iOS it is the search-field trait.
  search: 'searchfield',
  // React Native's and ARIA's spelling of a radio button (PILOT-664).
  radio: 'radiobutton',
} as const satisfies Record<string, NativeRole>;

/** Cross-platform role aliases (React Native spellings), by alias. */
export const ROLE_ALIASES: Readonly<Record<string, string>> = ROLE_ALIAS_MAP;

/**
 * A role name `getByRole()` and `toHaveRole()` accept: a native role or one of
 * its React Native aliases (`header`, `slider`, `search`, `radio`). Matching is
 * case-insensitive. `getByRole()` throws at once on an unknown role, with the
 * supported list.
 */
export type Role = NativeRole | keyof typeof ROLE_ALIAS_MAP;

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
  // The tab containers; a tab item is known only by its description
  // (PILOT-514).
  tablist: [
    'android.widget.TabWidget',
    'com.google.android.material.tabs.TabLayout',
  ],
  searchfield: [
    'android.widget.SearchView',
    'androidx.appcompat.widget.SearchView',
  ],
  // React Native's generic-view roles that also have a framework widget
  // (PILOT-702).
  radiogroup: ['android.widget.RadioGroup'],
  spinbutton: ['android.widget.NumberPicker'],
  timer: ['android.widget.Chronometer'],
};

/**
 * Android roles the agent also resolves from a published role description
 * (React Native's `accessibilityRole`, Compose's `Role`) — the agent's
 * `DUAL_PATH_ROLES`, which `roles.test.ts` pins. A node with a description
 * matches only through it; one without falls back to the role's classes.
 * RN renders progressbar, toolbar and tablist as a generic View with only a
 * description (PILOT-656, PILOT-514), and Compose its Switch (PILOT-828).
 * PILOT-664's radiogroup, spinbutton and timer are RN descriptions beside a
 * framework widget (RadioGroup, NumberPicker, Chronometer; PILOT-702).
 */
export const ANDROID_DUAL_PATH_ROLES: ReadonlySet<string> = new Set([
  'heading', 'link', 'image', 'searchfield', 'progressbar', 'toolbar', 'tablist', 'switch',
  'radiogroup', 'spinbutton', 'timer',
]);

/**
 * Android roles the agent resolves only from a role description (no class) —
 * the agent's `TRAIT_ONLY_ROLES`, which `roles.test.ts` pins. React Native
 * renders each as a generic android.view.View whose role description names
 * it ("Menu Item", "Scroll Bar"); PILOT-664 added the menu, scrollbar and
 * summary families (its radiogroup, spinbutton and timer also have a widget,
 * so they are dual-path). A tab item is one too: RN, Material and Compose all
 * publish "Tab" on a generic layout (PILOT-514).
 */
export const ANDROID_TRAIT_ONLY_ROLES: ReadonlySet<string> = new Set([
  'alert', 'combobox', 'menu', 'menubar', 'menuitem', 'scrollbar', 'summary', 'tab',
]);

/**
 * iOS element types per role — the agent's `RoleMapping.roleToElementTypes`
 * without `.other` (a generic view, which the agent narrows by trait or name),
 * as the `XCUIElementType…` names hierarchy dumps use. `roles.test.ts` pins it.
 * A tab bar's items are buttons the agent reports as "tab" (`tapsmith-role`)
 * from their tab-bar ancestor, which no type can say (PILOT-514).
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
  // An indeterminate ProgressView is an activity indicator: a progressbar,
  // as on Android, that still matches spinner (PILOT-797).
  progressbar: ['XCUIElementTypeProgressIndicator', 'XCUIElementTypeActivityIndicator'],
  seekbar: ['XCUIElementTypeSlider'],
  radiobutton: ['XCUIElementTypeRadioButton'],
  spinner: ['XCUIElementTypePicker', 'XCUIElementTypeActivityIndicator'],
  toolbar: ['XCUIElementTypeToolbar'],
  tab: ['XCUIElementTypeTab'],
  searchfield: ['XCUIElementTypeSearchField'],
  tablist: ['XCUIElementTypeTabBar'],
  // React Native's generic-view roles that also have a native type
  // (PILOT-702): a UIMenu and its items, a Stepper.
  menu: ['XCUIElementTypeMenu'],
  menubar: ['XCUIElementTypeMenuBar'],
  menuitem: ['XCUIElementTypeMenuItem'],
  radiogroup: ['XCUIElementTypeRadioGroup'],
  spinbutton: ['XCUIElementTypeStepper'],
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

/**
 * The generic-view roles an iOS static text also takes — the agent's
 * `RoleMapping.staticTextRoles` (PILOT-718), which `roles.test.ts` pins. React
 * Native's `<Text accessibilityRole="alert">` is plain static text on iOS, so
 * it is matched as a generic view is: by a description or a named query.
 */
export const IOS_STATIC_TEXT_ROLES: ReadonlySet<string> = new Set(['alert']);

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
  const described = iosDescribedRole(view.value);
  if (described) return described === role;
  return view.named && view.traitRole === '';
}

/**
 * The role an iOS generic view's accessibility value describes (`checkbox`
 * for "checkbox, unchecked"), or '' — read as the agent reads it: only the
 * first comma-separated part counts, since the states and the app's own
 * value text follow it.
 */
export function iosDescribedRole(value: string | undefined): string {
  if (value === undefined) return '';
  const lead = value.split(',')[0]!.trim().toLowerCase();
  return Object.entries(IOS_OTHER_ROLE_DESCRIPTIONS).find(([, description]) => description === lead)?.[0] ?? '';
}

/**
 * What to add to a "not found" failure of `getByRole(role)` with no name on
 * iOS, for a role React Native publishes nothing for there — alert, combobox
 * and the undescribed generic-view roles but tablist — so the miss is explained instead of
 * looking like a flaky screen (PILOT-718). For a role that also has a native
 * iOS type (a Stepper is a spinbutton, PILOT-702) it says the name is needed
 * only for the React Native view. Empty in every other case. Leads with a
 * space, ready to append to a sentence.
 */
export function iosUnnamedRoleMissHint(
  role: { role: string; name: string; nameRegex?: unknown },
  platform: 'android' | 'ios' | undefined,
): string {
  if (platform !== 'ios' || role.name !== '' || role.nameRegex !== undefined) return '';
  const canonical = normalizeRole(role.role);
  // tablist is left out: the agent matches a native tab bar without a name.
  const nameOnly = canonical === 'alert' || canonical === 'combobox'
    || (IOS_UNDESCRIBED_OTHER_ROLES.has(canonical) && canonical !== 'tablist');
  if (!nameOnly) return '';
  const quoted = JSON.stringify(role.role);
  const native = IOS_ROLE_TYPES[canonical]?.map((t) => t.replace(/^XCUIElementType/, '')).join(' or ');
  const unnamed = native ? ` (a native ${native} matches without one)` : '';
  return ` On iOS, React Native publishes no ${quoted} role that getByRole(${quoted}) can see without a name${unnamed}: ` +
    `pass the element's name — getByRole(${quoted}, { name: "…" }) — or use getByText() or getByTestId().`;
}
