import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { getNodeRole, isLabelField } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors, generateBestSelector, findBetterDescendant, hasGoodSelectors } from '../trace-viewer/components/selector-generation.js';
import { parseSelectorString, findMatchingNodes, hitTest, applyPositionalIndex, parsedSelectorError } from '../trace-viewer/components/selector-matching.js';

function makeNode(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return {
    tagName,
    attributes: new Map(Object.entries(attrs)),
    children,
    depth: 0,
  };
}

// ─── getNodeRole — tapsmith-role attribute ───

describe('getNodeRole with tapsmith-role', () => {
  it('returns tapsmith-role when present on Android ViewGroup', () => {
    const node = makeNode('node', {
      class: 'android.view.ViewGroup',
      'tapsmith-role': 'heading',
    });
    expect(getNodeRole(node)).toBe('heading');
  });

  it('returns tapsmith-role when present on iOS .other', () => {
    const node = makeNode('XCUIElementTypeOther', {
      type: 'XCUIElementTypeOther',
      'tapsmith-role': 'alert',
    });
    expect(getNodeRole(node)).toBe('alert');
  });

  it('tapsmith-role takes priority over class-based mapping', () => {
    const node = makeNode('node', {
      class: 'android.widget.TextView',
      'tapsmith-role': 'heading',
    });
    expect(getNodeRole(node)).toBe('heading');
  });

  it('falls back to class mapping when tapsmith-role absent (Android)', () => {
    const node = makeNode('node', { class: 'android.widget.Button' });
    expect(getNodeRole(node)).toBe('button');
  });

  it('falls back to type mapping when tapsmith-role absent (iOS)', () => {
    const node = makeNode('XCUIElementTypeButton', { type: 'XCUIElementTypeButton' });
    expect(getNodeRole(node)).toBe('button');
  });

  it('returns empty string for unmapped element without tapsmith-role', () => {
    const node = makeNode('node', { class: 'android.view.ViewGroup' });
    expect(getNodeRole(node)).toBe('');
  });
});

// ─── Native selector priority order ───

describe('generateNativeSelectors priority order', () => {
  it('follows Testing Library priority: Role+name > Label > Description > Placeholder > Text > TestID', () => {
    const node = makeNode('node', {
      class: 'android.widget.EditText',
      text: 'current value',
      'content-desc': 'Email',
      hint: 'Enter email',
      // An RN testID: a package-qualified id gets no getByTestId (PILOT-659).
      'resource-id': 'email_input',
    });
    const selectors = generateSelectors(node);
    const labels = selectors.map(s => s.label);

    expect(labels).toEqual([
      'Role + name',
      'Label',
      'Description',
      'Placeholder',
      'Text',
      'Test ID',
      'Resource ID',
      'Class name',
    ]);
  });

  it('suggests getByRole with tapsmith-role for heading', () => {
    const node = makeNode('node', {
      class: 'android.view.ViewGroup',
      'tapsmith-role': 'heading',
      'content-desc': 'Welcome',
    });
    const selectors = generateSelectors(node);
    expect(selectors[0].code).toBe('device.getByRole("heading", { name: "Welcome" })');
  });

  it('demotes agent-assigned suspect roles (tapsmith-role) in favor of text selectors', () => {
    const node = makeNode('node', {
      class: 'android.view.ViewGroup',
      'tapsmith-role': 'alert',
      'content-desc': 'Error occurred',
    });
    const selectors = generateSelectors(node);
    expect(selectors[0].code).toBe('device.getByDescription("Error occurred")');
    expect(selectors.some((s) => s.code.startsWith('device.getByRole("alert"'))).toBe(true);
  });

  it('suggests getByLabel only for form field roles', () => {
    const textField = makeNode('node', {
      class: 'android.widget.EditText',
      'content-desc': 'Email',
    });
    const textFieldSelectors = generateSelectors(textField);
    expect(textFieldSelectors.some(s => s.label === 'Label')).toBe(true);

    const button = makeNode('node', {
      class: 'android.widget.Button',
      'content-desc': 'Submit',
    });
    const buttonSelectors = generateSelectors(button);
    expect(buttonSelectors.some(s => s.label === 'Label')).toBe(false);
  });

  it('does not suggest getByLabel when no accessible name', () => {
    const node = makeNode('node', {
      class: 'android.widget.EditText',
      hint: 'Enter text',
    });
    const selectors = generateSelectors(node);
    expect(selectors.some(s => s.label === 'Label')).toBe(false);
  });

  it('suggests Role alone when no accessible name', () => {
    const node = makeNode('node', { class: 'android.widget.CheckBox' });
    const selectors = generateSelectors(node);
    expect(selectors[0].code).toBe('device.getByRole("checkbox")');
    expect(selectors[0].label).toBe('Role');
  });

  it('handles iOS label as text, not description', () => {
    const node = makeNode('XCUIElementTypeButton', {
      type: 'XCUIElementTypeButton',
      label: 'Continue',
    });
    const selectors = generateSelectors(node);
    const labels = selectors.map(s => s.label);
    expect(labels[0]).toBe('Role + name');
    // iOS label generates getByText only — getByDescription would also match
    // at runtime, but it's redundant since the label IS the visible text
    expect(labels).toContain('Text');
    expect(labels).not.toContain('Description (label)');
  });

  it('suggests getByText for iOS element with label but no text attr', () => {
    const node = makeNode('XCUIElementTypeOther', {
      type: 'XCUIElementTypeOther',
      label: 'Info',
    });
    const selectors = generateSelectors(node);
    const labels = selectors.map(s => s.label);
    expect(labels).toContain('Text');
    expect(labels).not.toContain('Description (label)');
  });

  it('deduplicates identical code strings', () => {
    const node = makeNode('node', {
      class: 'android.widget.EditText',
      text: 'hello',
      'content-desc': 'hello',
    });
    const selectors = generateSelectors(node);
    const codes = selectors.map(s => s.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

// ─── WebView selector priority order ───

describe('generateWebViewSelectors priority order', () => {
  it('follows Testing Library priority: Role+name > Label > Placeholder > Text > TestID > CSS', () => {
    const node = makeNode('node', {
      webview: 'true',
      'webview-tag': 'input',
      'webview-type': 'text',
      text: 'current value',
      'content-desc': 'Email field',
      hint: 'Enter email',
      'webview-testid': 'email-input',
      'webview-id': 'email',
      'webview-class': 'form-input',
    });
    const selectors = generateSelectors(node);
    const labels = selectors.map(s => s.label);

    expect(labels).toEqual([
      'Role + name',
      'Label',
      'Placeholder',
      'Text',
      'Test ID',
      'CSS #id',
      'CSS tag.class',
    ]);
  });

  it('suggests an id that is not a CSS identifier as an attribute selector the playground resolves (PILOT-666)', () => {
    for (const id of [':r1:', '1st', 'order.total']) {
      const node = makeNode('node', { webview: 'true', 'webview-tag': 'div', 'webview-id': id });
      const idSelector = generateSelectors(node).find((s) => s.label === 'CSS #id')!;
      expect(idSelector.code).toBe(`webview.locator("[id=\\"${id}\\"]")`);
      const root = makeNode('node', {}, [node]);
      expect(findMatchingNodes([root], parseSelectorString(idSelector.code)!)).toEqual([node]);
      // The #id form the runtime rejects or misreads matches nothing here either.
      expect(findMatchingNodes([root], parseSelectorString(`webview.locator("#${id}")`)!)).toEqual([]);
    }
  });

  it('the playground matches #id, .class and their tag forms only where the runtime does (PILOT-666)', () => {
    const node = makeNode('node', { webview: 'true', 'webview-tag': 'div', 'webview-id': 'café', 'webview-class': 'md:flex card' });
    const other = makeNode('node', { webview: 'true', 'webview-tag': 'div', 'webview-id': 'order.total' });
    const root = makeNode('node', {}, [node, other]);
    const count = (css: string) => findMatchingNodes([root], parseSelectorString(`webview.locator("${css}")`)!).length;
    expect(count('#café')).toBe(1);
    expect(count('div#café')).toBe(1);
    expect(count('.card')).toBe(1);
    expect(count('div.card')).toBe(1);
    expect(count('.md:flex')).toBe(0);
    expect(count('div.md:flex')).toBe(0);
    expect(count('div#order.total')).toBe(0);
  });

  it('suggests tag.class only for a class that is a CSS identifier (PILOT-666)', () => {
    const node = makeNode('node', { webview: 'true', 'webview-tag': 'div', 'webview-class': 'md:flex card' });
    expect(generateSelectors(node).some((s) => s.label === 'CSS tag.class')).toBe(false);
  });

  it('suggests and matches webview.getByLabel by the aria-label attribute only, as the runtime does (PILOT-666)', () => {
    // <label for="email">Email</label><input id="email">: an accessible name, no aria-label.
    const labelled = makeNode('node', { webview: 'true', 'webview-tag': 'input', 'content-desc': 'Email', 'webview-aria-label': '' });
    const ariaLabelled = makeNode('node', { webview: 'true', 'webview-tag': 'input', 'content-desc': 'Search', 'webview-aria-label': 'Search' });
    expect(generateSelectors(labelled).some((s) => s.label === 'Label')).toBe(false);
    expect(generateSelectors(ariaLabelled).some((s) => s.code === 'webview.getByLabel("Search")')).toBe(true);
    const root = makeNode('node', {}, [labelled, ariaLabelled]);
    expect(findMatchingNodes([root], parseSelectorString('webview.getByLabel("Email")')!)).toEqual([]);
    expect(findMatchingNodes([root], parseSelectorString('webview.getByLabel("Search")')!)).toEqual([ariaLabelled]);
    // The role name is still the accessible name.
    expect(findMatchingNodes([root], parseSelectorString('webview.getByRole("textfield", { name: "Email" })')!)).toEqual([labelled]);
  });

  it('Label comes before Text for webview elements', () => {
    const node = makeNode('node', {
      webview: 'true',
      'webview-tag': 'button',
      text: 'Login',
      'content-desc': 'Sign in button',
    });
    const selectors = generateSelectors(node);
    const labelIdx = selectors.findIndex(s => s.label === 'Label');
    const textIdx = selectors.findIndex(s => s.label === 'Text');
    expect(labelIdx).toBeLessThan(textIdx);
  });
});

// ─── generateBestSelector ───

describe('generateBestSelector', () => {
  it('returns Role+name as top suggestion for a button', () => {
    const node = makeNode('node', {
      class: 'android.widget.Button',
      'content-desc': 'Submit',
    });
    expect(generateBestSelector(node)).toBe('device.getByRole("button", { name: "Submit" })');
  });

  it('returns device.getBy* format, not legacy shorthand', () => {
    const node = makeNode('node', {
      class: 'android.widget.Button',
      'content-desc': 'OK',
    });
    const best = generateBestSelector(node);
    expect(best).toMatch(/^device\.getBy/);
    expect(best).not.toMatch(/^contentDesc\(/);
  });

  it('returns className locator fallback for elements with no accessible attributes', () => {
    const node = makeNode('node', { class: 'android.view.View' });
    expect(generateBestSelector(node)).toBe('device.locator({ className: "android.view.View" })');
  });

  it('returns fallback comment when no attributes at all', () => {
    const node = makeNode('node', {});
    expect(generateBestSelector(node)).toBe('// No locator available');
  });
});

// ─── parseSelectorString — chained positional steps compose like the runtime (PILOT-346) ───

describe('parseSelectorString chained positionals', () => {
  it('an identity step after an index is a no-op: first().first(), nth(2).last(), last().nth(-1), nth(1).nth(0)', () => {
    expect(parseSelectorString('device.getByRole("listitem").first().first()')).toEqual({ type: 'role', value: 'listitem', index: 'first' });
    expect(parseSelectorString('device.getByRole("listitem").nth(2).last()')).toEqual({ type: 'role', value: 'listitem', index: 2 });
    expect(parseSelectorString('device.getByRole("listitem").last().nth(-1)')).toEqual({ type: 'role', value: 'listitem', index: 'last' });
    expect(parseSelectorString('device.getByRole("listitem").nth(1).nth(0).first()')).toEqual({ type: 'role', value: 'listitem', index: 1 });
  });

  it('a non-identity index after an index can never match at runtime — rejected instead of silently re-indexing the full set', () => {
    // Previously parsed as { index: 1 } (the .first() was dropped by the
    // un-anchored selector regex), highlighting the SECOND listitem while the
    // runtime resolves this chain to nothing.
    expect(parseSelectorString('device.getByRole("listitem").first().nth(1)')).toBeNull();
    expect(parseSelectorString('device.getByRole("listitem").last().nth(-2)')).toBeNull();
    expect(parseSelectorString('device.getByText("x").nth(1).nth(1)')).toBeNull();
  });

  it('a single positional step is unchanged', () => {
    expect(parseSelectorString('device.getByRole("listitem").nth(-1)')).toEqual({ type: 'role', value: 'listitem', index: -1 });
    expect(parseSelectorString('device.getByRole("listitem")')).toEqual({ type: 'role', value: 'listitem' });
  });
});

// ─── parseSelectorString — Label support ───

describe('parseSelectorString Label support', () => {
  it('parses device.getByLabel("Email")', () => {
    const result = parseSelectorString('device.getByLabel("Email")');
    expect(result).toEqual({ type: 'label', value: 'Email' });
  });

  it('parses device.getByLabel("Email").first()', () => {
    const result = parseSelectorString('device.getByLabel("Email").first()');
    expect(result).toEqual({ type: 'label', value: 'Email', index: 'first' });
  });

  it('parses device.getByLabel with single quotes', () => {
    const result = parseSelectorString("device.getByLabel('Password')");
    expect(result).toEqual({ type: 'label', value: 'Password' });
  });
});

// ─── findMatchingNodes — Label matching ───

describe('findMatchingNodes with label selector', () => {
  it('matches form-field nodes by label attribute', () => {
    const root = makeNode('hierarchy', {}, [
      makeNode('XCUIElementTypeTextField', {
        type: 'XCUIElementTypeTextField',
        label: 'Email',
      }),
      makeNode('XCUIElementTypeButton', {
        type: 'XCUIElementTypeButton',
        label: 'Email',
      }),
    ]);
    const parsed = parseSelectorString('device.getByLabel("Email")')!;
    const matches = findMatchingNodes([root], parsed);
    expect(matches).toHaveLength(1);
    expect(matches[0].tagName).toBe('XCUIElementTypeTextField');
  });

  it('matches Android form fields by content-desc', () => {
    const root = makeNode('hierarchy', {}, [
      makeNode('node', {
        class: 'android.widget.EditText',
        'content-desc': 'Username',
      }),
      makeNode('node', {
        class: 'android.widget.Button',
        'content-desc': 'Username',
      }),
    ]);
    const parsed = parseSelectorString('device.getByLabel("Username")')!;
    const matches = findMatchingNodes([root], parsed);
    expect(matches).toHaveLength(1);
    expect(matches[0].attributes.get('class')).toBe('android.widget.EditText');
  });

  it('does not match non-form-field nodes', () => {
    const root = makeNode('hierarchy', {}, [
      makeNode('node', {
        class: 'android.widget.TextView',
        'content-desc': 'Title',
      }),
    ]);
    const parsed = parseSelectorString('device.getByLabel("Title")')!;
    const matches = findMatchingNodes([root], parsed);
    expect(matches).toHaveLength(0);
  });
});

// ─── isLabelField (PILOT-666) ───

describe('isLabelField: the inputs the runtime getByLabel finds', () => {
  it('goes by iOS element type, not the reported role', () => {
    expect(isLabelField(makeNode('XCUIElementTypeTextField', { type: 'XCUIElementTypeTextField', 'tapsmith-role': 'combobox' }))).toBe(true);
    expect(isLabelField(makeNode('XCUIElementTypeStepper', { type: 'XCUIElementTypeStepper' }))).toBe(true);
    expect(isLabelField(makeNode('XCUIElementTypeSearchField', { type: 'XCUIElementTypeSearchField' }))).toBe(false);
    expect(isLabelField(makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther', 'tapsmith-role': 'checkbox' }))).toBe(false);
  });

  it('goes by Android class, not the reported role', () => {
    expect(isLabelField(makeNode('node', { class: 'android.widget.EditText' }))).toBe(true);
    expect(isLabelField(makeNode('node', { class: 'android.widget.SearchView' }))).toBe(false);
    expect(isLabelField(makeNode('node', { class: 'android.view.ViewGroup', 'tapsmith-role': 'checkbox' }))).toBe(false);
  });

  it('is never a WebView node', () => {
    expect(isLabelField(makeNode('node', { class: 'android.widget.EditText', webview: 'true' }))).toBe(false);
  });
});

describe('getByLabel suggestions follow the runtime fields (PILOT-666)', () => {
  const hasLabel = (node: HierarchyNode) => generateSelectors(node).some((s) => s.label === 'Label');

  it('no getByLabel for an iOS search field, which getByLabel does not find', () => {
    expect(hasLabel(makeNode('XCUIElementTypeSearchField', { type: 'XCUIElementTypeSearchField', label: 'Search' }))).toBe(false);
  });

  it('getByLabel for an iOS text field that reports a trait role', () => {
    const node = makeNode('XCUIElementTypeTextField', { type: 'XCUIElementTypeTextField', label: 'Country', 'tapsmith-role': 'combobox' });
    expect(generateSelectors(node).some((s) => s.code === 'device.getByLabel("Country")')).toBe(true);
  });

  it('a multi-line iOS text view is found by its label, not by a textfield role the runtime does not give it', () => {
    const node = makeNode('XCUIElementTypeTextView', { type: 'XCUIElementTypeTextView', label: 'Notes' });
    const selectors = generateSelectors(node);
    expect(selectors[0].code).toBe('device.getByLabel("Notes")');
    expect(selectors.some((s) => s.code.startsWith('device.getByRole("textfield"'))).toBe(false);
  });

  it('no getByLabel for an Android view that only reports a checkbox role', () => {
    expect(hasLabel(makeNode('node', { class: 'android.view.ViewGroup', 'tapsmith-role': 'checkbox', 'content-desc': 'Agree' }))).toBe(false);
  });
});

// ─── hasGoodSelectors / findBetterDescendant ───

describe('hasGoodSelectors', () => {
  it('returns true for a node with meaningful selectors', () => {
    const node = makeNode('node', { class: 'android.widget.TextView', text: 'Welcome' });
    expect(hasGoodSelectors(node)).toBe(true);
  });

  it('returns false for a generic container with only fallback selectors', () => {
    const node = makeNode('node', { class: 'android.view.ViewGroup' });
    expect(hasGoodSelectors(node)).toBe(false);
  });
});

describe('findBetterDescendant', () => {
  it('promotes a textfield with placeholder inside a generic wrapper', () => {
    const textfield = makeNode('node', { class: 'android.widget.EditText', hint: 'Email' });
    const wrapper = makeNode('node', { class: 'android.view.ViewGroup' }, [textfield]);
    expect(findBetterDescendant(wrapper)).toBe(textfield);
  });

  it('returns null when the node itself has good selectors', () => {
    const child = makeNode('node', { class: 'android.widget.EditText', hint: 'Email' });
    const node = makeNode('node', { class: 'android.widget.Button', text: 'Submit' }, [child]);
    expect(findBetterDescendant(node)).toBeNull();
  });

  it('returns null when no descendant has good selectors', () => {
    const inner = makeNode('node', { class: 'android.view.ViewGroup' });
    const wrapper = makeNode('node', { class: 'android.view.ViewGroup' }, [inner]);
    expect(findBetterDescendant(wrapper)).toBeNull();
  });

  it('prefers the shallowest qualifying descendant (BFS)', () => {
    const deep = makeNode('node', { class: 'android.widget.TextView', text: 'Deep' });
    const middle = makeNode('node', { class: 'android.view.ViewGroup' }, [deep]);
    const shallow = makeNode('node', { class: 'android.widget.TextView', text: 'Shallow' });
    const wrapper = makeNode('node', { class: 'android.view.ViewGroup' }, [middle, shallow]);
    expect(findBetterDescendant(wrapper)).toBe(shallow);
  });
});

// ─── parseSelectorString — device.locator ───

describe('parseSelectorString device.locator', () => {
  it('parses device.locator({ className: ... })', () => {
    const parsed = parseSelectorString('device.locator({ className: "android.widget.TextView" })');
    expect(parsed).toEqual({ type: 'className', value: 'android.widget.TextView', index: undefined });
  });

  it('parses device.locator({ id: ... })', () => {
    const parsed = parseSelectorString('device.locator({ id: "com.app:id/submit" })');
    expect(parsed).toEqual({ type: 'id', value: 'com.app:id/submit', index: undefined });
  });

  it('matches nodes by className through findMatchingNodes', () => {
    const root = makeNode('hierarchy', {}, [
      makeNode('node', { class: 'android.widget.TextView', text: 'One' }),
      makeNode('node', { class: 'android.widget.Button', text: 'Two' }),
    ]);
    const parsed = parseSelectorString('device.locator({ className: "android.widget.TextView" })')!;
    const matches = findMatchingNodes([root], parsed);
    expect(matches).toHaveLength(1);
    expect(matches[0].attributes.get('text')).toBe('One');
  });
});

// ─── findMatchingNodes — iOS getByDescription matches label ───

describe('findMatchingNodes iOS description', () => {
  it('matches getByDescription against the iOS label attribute', () => {
    // The agent matches contentDesc selectors against the runtime label on
    // iOS, so the playground matcher must do the same with the label attr.
    const root = makeNode('XCUIElementTypeApplication', {}, [
      makeNode('XCUIElementTypeOther', { type: 'XCUIElementTypeOther', label: 'Info' }),
    ]);
    const parsed = parseSelectorString('device.getByDescription("Info")')!;
    const matches = findMatchingNodes([root], parsed);
    expect(matches).toHaveLength(1);
    expect(matches[0].attributes.get('label')).toBe('Info');
  });

  it('still matches Android content-desc', () => {
    const root = makeNode('hierarchy', {}, [
      makeNode('node', { class: 'android.widget.ImageButton', 'content-desc': 'Close' }),
    ]);
    const parsed = parseSelectorString('device.getByDescription("Close")')!;
    expect(findMatchingNodes([root], parsed)).toHaveLength(1);
  });
});

// ─── hitTest tie-breaking ───

describe('hitTest', () => {
  it('picks the deeper node when parent and child have equal bounds', () => {
    // RN apps commonly nest equal-bounds wrapper Views — the deeper node is
    // closer to the actual content.
    const child = makeNode('node', { class: 'android.widget.TextView', text: 'Hi', bounds: '[0,0][100,50]' });
    const parent = makeNode('node', { class: 'android.view.ViewGroup', bounds: '[0,0][100,50]' }, [child]);
    expect(hitTest([parent], 50, 25)).toBe(child);
  });

  it('picks the smallest node containing the point', () => {
    const small = makeNode('node', { class: 'android.widget.Button', bounds: '[10,10][50,30]' });
    const big = makeNode('node', { class: 'android.view.ViewGroup', bounds: '[0,0][100,100]' }, [small]);
    expect(hitTest([big], 20, 20)).toBe(small);
    expect(hitTest([big], 90, 90)).toBe(big);
  });
});

// ─── parseSelectorString — runtime-aligned getByText semantics (PILOT-226) ───

describe('parseSelectorString getByText semantics', () => {
  const heading = makeNode('node', { class: 'android.widget.TextView', text: 'Sign in to continue to DreamSpinner' });
  const button = makeNode('node', { class: 'android.widget.Button', text: 'Sign in' });
  const roots = [makeNode('node', { class: 'android.view.ViewGroup' }, [heading, button])];

  it('getByText without options parses to a SUBSTRING match (matches runtime)', () => {
    const parsed = parseSelectorString('device.getByText("Sign in")');
    expect(parsed).toEqual({ type: 'textContains', value: 'Sign in', index: undefined });
    // Both the heading and the button substring-match — exactly what the
    // runtime sees (the original story-app bug).
    expect(findMatchingNodes(roots, parsed!)).toHaveLength(2);
  });

  it('getByText with { exact: true } parses to an exact match', () => {
    const parsed = parseSelectorString('device.getByText("Sign in", { exact: true })');
    expect(parsed).toEqual({ type: 'text', value: 'Sign in', index: undefined });
    const matches = findMatchingNodes(roots, parsed!);
    expect(matches).toHaveLength(1);
    expect(matches[0].attributes.get('class')).toBe('android.widget.Button');
  });

  it('supports single quotes and exact: false', () => {
    expect(parseSelectorString("device.getByText('Sign in', { exact: false })"))
      .toEqual({ type: 'textContains', value: 'Sign in', index: undefined });
  });

  it('parses combined { name, exact } options on getByRole without confusion', () => {
    const parsed = parseSelectorString('device.getByRole("button", { name: "Sign in" })');
    expect(parsed).toEqual({ type: 'role', value: 'button', name: 'Sign in', index: undefined });
  });

  it('getByText with index chain keeps substring semantics', () => {
    const parsed = parseSelectorString('device.getByText("Sign in").first()');
    expect(parsed).toEqual({ type: 'textContains', value: 'Sign in', index: 'first' });
    expect(findMatchingNodes(roots, parsed!)).toHaveLength(1);
  });

  it('webview.getByText defaults to substring, exact with option', () => {
    expect(parseSelectorString('webview.getByText("Add")'))
      .toEqual({ type: 'wv-text-contains', value: 'Add', index: undefined });
    expect(parseSelectorString('webview.getByText("Add", { exact: true })'))
      .toEqual({ type: 'wv-text', value: 'Add', index: undefined });
  });

  it('wv-text-contains matches webview nodes by substring', () => {
    const wvNode = makeNode('node', { webview: 'true', text: 'Add item' });
    const wvRoots = [makeNode('node', {}, [wvNode])];
    expect(findMatchingNodes(wvRoots, parseSelectorString('webview.getByText("Add")')!)).toHaveLength(1);
    expect(findMatchingNodes(wvRoots, parseSelectorString('webview.getByText("Add", { exact: true })')!)).toHaveLength(0);
  });

  it('text matching falls back to the iOS value attribute', () => {
    const slider = makeNode('XCUIElementTypeSlider', { type: 'XCUIElementTypeSlider', value: '50%' });
    const matches = findMatchingNodes([slider], parseSelectorString('device.getByText("50%", { exact: true })')!);
    expect(matches).toHaveLength(1);
  });
});

describe('parseGetByOptions escaped-quote handling (PR #124 review)', () => {
  it('parses a name containing escaped quotes of the same type, unescaped', () => {
    const parsed = parseSelectorString('device.getByRole("button", { name: "Say \\"hi\\"" })');
    expect(parsed).toEqual({ type: 'role', value: 'button', name: 'Say "hi"', index: undefined });
  });

  it('parsed name matches raw node attribute values', () => {
    const node = makeNode('node', { class: 'android.widget.Button', text: 'Say "hi"' });
    const parsed = parseSelectorString('device.getByRole("button", { name: "Say \\"hi\\"" })');
    expect(findMatchingNodes([node], parsed!)).toHaveLength(1);
  });

  it('handles single-quoted names with escaped single quotes', () => {
    const parsed = parseSelectorString("device.getByRole('button', { name: 'Don\\'t' })");
    expect(parsed?.name).toBe("Don't");
  });

  it('still parses { name, exact } combinations', () => {
    const parsed = parseSelectorString('device.getByRole("button", { name: "OK", exact: true })');
    expect(parsed?.name).toBe('OK');
  });
});

describe('applyPositionalIndex (shared positional-chain util)', () => {
  const items = ['a', 'b', 'c'];
  it('passes through without an index', () => {
    expect(applyPositionalIndex(items, undefined)).toEqual(['a', 'b', 'c']);
  });
  it('resolves first/last/nth and negative indices', () => {
    expect(applyPositionalIndex(items, 'first')).toEqual(['a']);
    expect(applyPositionalIndex(items, 'last')).toEqual(['c']);
    expect(applyPositionalIndex(items, 1)).toEqual(['b']);
    expect(applyPositionalIndex(items, -1)).toEqual(['c']);
  });
  it('returns empty for out-of-range indices', () => {
    expect(applyPositionalIndex(items, 5)).toEqual([]);
    expect(applyPositionalIndex(items, -4)).toEqual([]);
    expect(applyPositionalIndex([], 'first')).toEqual([]);
  });
});

// ─── Native role names (PILOT-556) ───

describe('role names in the playground match the runtime', () => {
  const heading = makeNode('node', { class: 'android.view.ViewGroup', 'tapsmith-role': 'heading', text: 'Settings', bounds: '[0,0][100,50]' });
  const button = makeNode('node', { class: 'android.widget.Button', text: 'OK', bounds: '[0,60][100,110]' });
  const menuItem = makeNode('node', { class: 'android.view.ViewGroup', 'tapsmith-role': 'menuitem', text: 'Open', bounds: '[0,120][100,170]' });
  const roots = [makeNode('hierarchy', {}, [heading, button, menuItem])];
  const match = (selector: string) => findMatchingNodes(roots, parseSelectorString(selector)!);

  it('resolves aliases and ignores case, like getByRole', () => {
    expect(match('device.getByRole("header")')).toEqual([heading]);
    expect(match('device.getByRole("Button", { name: "OK" })')).toEqual([button]);
  });

  it('matches the roles the agents resolve by class, which the reverse map leaves out', () => {
    const scroll = makeNode('node', { class: 'android.widget.ScrollView', bounds: '[0,0][100,500]' });
    const recycler = makeNode('node', { class: 'androidx.recyclerview.widget.RecyclerView', bounds: '[0,0][100,400]' });
    const table = makeNode('XCUIElementTypeTable', { type: 'XCUIElementTypeTable', x: '0', y: '0', width: '100', height: '400' });
    const cell = makeNode('XCUIElementTypeCell', { type: 'XCUIElementTypeCell', x: '0', y: '0', width: '100', height: '40' });
    const text = makeNode('node', { class: 'android.widget.TextView', text: 'Plain', bounds: '[0,0][100,20]' });
    const tree = [makeNode('hierarchy', {}, [scroll, recycler, table, cell, text])];
    const on = (selector: string) => findMatchingNodes(tree, parseSelectorString(selector)!);
    expect(on('device.getByRole("scrollview")')).toEqual([scroll]);
    expect(on('device.getByRole("list")')).toEqual([recycler, table]);
    expect(on('device.getByRole("listitem")')).toEqual([cell]);
    // A TextView is only a heading or link through its role description, as
    // on the device.
    expect(on('device.getByRole("heading")')).toEqual([]);
    expect(on('device.getByRole("link")')).toEqual([]);
  });

  it('applies the Android agent\'s dual-path rule: a role description overrides the class', () => {
    // ElementFinder.kt: for heading/link/image/searchfield, a node with a role
    // description matches only through it; class roles (button, …) are
    // By.clazz matches and ignore it.
    const pressableImage = makeNode('node', { class: 'android.widget.ImageView', 'tapsmith-role': 'button', bounds: '[0,0][50,50]' });
    const plainImage = makeNode('node', { class: 'android.widget.ImageView', bounds: '[0,60][50,110]' });
    const menuButton = makeNode('node', { class: 'android.widget.Button', 'tapsmith-role': 'menuitem', text: 'Open', bounds: '[0,120][50,170]' });
    const tree = [makeNode('hierarchy', {}, [pressableImage, plainImage, menuButton])];
    const on = (selector: string) => findMatchingNodes(tree, parseSelectorString(selector)!);
    expect(on('device.getByRole("image")')).toEqual([plainImage]);
    expect(on('device.getByRole("button")')).toContain(menuButton);
  });

  it('matches nothing for a role getByRole rejects, and says why', () => {
    expect(match('device.getByRole("menuitem")')).toEqual([]);
    expect(parsedSelectorError(parseSelectorString('device.getByRole("menuitem")')!))
      .toMatch(/^Unknown role "menuitem"\. Supported: /);
    expect(parsedSelectorError(parseSelectorString('device.getByRole("button")')!)).toBeNull();
    expect(parsedSelectorError(parseSelectorString('device.getByText("OK")')!)).toBeNull();
  });

  it('leaves WebView roles alone (DOM ARIA roles)', () => {
    expect(parsedSelectorError(parseSelectorString('webview.getByRole("banner")')!)).toBeNull();
  });

  it('suggests no getByRole for a role getByRole rejects', () => {
    const codes = generateSelectors(menuItem).map((s) => s.code);
    expect(codes.some((c) => c.includes('getByRole'))).toBe(false);
    expect(codes).toContain('device.getByText("Open")');
  });
});
