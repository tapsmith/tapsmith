/**
 * WebView locators see into open shadow roots, as Playwright's do
 * (PILOT-1328). Ionic, Stencil, Lit and Shoelace render their native controls
 * inside shadow roots, so a light-DOM-only finder finds no buttons or inputs
 * on those pages.
 *
 * The finders are in-page JS, so these tests run the real expressions in a
 * jsdom page (which implements shadow roots and slots) instead of asserting
 * on the JS text.
 */
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { WebViewHandle } from '../webview-handle.js';
import { isStrictModeViolation } from '../element-handle.js';
import { parseHierarchyXml, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { findMatchingNodes, parseSelectorString } from '../trace-viewer/components/selector-matching.js';
import { pickNodeAt } from '../trace-viewer/components/pick-node.js';

const SHADOW_PAGE = `<!DOCTYPE html><html><body>
  <button id="light">Light</button>
  <x-button id="sign-in">Sign in</x-button>
  <x-field id="nickname"></x-field>
  <span id="lab">Document label</span>
  <x-slider id="volume"></x-slider>
  <x-outer id="outer"></x-outer>
  <x-closed id="closed"></x-closed>
  <x-icon id="close" class="icon-host" aria-label="Close"></x-icon>
  <p id="result">idle</p>
</body></html>`;

/** Build the page's shadow trees the way Stencil/Lit components would. */
function buildShadowTrees(doc: Document): void {
  const button = (host: Element) => {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>.button-native { color: red }</style>'
      + '<button class="button-native" type="button"><span class="button-inner"><slot></slot></span></button>';
    return root;
  };
  button(doc.getElementById('sign-in')!)
    .querySelector('button')!
    .addEventListener('click', () => { doc.getElementById('result')!.textContent = 'signed in'; });

  doc.getElementById('nickname')!.attachShadow({ mode: 'open' }).innerHTML =
    '<label for="nick">Nickname</label><input id="nick" placeholder="Your nickname" data-testid="nick-input">';

  // aria-labelledby resolves in the element's own tree: the shadow tree's
  // #lab, not the document's.
  doc.getElementById('volume')!.attachShadow({ mode: 'open' }).innerHTML =
    '<span id="lab">Volume</span><div role="slider" aria-labelledby="lab"></div>';

  // A shadow root inside a shadow root.
  const outer = doc.getElementById('outer')!.attachShadow({ mode: 'open' });
  outer.innerHTML = '<x-button id="nested">Nested</x-button>';
  button(outer.getElementById('nested')!);

  doc.getElementById('closed')!.attachShadow({ mode: 'closed' }).innerHTML = '<button>Secret</button>';

  // Ionic moves a host's aria-label onto its native control.
  const icon = doc.getElementById('close')!;
  const iconRoot = icon.attachShadow({ mode: 'open' });
  iconRoot.innerHTML = '<button class="icon"></button>';
  iconRoot.querySelector('button')!.setAttribute('aria-label', icon.getAttribute('aria-label')!);
  icon.removeAttribute('aria-label');
}

/** A WebViewHandle whose page is a jsdom window: every evaluate runs there. */
function handleOn(html: string, setup?: (doc: Document) => void) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  setup?.(dom.window.document);
  // jsdom does no layout: give every rendered element a box, and none to the
  // elements a browser gives none (a <slot> is display: contents).
  // An element can pin its box with data-rect="left,top,right,bottom".
  // display: none (on it or a shadow-including ancestor) leaves it no box.
  const win = dom.window;
  const undisplayed = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) {
      if (win.getComputedStyle(n).display === 'none') return true;
    }
    return false;
  };
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const pinned = this.getAttribute('data-rect')?.split(',').map(Number);
    const [left, top, right, bottom] = pinned
      ?? (['STYLE', 'SLOT', 'SCRIPT'].includes(this.nodeName) || undisplayed(this) ? [0, 0, 0, 0] : [0, 0, 10, 10]);
    return { left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top } as DOMRect;
  };
  win.Element.prototype.getClientRects = function (this: Element) {
    const r = this.getBoundingClientRect();
    return (r.width === 0 && r.height === 0 && (this.nodeName === 'SLOT' || undisplayed(this)) ? [] : [r]) as unknown as DOMRectList;
  };
  // The native WebView's place on screen, which the DOM dump offsets by.
  const client = {
    findElement: async () => ({ found: true, element: { bounds: { left: 0, top: 0, right: 100, bottom: 100 } } }),
  } as unknown as TapsmithGrpcClient;
  const handle = new WebViewHandle(client, 0, 300);
  vi.spyOn(handle, '_evaluate').mockImplementation(async (expression: string) => {
    const value: unknown = dom.window.eval(expression);
    // Runtime.evaluate returns by value.
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value)) as unknown;
  });
  return { handle, doc: dom.window.document, window: dom.window };
}

const shadowPage = () => handleOn(SHADOW_PAGE, buildShadowTrees);

/** The `id` (or class) of each match, in the order the locator returns them. */
async function idsOf(handle: WebViewHandle, finderAllJs: string): Promise<string[]> {
  return await handle._evaluate(`(${finderAllJs}).map((el) => el.id || el.className)`) as string[];
}

describe('WebView locators pierce open shadow roots (PILOT-1328)', () => {
  it('locator(css) finds elements in open shadow roots, in shadow-including tree order', async () => {
    const { handle } = shadowPage();
    const buttons = handle.locator('button');
    expect(await buttons.count()).toBe(4);
    // The light button, x-button's, the nested x-button's (inside x-outer's
    // shadow root), and x-icon's — never the closed root's.
    expect(await idsOf(handle, buttons._finderAllJs)).toEqual(['light', 'button-native', 'button-native', 'icon']);
  });

  it('does not reach into closed shadow roots', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByText('Secret').count()).toBe(0);
    expect(await handle.getByRole('button', { name: 'Secret' }).count()).toBe(0);
  });

  it('getByRole names a shadow button by its slotted text', async () => {
    const { handle } = shadowPage();
    const signIn = handle.getByRole('button', { name: 'Sign in' });
    expect(await signIn.count()).toBe(1);
    expect(await idsOf(handle, signIn._finderAllJs)).toEqual(['button-native']);
    expect(await handle.getByRole('button', { name: 'Nested' }).count()).toBe(1);
  });

  it('getByRole and getByLabel find a control that carries the aria-label inside the component', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByRole('button', { name: 'Close' }).count()).toBe(1);
    expect(await handle.getByLabel('Close').count()).toBe(1);
  });

  it('getByRole names a field by a <label for> inside the same shadow root', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByRole('textfield', { name: 'Nickname' }).count()).toBe(1);
  });

  it('resolves aria-labelledby in the element\'s own tree', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByRole('slider', { name: 'Volume' }).count()).toBe(1);
    expect(await handle.getByRole('slider', { name: 'Document label' }).count()).toBe(0);
  });

  it('getByPlaceholder and getByTestId pierce', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByPlaceholder('Your nickname').count()).toBe(1);
    expect(await handle.getByTestId('nick-input').count()).toBe(1);
  });

  it('getByText finds text inside shadow roots but never a shadow <style>', async () => {
    const { handle } = shadowPage();
    expect(await handle.getByText('Nested', { exact: true }).count()).toBe(1);
    expect(await handle.getByText('Volume', { exact: true }).count()).toBe(1);
    // Every x-button's shadow root holds a <style> mentioning button-native.
    expect(await handle.getByText('button-native').count()).toBe(0);
  });

  it('acts on a shadow element: click and fill', async () => {
    const { handle, doc } = shadowPage();
    await handle.getByRole('button', { name: 'Sign in' }).click();
    expect(doc.getElementById('result')!.textContent).toBe('signed in');

    // A real keystroke's input event is composed: it reaches listeners on the
    // component's host and the document, where Lit and Material Web apps listen.
    const heard: string[] = [];
    doc.getElementById('nickname')!.addEventListener('input', () => heard.push('host'));
    doc.addEventListener('input', () => heard.push('document'));
    const field = handle.getByPlaceholder('Your nickname');
    await field.fill('jordan');
    expect(await field.inputValue()).toBe('jordan');
    expect(heard).toEqual(['host', 'document']);
    heard.length = 0;
    await handle.fill('#nick', 'sam');
    expect(heard).toEqual(['host', 'document']);
  });

  it('counts shadow matches for strict mode', async () => {
    const { handle } = shadowPage();
    const err = await handle.locator('button.button-native').click().catch((e: unknown) => e);
    expect(isStrictModeViolation(err)).toBe(true);
    expect(await handle.locator('button.button-native').nth(1).count()).toBe(1);
    expect(await handle._evaluate(`(${handle.locator('button').last()._finderJs}).className`)).toBe('icon');
  });

  it('the string-selector methods pierce too', async () => {
    const { handle, doc } = shadowPage();
    await handle.click('x-button button', { timeout: 100 }).catch(() => undefined);
    expect(doc.getElementById('result')!.textContent).toBe('idle');
    await handle.click('button.button-native');
    expect(doc.getElementById('result')!.textContent).toBe('signed in');
    await handle.fill('#nick', 'sam');
    expect(await handle.inputValue('#nick')).toBe('sam');
    expect(await handle.getAttribute('input', 'placeholder')).toBe('Your nickname');
  });

  it('getByRole filters on an explicit empty name', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button></button><button>X</button>'
      + '<div role="banner"></div><div role="banner">Y</div></body>');
    expect(await handle.getByRole('button', { name: '' }).count()).toBe(1);
    expect(await handle.getByRole('banner', { name: '' }).count()).toBe(1);
    expect(await handle.getByRole('banner', { name: 'Y' }).count()).toBe(1);
  });

  it('leaves aria-hidden content out of an accessible name', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="b"><x-icon aria-hidden="true"></x-icon>Sign in</button>'
      + '<x-md-button id="m"><x-icon slot="icon" aria-hidden="true">send</x-icon>Send</x-md-button></body>', (doc) => {
      // An ionicons 5 icon renders its SVG <title> into its shadow root.
      doc.querySelector('#b x-icon')!.attachShadow({ mode: 'open' }).innerHTML = '<svg><title>Log In</title></svg>';
      // Material Web's md-button: the icon slot and the label slot inside the button.
      doc.getElementById('m')!.attachShadow({ mode: 'open' }).innerHTML =
        '<button><slot name="icon"></slot><span class="label"><slot></slot></span></button>';
    });
    expect(await handle.getByRole('button', { name: 'Sign in' }).count()).toBe(1);
    expect(await handle.getByRole('button', { name: 'Send' }).count()).toBe(1);
  });

  it('never suggests an id or test id from inside a shadow root, where it need not be unique', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><x-field></x-field><x-field></x-field></body>', (doc) => {
      for (const host of doc.querySelectorAll('x-field')) {
        host.attachShadow({ mode: 'open' }).innerHTML = '<input id="native-input" data-testid="field">';
      }
    });
    const err = await handle.getByRole('textfield').click().catch((e: unknown) => e);
    expect(isStrictModeViolation(err)).toBe(true);
    expect(String(err)).not.toContain('#native-input');
    expect(String(err)).not.toContain('webview.getByTestId');
    // Each would match both fields.
    expect(await handle.locator('#native-input').count()).toBe(2);
  });

  it('names a control by a wrapping <label> whose text is slotted in', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><x-check id="c">Accept terms</x-check></body>', (doc) => {
      // Shoelace's sl-checkbox: the label wraps the input and a slot, with no for=.
      doc.getElementById('c')!.attachShadow({ mode: 'open' }).innerHTML =
        '<label><input type="checkbox"><div class="label"><slot></slot></div></label>';
    });
    expect(await handle.getByRole('checkbox', { name: 'Accept terms' }).count()).toBe(1);
  });

  it('matches both a host and its inner control when both carry the attribute, as Playwright does', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><x-input id="h" placeholder="Search"></x-input></body>', (doc) => {
      doc.getElementById('h')!.attachShadow({ mode: 'open' }).innerHTML = '<input placeholder="Search">';
    });
    const search = handle.getByPlaceholder('Search');
    expect(await search.count()).toBe(2);
    expect(isStrictModeViolation(await search.click().catch((e: unknown) => e))).toBe(true);
    // The Playground's dump reads the host's attribute too (a custom element
    // has no placeholder property), so it knows the locator is not unique.
    const host = parseHierarchyXml((await handle._dumpDomHierarchy())!)[0]!.children[0]!;
    expect(host.attributes.get('webview-tag')).toBe('x-input');
    expect(host.attributes.get('hint')).toBe('Search');
  });

  it('getByRole skips a control hidden from assistive technology, as Playwright\'s does', async () => {
    // ion-toggle: the host is the switch; a display:none native input inside
    // carries the same role and, through its label and the slot, the same name.
    const { handle } = handleOn('<!DOCTYPE html><body><x-toggle role="switch">Email notifications</x-toggle>'
      + '<button style="display:none">Gone</button><button style="visibility:hidden">Ghost</button>'
      + '<button aria-hidden="true">Muted</button><button>Shown</button></body>', (doc) => {
      doc.querySelector('x-toggle')!.attachShadow({ mode: 'open' }).innerHTML =
        '<label><input type="checkbox" role="switch" style="display:none"><span><slot></slot></span></label>';
    });
    expect(await handle.getByRole('switch', { name: 'Email notifications' }).count()).toBe(1);
    expect(await handle.getByRole('button').count()).toBe(1);
    // Other locators still find hidden elements, as Playwright's do.
    expect(await handle.locator('button').count()).toBe(4);
  });

  it('treats an element as a leaf only when it has no element children, whatever its children property says', async () => {
    // Stencil's scoped components (ion-input) patch `children` to list
    // slotted content only, hiding the label and input they render.
    const { handle } = handleOn('<!DOCTYPE html><body><x-input id="h"><label><span>Email</span><input></label></x-input></body>',
      (doc) => { Object.defineProperty(doc.getElementById('h')!, 'children', { get: () => [] }); });
    expect(await handle.getByText('Email', { exact: true }).count()).toBe(1);
    const nodes = parseHierarchyXml((await handle._dumpDomHierarchy())!);
    const host = nodes[0]!.children[0]!;
    expect(host.attributes.get('webview-tag')).toBe('x-input');
    expect(host.children.map((c) => c.attributes.get('webview-tag'))).toEqual(['label']);
  });

  it('keeps document order and results on a page without shadow roots', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><div id="a"><p id="b"></p></div><p id="c"></p></body>');
    expect(await idsOf(handle, handle.locator('p, div')._finderAllJs)).toEqual(['a', 'b', 'c']);
  });

  it('still throws on an invalid selector, even on an empty page', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>');
    await expect(handle.locator('button[').count()).rejects.toThrow();
  });

  describe('the Playground DOM dump', () => {
    function flatten(nodes: HierarchyNode[]): HierarchyNode[] {
      return nodes.flatMap((n) => [n, ...flatten(n.children)]);
    }

    it('includes open shadow trees, in the order the locators match, and not closed ones', async () => {
      const { handle } = shadowPage();
      const xml = (await handle._dumpDomHierarchy())!;
      const nodes = flatten(parseHierarchyXml(xml));
      const tags = nodes.map((n) => n.attributes.get('webview-tag'));
      // Custom-element hosts parse, with their shadow contents as children.
      const host = nodes.find((n) => n.attributes.get('webview-id') === 'sign-in')!;
      expect(host.children.map((c) => c.attributes.get('webview-tag'))).toEqual(['button']);
      expect(tags.filter((t) => t === 'button')).toHaveLength(4);
      expect(nodes.some((n) => n.attributes.get('text') === 'Secret')).toBe(false);
      // No zero-size <style> or <slot>.
      expect(tags).not.toContain('style');
      expect(tags).not.toContain('slot');
    });

    it('names a shadow button by its slotted text, so the Playground suggests getByRole with that name', async () => {
      const { handle } = shadowPage();
      const nodes = flatten(parseHierarchyXml((await handle._dumpDomHierarchy())!));
      const inner = nodes.find((n) => n.attributes.get('webview-tag') === 'button'
        && n.attributes.get('content-desc') === 'Sign in');
      expect(inner).toBeDefined();
      expect(generateSelectors(inner!)[0]?.code).toBe('webview.getByRole("button", { name: "Sign in" })');
    });

    it('every top suggestion for a shadow element finds it at runtime', async () => {
      const { handle } = shadowPage();
      const nodes = flatten(parseHierarchyXml((await handle._dumpDomHierarchy())!));
      const named = (tag: string, name: string) => nodes.find((n) =>
        n.attributes.get('webview-tag') === tag && n.attributes.get('content-desc') === name);
      const suggestions = [
        named('button', 'Sign in'),
        named('button', 'Close'),
        named('input', 'Nickname'),
        named('div', 'Volume'),
      ].map((n) => generateSelectors(n!)[0]!.code);
      expect(suggestions).toEqual([
        'webview.getByRole("button", { name: "Sign in" })',
        'webview.getByRole("button", { name: "Close" })',
        'webview.getByRole("textfield", { name: "Nickname" })',
        'webview.getByRole("slider", { name: "Volume" })',
      ]);
      for (const code of suggestions) {
        const [, role, name] = /getByRole\("(\w+)", \{ name: "([^"]+)" \}\)/.exec(code)!;
        expect(await handle.getByRole(role!, { name }).count(), code).toBe(1);
      }
    });

    it('includes a slot\'s fallback content, which the slot (display: contents) has no box of its own to hold', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body><x-details id="d"></x-details></body>', (doc) => {
        doc.getElementById('d')!.attachShadow({ mode: 'open' }).innerHTML =
          '<div class="summary"><slot name="label"><span class="default-label">Details</span></slot></div>';
      });
      const nodes = flatten(parseHierarchyXml((await handle._dumpDomHierarchy())!));
      const summary = nodes.find((n) => n.attributes.get('webview-class') === 'summary')!;
      expect(summary.children.map((c) => c.attributes.get('text'))).toEqual(['Details']);
    });

    it('matches a custom element\'s tag.class and tag#id offline, as the page does', async () => {
      const { handle } = shadowPage();
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const count = (code: string) => findMatchingNodes(roots, parseSelectorString(code)!).length;
      expect(count('webview.locator("x-button#sign-in")')).toBe(1);
      expect(count('webview.locator("x-icon.icon-host")')).toBe(1);
      expect(await handle.locator('x-icon.icon-host').count()).toBe(1);
    });

    it('nests slotted content where it renders, so a pick on it is not taken by the component\'s own layers', async () => {
      // ion-content: a screen-sized background layer and a scroll container
      // whose slot holds the page's content.
      const { handle } = handleOn('<!DOCTYPE html><body data-rect="0,0,100,100">'
        + '<x-content id="c" data-rect="0,0,100,100"><h2 data-rect="10,10,90,20">Welcome</h2></x-content></body>', (doc) => {
        doc.getElementById('c')!.attachShadow({ mode: 'open' }).innerHTML =
          '<div id="background-content" data-rect="0,0,100,100"></div>'
          + '<main class="inner-scroll" data-rect="0,0,100,100"><slot></slot></main>';
      });
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const main = flatten(roots).find((n) => n.attributes.get('webview-tag') === 'main')!;
      expect(main.children.map((c) => c.attributes.get('webview-tag'))).toEqual(['h2']);
      const picked = pickNodeAt(roots, 50, 15)!.node;
      expect(picked.attributes.get('webview-tag')).toBe('h2');
      expect(generateSelectors(picked)[0]?.code).toBe('webview.getByRole("heading", { name: "Welcome" })');
    });

    it('a pick inside a button\'s own parts picks the button', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body data-rect="0,0,100,100">'
        + '<x-button id="b" data-rect="0,0,100,40">Sign in</x-button></body>', (doc) => {
        doc.getElementById('b')!.attachShadow({ mode: 'open' }).innerHTML =
          '<button class="button-native" data-rect="0,0,100,40"><span class="button-inner" data-rect="3,3,97,37"><slot></slot></span></button>';
      });
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const picked = pickNodeAt(roots, 50, 20)!.node;
      expect(picked.attributes.get('webview-tag')).toBe('button');
      expect(generateSelectors(picked)[0]?.code).toBe('webview.getByRole("button", { name: "Sign in" })');
    });

    it('never suggests an id from inside a shadow root', async () => {
      const { handle } = shadowPage();
      const nodes = flatten(parseHierarchyXml((await handle._dumpDomHierarchy())!));
      const lab = nodes.find((n) => n.attributes.get('webview-id') === 'lab' && n.attributes.get('text') === 'Volume')!;
      expect(generateSelectors(lab).map((g) => g.code)).not.toContain('webview.locator("#lab")');
      const light = nodes.find((n) => n.attributes.get('webview-id') === 'result')!;
      expect(generateSelectors(light).map((g) => g.code)).toContain('webview.locator("#result")');
    });

    it('a pick on a control inside another control stays on the control picked', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body data-rect="0,0,100,100">'
        + '<a href="/item" data-rect="0,0,100,40"><button data-rect="10,10,90,30">Buy</button></a>'
        + '<div role="button" aria-label="Card" data-rect="0,50,100,90"><input placeholder="Qty" data-rect="10,60,90,80"></div></body>');
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      expect(pickNodeAt(roots, 50, 20)!.node.attributes.get('webview-tag')).toBe('button');
      expect(pickNodeAt(roots, 50, 70)!.node.attributes.get('webview-tag')).toBe('input');
    });

    it('counts getByRole offline as the page does, without what assistive technology does not see', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body data-rect="0,0,100,100">'
        + '<div aria-hidden="true" data-rect="0,0,100,20"><button data-rect="0,0,50,20">Save</button></div>'
        + '<button data-rect="0,30,50,50">Save</button><button data-rect="0,60,50,80">Save</button></body>');
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const offline = findMatchingNodes(roots, parseSelectorString('webview.getByRole("button", { name: "Save" })')!);
      expect(offline).toHaveLength(2);
      expect(await handle.getByRole('button', { name: 'Save' }).count()).toBe(2);
    });

    it('reaches controls deep in a component tree', async () => {
      // An Ionic tabs + grid + form page nests a field's input well past 20
      // levels once each component's shadow internals are counted.
      const { handle } = handleOn('<!DOCTYPE html><body></body>', (doc) => {
        let parent: Element = doc.body;
        for (let i = 0; i < 12; i++) {
          const host = parent.appendChild(doc.createElement('x-wrap'));
          host.attachShadow({ mode: 'open' }).innerHTML = '<div class="inner"><slot></slot></div>';
          parent = host;
        }
        parent.appendChild(doc.createElement('input')).id = 'deep';
      });
      const nodes = flatten(parseHierarchyXml((await handle._dumpDomHierarchy())!));
      expect(nodes.some((n) => n.attributes.get('webview-id') === 'deep')).toBe(true);
    });
  });
});
