import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { parseSelectorParts } from '../trace-viewer/components/selector-parts.js';
import { parseSelectorToInternal } from '../mcp/locator-helper.js';
import { _label, _role, _textContains, formatSelector, selectorToProto } from '../selectors.js';

// PILOT-520: RegExp locators in the trace-viewer / UI-mode locator playground
// and the MCP locator parser. They must parse a RegExp literal and match it
// the way the agents do: getByText against the raw text, getByLabel against
// the raw label, a role name against the whitespace-normalized name.

function node(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName, attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

function count(roots: HierarchyNode[], code: string): number {
  const parsed = parseSelectorString(code);
  if (!parsed) throw new Error(`unparsed: ${code}`);
  return findMatchingNodes(roots, parsed).length;
}

const androidRoots = [
  node('android.widget.FrameLayout', { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, [
    node('android.widget.TextView', {
      class: 'android.widget.TextView', text: 'Welcome to Expo', bounds: '[0,100][1080,200]',
    }),
    node('android.widget.TextView', {
      class: 'android.widget.TextView', text: 'Line one\nLine two', bounds: '[0,300][1080,400]',
    }),
    node('android.widget.Button', {
      class: 'android.widget.Button', 'content-desc': 'Save draft', bounds: '[0,500][1080,600]',
    }),
    node('android.widget.EditText', {
      class: 'android.widget.EditText', 'content-desc': 'Full name', text: 'my draft', hint: 'Your name',
      bounds: '[0,700][1080,800]',
    }),
  ]),
];

const iosRoots = [
  node('XCUIElementTypeOther', { type: 'XCUIElementTypeOther', x: '0', y: '0', width: '390', height: '844' }, [
    node('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'Welcome to Expo', x: '0', y: '100', width: '390', height: '40',
    }),
    node('XCUIElementTypeButton', {
      type: 'XCUIElementTypeButton', label: 'Save  draft', x: '0', y: '200', width: '390', height: '40',
    }),
    node('XCUIElementTypeTextField', {
      type: 'XCUIElementTypeTextField', label: 'Full name', value: 'Ada', x: '0', y: '300', width: '390', height: '40',
    }),
  ]),
];

describe('playground RegExp locators (PILOT-520)', () => {
  it('getByText(RegExp) tests the raw text, \\s covering NBSP', () => {
    expect(count(androidRoots, 'device.getByText(/Welcome to\\sExpo/)')).toBe(1);
    expect(count(iosRoots, 'device.getByText(/Welcome to\\sExpo/)')).toBe(1);
    expect(count(androidRoots, 'device.getByText(/^welcome/i)')).toBe(1);
    expect(count(androidRoots, 'device.getByText(/^welcome/)')).toBe(0);
  });

  it('getByText(RegExp) anchors see the raw line breaks, as in Playwright', () => {
    expect(count(androidRoots, 'device.getByText(/^Line one Line two$/)')).toBe(0);
    expect(count(androidRoots, 'device.getByText(/^Line two$/m)')).toBe(1);
  });

  it('exact: true is ignored for a RegExp', () => {
    expect(count(androidRoots, 'device.getByText(/Welcome/, { exact: true })')).toBe(1);
  });

  it('iOS getByText(RegExp) also tests the value', () => {
    expect(count(iosRoots, 'device.getByText(/^Ada$/)')).toBe(1);
  });

  it('getByRole name RegExp tests the normalized name', () => {
    expect(count(androidRoots, 'device.getByRole("button", { name: /^save draft$/i })')).toBe(1);
    expect(count(iosRoots, 'device.getByRole("button", { name: /^save draft$/i })')).toBe(1);
    expect(count(iosRoots, "device.getByRole('button', { name: /^draft/ })")).toBe(0);
  });

  it('a typed EditText value is not a name for a RegExp', () => {
    expect(count(androidRoots, 'device.getByRole("textfield", { name: /draft/ })')).toBe(0);
    expect(count(androidRoots, 'device.getByRole("textfield", { name: /full\\sname/i })')).toBe(1);
  });

  it('getByLabel(RegExp) tests the raw label of a form field', () => {
    expect(count(androidRoots, 'device.getByLabel(/^Full\\sname$/)')).toBe(1);
    expect(count(iosRoots, 'device.getByLabel(/full\\sname/i)')).toBe(1);
    expect(count(androidRoots, 'device.getByLabel(/Save/)')).toBe(0);
  });

  it('parses RegExp literals containing slashes, brackets, braces and quotes', () => {
    const parsed = parseSelectorString('device.getByText(/a\\/b[/}]"x\'/gi).nth(1)');
    expect(parsed).toMatchObject({ type: 'textRegex', regex: { source: 'a\\/b[/}]"x\'', flags: 'gi' }, index: 1 });
    expect(parseSelectorString('device.getByRole("button", { name: /a}b/, exact: true })'))
      .toMatchObject({ type: 'role', value: 'button', nameRegex: { source: 'a}b', flags: '' } });
  });

  it('rejects a malformed RegExp or one on a getter without RegExp support', () => {
    expect(parseSelectorString('device.getByText(/(/)')).toBeNull();
    expect(parseSelectorString('device.getByTestId(/x/)')).toBeNull();
    expect(parseSelectorString('webview.getByText(/x/)')).toBeNull();
  });
});

describe('MCP locator parsing of RegExp locators (PILOT-520)', () => {
  it('builds the same selectors as the SDK', () => {
    expect(selectorToProto(parseSelectorToInternal('device.getByText(/save\\s+draft/i)').selector))
      .toEqual(selectorToProto(_textContains(/save\s+draft/i)));
    expect(selectorToProto(parseSelectorToInternal('device.getByLabel(/name$/)').selector))
      .toEqual(selectorToProto(_label(/name$/)));
    expect(selectorToProto(parseSelectorToInternal('device.getByRole("button", { name: /save/i })').selector))
      .toEqual(selectorToProto(_role('button', { name: /save/i })));
  });

  it('refuses an unsupported flag with the SDK\'s message', () => {
    expect(() => parseSelectorToInternal('device.getByText(/x/y)')).toThrow(/does not support the RegExp flag "y"/);
  });
});

describe('trace action list shows RegExp locators (PILOT-520)', () => {
  const display = (sel: Parameters<typeof selectorToProto>[0]) => parseSelectorParts(JSON.stringify(selectorToProto(sel)));

  it('renders the RegExp literal unquoted', () => {
    expect(display(_textContains(/Welcome\sto/i))).toEqual({ fn: 'getByText', args: ['/Welcome\\sto/i'], literal: [true] });
    expect(display(_label(/name/))).toEqual({ fn: 'getByLabel', args: ['/name/'], literal: [true] });
    expect(display(_role('button', { name: /save/i }))).toEqual({
      fn: 'getByRole', args: ['button'], options: [{ key: 'name', value: '/save/i', literal: true }],
    });
  });

  it('formats the same locator as code', () => {
    expect(formatSelector(_role('button', { name: /save/i }))).toBe('getByRole("button", { name: /save/i })');
  });
});
