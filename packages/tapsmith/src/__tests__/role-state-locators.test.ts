import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes, locatorStringError } from '../trace-viewer/components/selector-matching.js';

// getByRole's state options (checked / disabled / selected / expanded) in
// locator strings, as the offline trace Locator Playground parses them (the
// MCP tools build them with the SDK since PILOT-848). They used to be dropped silently, so
// `selected: true` matched an unselected element (PILOT-655).

function makeNode(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName, attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

// ─── Parsing ───

describe('parseSelectorString: getByRole state options', () => {
  it.each(['checked', 'disabled', 'selected', 'expanded'] as const)('parses %s: true and false', (key) => {
    expect(parseSelectorString(`device.getByRole("button", { name: "A", ${key}: true })`)?.[key]).toBe(true);
    expect(parseSelectorString(`device.getByRole("button", { name: "A", ${key}: false })`)?.[key]).toBe(false);
  });

  it('parses every state together with name and exact, in any order', () => {
    const parsed = parseSelectorString(
      'device.getByRole("tab", { selected: false, name: "Settings", exact: true, disabled: false, checked: true, expanded: true, })',
    );
    expect(parsed).toEqual({
      type: 'role', value: 'tab', name: 'Settings', exact: true,
      checked: true, disabled: false, selected: false, expanded: true, index: undefined,
    });
  });

  it('parses a state with no name, and with a RegExp name', () => {
    expect(parseSelectorString('device.getByRole("checkbox", { checked: true })'))
      .toMatchObject({ type: 'role', value: 'checkbox', checked: true });
    expect(parseSelectorString('device.getByRole("button", { name: /mag/i, selected: true })'))
      .toMatchObject({ type: 'role', nameRegex: { source: 'mag', flags: 'i' }, selected: true });
  });

  it('keeps a positional chain alongside a state', () => {
    expect(parseSelectorString('device.getByRole("button", { selected: true }).nth(1)'))
      .toMatchObject({ selected: true, index: 1 });
  });

  it('does not read a state out of the quoted name', () => {
    const parsed = parseSelectorString('device.getByRole("button", { name: "selected: true" })');
    expect(parsed?.name).toBe('selected: true');
    expect(parsed?.selected).toBeUndefined();
  });

  it('refuses an option it does not understand rather than dropping it', () => {
    for (const input of [
      'device.getByRole("heading", { name: "A", level: 2 })',
      'device.getByRole("button", { includeHidden: true })',
      'device.getByRole("button", { selected: "yes" })',
      'device.getByRole("button", { selected: true selected: false })',
      'device.getByRole("button", { selected: 1 })',
      'device.getByText("A", { exact: true, foo: 1 })',
    ]) {
      expect(parseSelectorString(input), input).toBeNull();
    }
  });

  it('refuses a state option on a getter that does not take one', () => {
    expect(parseSelectorString('device.getByText("A", { selected: true })')).toBeNull();
    expect(parseSelectorString('device.getByLabel("A", { checked: true })')).toBeNull();
    expect(parseSelectorString('webview.getByRole("tab", { name: "A", selected: true })')).toBeNull();
  });

  it('still parses the options it always understood', () => {
    expect(parseSelectorString('device.getByText("A", { exact: false })')).toMatchObject({ type: 'textContains' });
    expect(parseSelectorString('webview.getByText("A", { exact: true })')).toMatchObject({ type: 'wv-text' });
    expect(parseSelectorString('device.getByRole("button", {})')).toMatchObject({ type: 'role', value: 'button' });
  });
});

describe('locatorStringError: why a locator\'s options are refused', () => {
  it('names an unknown option, a non-boolean value and an option the getter does not take', () => {
    expect(locatorStringError('device.getByRole("button", { includeHidden: true })')).toBe('unsupported option "includeHidden"');
    expect(locatorStringError('device.getByRole("button", { selected: "yes" })')).toBe('option "selected" must be true or false, got "yes"');
    expect(locatorStringError('device.getByText("A", { selected: true }).first()'))
      .toBe('device.getByText() has no option "selected" (it takes exact)');
    expect(locatorStringError('device.getByLabel("A", { exact: true })'))
      .toBe('device.getByLabel() has no option "exact" (it takes no options)');
    expect(locatorStringError('webview.getByRole("tab", { name: "A", selected: true })'))
      .toBe('webview.getByRole() has no option "selected" (it takes name)');
  });

  it('says the name could not be read rather than that getByRole has no name', () => {
    for (const input of [
      'device.getByRole("button", { name: `A` })',
      'device.getByRole("button", { name: "A", name: "B" })',
      'device.getByRole("button", { name : "A" })',
    ]) {
      expect(locatorStringError(input), input).toBe('cannot read the name option (use one quoted string or a RegExp literal)');
    }
  });

  it('is null for valid options and for locators without any', () => {
    expect(locatorStringError('device.getByRole("tab", { name: "A", selected: true })')).toBeNull();
    expect(locatorStringError('device.getByText("A")')).toBeNull();
    expect(locatorStringError('not a locator')).toBeNull();
    // A getter Tapsmith does not have is the problem, not its options.
    expect(locatorStringError('device.getByAltText("Logo", { exact: true })')).toBeNull();
    expect(locatorStringError('webview.getByTitle("Help", { exact: true })')).toBeNull();
  });

});

// ─── Locator Playground (hierarchy snapshot) ───

describe('findMatchingNodes: state filters agree with the agents', () => {
  const on = (roots: HierarchyNode[], selector: string) => {
    const parsed = parseSelectorString(selector);
    expect(parsed, selector).not.toBeNull();
    return findMatchingNodes(roots, parsed!);
  };

  describe('Android', () => {
    const card = (name: string, attrs: Record<string, string>, top: number) => makeNode('node', {
      class: 'android.view.ViewGroup', 'tapsmith-role': 'button', 'content-desc': name,
      enabled: 'true', checked: 'false', selected: 'false', bounds: `[0,${top}][100,${top + 50}]`, ...attrs,
    });
    const adventure = card('Adventure', { selected: 'true' }, 0);
    const magical = card('Magical', {}, 60);
    const off = card('Off', { enabled: 'false' }, 120);
    const sw = makeNode('node', { class: 'android.widget.Switch', text: 'Dark', checked: 'true', enabled: 'true', selected: 'false', bounds: '[0,180][100,230]' });
    const details = card('Details', { 'tapsmith-expanded': 'true' }, 240);
    const more = card('More', { 'tapsmith-expanded': 'false' }, 300);
    const roots = [makeNode('hierarchy', {}, [adventure, magical, off, sw, details, more])];

    it('selected', () => {
      expect(on(roots, 'device.getByRole("button", { name: "Magical", exact: true, selected: true })')).toEqual([]);
      expect(on(roots, 'device.getByRole("button", { name: "Magical", exact: true, selected: false })')).toEqual([magical]);
      expect(on(roots, 'device.getByRole("button", { name: "Adventure", exact: true, selected: false })')).toEqual([]);
      expect(on(roots, 'device.getByRole("button", { selected: true })')).toEqual([adventure]);
    });

    it('disabled reads the enabled attribute', () => {
      expect(on(roots, 'device.getByRole("button", { disabled: true })')).toEqual([off]);
      expect(on(roots, 'device.getByRole("button", { name: "Off", disabled: false })')).toEqual([]);
    });

    it('checked', () => {
      expect(on(roots, 'device.getByRole("switch", { checked: true })')).toEqual([sw]);
      expect(on(roots, 'device.getByRole("switch", { checked: false })')).toEqual([]);
    });

    it('expanded reads tapsmith-expanded; a node without one is neither', () => {
      expect(on(roots, 'device.getByRole("button", { expanded: true })')).toEqual([details]);
      expect(on(roots, 'device.getByRole("button", { expanded: false })')).toEqual([more]);
    });
  });

  describe('iOS', () => {
    const el = (type: string, attrs: Record<string, string>, y: number) => makeNode(type, {
      type, enabled: 'true', selected: 'false', value: '', x: '0', y: String(y), width: '100', height: '40', ...attrs,
    });
    const tab = el('XCUIElementTypeButton', { label: 'Library', selected: 'true' }, 0);
    const other = el('XCUIElementTypeButton', { label: 'Settings' }, 50);
    const sw = el('XCUIElementTypeSwitch', { label: 'Dark', value: '1' }, 100);
    const box = el('XCUIElementTypeOther', { label: 'Agree', value: 'checkbox, checked', role: 'checkbox' }, 150);
    const toggle = el('XCUIElementTypeButton', { label: 'Details', value: 'expanded' }, 200);
    const off = el('XCUIElementTypeButton', { label: 'Off', enabled: 'false' }, 250);
    const roots = [makeNode('XCUIElementTypeApplication', { type: 'XCUIElementTypeApplication' }, [tab, other, sw, box, toggle, off])];

    it('selected and disabled', () => {
      expect(on(roots, 'device.getByRole("button", { selected: true })')).toEqual([tab]);
      expect(on(roots, 'device.getByRole("button", { name: "Library", selected: false })')).toEqual([]);
      expect(on(roots, 'device.getByRole("button", { disabled: true })')).toEqual([off]);
    });

    it('checked derives from the value, like the agent', () => {
      expect(on(roots, 'device.getByRole("switch", { checked: true })')).toEqual([sw]);
      expect(on(roots, 'device.getByRole("switch", { checked: false })')).toEqual([]);
      expect(on(roots, 'device.getByRole("button", { name: "Settings", checked: false })')).toEqual([other]);
    });

    it('expanded reads "expanded" in the value', () => {
      expect(on(roots, 'device.getByRole("button", { expanded: true })')).toEqual([toggle]);
      expect(on(roots, 'device.getByRole("button", { name: "Settings", expanded: false })')).toEqual([other]);
    });
  });
});
