import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes, locatorStringError } from '../trace-viewer/components/selector-matching.js';
import { parseSelectorToInternal } from '../mcp/locator-helper.js';
import { selectorToProto } from '../selectors.js';

// Locator strings written without `device.` — what the docs, the trace's
// action list and screen objects show. The Locator Playground read a bare
// `getByText("Explore")` as a legacy shorthand of type "getByText", which no
// element has, and showed "0 matches" for an element on screen; a bare
// `getByRole("button", { name })` showed no count and no reason (PILOT-717).
// The MCP tools share the parser.

function node(attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName: 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

const ROOTS = [
  node({ class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, [
    node({ class: 'android.widget.TextView', text: 'Welcome to Expo', bounds: '[40,100][1040,180]' }),
    node({ class: 'android.widget.TextView', text: 'Try editing app/index.tsx', bounds: '[40,200][1040,280]' }),
    node({ class: 'android.widget.Button', text: 'Explore', 'content-desc': 'Explore', 'resource-id': 'explore', bounds: '[40,300][1040,380]' }),
  ]),
];

const count = (input: string): number | null => {
  const parsed = parseSelectorString(input);
  return parsed ? findMatchingNodes(ROOTS, parsed).length : null;
};

describe('a locator string without device. parses like one with it', () => {
  const getters = [
    'getByText("Explore")',
    'getByText("Try editing")',
    'getByText("Welcome to Expo", { exact: true })',
    'getByText(/explore/i)',
    'getByRole("button", { name: "Explore" })',
    'getByRole("button", { name: /expl/i, selected: false })',
    'getByDescription("Explore")',
    'getByTestId("explore")',
    'locator({ id: "explore" })',
    'getByText("Explore").first()',
    'getByText("Explore").nth(-1);',
  ];
  for (const bare of getters) {
    for (const receiver of ['', 'device.', 'this.device.', 'page.', 'this.page.']) {
      it(`${receiver}${bare}`, () => {
        const parsed = parseSelectorString(`${receiver}${bare}`);
        expect(parsed).toEqual(parseSelectorString(`device.${bare}`));
        expect(count(`${receiver}${bare}`)).toBe(1);
      });
    }
  }

  it('this.webview. reads as webview.', () => {
    expect(parseSelectorString('this.webview.getByText("Go")')).toEqual(parseSelectorString('webview.getByText("Go")'));
    expect(parseSelectorString('this.webview.locator("#go")')).toEqual(parseSelectorString('webview.locator("#go")'));
  });

  it('leaves a value that contains a receiver alone', () => {
    expect(parseSelectorString('getByText("page.getByText(x)")')).toEqual({
      type: 'textContains', value: 'page.getByText(x)', index: undefined,
    });
  });

  it('allows whitespace around the receiver dot, like JavaScript', () => {
    expect(parseSelectorString('device .getByText("Explore")')).toEqual(parseSelectorString('device.getByText("Explore")'));
  });
});

describe('the bare forms keep the parser\'s refusals', () => {
  it('refuses a chained call and names it', () => {
    expect(parseSelectorString('getByRole("list").getByText("x")')).toBeNull();
    expect(locatorStringError('getByRole("list").getByText("x")')).toMatch(/^unsupported chained call \.getByText\(\) — /);
    expect(locatorStringError('page.getByText("a").filter({ hasText: "b" })')).toMatch(/^unsupported chained call \.filter\(\) — /);
  });

  it('refuses an option the getter does not take', () => {
    expect(parseSelectorString('getByRole("heading", { name: "x", level: 1 })')).toBeNull();
    expect(locatorStringError('getByRole("heading", { name: "x", level: 1 })')).toBe('unsupported option "level"');
    expect(locatorStringError('this.device.getByText("x", { name: "y" })')).toMatch(/^device\.getByText\(\) has no option "name"/);
  });
});

describe('what the parser cannot read is refused, never a type that matches nothing', () => {
  const unreadable = [
    'getByAltText("Logo")', // a Playwright getter Tapsmith does not have
    'page.getByTitle("x")',
    'getByFoo("x")',
    'foo("x")',
    'locator("#css")', // a CSS locator needs a webview receiver
    'list.getByText("x")', // a scoped locator: a different set of elements
    'getByText',
    'getByText("x"',
  ];
  for (const input of unreadable) {
    it(JSON.stringify(input), () => {
      expect(parseSelectorString(input)).toBeNull();
    });
  }

  it('still reads the legacy shorthand', () => {
    expect(parseSelectorString('text("Explore")')).toEqual({ type: 'text', value: 'Explore', index: undefined });
    expect(parseSelectorString('contentDesc("Explore")')).toEqual({ type: 'contentDesc', value: 'Explore', index: undefined });
    expect(count('text("Explore")')).toBe(1);
  });
});

describe('the MCP tools take the bare forms too', () => {
  it('builds the same runtime selector as device.', () => {
    for (const bare of ['getByText("Explore")', 'getByRole("button", { name: "Explore" })', 'locator({ id: "explore" })']) {
      const withDevice = parseSelectorToInternal(`device.${bare}`);
      for (const receiver of ['', 'this.device.', 'page.']) {
        const parsed = parseSelectorToInternal(`${receiver}${bare}`);
        expect(selectorToProto(parsed.selector)).toEqual(selectorToProto(withDevice.selector));
      }
    }
  });

  it('refuses an unreadable one as invalid, not as an unsupported type', () => {
    expect(() => parseSelectorToInternal('getByAltText("Logo")')).toThrow(/^Invalid locator: "getByAltText\("Logo"\)". Use a Tapsmith locator/);
  });
});
