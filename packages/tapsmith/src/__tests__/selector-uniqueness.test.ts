import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { disambiguateSelectors } from '../trace-viewer/components/selector-uniqueness.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { handlePickFromScreenshot } from '../trace-viewer/components/selector-pick.js';
import { formatHierarchy } from '../mcp/hierarchy-formatter.js';

function makeNode(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  const node: HierarchyNode = {
    tagName,
    attributes: new Map(Object.entries(attrs)),
    children,
    depth: 0,
  };
  const setDepth = (n: HierarchyNode, d: number) => {
    n.depth = d;
    n.children.forEach((c) => setDepth(c, d + 1));
  };
  setDepth(node, 0);
  return node;
}

/**
 * The story-app sign-in screen that motivated PILOT-226: a subtitle
 * "Sign in to continue to DreamSpinner" appears earlier in the tree than the
 * "Sign in" button. device.getByText("Sign in") substring-matches both at
 * runtime and taps the subtitle.
 */
function signInScreen(): { roots: HierarchyNode[]; subtitle: HierarchyNode; button: HierarchyNode } {
  const subtitle = makeNode('XCUIElementTypeStaticText', {
    type: 'XCUIElementTypeStaticText',
    label: 'Sign in to continue to DreamSpinner',
    clickable: 'false',
  });
  const button = makeNode('XCUIElementTypeButton', {
    type: 'XCUIElementTypeButton',
    label: 'Sign in',
    clickable: 'true',
  });
  const root = makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther' }, [subtitle, button]);
  return { roots: [root], subtitle, button };
}

describe('disambiguateSelectors (PILOT-226)', () => {
  it('keeps suggestions that are already unique', () => {
    const { roots, button } = signInScreen();
    const result = disambiguateSelectors(roots, button, generateSelectors(button));
    // getByRole("button", { name: "Sign in" }) is unique — stays on top untouched
    expect(result[0].code).toBe('device.getByRole("button", { name: "Sign in" })');
  });

  it('upgrades an ambiguous substring getByText to { exact: true } without demotion', () => {
    const { roots, button } = signInScreen();
    const result = disambiguateSelectors(roots, button, generateSelectors(button));
    const textSuggestion = result.find((s) => s.code.includes('getByText'));
    expect(textSuggestion).toBeDefined();
    // "Sign in" substring-matches the subtitle too; { exact: true } pins the button
    expect(textSuggestion!.code).toBe('device.getByText("Sign in", { exact: true })');
    expect(textSuggestion!.label).not.toContain('matches');
    expect(textSuggestion!.priority).toBeLessThan(8);
  });

  it('falls back to a positional chain when no upgrade pins the node', () => {
    const itemA = makeNode('node', { class: 'android.widget.TextView', text: 'Item 1' });
    const itemB = makeNode('node', { class: 'android.widget.TextView', text: 'Item 2' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [itemA, itemB]);
    // Suggestion that substring-matches both items and has no unique exact form
    const ambiguous = [{ code: 'device.getByText("Item")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], itemB, ambiguous);
    expect(result[0].code).toBe('device.getByText("Item").last()');
    expect(result[0].label).toContain('2 matches');
    expect(result[0].priority).toBeGreaterThanOrEqual(8);
  });

  it('upgrades a bare getByRole with the accessible name when that is unique', () => {
    const save = makeNode('node', { class: 'android.widget.Button', text: 'Save' });
    const cancel = makeNode('node', { class: 'android.widget.Button', text: 'Cancel' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [save, cancel]);
    const ambiguous = [{ code: 'device.getByRole("button")', label: 'Role', priority: 2 }];
    const result = disambiguateSelectors([root], cancel, ambiguous);
    expect(result[0].code).toBe('device.getByRole("button", { name: "Cancel" })');
    expect(result[0].priority).toBe(2);
  });

  it('marks suggestions that do not resolve to the picked node', () => {
    const other = makeNode('node', { class: 'android.widget.TextView', text: 'Other' });
    const root = makeNode('node', {}, [other]);
    const wrong = [{ code: 'device.getByText("Nope")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], other, wrong);
    expect(result[0].label).toContain('may not match');
    expect(result[0].priority).toBeGreaterThanOrEqual(8);
  });

  it('disambiguates identical siblings by position (reference identity)', () => {
    const twinA = makeNode('node', { class: 'android.widget.TextView', text: 'Twin' });
    const twinB = makeNode('node', { class: 'android.widget.TextView', text: 'Twin' });
    const root = makeNode('node', {}, [twinA, twinB]);
    const suggestion = [{ code: 'device.getByText("Twin", { exact: true })', label: 'Text', priority: 6 }];
    // Same tree → reference identity lets the second twin get .last(), not .first()
    const result = disambiguateSelectors([root], twinB, suggestion);
    expect(result[0].code).toBe('device.getByText("Twin", { exact: true }).last()');
  });
});

describe('formatHierarchy suggested locators (PILOT-226)', () => {
  it('emits a uniquely resolving locator for every ref on the sign-in screen', () => {
    const { roots } = signInScreen();
    const { locators } = formatHierarchy(roots);
    const buttonRef = locators.find((l) => l.includes('Sign in') && !l.includes('continue'));
    expect(buttonRef).toBeDefined();
    // Must NOT be the ambiguous substring locator that broke story-app
    expect(buttonRef).not.toContain('device.getByText("Sign in")\n');
    expect(buttonRef).toMatch(/getByRole\("button", \{ name: "Sign in" \}\)|getByText\("Sign in", \{ exact: true \}\)/);
  });

  it('appends a positional chain when nothing else disambiguates', () => {
    const itemA = makeNode('node', { class: 'android.widget.TextView', text: 'Item', clickable: 'true' });
    const itemB = makeNode('node', { class: 'android.widget.TextView', text: 'Item', clickable: 'true' });
    const root = makeNode('node', { class: 'android.view.ViewGroup' }, [itemA, itemB]);
    const { locators } = formatHierarchy([root]);
    expect(locators.length).toBeGreaterThanOrEqual(2);
    expect(locators[0]).toContain('.first()');
    expect(locators[1]).toContain('.last()');
  });
});

describe('exact-text upgrade quoting (PR #124 review)', () => {
  it('escapes bare double quotes when the source suggestion was single-quoted', () => {
    const a = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi"' });
    const b = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi" again' });
    const root = makeNode('node', {}, [a, b]);
    const suggestion = [{ code: `device.getByText('Say "hi"')`, label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], a, suggestion);
    expect(result[0].code).toBe('device.getByText("Say \\"hi\\"", { exact: true })');
  });

  it('does not double-escape backslash sequences from double-quoted sources', () => {
    const a = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi"' });
    const b = makeNode('node', { class: 'android.widget.TextView', text: 'Say "hi" again' });
    const root = makeNode('node', {}, [a, b]);
    const suggestion = [{ code: 'device.getByText("Say \\"hi\\"")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors([root], a, suggestion);
    expect(result[0].code).toBe('device.getByText("Say \\"hi\\"", { exact: true })');
  });
});

describe('iOS duplicate-aware pick identity (playground)', () => {
  /**
   * Two visual "Sign in" texts, each exposed twice by the iOS tree
   * (attribute-carrying parent StaticText + inner child with identical
   * label and bounds). Picking the CHILD must still disambiguate with a
   * positional chain instead of demoting to "(may not match)".
   */
  function duplicatedScreen() {
    const subtitleChild = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'Sign in', bounds: '[44,210][436,260]',
    });
    const subtitle = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'Sign in', identifier: 'subtitle', bounds: '[44,210][436,260]',
    }, [subtitleChild]);
    const buttonChild = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'Sign in', bounds: '[44,640][436,712]',
    });
    const button = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'Sign in', identifier: 'signin-btn', bounds: '[44,640][436,712]',
    }, [buttonChild]);
    const root = makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther' }, [subtitle, button]);
    return { roots: [root], subtitle, button, subtitleChild, buttonChild };
  }

  it('picking a child duplicate of the SECOND visual element appends .last(), not "(may not match)"', () => {
    const { roots, buttonChild } = duplicatedScreen();
    const suggestion = [{ code: 'device.getByText("Sign in", { exact: true })', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors(roots, buttonChild, suggestion);
    expect(result[0].label).not.toContain('may not match');
    expect(result[0].code).toBe('device.getByText("Sign in", { exact: true }).last()');
  });

  it('picking a child duplicate of the FIRST visual element appends .first()', () => {
    const { roots, subtitleChild } = duplicatedScreen();
    const suggestion = [{ code: 'device.getByText("Sign in", { exact: true })', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors(roots, subtitleChild, suggestion);
    expect(result[0].code).toBe('device.getByText("Sign in", { exact: true }).first()');
  });

  it('a child duplicate with a UNIQUE selector still validates as unique', () => {
    const { roots, buttonChild } = duplicatedScreen();
    // testId lives on the parent; matching it yields the parent, which must
    // be recognised as the picked child's representative.
    const suggestion = [{ code: 'device.getByText("Sign in")', label: 'Text', priority: 6 }];
    const result = disambiguateSelectors(roots, buttonChild, suggestion);
    // substring matches both visual elements → positional chain appended
    expect(result[0].code).toMatch(/\.(first|last)\(\)$/);
  });
});

describe('pick pre-fill disambiguation (playground input field)', () => {
  it('handlePickFromScreenshot pre-fills the disambiguated suggestion, not the generic one', () => {
    // Two headings with the same accessible name at different positions —
    // the generic getByRole suggestion matches both.
    const navTitle = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'API Calls', 'tapsmith-role': 'heading', bounds: '[165,73][236,94]',
    });
    const pageHeading = makeNode('XCUIElementTypeStaticText', {
      type: 'XCUIElementTypeStaticText', label: 'API Calls', 'tapsmith-role': 'heading', bounds: '[16,132][386,160]',
    });
    const root = makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther', bounds: '[0,0][400,800]' }, [navTitle, pageHeading]);
    const result = handlePickFromScreenshot([root], 200, 146);
    expect(result).not.toBeNull();
    expect(result!.selector).toMatch(/\.(first|last)\(\)$|\.nth\(-?\d+\)$/);
  });
});

describe('getByRole name matching in the playground (PILOT-549)', () => {
  function overlayScreen() {
    const show = makeNode('android.widget.Button', { class: 'android.widget.Button', text: 'SHOW OVERLAY', bounds: '[0,0][100,50]' });
    const showBriefly = makeNode('android.widget.Button', { class: 'android.widget.Button', text: 'Show overlay briefly', bounds: '[0,60][100,110]' });
    const root = makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout', bounds: '[0,0][100,200]' }, [show, showBriefly]);
    return { roots: [root], show, showBriefly };
  }

  it('matches a role name case-insensitively and by substring by default', () => {
    const { roots, show, showBriefly } = overlayScreen();
    const parsed = parseSelectorString('device.getByRole("button", { name: "show overlay" })')!;
    expect(findMatchingNodes(roots, parsed)).toEqual([show, showBriefly]);
  });

  it('matches case-sensitively and whole with { exact: true }', () => {
    const { roots, showBriefly } = overlayScreen();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Show overlay", exact: true })')!)).toEqual([]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Show  overlay briefly", exact: true })')!))
      .toEqual([showBriefly]);
  });

  it('upgrades an ambiguous role-name suggestion to { exact: true }', () => {
    const { roots, show } = overlayScreen();
    const result = disambiguateSelectors(roots, show, generateSelectors(show));
    expect(result[0].code).toBe('device.getByRole("button", { name: "SHOW OVERLAY", exact: true })');
    expect(result[0].label).not.toContain('matches');
  });

  it('matches any name source, as the agents do, not just the first', () => {
    const draft = makeNode('android.widget.Button', { class: 'android.widget.Button', 'content-desc': 'Draft', text: 'Save draft', bounds: '[0,0][100,50]' });
    const save = makeNode('android.widget.Button', { class: 'android.widget.Button', 'content-desc': 'Save', bounds: '[0,60][100,110]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [draft, save])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Save" })')!)).toEqual([draft, save]);
  });

  it("compares an EditText's typed value whole, but its hint by substring", () => {
    const notes = makeNode('android.widget.EditText', { class: 'android.widget.EditText', text: 'email me later', hint: 'Notes', bounds: '[0,0][100,50]' });
    const empty = makeNode('android.widget.EditText', { class: 'android.widget.EditText', text: 'Email address', hint: 'Email address', bounds: '[0,60][100,110]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [notes, empty])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("textfield", { name: "email" })')!)).toEqual([empty]);
  });

  it("matches an Android node's joined descendant text, like the agent", () => {
    const save = makeNode('android.widget.Button', { class: 'android.widget.Button', 'content-desc': 'Save', bounds: '[0,0][100,50]' });
    const label = makeNode('android.widget.TextView', { class: 'android.widget.TextView', text: 'Save draft' });
    const container = makeNode('android.view.ViewGroup', { class: 'android.view.ViewGroup', 'tapsmith-role': 'button', bounds: '[0,60][100,110]' }, [label]);
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [save, container])];
    const parsed = parseSelectorString('device.getByRole("button", { name: "save" })')!;
    expect(findMatchingNodes(roots, parsed)).toEqual([save, container]);
  });

  it('accepts one whole child of an iOS ", "-joined label under exact', () => {
    const row = makeNode('XCUIElementTypeButton', { type: 'XCUIElementTypeButton', label: 'Intro, Sign In', bounds: '[0,0][100,50]' });
    const roots = [makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther' }, [row])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Sign In", exact: true })')!)).toEqual([row]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Sign", exact: true })')!)).toEqual([]);
  });
});

describe('Android description-resolved roles in the playground (PILOT-656)', () => {
  // React Navigation's bottom tab on Android: a generic View with RN's "tab"
  // role description, named by its label text.
  function bottomTabs() {
    const tab = (label: string, top: number, selected: boolean) => makeNode('android.view.View', {
      class: 'android.view.View', 'tapsmith-role': 'tab', clickable: 'true', selected: String(selected), bounds: `[${top},1000][${top + 100},1100]`,
    }, [makeNode('android.widget.TextView', { class: 'android.widget.TextView', text: label, bounds: `[${top},1050][${top + 100},1090]` })]);
    const library = tab('Library', 0, true);
    const settings = tab('Settings', 100, false);
    const tabList = makeNode('android.view.View', { class: 'android.view.View', 'tapsmith-role': 'tablist', bounds: '[0,1000][200,1100]' }, [library, settings]);
    return { roots: [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [tabList])], library, settings };
  }

  it('matches a role-description tab, by role and by name', () => {
    const { roots, library, settings } = bottomTabs();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab")')!)).toEqual([library, settings]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab", { name: "Settings" })')!)).toEqual([settings]);
  });

  it('matches a native tab container as a tablist, not a tab (PILOT-514)', () => {
    const native = makeNode('android.widget.TabWidget', { class: 'android.widget.TabWidget', bounds: '[0,0][100,50]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [native])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab")')!)).toEqual([]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tablist")')!)).toEqual([native]);
  });

  it('matches the RN tab list as a tablist, and only its tabs as tabs (PILOT-514)', () => {
    const { roots, library, settings } = bottomTabs();
    const tabList = roots[0]!.children[0]!;
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tablist")')!)).toEqual([tabList]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab")')!)).toEqual([library, settings]);
  });

  it('does not match a TabLayout whose role description names another role, like the agent', () => {
    const other = makeNode('com.google.android.material.tabs.TabLayout', { class: 'com.google.android.material.tabs.TabLayout', 'tapsmith-role': 'toolbar', bounds: '[0,0][100,50]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [other])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tablist")')!)).toEqual([]);
  });
});

describe('iOS tab bars in the playground (PILOT-514)', () => {
  // A UITabBar (expo-router NativeTabs): the agent reports the bar as
  // "tablist" and its buttons as "tab".
  function tabBar() {
    const item = (label: string, left: number) => makeNode('XCUIElementTypeButton', {
      type: 'XCUIElementTypeButton', label, 'tapsmith-role': 'tab', bounds: `[${left},800][${left + 100},850]`,
    });
    const home = item('Home', 0);
    const explore = item('Explore', 100);
    const bar = makeNode('XCUIElementTypeTabBar', {
      type: 'XCUIElementTypeTabBar', label: 'Tab Bar', 'tapsmith-role': 'tablist', bounds: '[0,800][200,850]',
    }, [home, explore]);
    const other = makeNode('XCUIElementTypeButton', { type: 'XCUIElementTypeButton', label: 'Explore more', 'tapsmith-role': 'button', bounds: '[0,100][200,150]' });
    return { roots: [makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther' }, [other, bar])], home, explore, bar, other };
  }

  it('matches the tab bar\'s buttons as tabs, by role and by name', () => {
    const { roots, home, explore } = tabBar();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab")')!)).toEqual([home, explore]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab", { name: "Explore" })')!)).toEqual([explore]);
  });

  it('matches the bar as a tablist and not as a tab', () => {
    const { roots, bar } = tabBar();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tablist")')!)).toEqual([bar]);
  });

  it('still matches the tab bar\'s buttons as buttons, like the agent', () => {
    const { roots, explore, other } = tabBar();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Explore" })')!)).toEqual([other, explore]);
  });

  it('matches a native tab element as a tab and a bare tab bar as a tablist (dumps without a reported role)', () => {
    const tab = makeNode('XCUIElementTypeTab', { type: 'XCUIElementTypeTab', label: 'One', bounds: '[0,0][50,50]' });
    const bar = makeNode('XCUIElementTypeTabBar', { type: 'XCUIElementTypeTabBar', label: 'Bar', bounds: '[0,0][100,50]' }, [tab]);
    const roots = [bar];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tab")')!)).toEqual([tab]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("tablist")')!)).toEqual([bar]);
  });

  it('matches role-description progress bars and toolbars', () => {
    const progress = makeNode('android.view.View', { class: 'android.view.View', 'tapsmith-role': 'progressbar', 'content-desc': 'Upload progress', bounds: '[0,0][100,50]' });
    const toolbar = makeNode('android.view.View', { class: 'android.view.View', 'tapsmith-role': 'toolbar', 'content-desc': 'Formatting', bounds: '[0,60][100,110]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [progress, toolbar])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("progressbar", { name: "Upload" })')!)).toEqual([progress]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("toolbar")')!)).toEqual([toolbar]);
  });
});

describe('React Native generic-view roles in the playground (PILOT-664)', () => {
  // RN's accessibilityRole="menu"/"menuitem"/"timer" on Android: generic Views
  // whose only role signal is the role description the dump reports.
  function menu() {
    const item = (label: string, top: number) => makeNode('android.view.View', {
      class: 'android.view.View', 'tapsmith-role': 'menuitem', clickable: 'true', 'content-desc': label, bounds: `[0,${top}][200,${top + 50}]`,
    });
    const copy = item('Copy', 100);
    const paste = item('Paste', 150);
    const menuNode = makeNode('android.view.View', { class: 'android.view.View', 'tapsmith-role': 'menu', bounds: '[0,100][200,200]' }, [copy, paste]);
    const timer = makeNode('android.view.View', { class: 'android.view.View', 'tapsmith-role': 'timer', 'content-desc': 'Elapsed time', bounds: '[0,300][200,350]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [menuNode, timer])];
    return { roots, menuNode, copy, paste, timer };
  }

  it('matches menu items, the menu and a timer by role, like the agent', () => {
    const { roots, menuNode, copy, paste, timer } = menu();
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("menuitem")')!)).toEqual([copy, paste]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("menuitem", { name: "Paste" })')!)).toEqual([paste]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("menu")')!)).toEqual([menuNode]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("timer")')!)).toEqual([timer]);
  });

  it('suggests getByRole for a menu item instead of dropping the unknown role', () => {
    const { copy } = menu();
    const codes = generateSelectors(copy).map((s) => s.code);
    expect(codes).toContain('device.getByRole("menuitem", { name: "Copy" })');
  });

  it('reads a ToggleButton (RN togglebutton) as a button, and "radio" as radiobutton', () => {
    const toggle = makeNode('android.widget.ToggleButton', { class: 'android.widget.ToggleButton', 'content-desc': 'Bold', checkable: 'true', bounds: '[0,0][100,50]' });
    const radio = makeNode('android.widget.RadioButton', { class: 'android.widget.RadioButton', text: 'Small', bounds: '[0,60][100,110]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [toggle, radio])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("button", { name: "Bold" })')!)).toEqual([toggle]);
    expect(findMatchingNodes(roots, parseSelectorString('device.getByRole("radio")')!)).toEqual([radio]);
    expect(generateSelectors(toggle).map((s) => s.code)).toContain('device.getByRole("button", { name: "Bold" })');
  });
});

describe('iOS generic-view roles in the playground, like the agent (PILOT-664)', () => {
  // RN's new architecture publishes nothing for a menuitem or timer on iOS:
  // the device finds the generic view by a named query.
  const other = (label: string, y: number, extra: Record<string, string> = {}) => makeNode('XCUIElementTypeOther', {
    type: 'XCUIElementTypeOther', label, x: '0', y: String(y), width: '200', height: '40', ...extra,
  });
  const copy = other('Copy', 100);
  const paste = other('Paste', 140);
  const bold = other('Bold', 200, { 'tapsmith-role': 'button' });
  const radio = other('Small', 260, { value: 'radio button, unchecked' });
  const roots = [makeNode('XCUIElementTypeApplication', { type: 'XCUIElementTypeApplication' }, [copy, paste, bold, radio])];
  const on = (selector: string) => findMatchingNodes(roots, parseSelectorString(selector)!);

  it('matches a named query on an undescribed generic view, and no unnamed one', () => {
    expect(on('device.getByRole("menuitem", { name: "Paste" })')).toEqual([paste]);
    expect(on('device.getByRole("menuitem")')).toEqual([]);
  });

  it('does not match a view a trait or another description marks as another role', () => {
    expect(on('device.getByRole("menuitem", { name: "Bold" })')).toEqual([]);
    expect(on('device.getByRole("menuitem", { name: "Small" })')).toEqual([]);
    expect(on('device.getByRole("radio")')).toEqual([radio]);
  });
});

describe('icon-glyph accessible names (PILOT-659)', () => {
  // React Navigation bottom tabs with an icon-font icon (MaterialIcons via
  // IconSymbol): RN names the tab "<glyph>, <label>", and the glyph is a
  // private-use character that renders as nothing — copied by hand or by an
  // agent, getByDescription("<glyph>, Library") arrives as ", Library" and
  // matches 0 elements.
  const BOOK = '\uE865';
  const GEAR = '\uE8B8';
  function iconTabs(names: Array<[string, string]> = [[BOOK, 'Library'], [GEAR, 'Settings']]) {
    const tabs = names.map(([glyph, label], i) => makeNode('android.view.View', {
      class: 'android.view.View', 'tapsmith-role': 'tab', clickable: 'true', 'content-desc': `${glyph}, ${label}`,
      bounds: `[${i * 100},1000][${i * 100 + 100},1100]`,
    }, [
      makeNode('android.widget.TextView', { class: 'android.widget.TextView', text: glyph, bounds: `[${i * 100},1000][${i * 100 + 100},1040]` }),
      makeNode('android.widget.TextView', { class: 'android.widget.TextView', text: label, bounds: `[${i * 100},1050][${i * 100 + 100},1090]` }),
    ]));
    const root = makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, tabs);
    return { roots: [root], tabs };
  }

  it('suggests getByRole("tab", { name }) without the glyph as the top locator, and it resolves', () => {
    const { roots, tabs } = iconTabs();
    const top = disambiguateSelectors(roots, tabs[0], generateSelectors(tabs[0]))[0];
    expect(top.code).toBe('device.getByRole("tab", { name: "Library" })');
    expect(findMatchingNodes(roots, parseSelectorString(top.code)!)).toEqual([tabs[0]]);
  });

  it('snapshot refs for icon tabs are copy-paste safe and resolve to exactly one element', () => {
    const { roots, tabs } = iconTabs();
    const { locators, tree } = formatHierarchy(roots);
    for (const line of [...locators, tree]) {
      expect(line).not.toMatch(/\p{Co}/u);
    }
    const settingsRef = locators.find((l) => l.includes('"tab"') && l.includes('Settings'));
    expect(settingsRef).toMatch(/^\[\d+\] device\.getByRole\("tab", \{ name: "Settings" \}\)$/);
    expect(findMatchingNodes(roots, parseSelectorString(settingsRef!.replace(/^\[\d+\] /, ''))!)).toEqual([tabs[1]]);
  });

  it('escapes the glyph in getByDescription and reads the escape back to the raw value', () => {
    const { roots, tabs } = iconTabs();
    const desc = generateSelectors(tabs[0]).find((s) => s.label === 'Description')!;
    expect(desc.code).toBe('device.getByDescription("\\uE865, Library")');
    expect(parseSelectorString(desc.code)!.value).toBe(`${BOOK}, Library`);
    expect(findMatchingNodes(roots, parseSelectorString(desc.code)!)).toEqual([tabs[0]]);
  });

  it('ranks a glyph-pinning locator below the glyph-free role locator', () => {
    const { tabs } = iconTabs();
    const selectors = generateSelectors(tabs[0]);
    const role = selectors.findIndex((s) => s.code === 'device.getByRole("tab", { name: "Library" })');
    const desc = selectors.findIndex((s) => s.label === 'Description');
    expect(role).toBeGreaterThanOrEqual(0);
    expect(role).toBeLessThan(desc);
  });

  it('escapes astral private-use glyphs (decoded &#NNN; references) as \\u{…} and round-trips them', () => {
    const astral = String.fromCodePoint(0xF0001);
    const { roots, tabs } = iconTabs([[astral, 'Library'], [GEAR, 'Settings']]);
    const desc = generateSelectors(tabs[0]).find((s) => s.label === 'Description')!;
    expect(desc.code).toBe('device.getByDescription("\\u{F0001}, Library")');
    expect(findMatchingNodes(roots, parseSelectorString(desc.code)!)).toEqual([tabs[0]]);
  });

  it('keeps the glyph (escaped) when it sits inside the name, so the name stays a substring', () => {
    const node = makeNode('android.widget.Button', { class: 'android.widget.Button', clickable: 'true', 'content-desc': `Save ${BOOK} draft`, bounds: '[0,0][10,10]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [node])];
    const top = disambiguateSelectors(roots, node, generateSelectors(node))[0];
    expect(top.code).toBe('device.getByRole("button", { name: "Save \\uE865 draft" })');
    expect(findMatchingNodes(roots, parseSelectorString(top.code)!)).toEqual([node]);
  });

  it('never suggests an empty role name for an icon-only element', () => {
    const icon = makeNode('android.widget.Button', { class: 'android.widget.Button', clickable: 'true', 'content-desc': GEAR, bounds: '[0,0][10,10]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [icon])];
    const codes = generateSelectors(icon).map((s) => s.code);
    expect(codes).not.toContain('device.getByRole("button", { name: "" })');
    const top = disambiguateSelectors(roots, icon, generateSelectors(icon))[0];
    expect(findMatchingNodes(roots, parseSelectorString(top.code)!)).toEqual([icon]);
  });

  it('pins a tab whose glyph-free name is a substring of another by its full name, not its position', () => {
    const { roots, tabs } = iconTabs([[BOOK, 'Story'], [GEAR, 'Story list']]);
    const top = disambiguateSelectors(roots, tabs[0], generateSelectors(tabs[0]))[0];
    expect(top.code).toBe('device.getByRole("tab", { name: "\\uE865, Story", exact: true })');
    expect(findMatchingNodes(roots, parseSelectorString(top.code)!)).toEqual([tabs[0]]);
  });

  it('ranks a glyph-pinned full-name upgrade below a glyph-free test id', () => {
    const { roots, tabs } = iconTabs([[BOOK, 'Story'], [GEAR, 'Story list']]);
    tabs[0].attributes.set('resource-id', 'story-tab');
    const ranked = disambiguateSelectors(roots, tabs[0], generateSelectors(tabs[0]));
    expect(ranked[0].code).toBe('device.getByTestId("story-tab")');
    expect(ranked.map((s) => s.code)).toContain('device.getByRole("tab", { name: "\\uE865, Story", exact: true })');
  });

  it('keeps a playground pick on a role-less icon+label element rather than its label child', () => {
    const library = makeNode('android.view.ViewGroup', {
      class: 'android.view.ViewGroup', clickable: 'true', 'content-desc': `${BOOK}, Library`, bounds: '[0,1000][100,1100]',
    }, [makeNode('android.widget.TextView', { class: 'android.widget.TextView', text: 'Library', bounds: '[0,1050][100,1090]' })]);
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout', bounds: '[0,0][1000,2000]' }, [library])];
    const picked = handlePickFromScreenshot(roots, 50, 1010);
    expect(picked?.node).toBe(library);
    expect(picked?.selector).toBe('device.getByDescription("\\uE865, Library")');
  });

  it('disambiguates glyph-free tab names that are substrings of each other', () => {
    const { roots, tabs } = iconTabs([[BOOK, 'Story'], [GEAR, 'Story list']]);
    const locators = formatHierarchy(roots).locators.filter((l) => l.includes('"tab"'));
    expect(locators).toHaveLength(2);
    for (const [i, line] of locators.entries()) {
      const code = line.replace(/^\[\d+\] /, '');
      const parsed = parseSelectorString(code)!;
      const matches = findMatchingNodes(roots, parsed);
      const picked = parsed.index === undefined ? matches : [matches[parsed.index === 'first' ? 0 : parsed.index === 'last' ? matches.length - 1 : parsed.index]];
      expect(picked).toEqual([tabs[i]]);
    }
  });
});

describe('copy-paste safe escaping (PILOT-659)', () => {
  it.each([
    ['no-break space', 'Pay\u00A0now'],
    ['tab', 'Col\tA'],
    ['zero-width space', 'Zero\u200Bwidth'],
    ['line separator', 'Line\u2028break'],
    ['backslash-u text', 'C:\\users\\new'],
  ])('round-trips a %s through suggestion code', (_label, value) => {
    const node = makeNode('android.view.View', { class: 'android.view.View', 'content-desc': value, clickable: 'true', bounds: '[0,0][10,10]' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [node])];
    const desc = generateSelectors(node).find((s) => s.label === 'Description')!;
    expect(desc.code).toMatch(/^[\x20-\x7E]*$/);
    expect(parseSelectorString(desc.code)!.value).toBe(value);
    expect(findMatchingNodes(roots, parseSelectorString(desc.code)!)).toEqual([node]);
  });

  it('leaves visible non-ASCII text and emoji ZWJ sequences readable', () => {
    const value = 'T, ✓, Tester 👩‍💻 café';
    const node = makeNode('android.view.View', { class: 'android.view.View', 'content-desc': value, clickable: 'true', bounds: '[0,0][10,10]' });
    const desc = generateSelectors(node).find((s) => s.label === 'Description')!;
    expect(desc.code).toBe(`device.getByDescription("${value}")`);
  });
});

describe('getByLabel parity with the Android agent (PILOT-659)', () => {
  // The agent reads an Android label from content-desc (or a labelling view),
  // never the field's own text — the typed value, or the hint shown as text.
  const field = (attrs: Record<string, string>) => makeNode('android.widget.EditText', {
    class: 'android.widget.EditText', clickable: 'true', focusable: 'true', bounds: '[0,0][100,50]', ...attrs,
  });

  it('does not suggest getByLabel from a field\'s typed text', () => {
    const email = field({ text: 'e2e-test@example.com', hint: 'Enter your email' });
    expect(generateSelectors(email).map((s) => s.code)).not.toContain('device.getByLabel("e2e-test@example.com")');
  });

  it('does not match getByLabel against a field\'s own text', () => {
    const email = field({ text: 'Enter your email', hint: 'Enter your email' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [email])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByLabel("Enter your email")')!)).toEqual([]);
  });

  it('still suggests and matches getByLabel from content-desc', () => {
    const email = field({ text: 'typed', 'content-desc': 'Email' });
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [email])];
    expect(generateSelectors(email).map((s) => s.code)).toContain('device.getByLabel("Email")');
    expect(findMatchingNodes(roots, parseSelectorString('device.getByLabel("Email")')!)).toEqual([email]);
  });
});

describe('glyph-only names (PILOT-659)', () => {
  it('names an icon-only text by its glyph rather than a positional bare role', () => {
    const { roots } = (() => {
      const glyphs = ['\uE865', '\uE8B8'].map((g, i) => makeNode('android.widget.TextView', {
        class: 'android.widget.TextView', text: g, bounds: `[${i * 100},0][${i * 100 + 100},40]`,
      }));
      return { roots: [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, glyphs)] };
    })();
    const { locators } = formatHierarchy(roots);
    expect(locators).toEqual([
      '[1] device.getByRole("text", { name: "\\uE865" })',
      '[2] device.getByRole("text", { name: "\\uE8B8" })',
    ]);
  });
});

describe('getByTestId parity with the Android agent (PILOT-659)', () => {
  // The agent matches getByTestId against the whole resource-id
  // (UiAutomator By.res): an RN testID ("email-input") matches, a native
  // package-qualified id ("com.android.systemui:id/mobile_signal") does not.
  const view = (rid: string) => makeNode('android.widget.ImageView', {
    class: 'android.widget.ImageView', 'resource-id': rid, bounds: '[0,0][10,10]',
  });

  it('does not suggest getByTestId from a package-qualified resource id', () => {
    const codes = generateSelectors(view('com.android.systemui:id/mobile_signal')).map((s) => s.code);
    expect(codes.some((c) => c.startsWith('device.getByTestId('))).toBe(false);
    expect(codes).toContain('device.locator({ id: "com.android.systemui:id/mobile_signal" })');
  });

  it('does not match getByTestId against the name part of a package-qualified id', () => {
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [view('com.android.systemui:id/mobile_signal')])];
    expect(findMatchingNodes(roots, parseSelectorString('device.getByTestId("mobile_signal")')!)).toEqual([]);
  });

  it('keeps a playground pick on a native id-only container rather than its text child', () => {
    const caption = makeNode('android.widget.TextView', {
      class: 'android.widget.TextView', text: 'Profile', bounds: '[0,60][100,100]',
    });
    const row = makeNode('android.widget.LinearLayout', {
      class: 'android.widget.LinearLayout', 'resource-id': 'com.app:id/profile_row', bounds: '[0,0][100,100]',
    }, [caption]);
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout', bounds: '[0,0][1000,2000]' }, [row])];
    const picked = handlePickFromScreenshot(roots, 50, 20);
    expect(picked?.node).toBe(row);
    expect(picked?.selector).toBe('device.locator({ id: "com.app:id/profile_row" })');
  });

  it('still suggests and matches an RN testID', () => {
    const node = view('email-input');
    const roots = [makeNode('android.widget.FrameLayout', { class: 'android.widget.FrameLayout' }, [node])];
    expect(generateSelectors(node).map((s) => s.code)).toContain('device.getByTestId("email-input")');
    expect(findMatchingNodes(roots, parseSelectorString('device.getByTestId("email-input")')!)).toEqual([node]);
  });
});
