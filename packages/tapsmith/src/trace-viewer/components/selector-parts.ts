/**
 * The trace's serialized selector (the proto JSON an action or assertion
 * event records) as the locator call that made it, for the action list and
 * the Call tab.
 */

export interface SelectorParts {
  fn: string;
  args: string[];
  optionKey?: string;
  /** Per arg: a RegExp literal, shown unquoted (PILOT-520). */
  literal?: boolean[];
  /**
   * The last arg is getByRole's name, shown as `{ name: … }` so the locator
   * reads as code that runs — a copy pasted into the Locator tab or an MCP
   * tool parses (PILOT-717).
   */
  nameOption?: boolean;
}

export function parseSelectorParts(sel: string | undefined): SelectorParts | null {
  if (!sel) return null;
  try {
    const parsed = JSON.parse(sel);
    if (parsed.text) return { fn: 'getByText', args: [parsed.text] };
    if (parsed.textContains) return { fn: 'getByText', args: [parsed.textContains] };
    if (parsed.textRegex) return { fn: 'getByText', args: [parsed.textRegex.display], literal: [true] };
    if (parsed.labelRegex) return { fn: 'getByLabel', args: [parsed.labelRegex.display], literal: [true] };
    if (parsed.role?.nameRegex) {
      return { fn: 'getByRole', args: [parsed.role.role, parsed.role.nameRegex.display], literal: [false, true], nameOption: true };
    }
    if (parsed.role?.name) return { fn: 'getByRole', args: [parsed.role.role, parsed.role.name], nameOption: true };
    if (parsed.role) return { fn: 'getByRole', args: [parsed.role.role] };
    if (parsed.contentDesc) return { fn: 'getByDescription', args: [parsed.contentDesc] };
    if (parsed.hint) return { fn: 'getByPlaceholder', args: [parsed.hint] };
    if (parsed.testId) return { fn: 'getByTestId', args: [parsed.testId] };
    if (parsed.label) return { fn: 'getByLabel', args: [parsed.label] };
    if (parsed.resourceId) return { fn: 'locator', args: [parsed.resourceId], optionKey: 'id' };
    if (parsed.className) return { fn: 'locator', args: [parsed.className], optionKey: 'className' };
    if (parsed.xpath) return { fn: 'locator', args: [parsed.xpath], optionKey: 'xpath' };
    return null;
  } catch {
    return null;
  }
}

/** The parts as one line of locator code, e.g. `getByRole("button", { name: "Save" })`. */
export function selectorPartsCode(parts: SelectorParts): string {
  if (parts.optionKey) return `${parts.fn}({ ${parts.optionKey}: "${parts.args[0]}" })`;
  const args = parts.args.map((a, i) => (parts.literal?.[i] ? a : `"${a}"`));
  if (parts.nameOption) args[args.length - 1] = `{ name: ${args[args.length - 1]} }`;
  return `${parts.fn}(${args.join(', ')})`;
}
