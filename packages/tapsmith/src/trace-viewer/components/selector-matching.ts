import type { HierarchyNode } from './hierarchy-utils.js';
import { getNodeRole, isLabelField, webViewAriaLabel, getNodeBounds } from './hierarchy-utils.js';
import { isHooksMarkerNode, isNonAppNode, isNonAppSubtree } from './non-app-nodes.js';
import { iosTexts, iosTextMatchesExact, iosTextMatchesRegex, iosTextMatchesSubstring } from './text-content.js';
import { toJsRegExp } from '../../text-regex.js';
import { unescapeJsString } from '../../js-string-escape.js';
import { idOfAttributeSelector, isCssIdentifier } from '../../css-selector.js';
import { ANDROID_DUAL_PATH_ROLES, ANDROID_ROLE_CLASSES, IOS_ROLE_TYPES, IOS_STATIC_TEXT_ROLES, iosGenericViewHasRole, normalizeRole, unknownRoleMessage } from '../../roles.js';

// ─── Selector Parsing ───

export interface ParsedSelector {
  type: string
  value: string
  name?: string
  /** getByRole `{ exact: true }`: the name matches case-sensitively and whole. */
  exact?: boolean
  /** The RegExp of a `textRegex` / `labelRegex` selector (PILOT-520). */
  regex?: ParsedRegex
  /** getByRole `{ name: RegExp }` (PILOT-520). */
  nameRegex?: ParsedRegex
  /** getByRole's state filters (PILOT-655). Absent means "either". */
  checked?: boolean
  disabled?: boolean
  selected?: boolean
  expanded?: boolean
  index?: number | 'first' | 'last'
}

/** getByRole's state options, in the SDK's RoleLocatorOptions. */
const ROLE_STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded'] as const;
type RoleStateKey = typeof ROLE_STATE_KEYS[number];
type RoleStates = Partial<Record<RoleStateKey, boolean>>;

/** A RegExp literal from a locator string: its source and flags. */
export interface ParsedRegex {
  source: string
  flags: string
}

// A RegExp literal: /source/flags. The source skips escaped characters and
// bracketed classes, so `/a\/b/` and `/[/]/` parse whole (PILOT-520).
const REGEX_SOURCE = String.raw`\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^\\/\[\n])+)\/([a-z]*)`;
const DQ = String.raw`"((?:[^"\\]|\\.)*)"`;
const SQ = String.raw`'((?:[^'\\]|\\.)*)'`;
// An options object: quoted strings and RegExp literals may contain braces.
const OPTIONS = String.raw`((?:[^{}"'/]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|${REGEX_SOURCE.replace(/\((?!\?)/g, '(?:')})*)`;

// Matches: device.getByText("value"), device.getByRole("button", { name: "n" }),
// device.getByText("value", { exact: true }), device.getByText(/re/i) — the
// options object is captured as a blob and parsed by parseGetByOptions.
// Supports both single and double quotes, optional whitespace around args.
// The quoted-string alternation skips escaped characters so values containing
// escaped quotes (getByText("Say \\"hi\\"")) parse fully instead of truncating.
// Groups: 1 = method, 2 = double-quoted value, 3 = single-quoted value,
// 4 = RegExp source, 5 = RegExp flags, 6 = options blob.
const DEVICE_RE = new RegExp(
  String.raw`^device\.getBy(\w+)\(\s*(?:${DQ}|${SQ}|${REGEX_SOURCE})(?:\s*,\s*\{${OPTIONS}\})?\s*\)`,
);
// Matches: webview.getByText("value"), webview.getByRole("role", { name: "n" })
// (same groups; a RegExp is refused — the WebView engine doesn't take one).
const WEBVIEW_GETBY_RE = new RegExp(
  String.raw`^webview\.getBy(\w+)\(\s*(?:${DQ}|${SQ}|${REGEX_SOURCE})(?:\s*,\s*\{${OPTIONS}\})?\s*\)`,
);

/** A RegExp literal that JavaScript accepts, or null. */
function parseRegex(source: string | undefined, flags: string | undefined): ParsedRegex | null {
  if (source === undefined) return null;
  try {
    new RegExp(source, flags);
  } catch {
    return null;
  }
  return { source, flags: flags ?? '' };
}

interface ParsedOptions {
  name?: string
  nameRegex?: ParsedRegex | null
  exact?: boolean
  states: RoleStates
  /** Every option key given, so a getter can refuse the ones it does not take. */
  keys: Set<string>
}

/**
 * Parse the options-object blob of a getBy* call: `name: "x"` or `name: /x/`,
 * plus boolean options (`exact`, and getByRole's `checked`, `disabled`,
 * `selected`, `expanded`). Anything else — an unknown key, a non-boolean
 * value, a missing comma — is an `{ error }`, so a locator is refused rather
 * than run with an option silently dropped, which is how `selected: true`
 * came to match unselected elements (PILOT-655).
 */
function parseGetByOptions(blob: string | undefined): ParsedOptions | { error: string } {
  const parsed: ParsedOptions = { states: {}, keys: new Set() };
  if (!blob) return parsed;
  // Skip over escaped characters inside the quotes so an escaped quote of
  // the same type (name: "Say \"hi\"") doesn't truncate the capture.
  const nameMatch = blob.match(new RegExp(String.raw`(?:^|,)\s*name:\s*(?:${DQ}|${SQ}|${REGEX_SOURCE})\s*(?=,|$)`));
  if (nameMatch) {
    parsed.keys.add('name');
    const rawName = nameMatch[1] !== undefined ? nameMatch[1] : nameMatch[2];
    if (rawName !== undefined) parsed.name = unescapeJsString(rawName);
    if (nameMatch[3] !== undefined) parsed.nameRegex = parseRegex(nameMatch[3], nameMatch[4]);
  }
  // The other options, outside the name's own value: each `key: true|false`.
  const rest = nameMatch ? blob.slice(0, nameMatch.index) + ',' + blob.slice(nameMatch.index! + nameMatch[0].length) : blob;
  for (const raw of rest.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(\w+)\s*:\s*(.*)$/s);
    if (!m) return { error: `cannot read the option "${part}"` };
    const [, key, value] = m;
    // A `name` the name pattern above could not read: a template literal,
    // an expression, a second name.
    if (key === 'name') return { error: 'cannot read the name option (use one quoted string or a RegExp literal)' };
    if (key !== 'exact' && !(ROLE_STATE_KEYS as readonly string[]).includes(key)) {
      return { error: `unsupported option "${key}"` };
    }
    if (value !== 'true' && value !== 'false') return { error: `option "${key}" must be true or false, got ${value}` };
    if (key === 'exact') parsed.exact = value === 'true';
    else parsed.states[key as RoleStateKey] = value === 'true';
    parsed.keys.add(key);
  }
  return parsed;
}

/**
 * The options of a `<receiver>.getBy<method>(…)` call, or why they are
 * refused: unreadable, or a key `method` does not take (the SDK's signatures).
 */
function getterOptions(
  receiver: 'device' | 'webview', method: string, blob: string | undefined,
): ParsedOptions | { error: string } {
  const options = parseGetByOptions(blob);
  if ('error' in options) return options;
  const allowed = (receiver === 'device' ? DEVICE_OPTION_KEYS : WEBVIEW_OPTION_KEYS)[method] ?? [];
  const bad = [...options.keys].find((k) => !allowed.includes(k));
  if (bad === undefined) return options;
  const takes = allowed.length ? `it takes ${allowed.join(', ')}` : 'it takes no options';
  return { error: `${receiver}.getBy${method}() has no option "${bad}" (${takes})` };
}

/**
 * Why a locator string is refused, or null when it parses or is not a locator
 * at all (the callers then show the generic "use device.getBy…" message). The
 * MCP tools put this in their "Invalid locator" error and the Locator
 * Playground shows it, so a caller knows what to change:
 *
 * - an option the getter does not take, e.g. Playwright's `level` or
 *   `includeHidden` (PILOT-655);
 * - a call chained after the getter — a scoped getter, `filter()`, `and()`,
 *   `or()`, an action — which the parser cannot apply and used to drop, so the
 *   locator matched more than was asked for (PILOT-660).
 */
export function locatorStringError(input: string): string | null {
  const chain = parseChain(normalizeLocatorString(input));
  if (!chain) return null;
  const call = matchBaseCall(chain.base);
  if (!call) return null;
  if (call.kind === 'device-getby' || call.kind === 'wv-getby') {
    const receiver = call.kind === 'device-getby' ? 'device' : 'webview';
    // A getter Tapsmith does not have (Playwright's getByAltText, getByTitle)
    // is the problem, not its options or what follows it: leave it to the
    // generic message.
    if (!KNOWN_GETTERS[receiver].has(call.match[1])) return null;
    const options = getterOptions(receiver, call.match[1], call.match[6]);
    if ('error' in options) return options.error;
  }
  return call.rest ? trailingTextError(call.rest) : null;
}

/** The error for text left after the locator's call: the chained call it starts, by name. */
function trailingTextError(rest: string): string {
  // Skip positional steps written before the chained call — the call is what
  // is unsupported, not `.first()`.
  const unsupported = rest.replace(/^(?:\s*\.(?:first|last)\(\s*\)|\s*\.nth\(\s*-?\d+\s*\))*\s*/, '');
  const method = unsupported.match(/^\.\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (method) {
    return `unsupported chained call .${method[1]}() — a locator string here is one getter, optionally followed by .first(), .last() or .nth(n)`;
  }
  return `unexpected text after the locator: ${JSON.stringify(rest)}`;
}

/** The getBy* methods each receiver has (device.ts / webview-handle.ts). */
const KNOWN_GETTERS = {
  device: new Set(['Text', 'Role', 'Description', 'Placeholder', 'TestId', 'Label']),
  webview: new Set(['Text', 'Role', 'Label', 'Placeholder', 'TestId']),
};

/** The options each getter takes (the SDK's signatures). */
const DEVICE_OPTION_KEYS: Record<string, readonly string[]> = {
  Text: ['exact'],
  Role: ['name', 'exact', ...ROLE_STATE_KEYS],
};
const WEBVIEW_OPTION_KEYS: Record<string, readonly string[]> = {
  Text: ['exact'],
  Role: ['name'],
};
// Matches: webview.locator("css-selector") — groups: 1 = dq value, 2 = sq value
const WEBVIEW_LOCATOR_RE = /^webview\.locator\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/;
// Matches: device.locator({ className: "value" }) or device.locator({ id: "value" })
// Groups: 1 = prop, 2 = dq value, 3 = sq value
const DEVICE_LOCATOR_RE = /^device\.locator\(\s*\{\s*(className|id)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*,?\s*\}\s*\)/;
// Matches: text("value"), contentDesc("value") — legacy/shorthand format
// Groups: 1 = type, 2 = dq value, 3 = sq value
const SHORT_RE = /^(\w+)\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*\)/;
/** The selector types a one-string shorthand can name (nodeMatchesSelector's). */
const SHORTHAND_TYPES = new Set(['text', 'textContains', 'contentDesc', 'id', 'className', 'hint', 'testId', 'label', 'role']);

/** The forms a locator string's call can take, in the order they are tried. */
const BASE_CALLS = [
  ['wv-locator', WEBVIEW_LOCATOR_RE],
  ['wv-getby', WEBVIEW_GETBY_RE],
  ['device-locator', DEVICE_LOCATOR_RE],
  ['device-getby', DEVICE_RE],
  ['short', SHORT_RE],
] as const;

interface BaseCall {
  kind: typeof BASE_CALLS[number][0]
  match: RegExpMatchArray
  /** Whatever follows the call, trimmed — a chained call the parser cannot apply. */
  rest: string
}

/**
 * The call a locator string (without its trailing positional chain) starts
 * with. The patterns are anchored only at the start, so `rest` carries
 * anything after the call: the parser must refuse a non-empty one rather than
 * evaluate the call alone (PILOT-660).
 */
function matchBaseCall(base: string): BaseCall | null {
  for (const [kind, re] of BASE_CALLS) {
    const match = base.match(re);
    if (match) return { kind, match, rest: base.slice(match[0].length).trim() };
  }
  return null;
}

/** A locator pasted as a statement: drop its trailing semicolons. */
function stripStatementEnd(input: string): string {
  return input.trim().replace(/(?:\s*;)+$/, '');
}

// The receivers read as `device.`: none at all — `getByText("x")`, as the docs
// and the trace's action list write a locator — a screen object's
// `this.device.`, and a pasted Playwright `page.`. Without this a bare
// `getByText("x")` was read as a shorthand of type "getByText", which no
// element has, and the playground showed "0 matches" for an element on screen
// (PILOT-717). Only a getter or a native `locator({ … })` follows: a bare
// `locator("css")` is a WebView locator without its receiver.
const DEVICE_RECEIVER_RE = /^(?:(?:this\s*\.\s*)?(?:device|page)\s*\.\s*)?(?=getBy\w|locator\(\s*\{)/;
const WEBVIEW_RECEIVER_RE = /^(?:this\s*\.\s*)?webview\s*\.\s*/;

/** A locator string as the patterns below read it: no statement end, and `device.`/`webview.` receivers. */
function normalizeLocatorString(input: string): string {
  const trimmed = stripStatementEnd(input);
  if (WEBVIEW_RECEIVER_RE.test(trimmed)) return trimmed.replace(WEBVIEW_RECEIVER_RE, 'webview.');
  return trimmed.replace(DEVICE_RECEIVER_RE, 'device.');
}

// Matches trailing .first(), .last(), .nth(N) — N may be negative
// (the runtime's .nth() counts from the end for negative indices)
const CHAIN_RE = /\.(first|last)\(\)$|\.nth\(\s*(-?\d+)\s*\)$/;

/**
 * Split off the positional chain. Every trailing positional step is consumed
 * and composed the way the runtime composes them (ElementHandle.nth): the
 * innermost step picks the element and each later step narrows that ONE
 * element — `.first()`/`.last()`/`.nth(0)`/`.nth(-1)` of it are itself, any
 * other index is nothing. Returns `null` for a chain that can never match
 * (e.g. `.first().nth(1)`), so callers report an invalid locator instead of
 * silently evaluating a different one (the un-anchored selector regexes would
 * otherwise drop the leftover step and re-index the full set).
 */
function parseChain(input: string): { base: string; index?: number | 'first' | 'last' } | null {
  const steps: Array<number | 'first' | 'last'> = [];
  let base = input;
  for (let match = base.match(CHAIN_RE); match; match = base.match(CHAIN_RE)) {
    steps.unshift(match[1] === 'first' ? 'first' : match[1] === 'last' ? 'last' : parseInt(match[2], 10));
    base = base.slice(0, match.index);
  }
  if (steps.length === 0) return { base };
  const [index, ...rest] = steps;
  for (const step of rest) {
    const identity = step === 'first' || step === 'last' || step === 0 || step === -1;
    if (!identity) return null;
  }
  return { base, index };
}

export function parseSelectorString(input: string): ParsedSelector | null {
  const trimmed = normalizeLocatorString(input);
  if (!trimmed) return null;

  const chain = parseChain(trimmed);
  if (!chain) return null;
  const { base, index } = chain;

  const call = matchBaseCall(base);
  // A call chained after the getter (`.getByText()`, `.filter()`, …) cannot be
  // applied here; evaluating the getter alone would match more than the
  // locator asks for (PILOT-660). locatorStringError names it.
  if (!call || call.rest) return null;
  const { match } = call;

  // Parsed values are UNESCAPED (raw) — they compare directly against raw
  // node attribute values; emitters re-escape when generating code strings.
  const pick = (dq: string | undefined, sq: string | undefined): string =>
    unescapeJsString(dq !== undefined ? dq : (sq ?? ''));

  switch (call.kind) {
    // WebView locator: webview.locator("#email")
    case 'wv-locator':
      return { type: 'wv-locator', value: pick(match[1], match[2]), index };

    // WebView getBy*: webview.getByRole("button", { name: "Login" })
    case 'wv-getby': {
      const method = match[1];
      if (match[4] !== undefined) return null;
      const value = pick(match[2], match[3]);
      const options = getterOptions('webview', method, match[6]);
      if ('error' in options) return null;
      const { name, nameRegex, exact } = options;
      if (nameRegex !== undefined) return null;
      const sel = mapWebViewMethod(method, value, name, exact);
      if (sel) sel.index = index;
      return sel;
    }

    // Native device.locator({ className/id: "..." })
    case 'device-locator': {
      const type = match[1] === 'className' ? 'className' : 'id';
      return { type, value: pick(match[2], match[3]), index };
    }

    // Native device getBy*
    case 'device-getby': {
      const method = match[1];
      const options = getterOptions('device', method, match[6]);
      if ('error' in options) return null;
      const { name, nameRegex, exact, states } = options;
      if (nameRegex === null) return null; // a malformed RegExp
      let sel: ParsedSelector | null;
      if (match[4] !== undefined) {
        const regex = parseRegex(match[4], match[5]);
        sel = regex ? mapDeviceRegexMethod(method, regex) : null;
      } else {
        sel = mapDeviceMethod(method, pick(match[2], match[3]), name, exact, nameRegex);
      }
      if (sel?.type === 'role') Object.assign(sel, states);
      if (sel) sel.index = index;
      return sel;
    }

    // Legacy/shorthand: text("value"), contentDesc("value"). Only a selector
    // type the matcher knows: any other name matched nothing, so the
    // playground counted "0 matches" for a locator it could not read.
    case 'short':
      if (!SHORTHAND_TYPES.has(match[1])) return null;
      return { type: match[1], value: pick(match[2], match[3]), index };
  }
}

function mapDeviceMethod(
  method: string, value: string, name?: string, exact?: boolean, nameRegex?: ParsedRegex,
): ParsedSelector | null {
  if (nameRegex && method !== 'Role') return null;
  switch (method) {
    // Runtime getByText is a SUBSTRING match unless { exact: true } is passed
    // (device.ts getByText → textContains). The playground must agree, or a
    // selector validated here taps a different element at runtime (PILOT-226).
    case 'Text': return exact ? { type: 'text', value } : { type: 'textContains', value };
    // Role names match like the agents (PILOT-549): a case-insensitive
    // substring unless { exact: true } is passed.
    case 'Role':
      // A RegExp name ignores `exact`, as in Playwright (PILOT-520).
      if (nameRegex) return { type: 'role', value, nameRegex };
      return { type: 'role', value, name, ...(exact && name ? { exact: true } : {}) };
    case 'Description': return { type: 'contentDesc', value };
    case 'Placeholder': return { type: 'hint', value };
    case 'TestId': return { type: 'testId', value };
    case 'Label': return { type: 'label', value };
    default: return null;
  }
}

/** getByText / getByLabel with a RegExp (PILOT-520); the other getters take strings only. */
function mapDeviceRegexMethod(method: string, regex: ParsedRegex): ParsedSelector | null {
  switch (method) {
    case 'Text': return { type: 'textRegex', value: '', regex };
    case 'Label': return { type: 'labelRegex', value: '', regex };
    default: return null;
  }
}

function mapWebViewMethod(method: string, value: string, name?: string, exact?: boolean): ParsedSelector | null {
  switch (method) {
    // webview.getByText is substring by default too (webview-handle.ts).
    case 'Text': return exact ? { type: 'wv-text', value } : { type: 'wv-text-contains', value };
    case 'Role': return { type: 'wv-role', value, name };
    case 'Label': return { type: 'wv-label', value };
    case 'Placeholder': return { type: 'wv-placeholder', value };
    case 'TestId': return { type: 'wv-testid', value };
    default: return null;
  }
}

// ─── Node Attribute Helpers ───
// Android uses: text, content-desc, resource-id, hint, class
// iOS uses: label, identifier, placeholderValue, type

// A node's text: Android's `text`, else an iOS label or value. iOS getByText
// reads the agent's text content rule instead (text-content.ts); this is
// getByText on other nodes and the duplicate collapse's key. Native selector
// VALIDATION goes through the real runtime (EvaluateSelectors); this TS matcher
// only powers the offline trace playground.
function getNodeText(node: HierarchyNode): string {
  return node.attributes.get('text') ?? node.attributes.get('label') ?? node.attributes.get('value') ?? '';
}

function getNodeContentDesc(node: HierarchyNode): string {
  // Android: content-desc. iOS: contentDesc selectors match the accessibility
  // label at runtime (the agent compares against label/title), so fall back
  // to the label attribute for iOS nodes.
  return node.attributes.get('content-desc') ?? node.attributes.get('label') ?? '';
}

function getNodeId(node: HierarchyNode): string {
  return node.attributes.get('resource-id') ?? node.attributes.get('identifier') ?? '';
}

function getNodeHint(node: HierarchyNode): string {
  return node.attributes.get('hint') ?? node.attributes.get('placeholderValue') ?? '';
}

function getNodeClassName(node: HierarchyNode): string {
  return node.attributes.get('class') ?? node.attributes.get('type') ?? node.tagName;
}

// ─── Node Matching ───

/**
 * Collapse whitespace runs (JavaScript's `\s`, so NBSP and line breaks too) to
 * one space and trim — how the agents compare getByText, getByRole names and
 * getByLabel (PILOT-510, Playwright's text normalization).
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// The Android agent's EDIT_TEXT_HINT_CLASS_PATTERN and MAX_DESCENDANT_TEXT_DEPTH.
const ANDROID_EDIT_TEXT_CLASSES = new Set([
  'android.widget.EditText',
  'android.widget.AutoCompleteTextView',
  'com.google.android.material.textfield.TextInputEditText',
  'androidx.appcompat.widget.AppCompatEditText',
]);
const MAX_DESCENDANT_TEXT_DEPTH = 6;

/**
 * The Android agent's joined descendant text: each child's text, else its
 * content-desc, else its own descendants'. A hooks marker gives none.
 */
function descendantText(node: HierarchyNode, depth = 0): string[] {
  if (depth >= MAX_DESCENDANT_TEXT_DEPTH) return [];
  const parts: string[] = [];
  for (const child of node.children) {
    if (isHooksMarkerNode(child)) continue;
    const own = child.attributes.get('text') || child.attributes.get('content-desc');
    if (own) parts.push(own);
    else parts.push(...descendantText(child, depth + 1));
  }
  return parts;
}

/**
 * Whether a node's accessible name matches a getByRole `name` the way the
 * agents match it (PILOT-549): any of its name sources — Android
 * content-desc, text and joined descendant text; iOS label and title —
 * case-insensitively by substring, or whole and case-sensitively with
 * `exact` (on iOS, also one whole child of a ", "-joined label). An Android
 * EditText's text is its typed value unless it equals the hint (an empty
 * field reports its hint as text), and a typed value is only compared whole.
 */
function roleNameMatches(node: HierarchyNode, name: string, exact: boolean): boolean {
  const query = normalizeWhitespace(name);
  const matches = (actual: string | undefined, wholeOnly: boolean): boolean => {
    if (actual === undefined || actual === '') return false;
    const value = normalizeWhitespace(actual);
    return wholeOnly ? value === query : value.toLowerCase().includes(query.toLowerCase());
  };
  const isAndroid = node.attributes.has('class');
  const text = node.attributes.get('text');
  const textIsValue = text !== undefined && ANDROID_EDIT_TEXT_CLASSES.has(node.attributes.get('class') ?? '')
    && text !== node.attributes.get('hint');
  const iosChildLabel = (label: string | undefined): boolean =>
    exact && label !== undefined && normalizeWhitespace(label).split(', ').includes(query);
  return matches(node.attributes.get('content-desc'), exact)
    || matches(node.attributes.get('label'), exact)
    || matches(node.attributes.get('title'), exact)
    || matches(text, exact || textIsValue)
    || (!isAndroid && (iosChildLabel(node.attributes.get('label')) || iosChildLabel(node.attributes.get('title'))))
    || (isAndroid && matches(descendantText(node).join(' '), exact));
}

/**
 * {@link roleNameMatches} for a RegExp name (PILOT-520): the RegExp is tested
 * against each name source, whitespace-normalized (Playwright tests the
 * normalized accessible name). A typed Android EditText value is not a name.
 */
function roleNameMatchesRegex(node: HierarchyNode, re: RegExp): boolean {
  const test = (actual: string | undefined): boolean =>
    actual !== undefined && actual !== '' && re.test(normalizeWhitespace(actual));
  const isAndroid = node.attributes.has('class');
  const text = node.attributes.get('text');
  const textIsValue = text !== undefined && ANDROID_EDIT_TEXT_CLASSES.has(node.attributes.get('class') ?? '')
    && text !== node.attributes.get('hint');
  return test(node.attributes.get('content-desc'))
    || test(node.attributes.get('label'))
    || test(node.attributes.get('title'))
    || (!textIsValue && test(text))
    || (isAndroid && test(descendantText(node).join(' ')));
}

/**
 * getByText(RegExp) (PILOT-520): the raw text the agents test — Android's
 * `text`, iOS's label, title or value. Not whitespace-normalized, as
 * Playwright tests the element's full text.
 */
function textMatchesRegex(node: HierarchyNode, re: RegExp): boolean {
  return re.test(node.attributes.get('text') ?? '');
}

/** The getByText selector types, which on iOS read a node's text content (text-content.ts). */
const TEXT_SELECTOR_TYPES: ReadonlySet<string> = new Set(['text', 'textContains', 'textRegex']);

/**
 * getByText on an iOS node (PILOT-794): its text content, as the agent's
 * TextContent reads it. `containerLabel` is the nearest app ancestor's label.
 */
function iosNodeMatchesText(node: HierarchyNode, selector: ParsedSelector, containerLabel: string): boolean {
  const texts = iosTexts(node, containerLabel);
  switch (selector.type) {
    case 'text': return iosTextMatchesExact(texts, selector.value);
    case 'textContains': return iosTextMatchesSubstring(texts, selector.value);
    default: return selector.regex !== undefined && iosTextMatchesRegex(texts, toJsRegExp(selector.regex));
  }
}

/**
 * Whether a getByLabel field's name passes `test` — the one rule the agents
 * use for a string and a RegExp alike (PILOT-666): Android's content-desc
 * (the agent also follows a labelling view, which the dump does not carry),
 * iOS's label or title. iOS tests an empty label like any other text, as its
 * agent does; Android has no name without a content-desc.
 */
function labelNameMatches(node: HierarchyNode, test: (name: string) => boolean): boolean {
  if (node.attributes.has('class')) {
    const contentDesc = node.attributes.get('content-desc');
    return contentDesc !== undefined && contentDesc !== '' && test(contentDesc);
  }
  return test(node.attributes.get('label') ?? '') || test(node.attributes.get('title') ?? '');
}

function isWebViewNode(node: HierarchyNode): boolean {
  return node.attributes.get('webview') === 'true';
}

function nodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  // WebView selector types only match WebView nodes
  if (selector.type.startsWith('wv-')) {
    if (!isWebViewNode(node)) return false;
    return webViewNodeMatchesSelector(node, selector);
  }

  // Native selector types match native nodes
  switch (selector.type) {
    case 'text':
      return normalizeWhitespace(getNodeText(node)) === normalizeWhitespace(selector.value);
    case 'textContains':
      // Case-insensitive, like Playwright's non-exact getByText and the
      // agents (PILOT-522); { exact: true } stays case-sensitive.
      return normalizeWhitespace(getNodeText(node)).toLowerCase()
        .includes(normalizeWhitespace(selector.value).toLowerCase());
    case 'textRegex':
      return selector.regex !== undefined && textMatchesRegex(node, toJsRegExp(selector.regex));
    case 'contentDesc':
      return getNodeContentDesc(node) === selector.value;
    case 'id': {
      const rid = getNodeId(node);
      return rid === selector.value;
    }
    case 'className':
      return getNodeClassName(node) === selector.value;
    case 'hint':
      return getNodeHint(node) === selector.value;
    case 'label': {
      // An empty string is no label criterion at all: the agents drop it, so
      // nothing matches (a whitespace-only one is a real, empty, name).
      if (selector.value === '') return false;
      // Whole and whitespace-normalized, never the field's own text — its
      // typed value or hint (PILOT-659).
      const query = normalizeWhitespace(selector.value);
      return isLabelField(node) && labelNameMatches(node, (name) => normalizeWhitespace(name) === query);
    }
    case 'labelRegex': {
      if (selector.regex === undefined || !isLabelField(node)) return false;
      // The raw name, like Playwright tests the label's text (PILOT-520).
      const re = toJsRegExp(selector.regex);
      return labelNameMatches(node, (name) => re.test(name));
    }
    case 'testId': {
      const rid = getNodeId(node);
      // Whole resource-id, like the agent's By.res (PILOT-659).
      return rid === selector.value;
    }
    case 'role': {
      // Like getByRole at runtime (PILOT-556): case-insensitive, aliases
      // resolved, and a role it rejects matches nothing.
      if (unknownRoleMessage(selector.value) !== null) return false;
      const named = selector.name !== undefined || selector.nameRegex !== undefined;
      if (!nodeHasRole(node, normalizeRole(selector.value), named)) return false;
      if (!nodeMatchesRoleStates(node, selector)) return false;
      if (selector.nameRegex) return roleNameMatchesRegex(node, toJsRegExp(selector.nameRegex));
      if (selector.name) return roleNameMatches(node, selector.name, selector.exact === true);
      return true;
    }
    default:
      return false;
  }
}

// ─── Role state filters (PILOT-655) ───

/** The iOS element types whose checked state falls back to isSelected (the agent's deriveCheckedState). */
const IOS_TOGGLE_TYPES = new Set([
  'XCUIElementTypeSwitch', 'XCUIElementTypeToggle', 'XCUIElementTypeCheckBox', 'XCUIElementTypeRadioButton',
]);

/** The iOS agent's ElementInfo.deriveCheckedState: the value first, then a toggle's selected state. */
function iosChecked(node: HierarchyNode): boolean {
  const value = (node.attributes.get('value') ?? '').trim().toLowerCase();
  if (['1', 'true', 'on', 'yes', 'selected', 'checked'].includes(value)) return true;
  if (['0', 'false', 'off', 'no', 'not selected', 'unchecked'].includes(value)) return false;
  if (value.endsWith(', checked') || value.endsWith(', selected')) return true;
  if (value.endsWith(', unchecked') || value.endsWith(', not selected')) return false;
  const type = node.attributes.get('type') ?? node.tagName;
  return IOS_TOGGLE_TYPES.has(type) && node.attributes.get('selected') === 'true';
}

/**
 * A node's state as the agents read it at runtime, from the hierarchy
 * snapshot; undefined when the node has no such state, which no filter
 * matches (the Android agent's expanded state of a node with neither an
 * expand nor a collapse action).
 */
function nodeState(node: HierarchyNode, key: 'checked' | 'disabled' | 'selected' | 'expanded'): boolean | undefined {
  const isAndroid = node.attributes.has('class');
  switch (key) {
    case 'disabled': return node.attributes.get('enabled') === 'false';
    case 'selected': return node.attributes.get('selected') === 'true';
    case 'checked': return isAndroid ? node.attributes.get('checked') === 'true' : iosChecked(node);
    case 'expanded': {
      // Android: the dump's tapsmith-expanded (from the expand/collapse
      // actions). iOS: React Native puts "expanded" in the value, and its
      // absence means collapsed.
      if (!isAndroid) return (node.attributes.get('value') ?? '').toLowerCase().includes('expanded');
      const expanded = node.attributes.get('tapsmith-expanded');
      return expanded === undefined ? undefined : expanded === 'true';
    }
  }
}

/** getByRole's checked / disabled / selected / expanded filters against the snapshot. */
function nodeMatchesRoleStates(node: HierarchyNode, selector: ParsedSelector): boolean {
  for (const key of ['checked', 'disabled', 'selected', 'expanded'] as const) {
    const want = selector[key];
    if (want !== undefined && nodeState(node, key) !== want) return false;
  }
  return true;
}

function webViewNodeMatchesSelector(node: HierarchyNode, selector: ParsedSelector): boolean {
  const tag = node.attributes.get('webview-tag') ?? '';
  const id = node.attributes.get('webview-id') ?? '';
  const text = node.attributes.get('text') ?? '';
  const ariaLabel = node.attributes.get('content-desc') ?? '';
  const placeholder = node.attributes.get('hint') ?? '';
  const testId = node.attributes.get('webview-testid') ?? '';
  const cssClass = node.attributes.get('webview-class') ?? '';

  switch (selector.type) {
    case 'wv-text':
      return text === selector.value;
    case 'wv-text-contains':
      return text.includes(selector.value);
    case 'wv-role': {
      const role = getNodeRole(node);
      if (role !== selector.value) return false;
      if (selector.name) {
        return (ariaLabel || text || placeholder) === selector.name;
      }
      return true;
    }
    case 'wv-label':
      return webViewAriaLabel(node) === selector.value;
    case 'wv-placeholder':
      return placeholder === selector.value;
    case 'wv-testid':
      return testId === selector.value;
    case 'wv-locator':
      return matchCssSelector(selector.value, tag, id, cssClass);
    default:
      return false;
  }
}

function matchCssSelector(css: string, tag: string, id: string, cssClass: string): boolean {
  // Simple CSS selector matching for the playground
  // Supports: #id, [id="…"], .class, tag, tag.class, tag#id
  const trimmed = css.trim();

  // `#` and `.` take a plain identifier only: the runtime's querySelectorAll
  // throws on `#1st`, and reads `#order.total` as an id and a class (PILOT-666).
  const classes = cssClass.split(/\s+/);
  if (trimmed.startsWith('#')) {
    const name = trimmed.slice(1);
    return isCssIdentifier(name) && id === name;
  }
  const attributeId = idOfAttributeSelector(trimmed);
  if (attributeId !== null) return id === attributeId;
  if (trimmed.startsWith('.')) {
    const name = trimmed.slice(1);
    return isCssIdentifier(name) && classes.includes(name);
  }

  // tag#id
  const tagIdMatch = trimmed.match(/^(\w+)#(\S+)$/);
  if (tagIdMatch) {
    return isCssIdentifier(tagIdMatch[2]) && tag === tagIdMatch[1] && id === tagIdMatch[2];
  }

  // tag.class
  const tagClassMatch = trimmed.match(/^(\w+)\.(\S+)$/);
  if (tagClassMatch) {
    return isCssIdentifier(tagClassMatch[2]) && tag === tagClassMatch[1] && classes.includes(tagClassMatch[2]);
  }

  // tag only
  return tag === trimmed;
}

/**
 * Collapse accessibility-tree duplicates targeting the same visual element —
 * the TS-matcher mirror of the SDK's collapseSameTargetDuplicates (the iOS
 * tree exposes some text elements twice: an attribute-carrying parent and an
 * inner child with identical text and pixel-identical bounds). Keeping them
 * distinct would make playground counts and .nth() suffixes disagree with
 * runtime resolution (PILOT-226).
 */
function collapseSameTargetNodes(nodes: HierarchyNode[]): HierarchyNode[] {
  if (nodes.length < 2) return nodes;
  const seen = new Set<string>();
  const result: HierarchyNode[] = [];
  for (const node of nodes) {
    const bounds = getNodeBounds(node);
    if (!bounds || bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) {
      result.push(node);
      continue;
    }
    const key = `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}|${getNodeText(node)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(node);
  }
  return result;
}

/**
 * Resolve a positional chain (.first()/.last()/.nth(n), negative n counting
 * from the end) to a concrete index. May be out of range — callers decide
 * whether that means "empty result" or an error.
 */
export function resolvePositionalIndex(count: number, index: number | 'first' | 'last'): number {
  if (index === 'first') return 0;
  if (index === 'last') return count - 1;
  return index < 0 ? count + index : index;
}

/** Apply a parsed positional chain to a match list (out of range → empty). */
export function applyPositionalIndex<T>(items: T[], index: ParsedSelector['index']): T[] {
  if (index === undefined) return items;
  const idx = resolvePositionalIndex(items.length, index);
  return idx >= 0 && idx < items.length ? [items[idx]] : [];
}

/**
 * Of the Android dual-path roles, those whose class (TextView) the agent never
 * accepts on its own: without a role description a node is neither.
 */
const ANDROID_DESCRIPTION_ONLY_ROLES = new Set(['heading', 'link']);

/**
 * Whether a native node has `role` (canonical) the way the agent's getByRole
 * decides it: its reported role, or membership of the role's classes / element
 * types — which covers roles the reverse map leaves out (list, listitem,
 * scrollview, …) without making every layout suggest getByRole("listitem").
 *
 * iOS heading is header-trait only (its reported role), like the agent since
 * PILOT-608: static text is a heading's candidate type, not proof of one.
 * `named` is whether the query has a name, which identifies an iOS generic
 * view no role description marks.
 */
function nodeHasRole(node: HierarchyNode, role: string, named: boolean): boolean {
  const reported = getNodeRole(node);
  if (reported && normalizeRole(reported) === role) return true;
  const className = node.attributes.get('class');
  if (className) {
    // Like the agent's dual-path post-filter: a published role description
    // decides the role on its own (it did not match above), and only a node
    // without one falls back to its class.
    if (ANDROID_DUAL_PATH_ROLES.has(role)
      && (ANDROID_DESCRIPTION_ONLY_ROLES.has(role) || node.attributes.has('tapsmith-role'))) return false;
    return ANDROID_ROLE_CLASSES[role]?.includes(className) ?? false;
  }
  const type = node.attributes.get('type') ?? node.tagName;
  if (type === 'XCUIElementTypeOther') {
    // RN's checkbox, alert, menuitem, …: a description or a name decides,
    // like the agent (PILOT-608, PILOT-664).
    const generic = iosGenericViewHasRole(role, { value: node.attributes.get('value'), traitRole: reported, named });
    if (generic !== undefined) return generic;
  } else if (type === 'XCUIElementTypeStaticText' && IOS_STATIC_TEXT_ROLES.has(role)) {
    // An RN alert Text, on the same terms (PILOT-718). A static text reports
    // "text" unless a trait makes it a heading or link; the dump can't show
    // a button trait, which the agent also excludes.
    return iosGenericViewHasRole(role, {
      value: node.attributes.get('value'), traitRole: reported === 'text' ? '' : reported, named,
    }) ?? false;
  }
  return role !== 'heading' && (IOS_ROLE_TYPES[role]?.includes(type) ?? false);
}

/**
 * Why a parsed locator would throw when the test builds it, or `null`. Today
 * that is a native getByRole role the runtime rejects (PILOT-556); WebView
 * roles are DOM ARIA roles and are not checked.
 */
export function parsedSelectorError(selector: ParsedSelector): string | null {
  return selector.type === 'role' ? unknownRoleMessage(selector.value) : null;
}

export function findMatchingNodes(roots: HierarchyNode[], selector: ParsedSelector): HierarchyNode[] {
  const raw: HierarchyNode[] = [];
  // iOS getByText, like the agent (PILOT-794): a node's text content depends
  // on its container's label, and a match that contains another match gives
  // way to it (innermost). `suppressed` holds those ancestors' raw indices.
  const iosText = TEXT_SELECTOR_TYPES.has(selector.type);
  const suppressed = new Set<number>();
  const matchedAncestors: number[] = [];

  function walk(node: HierarchyNode, containerLabel: string) {
    // What isn't the app's never matches (PILOT-756, non-app-nodes.ts).
    if (isNonAppSubtree(node)) return;
    const isIos = !node.attributes.has('class') && !isWebViewNode(node);
    const appNode = !isNonAppNode(node);
    const matches = appNode && (iosText && isIos
      ? iosNodeMatchesText(node, selector, containerLabel)
      : nodeMatchesSelector(node, selector));
    let pushed = false;
    if (matches) {
      if (iosText && isIos) {
        for (const index of matchedAncestors) suppressed.add(index);
        matchedAncestors.push(raw.length);
        pushed = true;
      }
      raw.push(node);
    }
    const label = node.attributes.get('label') ?? '';
    const childContainer = isIos && appNode && label !== '' ? label : containerLabel;
    for (const child of node.children) {
      walk(child, childContainer);
    }
    if (pushed) matchedAncestors.pop();
  }

  for (const root of roots) {
    walk(root, '');
  }

  const kept = suppressed.size === 0 ? raw : raw.filter((_, i) => !suppressed.has(i));
  return applyPositionalIndex(collapseSameTargetNodes(kept), selector.index);
}

// Geometry lives with the hierarchy model (no matching); re-exported for
// existing importers.
export { getNodeBounds, hitTest } from './hierarchy-utils.js';
