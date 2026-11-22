import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import type { GeneratedSelector } from '../trace-viewer/components/selector-generation.js';
import { formatHierarchy, semanticNodes } from '../mcp/hierarchy-formatter.js';

// The formatter renders whatever the agent validated (PILOT-848): it never
// decides a match itself.

function node(attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName: 'node', attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

const save = node({ class: 'android.widget.Button', text: 'Save', clickable: 'true' });
const title = node({ class: 'android.widget.TextView', text: 'Settings' });
const root = node({ class: 'android.widget.FrameLayout' }, [title, save]);

const s = (code: string, priority = 1): GeneratedSelector => ({ code, label: 'x', priority });

describe('formatHierarchy', () => {
  it('refs each node with its best validated suggestion', () => {
    const { tree, locators } = formatHierarchy([root], new Map([
      [save, [s('device.getByRole("button", { name: "Save" })'), s('device.getByText("Save")', 6)]],
    ]));
    expect(locators).toEqual(['[1] device.getByRole("button", { name: "Save" })']);
    expect(tree).toBe('- text "Settings"\n- [1] button "Save"');
  });

  it('lists a node with no validated suggestion without a ref', () => {
    const { tree, locators } = formatHierarchy([root], new Map());
    expect(locators).toEqual([]);
    expect(tree).toBe('- text "Settings"\n- button "Save"');
  });
});

describe('semanticNodes', () => {
  it('returns the nodes the tree lists, in tree order', () => {
    expect(semanticNodes([root])).toEqual([title, save]);
  });
});

describe('non-app nodes (PILOT-756, PILOT-830)', () => {
  // No locator matches these, so the snapshot neither lists them nor asks the
  // agent about them — or every Android snapshot would report its status
  // bar as "not on screen".
  const clock = node({ class: 'android.widget.TextView', text: '10:06' });
  const statusBar = node({ class: 'android.widget.FrameLayout', 'tapsmith-non-app': 'true' }, [clock]);
  const marker = node({ class: 'android.widget.TextView', text: 'tapsmith-hooks:1;epoch=0;nav=1;url=app:///' });
  const carrier = node({ class: 'android.view.ViewGroup' }, [marker]);
  const app = node({ class: 'android.widget.FrameLayout' }, [title, save, carrier]);

  it('leaves them out of the nodes offered for suggestions', () => {
    expect(semanticNodes([statusBar, app])).toEqual([title, save]);
  });

  it('leaves them out of the tree', () => {
    expect(formatHierarchy([statusBar, app], new Map()).tree).toBe('- text "Settings"\n- button "Save"');
  });
});

describe("a SwiftUI Toggle's knob (PILOT-790)", () => {
  // The agent marks it part of the switch it sits in: no locator matches it.
  const knob = node({ type: 'XCUIElementTypeSwitch', label: '', value: '0', 'tapsmith-role': 'switch', 'tapsmith-switch-part': 'true' });
  const text = node({ type: 'XCUIElementTypeStaticText', label: 'Dark Mode', 'tapsmith-role': 'text' });
  const toggle = node({ type: 'XCUIElementTypeSwitch', label: 'Dark Mode', value: '0', 'tapsmith-role': 'switch' }, [text, knob]);

  it('leaves it out of the nodes offered for suggestions', () => {
    expect(semanticNodes([toggle])).toEqual([toggle, text]);
  });
});

describe('WebView content (PILOT-1329)', () => {
  // A native WebView's content reaches the hierarchy as its accessibility
  // projection: the tree says where it starts, so the reader knows the
  // `webview.` locators apply there.
  function ios(type: string, attrs: Record<string, string> = {}, children: HierarchyNode[] = []): HierarchyNode {
    return { tagName: type, attributes: new Map(Object.entries({ type, ...attrs })), children, depth: 0 };
  }
  const email = ios('XCUIElementTypeTextField', { label: 'Email', 'tapsmith-role': 'textfield' });
  const signIn = ios('XCUIElementTypeButton', { label: 'Sign in', 'tapsmith-role': 'button' });
  // WKWebView nests three WebView elements on iOS: one marker, not three.
  const web = ios('XCUIElementTypeWebView', {}, [ios('XCUIElementTypeWebView', {}, [ios('XCUIElementTypeWebView', {}, [
    ios('XCUIElementTypeOther', {}, [email, signIn]),
  ])])]);
  const heading = ios('XCUIElementTypeStaticText', { label: 'Embedded WebView', 'tapsmith-role': 'heading' });
  const screen = ios('XCUIElementTypeOther', {}, [heading, web]);

  it('marks the WebView once, with its content under it', () => {
    const { tree, hasWebView } = formatHierarchy([screen], new Map([[signIn, [s('device.getByRole("button", { name: "Sign in" })')]]]));
    expect(tree).toBe([
      '- heading "Embedded WebView"',
      '- webview (web content: device.webview() locators)',
      '  - textfield "Email"',
      '  - [1] button "Sign in"',
    ].join('\n'));
    expect(hasWebView).toBe(true);
  });

  it('marks an Android WebView', () => {
    const page = node({ class: 'android.widget.Button', text: 'Login', clickable: 'true' });
    const wv = node({ class: 'android.webkit.WebView' }, [page]);
    const { tree, hasWebView } = formatHierarchy([node({ class: 'android.widget.FrameLayout' }, [title, wv])], new Map());
    expect(tree).toBe('- text "Settings"\n- webview (web content: device.webview() locators)\n  - button "Login"');
    expect(hasWebView).toBe(true);
  });

  it('marks nothing on a screen with no WebView', () => {
    expect(formatHierarchy([root], new Map()).hasWebView).toBe(false);
  });

  it('marks nothing for an empty WebView', () => {
    const { tree, hasWebView } = formatHierarchy([ios('XCUIElementTypeOther', {}, [heading, ios('XCUIElementTypeWebView')])], new Map());
    expect(tree).toBe('- heading "Embedded WebView"');
    expect(hasWebView).toBe(false);
  });

  it('offers no WebView node for suggestions', () => {
    expect(semanticNodes([screen])).toEqual([heading, email, signIn]);
  });

  it("does not mark an in-app browser's page, which device.webview() cannot reach (PILOT-1384)", () => {
    // SFSafariViewController's page is SafariViewService's, not the app's:
    // its content is matched with native locators only.
    const done = ios('XCUIElementTypeButton', { label: 'Done', identifier: 'Close', 'tapsmith-role': 'button' });
    const browser = ios('XCUIElementTypeOther', { identifier: 'BrowserView?IsPageLoaded=true&WebViewProcessID=1' }, [
      ios('XCUIElementTypeOther', { identifier: 'TopBrowserBar' }, [done]),
      web,
    ]);
    const { tree, hasWebView } = formatHierarchy([ios('XCUIElementTypeOther', {}, [browser])], new Map());
    expect(tree).toBe([
      '- button "Done"',
      '- textfield "Email"',
      '- button "Sign in"',
    ].join('\n'));
    expect(hasWebView).toBe(false);
  });
});
