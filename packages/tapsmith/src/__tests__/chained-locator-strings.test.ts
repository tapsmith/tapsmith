import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes, locatorStringError } from '../trace-viewer/components/selector-matching.js';

// Locator strings with a call chained after the getter, as the offline
// trace Locator Playground parses them (the MCP tools build chains with the
// SDK since PILOT-848). The parser read the first getter and dropped the rest, so
// `device.getByRole("list").getByText("x")` matched every list and a tap could
// land on the wrong element (PILOT-660). A chained call is now refused, with
// an error that names it.

describe('parseSelectorString refuses a chained call instead of dropping it', () => {
  const chained = [
    // Scoped getters
    'device.getByRole("list").getByText("x")',
    'device.getByRole("list").getByRole("button", { name: "Delete" })',
    'device.getByTestId("row").locator({ id: "com.app:id/title" })',
    // filter / and / or
    'device.getByText("a").filter({ hasText: "b" })',
    'device.getByRole("button").and(device.getByText("Save"))',
    'device.getByText("Save").or(device.getByText("Submit"))',
    // A positional step that is not last
    'device.getByRole("listitem").first().getByText("x")',
    'device.getByRole("listitem").nth(2).filter({ hasText: "b" })',
    // An action pasted along with the locator
    'device.getByText("Sign in").tap()',
    // Over several lines
    'device.getByRole("list")\n  .getByText("x")',
    // Every receiver and form, not just device.getBy*
    'device.locator({ id: "com.app:id/list" }).getByText("x")',
    'webview.getByRole("button", { name: "Go" }).getByText("x")',
    'webview.locator("#form").locator("input")',
    'text("Sign in").first().tap()',
    // Text after the call that is not a call at all
    'device.getByText("a") foo',
    'device.getByText("a"))',
  ];
  for (const input of chained) {
    it(JSON.stringify(input), () => {
      expect(parseSelectorString(input)).toBeNull();
    });
  }

  it('still reads a value that contains what looks like a chained call', () => {
    expect(parseSelectorString('device.getByText(").getByText(\\"x\\")")')).toEqual({
      type: 'textContains', value: ').getByText("x")', index: undefined,
    });
    expect(parseSelectorString('device.getByRole("button", { name: "a).filter(b" }).first()')).toEqual({
      type: 'role', value: 'button', name: 'a).filter(b', index: 'first',
    });
  });

  it('still parses one getter with a trailing positional chain', () => {
    expect(parseSelectorString('device.getByText("Item").nth(-1)')).toMatchObject({ type: 'textContains', index: -1 });
    expect(parseSelectorString('device.getByText("Item") .first()')).toMatchObject({ type: 'textContains', index: 'first' });
    expect(parseSelectorString('  device.getByText("Item")  ')).toMatchObject({ type: 'textContains', index: undefined });
  });

  it('reads a locator pasted as a statement, keeping its positional step', () => {
    // `.first();` used to leave the step unparsed and silently dropped.
    expect(parseSelectorString('device.getByText("Item").first();')).toMatchObject({ type: 'textContains', index: 'first' });
    expect(parseSelectorString('device.getByText("Item");  ')).toMatchObject({ type: 'textContains', index: undefined });
  });
});

describe('locatorStringError names the chained call', () => {
  it('names the first call after the getter', () => {
    expect(locatorStringError('device.getByRole("list").getByText("x")'))
      .toBe('unsupported chained call .getByText() — a locator string here is one getter, optionally followed by .first(), .last() or .nth(n)');
    expect(locatorStringError('device.getByText("a").filter({ hasText: "b" })')).toMatch(/^unsupported chained call \.filter\(\) — /);
    expect(locatorStringError('device.getByRole("button").and(device.getByText("Save"))')).toMatch(/^unsupported chained call \.and\(\) — /);
    expect(locatorStringError('device.getByText("Save").or(device.getByText("Submit"))')).toMatch(/^unsupported chained call \.or\(\) — /);
    expect(locatorStringError('device.getByText("Sign in").tap()')).toMatch(/^unsupported chained call \.tap\(\) — /);
    expect(locatorStringError('device.getByRole("list")\n  .getByText("x")')).toMatch(/^unsupported chained call \.getByText\(\) — /);
    expect(locatorStringError('webview.locator("#form").locator("input")')).toMatch(/^unsupported chained call \.locator\(\) — /);
    expect(locatorStringError('text("Sign in").first().tap()')).toMatch(/^unsupported chained call \.tap\(\) — /);
  });

  it('names the call a mid-chain positional step leads to, not the step', () => {
    expect(locatorStringError('device.getByRole("listitem").first().getByText("x")'))
      .toMatch(/^unsupported chained call \.getByText\(\) — /);
    expect(locatorStringError('device.getByRole("listitem").nth(2).filter({ hasText: "b" })'))
      .toMatch(/^unsupported chained call \.filter\(\) — /);
  });

  it('quotes text after the locator that is not a call', () => {
    expect(locatorStringError('device.getByText("a") foo')).toBe('unexpected text after the locator: "foo"');
    expect(locatorStringError('device.getByText("a"))')).toBe('unexpected text after the locator: ")"');
  });

  it('reports a refused option before a chained call (PILOT-655)', () => {
    expect(locatorStringError('device.getByRole("heading", { level: 2 }).getByText("x")')).toBe('unsupported option "level"');
  });

  it('is null for a valid locator and for a string that is not one', () => {
    expect(locatorStringError('device.getByText("Item").first()')).toBeNull();
    expect(locatorStringError('device.getByText("Item").first();')).toBeNull();
    expect(locatorStringError('click the login button')).toBeNull();
    // A getter Tapsmith does not have is the problem, not what follows it.
    expect(locatorStringError('device.getByAltText("Logo").first().tap()')).toBeNull();
  });
});

describe('the Locator Playground matches nothing for a chained locator', () => {
  const node = (attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode =>
    ({ tagName: 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 });
  const roots = [node({ class: 'android.widget.ListView', 'tapsmith-role': 'list', bounds: '[0,0][100,100]' }, [
    node({ class: 'android.widget.TextView', text: 'y', bounds: '[0,0][100,50]' }),
  ])];

  it('has no parsed selector to highlight the unscoped list with', () => {
    // Before PILOT-660 this parsed as getByRole("list") and highlighted the list.
    const parsed = parseSelectorString('device.getByRole("list").getByText("x")');
    expect(parsed).toBeNull();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("list")')!)).toHaveLength(1);
  });
});
