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

const SHADOW_PAGE = `<!DOCTYPE html><html><body>
  <button id="light">Light</button>
  <x-button id="sign-in">Sign in</x-button>
  <x-field id="nickname"></x-field>
  <span id="lab">Document label</span>
  <x-slider id="volume"></x-slider>
  <x-outer id="outer"></x-outer>
  <x-closed id="closed"></x-closed>
  <x-icon id="close" aria-label="Close"></x-icon>
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
  const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, 300);
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

    const field = handle.getByPlaceholder('Your nickname');
    await field.fill('jordan');
    expect(await field.inputValue()).toBe('jordan');
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

  it('keeps document order and results on a page without shadow roots', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body><div id="a"><p id="b"></p></div><p id="c"></p></body>');
    expect(await idsOf(handle, handle.locator('p, div')._finderAllJs)).toEqual(['a', 'b', 'c']);
  });

  it('still throws on an invalid selector, even on an empty page', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>');
    await expect(handle.locator('button[').count()).rejects.toThrow();
  });

  it('walks a very deep tree without overflowing the stack', async () => {
    const { handle } = handleOn('<!DOCTYPE html><body></body>', (doc) => {
      doc.body.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot>';
      let parent: Element = doc.body;
      for (let i = 0; i < 12_000; i++) parent = parent.appendChild(doc.createElement('div'));
      parent.appendChild(doc.createElement('p')).id = 'deep';
    });
    expect(await idsOf(handle, handle.locator('#deep')._finderAllJs)).toEqual(['deep']);
  }, 30_000);
});
