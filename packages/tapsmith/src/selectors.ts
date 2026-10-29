/**
 * Selectors — internal representation of how to locate UI elements.
 *
 * The public API is `device.getByText()`, `device.getByRole()`, etc. (see
 * `device.ts`). Selector values are an implementation detail of how those
 * methods communicate with the daemon over gRPC. Nothing in this file is
 * part of the user-facing surface.
 *
 * @internal
 */

import { textRegexValue, formatRegex } from './text-regex.js';
import type { TextRegexValue } from './text-regex.js';
import { assertKnownRole } from './roles.js';

// ─── Types ───

/** Options for `getByRole()` on a device or element handle. */
export interface RoleLocatorOptions {
  /**
   * Filter by accessible name. A case-insensitive substring match by default,
   * like Playwright; whitespace is normalized on both sides. A RegExp is
   * tested against the whitespace-normalized name.
   */
  name?: string | RegExp;
  /** Match a string `name` case-sensitively and as the whole string. Ignored for a RegExp. */
  exact?: boolean;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
}

export interface RoleSelectorValue {
  role: string;
  name: string;
  /**
   * Match `name` case-sensitively and as the whole string. Absent is
   * Playwright's default: a case-insensitive substring match.
   */
  exact?: boolean;
  /**
   * getByRole `{ name: RegExp }`; `name` is then empty here (the
   * proto carries the literal in `name` for agents without RegExp support).
   */
  nameRegex?: TextRegexValue;
  checked?: boolean;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
}

export type SelectorKind =
  | { type: 'role'; value: RoleSelectorValue }
  | { type: 'text'; value: string }
  | { type: 'textContains'; value: string }
  | { type: 'textRegex'; value: TextRegexValue }
  | { type: 'contentDesc'; value: string }
  | { type: 'hint'; value: string }
  | { type: 'className'; value: string }
  | { type: 'testId'; value: string }
  | { type: 'id'; value: string }
  | { type: 'xpath'; value: string }
  | { type: 'label'; value: string }
  | { type: 'labelRegex'; value: TextRegexValue };

/**
 * A Selector identifies a UI element. Internal representation only.
 *
 * @internal
 */
export interface Selector {
  readonly kind: SelectorKind;
  readonly parent?: Selector;
}

// ─── Internal helpers ───

/** @internal */
export function makeSelector(kind: SelectorKind, parent?: Selector): Selector {
  return { kind, parent };
}

/** @internal — Return a new selector scoped within `parent`. */
export function withParent(child: Selector, parent: Selector): Selector {
  return { kind: child.kind, parent };
}

// ─── Proto serialization ───

/**
 * Converts a Selector into the proto-compatible shape expected by the gRPC
 * layer. This is the only place that knows about the protobuf message layout.
 *
 * @internal
 */
export function selectorToProto(selector: Selector): Record<string, unknown> {
  const proto: Record<string, unknown> = {};

  switch (selector.kind.type) {
    case 'role': {
      const rv = selector.kind.value;
      const roleProto: Record<string, unknown> = { role: rv.role, name: rv.name };
      if (rv.exact) roleProto.exact = true;
      if (rv.nameRegex) {
        roleProto.nameRegex = regexToProto(rv.nameRegex);
        // An agent from before RegExp support ignores `nameRegex` and would
        // read an empty name as "any element of this role" — and act on the
        // wrong one. The literal as `name` matches nothing there, so such an
        // agent fails loudly instead; current agents ignore `name` when
        // `nameRegex` is set.
        roleProto.name = formatRegex(rv.nameRegex);
      }
      if (rv.checked !== undefined) roleProto.checked = rv.checked;
      if (rv.disabled !== undefined) roleProto.disabled = rv.disabled;
      if (rv.selected !== undefined) roleProto.selected = rv.selected;
      if (rv.expanded !== undefined) roleProto.expanded = rv.expanded;
      proto.role = roleProto;
      break;
    }
    case 'text':
      proto.text = selector.kind.value;
      break;
    case 'textContains':
      proto.textContains = selector.kind.value;
      break;
    case 'textRegex':
      proto.textRegex = regexToProto(selector.kind.value);
      break;
    case 'contentDesc':
      proto.contentDesc = selector.kind.value;
      break;
    case 'hint':
      proto.hint = selector.kind.value;
      break;
    case 'className':
      proto.className = selector.kind.value;
      break;
    case 'testId':
      proto.testId = selector.kind.value;
      break;
    case 'id':
      proto.resourceId = selector.kind.value;
      break;
    case 'xpath':
      proto.xpath = selector.kind.value;
      break;
    case 'label':
      proto.label = selector.kind.value;
      break;
    case 'labelRegex':
      proto.labelRegex = regexToProto(selector.kind.value);
      break;
  }

  if (selector.parent) {
    proto.parent = selectorToProto(selector.parent);
  }

  return proto;
}

/** The proto `TextRegex` message: what the agents compile, plus the literal for their messages. */
function regexToProto(v: TextRegexValue): Record<string, unknown> {
  return { pattern: v.pattern, ignoreCase: v.ignoreCase, display: formatRegex(v) };
}

// ─── Human-readable formatting (error messages, traces) ───

/**
 * Render a Selector as the user-facing locator call that produced it, e.g.
 * `getByText("Sign in")` or `getByRole("button", { name: "Submit" })`. Used in error
 * messages and trace output.
 *
 * @internal
 */
export function formatSelector(sel: Selector): string {
  let base: string;
  switch (sel.kind.type) {
    case 'role': {
      const rv = sel.kind.value;
      // Rendered as the call the user wrote, so it can be pasted back as code.
      const opts: string[] = [];
      if (rv.nameRegex) opts.push(`name: ${formatRegex(rv.nameRegex)}`);
      else if (rv.name) opts.push(`name: ${JSON.stringify(rv.name)}`);
      if (rv.name && rv.exact) opts.push('exact: true');
      for (const key of ['checked', 'disabled', 'selected', 'expanded'] as const) {
        if (rv[key] !== undefined) opts.push(`${key}: ${rv[key]}`);
      }
      base = opts.length
        ? `getByRole(${JSON.stringify(rv.role)}, { ${opts.join(', ')} })`
        : `getByRole(${JSON.stringify(rv.role)})`;
      break;
    }
    case 'text': base = `getByText("${sel.kind.value}", { exact: true })`; break;
    case 'textContains': base = `getByText("${sel.kind.value}")`; break;
    case 'textRegex': base = `getByText(${formatRegex(sel.kind.value)})`; break;
    case 'contentDesc': base = `getByDescription("${sel.kind.value}")`; break;
    case 'hint': base = `getByPlaceholder("${sel.kind.value}")`; break;
    case 'testId': base = `getByTestId("${sel.kind.value}")`; break;
    case 'label': base = `getByLabel("${sel.kind.value}")`; break;
    case 'labelRegex': base = `getByLabel(${formatRegex(sel.kind.value)})`; break;
    case 'id': base = `locator({ id: "${sel.kind.value}" })`; break;
    case 'className': base = `locator({ className: "${sel.kind.value}" })`; break;
    case 'xpath': base = `locator({ xpath: "${sel.kind.value}" })`; break;
    default: base = JSON.stringify(selectorToProto(sel)); break;
  }
  // Scoped locators chain getBy* calls: getByRole("list").getByText("Row")
  if (sel.parent) return `${formatSelector(sel.parent)}.${base}`;
  return base;
}

// ─── Internal builders (used by Device/ElementHandle getBy* methods) ───

/**
 * Throw when a getBy* text argument is neither a string nor a RegExp. The
 * parameters are typed, but tests run through tsx are not type-checked, and
 * anything else would reach the agent as garbage and silently match nothing.
 */
function assertTextArg(value: unknown, what: string): asserts value is string | RegExp {
  if (typeof value === 'string' || value instanceof RegExp) return;
  const got = value === null ? 'null' : `a ${typeof value}`;
  throw new TypeError(`${what} expects a string or a RegExp, got ${got}.`);
}

/** @internal */
export function _role(roleName: string, options?: RoleLocatorOptions): Selector {
  // Fail fast on a role no element can have, instead of polling until the
  // timeout (PILOT-556).
  assertKnownRole(roleName, 'getByRole()');
  if (options?.name !== undefined) assertTextArg(options.name, 'getByRole() option `name`');
  const nameRegex = options?.name instanceof RegExp
    ? textRegexValue(options.name, 'getByRole() option `name`')
    : undefined;
  const name = typeof options?.name === 'string' ? options.name : '';
  return makeSelector({
    type: 'role',
    value: {
      role: roleName,
      name,
      // `exact` only qualifies a string name; Playwright ignores it without
      // one, and for a RegExp.
      ...(options?.exact && name ? { exact: true } : {}),
      ...(nameRegex ? { nameRegex } : {}),
      checked: options?.checked,
      disabled: options?.disabled,
      selected: options?.selected,
      expanded: options?.expanded,
    },
  });
}

/** @internal — getByText with `{ exact: true }`; a RegExp ignores `exact`, as in Playwright. */
export function _text(exactText: string | RegExp): Selector {
  assertTextArg(exactText, 'getByText()');
  if (exactText instanceof RegExp) return _textRegex(exactText);
  return makeSelector({ type: 'text', value: exactText });
}

/** @internal — getByText's default substring match, or a RegExp. */
export function _textContains(partial: string | RegExp): Selector {
  assertTextArg(partial, 'getByText()');
  if (partial instanceof RegExp) return _textRegex(partial);
  return makeSelector({ type: 'textContains', value: partial });
}

function _textRegex(re: RegExp): Selector {
  return makeSelector({ type: 'textRegex', value: textRegexValue(re, 'getByText()') });
}

/** @internal */
export function _contentDesc(desc: string): Selector {
  return makeSelector({ type: 'contentDesc', value: desc });
}

/** @internal */
export function _hint(hintText: string): Selector {
  return makeSelector({ type: 'hint', value: hintText });
}

/** @internal */
export function _className(name: string): Selector {
  return makeSelector({ type: 'className', value: name });
}

/** @internal */
export function _testId(id: string): Selector {
  return makeSelector({ type: 'testId', value: id });
}

/** @internal */
export function _id(resourceId: string): Selector {
  return makeSelector({ type: 'id', value: resourceId });
}

/** @internal */
export function _xpath(expr: string): Selector {
  return makeSelector({ type: 'xpath', value: expr });
}

/** @internal */
export function _label(text: string | RegExp): Selector {
  assertTextArg(text, 'getByLabel()');
  if (text instanceof RegExp) {
    return makeSelector({ type: 'labelRegex', value: textRegexValue(text, 'getByLabel()') });
  }
  return makeSelector({ type: 'label', value: text });
}
