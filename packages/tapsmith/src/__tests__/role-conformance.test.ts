import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { ANDROID_EDIT_TEXT_CLASSES, IOS_PLACEHOLDER_NAMED_TYPES } from '../accessible-name.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { escapeJsString } from '../js-string-escape.js';
import { translateRegex } from '../text-regex.js';

/**
 * getByRole conformance (PILOT-834, PILOT-707): which elements have a role,
 * and how a role's `name` matches. Each case is one element and one getByRole
 * query, with the agent's answer. The TypeScript playground matcher (the
 * offline trace playground's) is checked here; the iOS agent's RoleMapping and
 * RoleName replay the iOS cases (ios-agent/Tests/RoleNameTests), and the
 * Android agent's ElementFinder the Android ones (agent LocatorConformanceTest),
 * from `fixtures/role-conformance.json`. Regenerate the fixture after changing a
 * case with `UPDATE_ROLE_FIXTURE=1 npx vitest run src/__tests__/role-conformance.test.ts`.
 *
 * `reportedRole` is the role the agent's hierarchy dump writes for the element
 * (`tapsmith-role`), which is all the playground knows of its traits or
 * published role description: iOS RoleMapping.resolveRole of its type, traits
 * and tab-bar ancestry; Android FindRules.publishedRole of its heading flag and
 * role description. Each agent's replay checks it too.
 *
 * The placeholder rows: Playwright names an input with no label by its
 * placeholder; so do the agents: an iOS text input whose label and title are
 * empty is named by its placeholderValue, an Android EditText with no
 * content-desc and no text but its typed value by its hint. A labelled field
 * stays named by its label alone — the placeholder is a fallback, not another
 * name.
 */

interface Case {
  why: string
  platform: 'ios' | 'android'
  /** iOS element type name, or Android class name. */
  type: string
  role: string
  /** The role the hierarchy dump reports for the element (`tapsmith-role`); none when absent. */
  reportedRole?: string
  label?: string
  title?: string
  /** iOS: the accessibility value — React Native leads a generic view's with its role ("checkbox, unchecked"). */
  value?: string
  /** iOS: the UIAccessibilityTraits the element carries, by name (RoleMapping's AccessibilityTrait). */
  traits?: string[]
  /** iOS: whether the element is inside a tab bar. */
  inTabBar?: boolean
  placeholder?: string
  contentDesc?: string
  /** Android: the node's text (an empty EditText reports its hint here). */
  text?: string
  /** Android: the role description the app published (AccessibilityNodeInfoCompat), as published. */
  roleDescription?: string
  /** Android: the node's heading flag (React Native's accessibilityRole="header"). */
  heading?: boolean
  /** Android: the text of the node's children, each a TextView (an RN Pressable's label). */
  childTexts?: string[]
  /** A string name, a RegExp as source + flags, or none. */
  name?: string | { source: string; flags: string }
  exact?: boolean
  matches: boolean
}

const I = {
  button: 'XCUIElementTypeButton',
  other: 'XCUIElementTypeOther',
  text: 'XCUIElementTypeStaticText',
  field: 'XCUIElementTypeTextField',
  link: 'XCUIElementTypeLink',
  image: 'XCUIElementTypeImage',
  slider: 'XCUIElementTypeSlider',
  switch: 'XCUIElementTypeSwitch',
  toggle: 'XCUIElementTypeToggle',
  search: 'XCUIElementTypeSearchField',
  tab: 'XCUIElementTypeTab',
  tabBar: 'XCUIElementTypeTabBar',
  checkBox: 'XCUIElementTypeCheckBox',
  stepper: 'XCUIElementTypeStepper',
  progress: 'XCUIElementTypeProgressIndicator',
  activity: 'XCUIElementTypeActivityIndicator',
  cell: 'XCUIElementTypeCell',
  table: 'XCUIElementTypeTable',
} as const;

const A = {
  button: 'android.widget.Button',
  imageButton: 'android.widget.ImageButton',
  toggleButton: 'android.widget.ToggleButton',
  materialButton: 'com.google.android.material.button.MaterialButton',
  viewGroup: 'android.view.ViewGroup',
  view: 'android.view.View',
  textView: 'android.widget.TextView',
  imageView: 'android.widget.ImageView',
  editText: 'android.widget.EditText',
  checkBox: 'android.widget.CheckBox',
  switch: 'android.widget.Switch',
  switchCompat: 'androidx.appcompat.widget.SwitchCompat',
  seekBar: 'android.widget.SeekBar',
  radioButton: 'android.widget.RadioButton',
  searchView: 'android.widget.SearchView',
  spinner: 'android.widget.Spinner',
  progressBar: 'android.widget.ProgressBar',
  radioGroup: 'android.widget.RadioGroup',
  numberPicker: 'android.widget.NumberPicker',
  chronometer: 'android.widget.Chronometer',
  recyclerView: 'androidx.recyclerview.widget.RecyclerView',
  scrollView: 'android.widget.ScrollView',
  tabLayout: 'com.google.android.material.tabs.TabLayout',
  linearLayout: 'android.widget.LinearLayout',
} as const;

const NBSP = '\u00a0';

const CASES: Case[] = [
  // iOS: a SwiftUI TextField("Title", text:) has an empty label and the text as its placeholder.
  { why: 'a label-less field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Title', name: 'Title', matches: true },
  { why: 'a placeholder name is a case-insensitive substring', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Email address', name: 'email', matches: true },
  { why: 'exact compares the placeholder whole', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Title', name: 'Title', exact: true, matches: true },
  { why: 'exact is case-sensitive on the placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Title', name: 'title', exact: true, matches: false },
  { why: 'exact does not split a placeholder at ", "', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'City, State', name: 'City', exact: true, matches: false },
  { why: 'a RegExp tests the placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Title', name: { source: '^tit', flags: 'i' }, matches: true },
  { why: 'a RegExp tests only the placeholder, not the empty label', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Email address', name: { source: '^(?!.*email)', flags: 'i' }, matches: false },
  { why: 'a secure field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeSecureTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Password', name: 'Password', matches: true },
  { why: 'a search field is named by its placeholder', platform: 'ios', type: 'XCUIElementTypeSearchField', reportedRole: 'searchfield', role: 'searchfield', label: '', placeholder: 'Search', name: 'Search', matches: true },
  { why: 'a whitespace-only label is no label', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: ' ', placeholder: 'Title', name: 'Title', matches: true },
  { why: 'NBSP in the placeholder is a space', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: 'Full name', name: 'Full name', exact: true, matches: true },
  { why: 'a labelled field is not named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: 'example', matches: false },
  { why: 'a labelled field is still named by its label', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: 'Email', matches: true },
  { why: 'a RegExp does not test a labelled field\'s placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: 'Email', placeholder: 'name@example.com', name: { source: 'example', flags: '' }, matches: false },
  { why: 'a titled field is not named by its placeholder', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', title: 'Email', placeholder: 'Your email', name: 'Your', matches: false },
  { why: 'no label, title or placeholder, no name', platform: 'ios', type: 'XCUIElementTypeTextField', reportedRole: 'textfield', role: 'textfield', label: '', placeholder: '', name: 'Title', matches: false },
  { why: 'a button is not named by a placeholder', platform: 'ios', type: 'XCUIElementTypeButton', reportedRole: 'button', role: 'button', label: '', placeholder: 'Go', name: 'Go', matches: false },

  // Android: an empty EditText reports its hint as its text; a typed one keeps the hint as its name.
  { why: 'an empty EditText is named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'Email', placeholder: 'Email', name: 'Email', matches: true },
  { why: 'a typed EditText is still named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'sam@example.com', placeholder: 'Email', name: 'Email', matches: true },
  { why: 'a typed EditText\'s hint is a case-insensitive substring', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'x', placeholder: 'Email address', name: 'email', matches: true },
  { why: 'a RegExp tests a typed EditText\'s hint', platform: 'android', type: 'com.google.android.material.textfield.TextInputEditText', role: 'textfield', text: 'x', placeholder: 'Email', name: { source: '^e', flags: 'i' }, matches: true },
  { why: 'a RegExp tests only a typed EditText\'s hint, not its empty description', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: '', text: 'x', placeholder: 'Email address', name: { source: '^(?!.*email)', flags: 'i' }, matches: false },
  { why: 'a described EditText is not named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: 'Email', text: 'x', placeholder: 'Phone', name: 'Phone', matches: false },
  { why: 'an empty described EditText is not named by its hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: 'Full name', text: 'Your name', placeholder: 'Your name', name: 'Your name', matches: false },
  { why: 'a RegExp does not test an empty described EditText\'s hint', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: 'Full name', text: 'Your name', placeholder: 'Your name', name: { source: 'your', flags: 'i' }, matches: false },
  { why: 'an empty described EditText is named by its description', platform: 'android', type: 'android.widget.EditText', role: 'textfield', contentDesc: 'Full name', text: 'Your name', placeholder: 'Your name', name: 'Full name', matches: true },
  { why: 'a typed value is still not a substring name', platform: 'android', type: 'android.widget.EditText', role: 'textfield', text: 'email me later', placeholder: 'Notes', name: 'email', matches: false },

  // ─── Which elements have the role ───

  // iOS: an element type, a trait, or (React Native's generic views) a role description or a name.
  { why: 'a button by its type', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', matches: true },
  { why: 'a role is case-insensitive', platform: 'ios', type: I.button, reportedRole: 'button', role: 'BUTTON', matches: true },
  { why: 'a generic view with the button trait (an RN Pressable)', platform: 'ios', type: I.other, traits: ['button'], reportedRole: 'button', role: 'button', matches: true },
  { why: 'a generic view without one is no button', platform: 'ios', type: I.other, role: 'button', matches: false },
  { why: 'a heading is the header trait', platform: 'ios', type: I.text, traits: ['header'], reportedRole: 'heading', role: 'heading', matches: true },
  { why: 'on any element type', platform: 'ios', type: I.other, traits: ['header'], reportedRole: 'heading', role: 'heading', matches: true },
  { why: 'by its React Native spelling', platform: 'ios', type: I.text, traits: ['header'], reportedRole: 'heading', role: 'header', matches: true },
  { why: 'static text alone is no heading', platform: 'ios', type: I.text, reportedRole: 'text', role: 'heading', matches: false },
  { why: 'static text is text', platform: 'ios', type: I.text, reportedRole: 'text', role: 'text', matches: true },
  { why: 'a link by its type', platform: 'ios', type: I.link, reportedRole: 'link', role: 'link', matches: true },
  { why: 'a generic view with the link trait', platform: 'ios', type: I.other, traits: ['link'], reportedRole: 'link', role: 'link', matches: true },
  { why: 'an image by its type', platform: 'ios', type: I.image, reportedRole: 'image', role: 'image', matches: true },
  { why: 'a generic view with the image trait', platform: 'ios', type: I.other, traits: ['image'], reportedRole: 'image', role: 'image', matches: true },
  { why: 'a slider is a seekbar', platform: 'ios', type: I.slider, reportedRole: 'seekbar', role: 'seekbar', matches: true },
  { why: 'by its React Native spelling', platform: 'ios', type: I.slider, reportedRole: 'seekbar', role: 'slider', matches: true },
  { why: 'a generic view with the adjustable trait is a seekbar', platform: 'ios', type: I.other, traits: ['adjustable'], reportedRole: 'seekbar', role: 'seekbar', matches: true },
  { why: 'a switch by its type', platform: 'ios', type: I.switch, reportedRole: 'switch', role: 'switch', matches: true },
  { why: 'a toggle is a switch', platform: 'ios', type: I.toggle, reportedRole: 'switch', role: 'switch', matches: true },
  { why: 'a search field by its React Native spelling', platform: 'ios', type: I.search, reportedRole: 'searchfield', role: 'search', matches: true },
  { why: 'a tab by its type', platform: 'ios', type: I.tab, reportedRole: 'tab', role: 'tab', matches: true },
  { why: "a tab bar's button is a tab", platform: 'ios', type: I.button, inTabBar: true, reportedRole: 'tab', role: 'tab', matches: true },
  { why: 'a button outside a tab bar is no tab', platform: 'ios', type: I.button, reportedRole: 'button', role: 'tab', matches: false },
  { why: 'a tab bar is a tablist', platform: 'ios', type: I.tabBar, reportedRole: 'tablist', role: 'tablist', matches: true },
  { why: 'a native check box', platform: 'ios', type: I.checkBox, reportedRole: 'checkbox', role: 'checkbox', matches: true },
  { why: "React Native's checkbox description", platform: 'ios', type: I.other, value: 'checkbox, unchecked', role: 'checkbox', matches: true },
  { why: "React Native's radio description, by the radio spelling", platform: 'ios', type: I.other, value: 'radio button, checked', role: 'radio', matches: true },
  { why: 'another role\'s description is not the role', platform: 'ios', type: I.other, value: 'checkbox, checked', role: 'radiobutton', matches: false },
  { why: 'only the first part of the value is a description', platform: 'ios', type: I.other, value: 'Muted, checkbox', role: 'checkbox', matches: false },
  { why: 'an undescribed generic view is no checkbox', platform: 'ios', type: I.other, label: 'Accept terms', role: 'checkbox', matches: false },
  { why: 'unless a named query says so', platform: 'ios', type: I.other, label: 'Accept terms', role: 'checkbox', name: 'Accept', matches: true },
  { why: 'not when a trait makes it another role', platform: 'ios', type: I.other, traits: ['button'], reportedRole: 'button', label: 'Accept terms', role: 'checkbox', name: 'Accept', matches: false },
  { why: 'a named menu item on a generic view', platform: 'ios', type: I.other, label: 'Copy', role: 'menuitem', name: 'Copy', matches: true },
  { why: 'an unnamed one is not found', platform: 'ios', type: I.other, label: 'Copy', role: 'menuitem', matches: false },
  { why: 'a named alert on static text (an RN Text)', platform: 'ios', type: I.text, reportedRole: 'text', label: 'Saved', role: 'alert', name: 'Saved', matches: true },
  { why: 'an unnamed one is not found', platform: 'ios', type: I.text, reportedRole: 'text', label: 'Saved', role: 'alert', matches: false },
  { why: 'a stepper is a spinbutton', platform: 'ios', type: I.stepper, reportedRole: 'spinbutton', role: 'spinbutton', matches: true },
  { why: 'a progress indicator is a progressbar', platform: 'ios', type: I.progress, reportedRole: 'progressbar', role: 'progressbar', matches: true },
  { why: 'an activity indicator is a progressbar', platform: 'ios', type: I.activity, reportedRole: 'progressbar', role: 'progressbar', matches: true },
  { why: 'and still a spinner', platform: 'ios', type: I.activity, reportedRole: 'progressbar', role: 'spinner', matches: true },
  { why: 'a cell is a listitem', platform: 'ios', type: I.cell, reportedRole: 'listitem', role: 'listitem', matches: true },
  { why: 'a table is a list', platform: 'ios', type: I.table, reportedRole: 'list', role: 'list', matches: true },

  // Android: a class, or (React Native, Compose) a published role description.
  { why: 'a Button', platform: 'android', type: A.button, role: 'button', matches: true },
  { why: 'a role is case-insensitive', platform: 'android', type: A.button, role: 'BUTTON', matches: true },
  { why: 'an ImageButton', platform: 'android', type: A.imageButton, role: 'button', matches: true },
  { why: 'a ToggleButton (RN togglebutton)', platform: 'android', type: A.toggleButton, role: 'button', matches: true },
  { why: 'a MaterialButton', platform: 'android', type: A.materialButton, role: 'button', matches: true },
  { why: 'a ViewGroup is no button', platform: 'android', type: A.viewGroup, role: 'button', matches: false },
  { why: "RN's image button description reads as a button", platform: 'android', type: A.imageButton, roleDescription: 'Button, Image', reportedRole: 'button', role: 'button', matches: true },
  { why: 'a TextView is text', platform: 'android', type: A.textView, role: 'text', matches: true },
  { why: 'a bare TextView is no heading', platform: 'android', type: A.textView, role: 'heading', matches: false },
  { why: 'nor a link', platform: 'android', type: A.textView, role: 'link', matches: false },
  { why: 'the heading flag makes a heading', platform: 'android', type: A.textView, heading: true, reportedRole: 'heading', role: 'heading', matches: true },
  { why: 'on any class', platform: 'android', type: A.viewGroup, heading: true, reportedRole: 'heading', role: 'heading', matches: true },
  { why: 'by its React Native spelling', platform: 'android', type: A.textView, heading: true, reportedRole: 'heading', role: 'header', matches: true },
  { why: 'a "Header" description is a heading', platform: 'android', type: A.viewGroup, roleDescription: 'Header', reportedRole: 'header', role: 'heading', matches: true },
  { why: 'a "link" description makes a link', platform: 'android', type: A.textView, roleDescription: 'link', reportedRole: 'link', role: 'link', matches: true },
  { why: 'a class-only role ignores the description', platform: 'android', type: A.textView, roleDescription: 'link', reportedRole: 'link', role: 'text', matches: true },
  { why: 'an ImageView is an image', platform: 'android', type: A.imageView, role: 'image', matches: true },
  { why: 'a description decides over the class', platform: 'android', type: A.imageView, roleDescription: 'button', reportedRole: 'button', role: 'image', matches: false },
  { why: 'an "image" description on a ViewGroup', platform: 'android', type: A.viewGroup, roleDescription: 'image', reportedRole: 'image', role: 'image', matches: true },
  { why: 'a ProgressBar', platform: 'android', type: A.progressBar, role: 'progressbar', matches: true },
  { why: "RN's progressbar", platform: 'android', type: A.view, roleDescription: 'Progress Bar', reportedRole: 'progressbar', role: 'progressbar', matches: true },
  { why: "RN's toolbar", platform: 'android', type: A.viewGroup, roleDescription: 'Tool Bar', reportedRole: 'toolbar', role: 'toolbar', matches: true },
  { why: "RN's combobox", platform: 'android', type: A.viewGroup, roleDescription: 'Combo Box', reportedRole: 'combobox', role: 'combobox', matches: true },
  { why: "RN's tablist", platform: 'android', type: A.viewGroup, roleDescription: 'Tab List', reportedRole: 'tablist', role: 'tablist', matches: true },
  { why: "a TabLayout is a tablist", platform: 'android', type: A.tabLayout, role: 'tablist', matches: true },
  { why: "a tab's description", platform: 'android', type: A.linearLayout, roleDescription: 'Tab', reportedRole: 'tab', role: 'tab', matches: true },
  { why: "RN's menuitem", platform: 'android', type: A.viewGroup, roleDescription: 'Menu Item', reportedRole: 'menuitem', role: 'menuitem', matches: true },
  { why: "RN's menubar", platform: 'android', type: A.viewGroup, roleDescription: 'Menu Bar', reportedRole: 'menubar', role: 'menubar', matches: true },
  { why: "RN's menu", platform: 'android', type: A.viewGroup, roleDescription: 'Menu', reportedRole: 'menu', role: 'menu', matches: true },
  { why: "RN's radiogroup", platform: 'android', type: A.viewGroup, roleDescription: 'Radio Group', reportedRole: 'radiogroup', role: 'radiogroup', matches: true },
  { why: 'a RadioGroup', platform: 'android', type: A.radioGroup, role: 'radiogroup', matches: true },
  { why: "RN's scrollbar", platform: 'android', type: A.viewGroup, roleDescription: 'Scroll Bar', reportedRole: 'scrollbar', role: 'scrollbar', matches: true },
  { why: "RN's spinbutton", platform: 'android', type: A.viewGroup, roleDescription: 'Spin Button', reportedRole: 'spinbutton', role: 'spinbutton', matches: true },
  { why: 'a NumberPicker is a spinbutton', platform: 'android', type: A.numberPicker, role: 'spinbutton', matches: true },
  { why: "RN's timer", platform: 'android', type: A.viewGroup, roleDescription: 'Timer', reportedRole: 'timer', role: 'timer', matches: true },
  { why: 'a Chronometer is a timer', platform: 'android', type: A.chronometer, role: 'timer', matches: true },
  { why: "RN's summary", platform: 'android', type: A.viewGroup, roleDescription: 'Summary', reportedRole: 'summary', role: 'summary', matches: true },
  { why: "RN's alert", platform: 'android', type: A.viewGroup, roleDescription: 'Alert', reportedRole: 'alert', role: 'alert', matches: true },
  { why: 'an alert is its description alone', platform: 'android', type: A.viewGroup, role: 'alert', name: 'Saved', childTexts: ['Saved'], matches: false },
  { why: 'a custom description is no known role', platform: 'android', type: A.viewGroup, roleDescription: 'Überschrift', reportedRole: 'überschrift', role: 'heading', matches: false },
  { why: 'a Switch', platform: 'android', type: A.switch, role: 'switch', matches: true },
  { why: 'a SwitchCompat', platform: 'android', type: A.switchCompat, role: 'switch', matches: true },
  { why: "Compose's Switch: a View with the description", platform: 'android', type: A.view, roleDescription: 'Switch', reportedRole: 'switch', role: 'switch', matches: true },
  { why: 'a View without it is no switch', platform: 'android', type: A.view, role: 'switch', matches: false },
  { why: 'a SeekBar by its React Native spelling', platform: 'android', type: A.seekBar, role: 'slider', matches: true },
  { why: 'a RadioButton by its React Native spelling', platform: 'android', type: A.radioButton, role: 'radio', matches: true },
  { why: 'a CheckBox', platform: 'android', type: A.checkBox, role: 'checkbox', matches: true },
  { why: 'a Spinner', platform: 'android', type: A.spinner, role: 'spinner', matches: true },
  { why: 'a SearchView by its React Native spelling', platform: 'android', type: A.searchView, role: 'search', matches: true },
  { why: "an EditText (RN's search role) is no searchfield", platform: 'android', type: A.editText, role: 'search', matches: false },
  { why: 'a RecyclerView is a list', platform: 'android', type: A.recyclerView, role: 'list', matches: true },
  { why: 'a ScrollView is a scrollview', platform: 'android', type: A.scrollView, role: 'scrollview', matches: true },

  // ─── The name ───

  // iOS: the label or title.
  { why: 'a name is a case-insensitive substring', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: 'Sign In', name: 'sign', matches: true },
  { why: 'exact compares it whole', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: 'Sign In', name: 'Sign', exact: true, matches: false },
  { why: 'exact matches the whole name', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: 'Sign In', name: 'Sign In', exact: true, matches: true },
  { why: 'exact is case-sensitive', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: 'Sign In', name: 'sign in', exact: true, matches: false },
  { why: 'NBSP in the label is a space', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: `Sign${NBSP}In`, name: 'Sign In', exact: true, matches: true },
  { why: 'exact matches one child of a ", "-joined label', platform: 'ios', type: I.other, traits: ['button'], reportedRole: 'button', role: 'button', label: 'Login Form, Text inputs', name: 'Text inputs', exact: true, matches: true },
  { why: 'the title is a name', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: '', title: 'Save', name: 'Save', exact: true, matches: true },
  { why: 'the value is not a name', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: '', value: 'Submit', name: 'Submit', matches: false },
  { why: 'a RegExp tests the name', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: 'Sign In', name: { source: '^sign', flags: 'i' }, matches: true },
  { why: 'a RegExp tests the normalized name', platform: 'ios', type: I.button, reportedRole: 'button', role: 'button', label: `Sign${NBSP}In`, name: { source: '^Sign In$', flags: '' }, matches: true },

  // Android: the content description, the text, or the children's text.
  { why: 'a name is a case-insensitive substring of the text', platform: 'android', type: A.button, role: 'button', text: 'Sign In', name: 'sign', matches: true },
  { why: 'exact compares it whole', platform: 'android', type: A.button, role: 'button', text: 'Sign In', name: 'Sign', exact: true, matches: false },
  { why: 'exact matches the whole name', platform: 'android', type: A.button, role: 'button', text: 'Sign In', name: 'Sign In', exact: true, matches: true },
  { why: 'exact is case-sensitive', platform: 'android', type: A.button, role: 'button', text: 'Sign In', name: 'sign in', exact: true, matches: false },
  { why: 'NBSP in the text is a space', platform: 'android', type: A.button, role: 'button', text: `Sign${NBSP}In`, name: 'Sign In', exact: true, matches: true },
  { why: 'the content description is a name', platform: 'android', type: A.imageButton, role: 'button', contentDesc: 'Close', name: 'Close', exact: true, matches: true },
  { why: 'the children\'s text names a Pressable', platform: 'android', type: A.button, role: 'button', childTexts: ['Sign In'], name: 'Sign In', exact: true, matches: true },
  { why: 'joined with spaces', platform: 'android', type: A.button, role: 'button', childTexts: ['Sign', 'In'], name: 'Sign In', exact: true, matches: true },
  { why: 'a ", "-joined text is one name, not children', platform: 'android', type: A.viewGroup, roleDescription: 'Menu Item', reportedRole: 'menuitem', role: 'menuitem', text: 'Copy, Paste', name: 'Paste', exact: true, matches: false },
  { why: 'a described role is named too', platform: 'android', type: A.viewGroup, roleDescription: 'Menu Item', reportedRole: 'menuitem', role: 'menuitem', childTexts: ['Copy'], name: 'copy', matches: true },
  { why: 'a heading by its name', platform: 'android', type: A.textView, heading: true, reportedRole: 'heading', role: 'heading', text: 'Settings', name: 'Settings', exact: true, matches: true },
  { why: 'a RegExp tests the content description', platform: 'android', type: A.imageButton, role: 'button', contentDesc: 'Close', name: { source: '^close$', flags: 'i' }, matches: true },
  { why: 'a RegExp tests the normalized name', platform: 'android', type: A.button, role: 'button', text: `Sign${NBSP}In`, name: { source: '^Sign In$', flags: '' }, matches: true },
  { why: 'a RegExp tests the children\'s text', platform: 'android', type: A.button, role: 'button', childTexts: ['Sign', 'In'], name: { source: 'n I', flags: '' }, matches: true },
];

/** The case's element as a hierarchy node, the way each agent's dump writes it. */
function nodeFor(c: Case): HierarchyNode {
  const attrs: Record<string, string> = c.platform === 'ios'
    ? { type: c.type, label: c.label ?? '', identifier: '', value: c.value ?? '', placeholderValue: c.placeholder ?? '' }
    : { class: c.type, text: c.text ?? '', 'resource-id': '', hint: c.placeholder ?? '' };
  if (c.title !== undefined) attrs.title = c.title;
  if (c.contentDesc !== undefined) attrs['content-desc'] = c.contentDesc;
  if (c.reportedRole !== undefined) attrs['tapsmith-role'] = c.reportedRole;
  const children = (c.childTexts ?? []).map((text): HierarchyNode => ({
    tagName: 'node',
    attributes: new Map(Object.entries({ class: 'android.widget.TextView', text, 'resource-id': '' })),
    children: [],
    depth: 1,
  }));
  return { tagName: c.platform === 'ios' ? c.type : 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

function codeFor(c: Case): string {
  if (c.name === undefined) return `device.getByRole("${c.role}")`;
  const name = typeof c.name === 'string' ? `"${escapeJsString(c.name)}"` : `/${c.name.source}/${c.name.flags}`;
  return `device.getByRole("${c.role}", { name: ${name}${c.exact ? ', exact: true' : ''} })`;
}

const FIXTURE = fileURLToPath(new URL('./fixtures/role-conformance.json', import.meta.url));

function buildFixture() {
  return {
    comment:
      'Generated by packages/tapsmith/src/__tests__/role-conformance.test.ts (PILOT-834, PILOT-707). One element and ' +
      'one getByRole query per case, with the agent\'s answer; a RegExp name carries the SDK translation the agents ' +
      'compile. Replayed by the TypeScript playground matcher, the iOS agent\'s RoleNameTests and the Android agent\'s ' +
      'LocatorConformanceTest.',
    cases: CASES.map((c) => ({
      ...c,
      ...(c.name === undefined || typeof c.name === 'string'
        ? {}
        : { name: { ...c.name, ...translateRegex(c.name.source, c.name.flags) } }),
    })),
  };
}

describe('getByRole conformance (PILOT-834, PILOT-707)', () => {
  it.each(CASES)('$platform $why → $matches', (c) => {
    const parsed = parseSelectorString(codeFor(c));
    expect(parsed).not.toBeNull();
    const root = nodeFor(c);
    expect(findMatchingNodes([root], parsed!).includes(root)).toBe(c.matches);
  });

  it('every case says what the element\'s dump reports', () => {
    // An iOS element always reports a role or none; the replays check which.
    for (const c of CASES) {
      if (c.platform === 'android') expect(c.reportedRole === undefined, c.why).toBe(c.roleDescription === undefined && !c.heading);
    }
  });

  it('the agents\' fixture is the current table', () => {
    const fresh = buildFixture();
    if (process.env.UPDATE_ROLE_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + '\n');
    const committed = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(committed).toEqual(fresh);
  });

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

  it('Android: the hint-named classes are EDIT_TEXT_HINT_CLASS_PATTERN', () => {
    const source = readFileSync(path.join(repoRoot, 'agent/app/src/main/kotlin/dev/tapsmith/agent/ElementFinder.kt'), 'utf8');
    const from = source.indexOf('val EDIT_TEXT_HINT_CLASS_PATTERN');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = source.slice(source.indexOf('listOf(', from), source.indexOf(').joinToString', from));
    const classes = [...block.matchAll(/"([\w.]+)"/g)].map((m) => m[1]);
    expect(classes.length).toBeGreaterThan(0);
    expect([...classes].sort()).toEqual([...ANDROID_EDIT_TEXT_CLASSES].sort());
  });

  it('iOS: the placeholder-named types are RoleName.placeholderNamedTypes', () => {
    const source = readFileSync(path.join(repoRoot, 'ios-agent/TapsmithAgent/RoleName.swift'), 'utf8');
    const from = source.indexOf('static let placeholderNamedTypes');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = source.slice(source.indexOf('[', from), source.indexOf(']', from));
    const types = [...block.matchAll(/\.(\w+)/g)]
      .map((m) => `XCUIElementType${m[1][0].toUpperCase()}${m[1].slice(1)}`);
    expect(types.length).toBeGreaterThan(0);
    expect([...types].sort()).toEqual([...IOS_PLACEHOLDER_NAMED_TYPES].sort());
  });
});
