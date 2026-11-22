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
import type { WebViewLocator } from '../webview-locator.js';
import { isStrictModeViolation } from '../element-handle.js';
import { parseHierarchyXml, type HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { generateSelectors } from '../trace-viewer/components/selector-generation.js';
import { findMatchingNodes, parsedSelectorError, parseSelectorString } from '../trace-viewer/components/selector-matching.js';
import { pickNodeAt } from '../trace-viewer/components/pick-node.js';
import { withDomHelpers } from '../webview-dom-js.js';
import { disambiguateSelectors } from '../trace-viewer/components/selector-uniqueness.js';

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

  it('getByRole filters on an explicit empty name, as Playwright does', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button></button><button>X</button>'
      + '<div role="banner" aria-label="Y"></div><div role="banner">Y</div></body>');
    // A substring match: every name contains "". Exact, only the nameless.
    expect(await handle.getByRole('button', { name: '' }).count()).toBe(2);
    expect(await handle.getByRole('button', { name: '', exact: true }).count()).toBe(1);
    // A banner is not named by its content.
    expect(await handle.getByRole('banner', { name: '', exact: true }).count()).toBe(1);
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
        'webview.getByRole("textbox", { name: "Nickname" })',
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

    it('a pick on a switch\'s or tab\'s own parts picks the switch or tab', async () => {
      // ion-toggle (the host is the switch) and ion-tab-button (role="tab")
      // with an aria-hidden icon inside.
      const { handle } = handleOn('<!DOCTYPE html><body data-rect="0,0,100,100">'
        + '<x-toggle id="t" role="switch" data-rect="0,0,100,40">Email notifications</x-toggle>'
        + '<x-tab id="b" role="tab" data-rect="0,50,100,90"><x-icon aria-hidden="true" data-rect="40,55,60,75"></x-icon>Settings</x-tab></body>', (doc) => {
        doc.getElementById('t')!.attachShadow({ mode: 'open' }).innerHTML =
          '<label data-rect="0,0,100,40"><div class="label-text-wrapper" data-rect="0,0,70,40"><slot></slot></div>'
          + '<div class="toggle-inner" data-rect="70,0,100,40"></div></label>';
        doc.querySelector('x-icon')!.attachShadow({ mode: 'open' }).innerHTML = '<svg data-rect="40,55,60,75"><path data-rect="45,60,55,70"></path></svg>';
      });
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      for (const [x, y] of [[30, 20], [85, 20]]) {
        expect(generateSelectors(pickNodeAt(roots, x!, y!)!.node)[0]?.code).toBe('webview.getByRole("switch", { name: "Email notifications" })');
      }
      expect(pickNodeAt(roots, 50, 65)!.node.attributes.get('webview-id')).toBe('b');
    });

    it('suggests no role locator for an element assistive technology does not see', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body><button aria-hidden="true">Hidden</button></body>');
      const button = parseHierarchyXml((await handle._dumpDomHierarchy())!)[0]!.children[0]!;
      expect(generateSelectors(button).map((g) => g.code).filter((c) => c.includes('getByRole'))).toEqual([]);
    });
  });
});

/**
 * Roles, accessible names and labels as Playwright computes them
 * (PILOT-1361, PILOT-700). Each expectation is what Playwright's
 * page.getByRole / page.getByLabel finds on the same page.
 */
describe('WebView getByRole and getByLabel match as Playwright\'s do (PILOT-1361, PILOT-700)', () => {
  // ion-input (Ionic 8/9): a scoped component whose <label> wraps the input,
  // which also points aria-labelledby at a copy of the label text.
  const ION_LOGIN = '<!DOCTYPE html><body>'
    + '<ion-input id="email-host"><label class="input-wrapper" for="ion-input-0"><div class="label-text">Email</div>'
    + '<div class="native-wrapper"><input class="native-input" id="ion-input-0" type="email" placeholder="you@company.com"'
    + ' aria-labelledby="ion-input-0-lbl"></div></label><span id="ion-input-0-lbl" hidden>Email</span></ion-input>'
    + '<ion-input id="pw-host"><label><span>Password</span><input id="pw" type="password"></label></ion-input>'
    + '<button id="sign-in">Sign in</button><button id="sign-in-google">Sign in with Google</button></body>';

  it('finds an Ionic text field by the ARIA role "textbox" and its label', async () => {
    const { handle } = handleOn(ION_LOGIN);
    expect(await idsOf(handle, handle.getByRole('textbox')._finderAllJs)).toEqual(['ion-input-0', 'pw']);
    expect(await idsOf(handle, handle.getByRole('textbox', { name: 'Email' })._finderAllJs)).toEqual(['ion-input-0']);
    expect(await idsOf(handle, handle.getByLabel('Email')._finderAllJs)).toEqual(['ion-input-0']);
    expect(await idsOf(handle, handle.getByLabel('Password')._finderAllJs)).toEqual(['pw']);
    // Tapsmith's own name for the role still works.
    expect(await handle.getByRole('textfield', { name: 'Password' }).count()).toBe(1);
  });

  it('matches a name or label as a case-insensitive substring, whole with exact, or by RegExp', async () => {
    const { handle } = handleOn(ION_LOGIN);
    expect(await handle.getByRole('button', { name: 'sign in' }).count()).toBe(2);
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Sign in', exact: true })._finderAllJs)).toEqual(['sign-in']);
    expect(await handle.getByRole('button', { name: 'sign in', exact: true }).count()).toBe(0);
    expect(await idsOf(handle, handle.getByRole('button', { name: /google$/i })._finderAllJs)).toEqual(['sign-in-google']);
    expect(await handle.getByLabel('email').count()).toBe(1);
    expect(await handle.getByLabel('email', { exact: true }).count()).toBe(0);
    expect(await idsOf(handle, handle.getByLabel(/^pass/i)._finderAllJs)).toEqual(['pw']);
    // A global RegExp keeps no state between matches.
    expect(await handle.getByRole('button', { name: /Sign/g }).count()).toBe(2);
  });

  it('splits text fields into textbox, searchbox and spinbutton, as ARIA does', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><input id="t"><input id="p" type="password"><textarea id="a"></textarea>'
      + '<input id="s" type="search"><input id="n" type="number"><input id="c" type="checkbox"><div id="r" role="textbox"></div>'
      + '<input id="h" type="hidden"></body>');
    expect(await idsOf(handle, handle.getByRole('textbox')._finderAllJs)).toEqual(['t', 'p', 'a', 'r']);
    expect(await idsOf(handle, handle.getByRole('searchbox')._finderAllJs)).toEqual(['s']);
    expect(await idsOf(handle, handle.getByRole('spinbutton')._finderAllJs)).toEqual(['n']);
    expect(await idsOf(handle, handle.getByRole('textfield')._finderAllJs)).toEqual(['t', 'p', 'a', 's', 'n', 'r']);
    // Role names are case-insensitive, as Playwright lowercases them.
    expect(await handle.getByRole('TextBox').count()).toBe(4);
  });

  it('takes an element\'s role attribute over its tag\'s role', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="b" role="tab">One</button><button id="plain">Two</button>'
      + '<ul role="none"><li id="pres">A</li></ul><ol><li id="item">B</li></ol><img id="deco" alt=""><img id="logo" alt="Logo"></body>');
    expect(await idsOf(handle, handle.getByRole('tab')._finderAllJs)).toEqual(['b']);
    expect(await idsOf(handle, handle.getByRole('button')._finderAllJs)).toEqual(['plain']);
    // A presentational list's items are presentational too.
    expect(await idsOf(handle, handle.getByRole('listitem')._finderAllJs)).toEqual(['item']);
    expect(await idsOf(handle, handle.getByRole('img')._finderAllJs)).toEqual(['logo']);
    expect(await idsOf(handle, handle.getByRole('image', { name: 'Logo' })._finderAllJs)).toEqual(['logo']);
  });

  it('computes the accessible name in Playwright\'s order', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="tip" title="Tooltip">Save</button>'
      + '<button id="fallback" aria-labelledby="empty">Fallback</button><span id="empty"></span>'
      + '<input id="titled" title="Notes" placeholder="Write here"><input id="ph" placeholder="Only placeholder">'
      + '<h2 id="hd" title="H">Heading text</h2><div role="dialog" id="dlg">Dialog content</div>'
      + '<input id="sub" type="submit"><button id="blocks"><div>Two</div><div>Words</div></button></body>');
    // Content outranks a title for a button; a title is the fallback.
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Save' })._finderAllJs)).toEqual(['tip']);
    expect(await handle.getByRole('button', { name: 'Tooltip' }).count()).toBe(0);
    expect(await idsOf(handle, handle.getByRole('heading', { name: 'Heading text' })._finderAllJs)).toEqual(['hd']);
    // aria-labelledby whose target has no text falls through to the content.
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Fallback' })._finderAllJs)).toEqual(['fallback']);
    // A field's title outranks its placeholder; a placeholder is the last resort.
    expect(await idsOf(handle, handle.getByRole('textbox', { name: 'Notes' })._finderAllJs)).toEqual(['titled']);
    expect(await handle.getByRole('textbox', { name: 'Write here' }).count()).toBe(0);
    expect(await idsOf(handle, handle.getByRole('textbox', { name: 'Only placeholder' })._finderAllJs)).toEqual(['ph']);
    // A dialog is not named by its content.
    expect(await handle.getByRole('dialog', { name: 'Dialog content' }).count()).toBe(0);
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Submit' })._finderAllJs)).toEqual(['sub']);
    // Block children are separate words.
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Two Words', exact: true })._finderAllJs)).toEqual(['blocks']);
  });

  it('getByLabel reads <label for>, a wrapping <label>, aria-labelledby and aria-label', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><label for="first">First name</label><input id="first">'
      + '<label>Last <input id="last"><input id="second"></label><span id="lab">Volume</span><div id="vol" role="slider" aria-labelledby="lab"></div>'
      + '<div id="card" aria-label="Card">x</div><select id="pick"><option>One</option></select><label for="pick">Pick one</label>'
      + '<div id="nolabel">First name</div><input id="ws" aria-label="   "><label for="ws">Spaces</label></body>');
    expect(await idsOf(handle, handle.getByLabel('First name')._finderAllJs)).toEqual(['first']);
    // A wrapping label labels its first control only.
    expect(await idsOf(handle, handle.getByLabel('Last')._finderAllJs)).toEqual(['last']);
    expect(await idsOf(handle, handle.getByLabel('Volume')._finderAllJs)).toEqual(['vol']);
    // aria-label labels any element; a <label> only a form control.
    expect(await idsOf(handle, handle.getByLabel('Card')._finderAllJs)).toEqual(['card']);
    expect(await idsOf(handle, handle.getByLabel('Pick one')._finderAllJs)).toEqual(['pick']);
    // A blank aria-label falls through to the <label>.
    expect(await idsOf(handle, handle.getByLabel('Spaces')._finderAllJs)).toEqual(['ws']);
  });

  it('includeHidden finds what assistive technology does not see', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="v">Shown</button><button id="h" style="display:none">Gone</button>'
      + '<button id="ah" aria-hidden="true">AH</button><input type="checkbox" id="cb" style="display:none"><label for="cb">Hidden box</label></body>');
    expect(await idsOf(handle, handle.getByRole('button')._finderAllJs)).toEqual(['v']);
    expect(await idsOf(handle, handle.getByRole('button', { includeHidden: true })._finderAllJs)).toEqual(['v', 'h', 'ah']);
    expect(await handle.getByRole('checkbox', { name: 'Hidden box' }).count()).toBe(0);
    expect(await handle.getByRole('checkbox', { name: 'Hidden box', includeHidden: true }).count()).toBe(1);
    // getByLabel does not filter hidden elements, as in Playwright.
    expect(await handle.getByLabel('Hidden box').count()).toBe(1);
  });

  it('treats aria-hidden case-insensitively everywhere, as Playwright does', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="v">Shown</button><button id="ah" aria-hidden="TRUE">AH</button></body>');
    expect(await idsOf(handle, handle.getByRole('button')._finderAllJs)).toEqual(['v']);
    expect(await idsOf(handle, handle.getByRole('button', { includeHidden: true })._finderAllJs)).toEqual(['v', 'ah']);
    expect(await handle._dumpDomHierarchy()).toMatch(/webview-id="ah"[^>]*webview-a11y-hidden="true"/);
  });

  it('gives an unscoped <th> the role Playwright gives it from its neighbouring cells', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><table><tr><th id="c1">Plan</th><th id="c2">Price</th></tr>'
      + '<tr><th id="r1">Basic</th><td>$1</td></tr><tr><th id="r2" scope="col">Pro</th><td>$2</td></tr></table>'
      + '<table><tr><th id="only">Alone</th></tr></table></body>');
    expect(await idsOf(handle, handle.getByRole('columnheader')._finderAllJs)).toEqual(['c1', 'c2', 'r2']);
    expect(await idsOf(handle, handle.getByRole('rowheader', { name: 'Basic' })._finderAllJs)).toEqual(['r1']);
    // The only cell of a one-row table heads nothing.
    expect(await handle.getByRole('columnheader', { name: 'Alone' }).count()).toBe(0);
  });

  it('never puts a password\'s value into a name, while other fields\' values still name', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><label id="pl">PIN <input id="pin" type="password" value="hunter2"></label>'
      + '<button id="go" aria-labelledby="pl">Go</button><label id="ql">Qty <input id="qty" value="3"></label>'
      + '<button id="buy" aria-labelledby="ql">Buy</button></body>');
    expect(await idsOf(handle, handle.getByRole('button', { name: 'PIN', exact: true })._finderAllJs)).toEqual(['go']);
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Qty 3', exact: true })._finderAllJs)).toEqual(['buy']);
    expect(await idsOf(handle, handle.getByRole('textbox', { name: 'PIN' })._finderAllJs)).toEqual(['pin']);
    expect(await handle._dumpDomHierarchy()).not.toContain('hunter2');
  });

  it('strips soft hyphens and zero-width spaces before trimming, as Playwright normalises text', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="co" aria-label="Check\u00adout">x</button>'
      + '<button id="zw" aria-label="\u200b Save">y</button></body>');
    expect(await idsOf(handle, handle.getByLabel('Checkout', { exact: true })._finderAllJs)).toEqual(['co']);
    expect(await idsOf(handle, handle.getByRole('button', { name: 'Save', exact: true })._finderAllJs)).toEqual(['zw']);
  });

  it('keeps a RegExp\'s sticky flag, anchoring every test at the start', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><button id="s" aria-label="Save">a</button>'
      + '<button id="q" aria-label="Quick Save">b</button></body>');
    const sticky = handle.getByLabel(/Save/y);
    expect(await idsOf(handle, sticky._finderAllJs)).toEqual(['s']);
    expect(await idsOf(handle, sticky._finderAllJs)).toEqual(['s']);
    expect(await handle.getByRole('button', { name: /Save/y }).count()).toBe(1);
  });

  it('suggests, in a strict-mode error, the label getByLabel reads, and only one that tells the matches apart', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><span id="d">Save draft</span>'
      + '<button aria-label="Save" aria-labelledby="d">a</button><button aria-label="Save">b</button>'
      + '<button aria-label="Same">c</button><button aria-label="Same">d</button></body>');
    const err = String(await handle.getByRole('button', { name: 'Sa' }).click().catch((e: unknown) => e));
    expect(err).toContain('webview.getByLabel("Save draft", { exact: true })');
    expect(err).toContain('webview.getByLabel("Save", { exact: true })');
    expect(err).not.toContain('webview.getByLabel("Same"');
  });

  it('rejects a name that is only an inherited property, such as "constructor", as an unknown role', () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>');
    for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(() => handle.getByRole(role), role).toThrow(/unknown role/);
      expect(parsedSelectorError(parseSelectorString(`webview.getByRole("${role}")`)!), role).toMatch(/unknown role/);
    }
  });

  it('throws at once on a role no element can have, an option it does not take, or a bad name', () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>');
    expect(() => handle.getByRole('textfeild')).toThrow(/unknown role "textfeild".*textbox.*textfield \(textbox, searchbox, spinbutton\)/);
    expect(() => handle.getByRole('button', { checked: true } as never)).toThrow(/webview\.getByRole\(\): unknown option "checked"/);
    expect(() => handle.getByRole('button', { name: 3 } as never)).toThrow(TypeError);
    expect(() => handle.getByLabel(undefined as never)).toThrow(TypeError);
    expect(() => handle.getByLabel('x', { name: 'y' } as never)).toThrow(/unknown option "name"/);
  });

  it('describes the locator with its options', () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>');
    expect(handle.getByRole('textbox', { name: 'Email' })._selector).toBe('role=textbox[name=Email]');
    expect(handle.getByRole('textbox', { name: 'Email', exact: true })._selector).toBe('role=textbox[name="Email"]');
    expect(handle.getByRole('button', { name: /sign/i, includeHidden: true })._selector).toBe('role=button[name=/sign/i][include-hidden]');
    expect(handle.getByLabel(/mail/)._selector).toBe('label=/mail/');
  });

  describe('the Playground agrees with the page', () => {
    function flatten(nodes: HierarchyNode[]): HierarchyNode[] {
      return nodes.flatMap((n) => [n, ...flatten(n.children)]);
    }
    const count = (roots: HierarchyNode[], code: string) => findMatchingNodes(roots, parseSelectorString(code)!).length;
    // A box of its own for every displayed element: the Playground counts
    // nodes with the same box and text once.
    const distinctBoxes = (doc: Document) => {
      doc.body.querySelectorAll('*').forEach((el, i) => {
        if ((el as HTMLElement).style.display !== 'none') el.setAttribute('data-rect', `0,${i * 10},100,${i * 10 + 9}`);
      });
    };

    it('counts every role, name and label locator as the page does', async () => {
      const { handle } = handleOn(ION_LOGIN.replace('</body>', '<input id="q" type="search" aria-label="Search">'
        + '<input type="checkbox" id="cb" style="display:none"><label for="cb">Hidden box</label></body>'), distinctBoxes);
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const cases: [string, WebViewLocator][] = [
        ['webview.getByRole("textbox")', handle.getByRole('textbox')],
        ['webview.getByRole("textfield")', handle.getByRole('textfield')],
        ['webview.getByRole("searchbox")', handle.getByRole('searchbox')],
        ['webview.getByRole("textbox", { name: "Email" })', handle.getByRole('textbox', { name: 'Email' })],
        ['webview.getByRole("textbox", { name: "email", exact: true })', handle.getByRole('textbox', { name: 'email', exact: true })],
        ['webview.getByRole("button", { name: "sign in" })', handle.getByRole('button', { name: 'sign in' })],
        ['webview.getByRole("button", { name: "Sign in", exact: true })', handle.getByRole('button', { name: 'Sign in', exact: true })],
        ['webview.getByRole("button", { name: /google/i })', handle.getByRole('button', { name: /google/i })],
        // (includeHidden is left out: the dump has no node for an element
        // with no box, which includeHidden finds on the page.)
        ['webview.getByRole("checkbox")', handle.getByRole('checkbox')],
        ['webview.getByLabel("Email")', handle.getByLabel('Email')],
        ['webview.getByLabel("Password", { exact: true })', handle.getByLabel('Password', { exact: true })],
        ['webview.getByLabel(/^pass/i)', handle.getByLabel(/^pass/i)],
        ['webview.getByLabel("Search")', handle.getByLabel('Search')],
      ];
      for (const [code, locator] of cases) {
        expect(count(roots, code), code).toBe(await locator.count());
      }
    });

    it('suggests getByRole with the ARIA role and getByLabel from a <label>, pinned with exact when ambiguous', async () => {
      const { handle } = handleOn(ION_LOGIN, distinctBoxes);
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      const nodes = flatten(roots);
      const email = nodes.find((n) => n.attributes.get('webview-id') === 'ion-input-0')!;
      const codes = generateSelectors(email).map((g) => g.code);
      expect(codes[0]).toBe('webview.getByRole("textbox", { name: "Email" })');
      expect(codes).toContain('webview.getByLabel("Email")');
      const signIn = nodes.find((n) => n.attributes.get('webview-id') === 'sign-in')!;
      const [best] = disambiguateSelectors(roots, signIn, generateSelectors(signIn));
      expect(best!.code).toBe('webview.getByRole("button", { name: "Sign in", exact: true })');
    });

    it('tests a getByLabel RegExp against the raw label text, as the page does', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body><label for="e">\n  Email\n</label><input id="e"></body>', distinctBoxes);
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      for (const [code, locator] of [
        ['webview.getByLabel(/^Email$/)', handle.getByLabel(/^Email$/)],
        ['webview.getByLabel(/^\\s+Email/)', handle.getByLabel(/^\s+Email/)],
        ['webview.getByLabel("Email", { exact: true })', handle.getByLabel('Email', { exact: true })],
      ] as const) {
        expect(count(roots, code), code).toBe(await locator.count());
      }
      expect(await handle.getByLabel(/^\s+Email/).count()).toBe(1);
      const input = flatten(roots).find((n) => n.attributes.get('webview-id') === 'e')!;
      expect(generateSelectors(input).map((g) => g.code)).toContain('webview.getByLabel("Email")');
    });

    it('reads each element\'s style once while naming every element, however deep the names', async () => {
      // A list whose rows are links named by their content, deep in the page:
      // every name walks its row, and every node of it its ancestors.
      const row = (i: number) => `<li><a href="#${i}"><h2>Item ${i}</h2><p>Detail <span>${i}</span></p><button>Open</button></a></li>`;
      const nest = (html: string, depth: number): string => depth === 0 ? html : `<div>${nest(html, depth - 1)}</div>`;
      const { handle, window } = handleOn(`<!DOCTYPE html><body>${nest(`<ul>${Array.from({ length: 30 }, (_, i) => row(i)).join('')}</ul>`, 15)}</body>`);
      const elements = window.document.querySelectorAll('*').length;
      const original = window.getComputedStyle.bind(window);
      let calls = 0;
      window.getComputedStyle = ((el: Element, pseudo?: string | null) => { calls++; return original(el, pseudo); }) as typeof window.getComputedStyle;
      // Every element's name, as the DOM dump computes them.
      const names = await handle._evaluate(withDomHelpers('__ts.all(document).map((el) => __ts.name(el))')) as string[];
      expect(names).toContain('Item 3 Detail 3 Open');
      expect(calls).toBeLessThanOrEqual(elements);
    });

    it('counts includeHidden names as the page does, hidden content included', async () => {
      const { handle } = handleOn('<!DOCTYPE html><body><button id="ah" aria-hidden="true">AH</button>'
        + '<button id="icon"><span aria-hidden="true">close</span>Save</button></body>', distinctBoxes);
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      for (const [code, locator] of [
        ['webview.getByRole("button", { name: "AH", includeHidden: true })', handle.getByRole('button', { name: 'AH', includeHidden: true })],
        ['webview.getByRole("button", { name: "Save", exact: true, includeHidden: true })', handle.getByRole('button', { name: 'Save', exact: true, includeHidden: true })],
        ['webview.getByRole("button", { name: "close Save", exact: true, includeHidden: true })', handle.getByRole('button', { name: 'close Save', exact: true, includeHidden: true })],
        ['webview.getByRole("button", { name: "Save", exact: true })', handle.getByRole('button', { name: 'Save', exact: true })],
      ] as const) {
        expect(count(roots, code), code).toBe(await locator.count());
      }
    });

    it('shows the error the page throws for a role webview.getByRole rejects', () => {
      const { handle } = handleOn('<!DOCTYPE html><body></body>');
      const thrown = (() => { try { handle.getByRole('textfeild'); } catch (e) { return (e as Error).message; } return null; })();
      expect(thrown).not.toBeNull();
      expect(parsedSelectorError(parseSelectorString('webview.getByRole("textfeild")')!)).toBe(thrown);
      // An old dump's role attribute that is not an ARIA role is not suggested.
      const roots = parseHierarchyXml('<webview.div bounds="[0,0][10,10]" class="webview.div" webview-tag="div"'
        + ' webview-role="toast" text="Saved" webview="true" />');
      expect(generateSelectors(roots[0]!).map((g) => g.code).filter((c) => c.includes('getByRole'))).toEqual([]);
    });

    it('agrees on soft hyphens, full-length names and labels, and an old dump\'s input types', async () => {
      const long = `${'A'.repeat(200)}Z`;
      const { handle } = handleOn(`<!DOCTYPE html><body><button id="co" aria-label="Check\u00adout">x</button>`
        + `<button id="long">${long}</button><label for="f">${long}</label><input id="f">`
        + '<button id="s1">One</button><button id="s2">One</button></body>');
      // Every element here has the same 10×10 box: two buttons with the same
      // box and text are still two to the page.
      const roots = parseHierarchyXml((await handle._dumpDomHierarchy())!);
      for (const [code, locator] of [
        ['webview.getByLabel("Checkout")', handle.getByLabel('Checkout')],
        ['webview.getByRole("button", { name: "Checkout", exact: true })', handle.getByRole('button', { name: 'Checkout', exact: true })],
        [`webview.getByRole("button", { name: "${long}", exact: true })`, handle.getByRole('button', { name: long, exact: true })],
        [`webview.getByRole("button", { name: "${'A'.repeat(200)}", exact: true })`, handle.getByRole('button', { name: 'A'.repeat(200), exact: true })],
        ['webview.getByLabel(/Z$/)', handle.getByLabel(/Z$/)],
        ['webview.getByRole("button", { name: "One" })', handle.getByRole('button', { name: 'One' })],
      ] as const) {
        expect(count(roots, code), code).toBe(await locator.count());
      }
      expect(await handle.getByLabel('Checkout').count()).toBe(1);
      expect(await handle.getByRole('button', { name: 'One' }).count()).toBe(2);
      // A dump from before PILOT-1361 suggests and matches an input's type-given role alike.
      const old = parseHierarchyXml('<webview.input bounds="[0,0][10,10]" class="webview.input" webview-tag="input"'
        + ' webview-type="checkbox" webview="true" />');
      const suggested = generateSelectors(old[0]!).map((g) => g.code).filter((c) => c.includes('getByRole'));
      expect(suggested[0]).toMatch(/^webview\.getByRole\("checkbox"/);
      expect(count(old, suggested[0]!)).toBe(1);
    });

    it('reads a dump from before PILOT-1361', () => {
      const roots = parseHierarchyXml('<webview.input bounds="[0,0][10,10]" class="webview.input" webview-tag="input"'
        + ' content-desc="Email" webview-aria-label="" webview="true" />');
      expect(count(roots, 'webview.getByRole("textbox", { name: "Email" })')).toBe(1);
      expect(count(roots, 'webview.getByRole("textfield")')).toBe(1);
      expect(count(roots, 'webview.getByLabel("Email")')).toBe(0);
    });
  });
});
