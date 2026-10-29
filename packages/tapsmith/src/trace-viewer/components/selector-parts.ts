/**
 * The trace's serialized selector (the proto JSON an action or assertion
 * event records) as the locator call that made it, for the action list and
 * the Call tab.
 */

import { escapeJsString } from '../../js-string-escape.js';

/** One entry of a getter's options object, e.g. `name: "Save"` or `exact: true`. */
export interface SelectorOption {
  key: string;
  value: string;
  /** Shown as is (a RegExp literal or a boolean) rather than as a quoted string. */
  literal?: boolean;
}

export interface SelectorParts {
  fn: string;
  args: string[];
  optionKey?: string;
  /** Per arg: a RegExp literal, shown unquoted. */
  literal?: boolean[];
  /**
   * The getter's options object — getByRole's `name`, `exact` and state
   * filters, getByText's `exact` — so the locator reads as the code that ran
   * and a copy pasted into the Locator tab or an MCP tool matches what the
   * action matched.
   */
  options?: SelectorOption[];
  /**
   * The locator this one is scoped to (`getByRole("list").getByText("x")`).
   * Shown, so a copy keeps the scope instead of matching every "x" on screen.
   */
  parent?: SelectorParts;
}

/** A raw value as it is written in code: quoted and escaped, or as is when `literal`. */
export function selectorValueCode(value: string, literal: boolean | undefined): string {
  return literal ? value : `"${escapeJsString(value)}"`;
}

const ROLE_STATE_KEYS = ['checked', 'disabled', 'selected', 'expanded'] as const;

function roleOptions(role: Record<string, unknown>): SelectorOption[] {
  const options: SelectorOption[] = [];
  const nameRegex = role.nameRegex as { display?: string } | undefined;
  if (nameRegex?.display) options.push({ key: 'name', value: nameRegex.display, literal: true });
  else if (typeof role.name === 'string' && role.name) options.push({ key: 'name', value: role.name });
  if (role.exact === true && !nameRegex?.display) options.push({ key: 'exact', value: 'true', literal: true });
  for (const key of ROLE_STATE_KEYS) {
    if (typeof role[key] === 'boolean') options.push({ key, value: String(role[key]), literal: true });
  }
  return options;
}

export function parseSelectorParts(sel: string | undefined): SelectorParts | null {
  if (!sel) return null;
  try {
    return protoParts(JSON.parse(sel));
  } catch {
    return null;
  }
}

/** The parts of one proto selector and the parents it is scoped to, or null for one this cannot show. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the trace's untyped selector JSON
function protoParts(parsed: any): SelectorParts | null {
  const leaf = leafParts(parsed);
  if (!leaf || !parsed.parent) return leaf;
  const parent = protoParts(parsed.parent);
  return parent ? { ...leaf, parent } : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the trace's untyped selector JSON
function leafParts(parsed: any): SelectorParts | null {
  if (parsed.text) return { fn: 'getByText', args: [parsed.text], options: [{ key: 'exact', value: 'true', literal: true }] };
  if (parsed.textContains) return { fn: 'getByText', args: [parsed.textContains] };
  if (parsed.textRegex) return { fn: 'getByText', args: [parsed.textRegex.display], literal: [true] };
  if (parsed.labelRegex) return { fn: 'getByLabel', args: [parsed.labelRegex.display], literal: [true] };
  if (parsed.role) {
    const options = roleOptions(parsed.role);
    return { fn: 'getByRole', args: [parsed.role.role], ...(options.length ? { options } : {}) };
  }
  if (parsed.contentDesc) return { fn: 'getByDescription', args: [parsed.contentDesc] };
  if (parsed.hint) return { fn: 'getByPlaceholder', args: [parsed.hint] };
  if (parsed.testId) return { fn: 'getByTestId', args: [parsed.testId] };
  if (parsed.label) return { fn: 'getByLabel', args: [parsed.label] };
  if (parsed.resourceId) return { fn: 'locator', args: [parsed.resourceId], optionKey: 'id' };
  if (parsed.className) return { fn: 'locator', args: [parsed.className], optionKey: 'className' };
  if (parsed.xpath) return { fn: 'locator', args: [parsed.xpath], optionKey: 'xpath' };
  return null;
}

/** The parts as one line of locator code, e.g. `getByRole("button", { name: "Save" })`. */
export function selectorPartsCode(parts: SelectorParts): string {
  const leaf = leafCode(parts);
  return parts.parent ? `${selectorPartsCode(parts.parent)}.${leaf}` : leaf;
}

function leafCode(parts: SelectorParts): string {
  if (parts.optionKey) return `${parts.fn}({ ${parts.optionKey}: ${selectorValueCode(parts.args[0], false)} })`;
  const args = parts.args.map((a, i) => selectorValueCode(a, parts.literal?.[i]));
  if (parts.options?.length) {
    args.push(`{ ${parts.options.map((o) => `${o.key}: ${selectorValueCode(o.value, o.literal)}`).join(', ')} }`);
  }
  return `${parts.fn}(${args.join(', ')})`;
}
