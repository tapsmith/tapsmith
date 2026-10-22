/**
 * Strict mode for WebView locators (PILOT-227).
 *
 * A webview.getBy* locator that resolves to more than one DOM element must
 * throw a StrictModeViolationError on actions, single-element queries, and
 * positive assertions — never silently act on the first match. Positional
 * chains (.first()/.nth()/.last()), count()/all(), and absence checks are
 * exempt, mirroring native locators.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { WebViewHandle, type WebViewLocatorProbe } from '../webview-handle.js';
import { isStrictModeViolation } from '../element-handle.js';
import { expect as texpect } from '../expect.js';

const TIMEOUT_MS = 400;

interface ProbeMatch {
  tag?: string
  id?: string
  testId?: string
  ariaLabel?: string
  role?: string
  text?: string
  /** Whether the element has no child elements (the elements getByText finds). */
  leaf?: boolean
  visible?: boolean
}

function probeOf(matches: ProbeMatch[], nthIndex = 0): WebViewLocatorProbe {
  const idx = nthIndex < 0 ? matches.length + nthIndex : nthIndex;
  const target = matches[idx];
  return {
    count: matches.length,
    anyVisible: matches.some((m) => m.visible ?? true),
    targetVisible: target ? (target.visible ?? true) : false,
    sample: matches.slice(0, 10).map((m) => ({
      tag: m.tag ?? 'div',
      id: m.id ?? '',
      testId: m.testId ?? '',
      ariaLabel: m.ariaLabel ?? '',
      role: m.role ?? '',
      text: m.text ?? '',
      leaf: m.leaf ?? true,
    })),
  };
}

/** WebViewHandle with the CDP layer stubbed out: probes come from `matches`
 * (including the target-value read for assertion value ticks, answered with
 * `evaluateResult`), other evaluates are recorded and answered with
 * `evaluateResult` too. */
function makeHandle(matches: ProbeMatch[], evaluateResult: unknown = undefined) {
  const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, TIMEOUT_MS);
  const evaluated: string[] = [];
  vi.spyOn(handle, '_probeLocator').mockImplementation(async (loc, _timeoutMs, opts) => {
    const probe = probeOf(matches, loc._nthIndex ?? 0);
    if (opts?.valueJs) {
      // Mirror the in-page target derivation: nth-aware, first by default.
      const n = loc._nthIndex ?? 0;
      const idx = n < 0 ? matches.length + n : n;
      const found = idx >= 0 && idx < matches.length;
      probe.target = found ? { found, value: evaluateResult } : { found: false };
    }
    return probe;
  });
  vi.spyOn(handle, '_evaluate').mockImplementation(async (expression: string) => {
    evaluated.push(expression);
    return evaluateResult;
  });
  return { handle, evaluated };
}

describe('WebView strict mode (PILOT-227)', () => {
  describe('actions', () => {
    it('click() on a locator resolving to 2 elements throws a StrictModeViolationError', async () => {
      const { handle, evaluated } = makeHandle([
        { tag: 'p', text: 'Sign in to continue' },
        { tag: 'button', text: 'Sign in', testId: 'login' },
      ]);
      const err = await handle.getByText('Sign in').click().catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
      expect((err as Error).message).toContain('strict mode violation: "text=Sign in" resolved to 2 elements');
      expect((err as Error).message).toContain('1) p "Sign in to continue"');
      expect((err as Error).message).toContain('2) button "Sign in"');
      // No click was dispatched to the page.
      expect(evaluated.some((e) => e.includes('.click()'))).toBe(false);
    });

    it('throws immediately on ambiguity instead of waiting out the timeout', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const start = Date.now();
      await expect(handle.getByText('A').click()).rejects.toThrow('strict mode violation');
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('click() proceeds with exactly one match', async () => {
      const { handle, evaluated } = makeHandle([{ tag: 'button', text: 'Sign in' }]);
      await handle.getByText('Sign in').click();
      expect(evaluated.some((e) => e.includes('.click()'))).toBe(true);
    });

    it('suggests unambiguous webview selectors in the violation message', async () => {
      const { handle } = makeHandle([
        { tag: 'button', text: 'Save', testId: 'save-primary' },
        { tag: 'button', text: 'Save', id: 'save2' },
        { tag: 'button', ariaLabel: 'Save draft' },
        { tag: 'span', text: 'Save' },
      ]);
      const err = await handle.getByText('Save').click().catch((e: unknown) => e);
      const message = (err as Error).message;
      expect(message).toContain('aka webview.getByTestId("save-primary")');
      expect(message).toContain('aka webview.locator("#save2")');
      expect(message).toContain('aka webview.getByLabel("Save draft")');
      expect(message).toContain('aka webview.getByText("Save", { exact: true })');
    });

    it('suggests copy-paste-safe literals, and a long text as a substring prefix (PILOT-659)', async () => {
      const long = 'Terms and conditions apply to every order placed through this store';
      const { handle } = makeHandle([
        { tag: 'button', ariaLabel: 'Pay\u00A0now' },
        { tag: 'p', text: long },
      ]);
      const err = await handle.locator('*').click().catch((e: unknown) => e);
      const message = (err as Error).message;
      expect(message).toContain('aka webview.getByLabel("Pay\\u00A0now")');
      expect(message).toContain(`aka webview.getByText("${long.slice(0, 60)}")`);
      expect(message).not.toContain('…", { exact: true })');
    });

    it('suggests getByText only for a leaf element, which getByText can find (PILOT-666)', async () => {
      const { handle } = makeHandle([
        { tag: 'div', text: 'Email', leaf: false },
        { tag: 'label', text: 'Email' },
      ]);
      const err = await handle.locator('.form-group, label').click().catch((e: unknown) => e);
      const lines = (err as Error).message.split('\n');
      expect(lines.find((l) => l.includes('1) div'))).not.toContain(' aka ');
      expect(lines.find((l) => l.includes('2) label'))).toContain('aka webview.getByText("Email", { exact: true })');
    });

    it('suggests an id that is not a CSS identifier as an attribute selector (PILOT-666)', async () => {
      const { handle } = makeHandle([
        { tag: 'div', id: '1st' },
        { tag: 'div', id: 'order.total' },
        { tag: 'div', id: 'say "hi"' },
        { tag: 'div', id: 'save-2_b' },
      ]);
      const message = ((await handle.locator('div').click().catch((e: unknown) => e)) as Error).message;
      expect(message).toContain('aka webview.locator("[id=\\"1st\\"]")');
      expect(message).toContain('aka webview.locator("[id=\\"order.total\\"]")');
      expect(message).toContain('aka webview.locator("[id=\\"say \\\\\\"hi\\\\\\"\\"]")');
      expect(message).toContain('aka webview.locator("#save-2_b")');
    });

    it('reports the total match count when more elements match than are sampled', async () => {
      const matches = Array.from({ length: 14 }, (_, i) => ({ tag: 'li', text: `Row ${i}` }));
      const { handle } = makeHandle(matches);
      const err = await handle.locator('li').click().catch((e: unknown) => e);
      expect((err as Error).message).toContain('resolved to 14 elements');
      expect((err as Error).message).toContain('… and 4 more');
    });

    it('fill() and textContent() are strict too', async () => {
      const { handle } = makeHandle([{ text: 'X' }, { text: 'X' }]);
      await expect(handle.getByText('X').fill('v')).rejects.toThrow('strict mode violation');
      await expect(handle.getByText('X').textContent()).rejects.toThrow('strict mode violation');
    });

    it('times out with the locator description when nothing matches', async () => {
      const { handle } = makeHandle([]);
      await expect(handle.getByText('Missing').click()).rejects.toThrow(
        `Timed out waiting for "text=Missing" in WebView (${TIMEOUT_MS}ms)`,
      );
    });
  });

  describe('positional chains are exempt', () => {
    it('.first().click() acts on index 0 of an ambiguous match set', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').first().click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('[0]');
    });

    it('.nth(1) addresses the second match', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').nth(1).click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('[1]');
    });

    it('.last() addresses the final match via a negative index', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').last().click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('els.length - 1');
    });

    it('.nth(2) waits and times out when fewer elements match', async () => {
      const { handle } = makeHandle([{ text: 'A' }]);
      await expect(handle.getByText('A').nth(2).click()).rejects.toThrow(
        `Timed out waiting for "text=A >> nth=2" in WebView (${TIMEOUT_MS}ms)`,
      );
    });

    it('nth() rejects non-integer indices', () => {
      const { handle } = makeHandle([]);
      expect(() => handle.getByText('A').nth(1.5)).toThrow('nth(1.5): index must be an integer');
    });

    it('chained positional narrowing composes instead of re-indexing the original set', () => {
      const { handle } = makeHandle([]);
      const chained = handle.getByText('A').first().nth(1);
      expect(chained._selector).toBe('text=A >> nth=0 >> nth=1');
      // The chained locator's base set is the single already-narrowed element,
      // so nth(1) can never resolve to the second element of the ORIGINAL set.
      expect(chained._finderAllJs).toContain('(el) => el ? [el] : []');
      // Unchained narrowing keeps the raw match set as its base.
      expect(handle.getByText('A').nth(1)._finderAllJs).not.toContain('(el) => el ? [el] : []');
    });

    it('getByRole treats an explicit empty accessible name as a filter, not "no filter"', () => {
      const { handle } = makeHandle([]);
      // Mapped role: goes through the accessible-name computation.
      expect(handle.getByRole('button', { name: '' })._finderAllJs).toContain('accessibleName');
      // Unmapped role: filters on aria-label/text.
      expect(handle.getByRole('banner', { name: '' })._finderAllJs).toContain('aria-label');
    });
  });

  describe('count() and all() are exempt', () => {
    it('count() returns the full match count without throwing', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }, { text: 'A' }]);
      expect(await handle.getByText('A').count()).toBe(3);
    });

    it('count() on a positional locator reflects whether the index resolves', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      expect(await handle.getByText('A').nth(1).count()).toBe(1);
      expect(await handle.getByText('A').nth(5).count()).toBe(0);
    });

    it('all() returns one positionally-narrowed locator per match', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const all = await handle.getByText('A').all();
      expect(all.map((l) => l._nthIndex)).toEqual([0, 1]);
      expect(all.map((l) => l._selector)).toEqual(['text=A >> nth=0', 'text=A >> nth=1']);
    });
  });

  describe('isVisible()', () => {
    it('throws on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(handle.getByText('A').isVisible()).rejects.toThrow('strict mode violation');
    });

    it('returns the target visibility for positional locators', async () => {
      const { handle } = makeHandle([{ text: 'A', visible: false }, { text: 'A', visible: true }]);
      expect(await handle.getByText('A').first().isVisible()).toBe(false);
      expect(await handle.getByText('A').last().isVisible()).toBe(true);
    });

    it('returns false when nothing matches', async () => {
      const { handle } = makeHandle([]);
      expect(await handle.getByText('A').isVisible()).toBe(false);
    });
  });

  describe('isHidden(selector) — string-selector form', () => {
    it('is the negation of isVisible(selector)', async () => {
      const hiddenOrAbsent = makeHandle([], false).handle;
      expect(await hiddenOrAbsent.isHidden('.banner')).toBe(true);
      expect(await hiddenOrAbsent.isVisible('.banner')).toBe(false);
      const visible = makeHandle([], true).handle;
      expect(await visible.isHidden('.banner')).toBe(false);
    });

    it('both string forms are traced under their own names, like the locator forms (review follow-up)', async () => {
      const { handle } = makeHandle([], true);
      const traced = vi.spyOn(handle as unknown as { _traced: (action: string) => unknown }, '_traced');
      await handle.isVisible('.banner');
      await handle.isHidden('.banner');
      expect(traced.mock.calls.map((c) => c[0])).toEqual(['isVisible', 'isHidden']);
    });
  });

  describe('isHidden()', () => {
    it('is the negation of isVisible for a single match', async () => {
      const { handle } = makeHandle([{ text: 'A', visible: false }]);
      expect(await handle.getByText('A').isHidden()).toBe(true);
      expect(await handle.getByText('A').isVisible()).toBe(false);
    });

    it('returns true when nothing matches', async () => {
      const { handle } = makeHandle([]);
      expect(await handle.getByText('A').isHidden()).toBe(true);
    });

    it('is strict: an ambiguous locator throws rather than reporting the first match', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(handle.getByText('A').isHidden()).rejects.toThrow('strict mode violation');
    });

    it('honours positional narrowing', async () => {
      const { handle } = makeHandle([{ text: 'A', visible: false }, { text: 'A', visible: true }]);
      expect(await handle.getByText('A').first().isHidden()).toBe(true);
      expect(await handle.getByText('A').last().isHidden()).toBe(false);
    });

    it('both probes are traced under their own names, like every other locator method (review follow-up)', async () => {
      const { handle } = makeHandle([{ text: 'A', visible: true }]);
      const traced = vi.spyOn(handle as unknown as { _traced: (action: string) => unknown }, '_traced');
      await handle.getByText('A').isVisible();
      await handle.getByText('A').isHidden();
      expect(traced.mock.calls.map((c) => c[0])).toEqual(['isVisible', 'isHidden']);
    });
  });

  describe('assertions', () => {
    it('toBeVisible() throws a strict violation on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const err = await texpect(handle.getByText('A')).toBeVisible().catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
    });

    it('toBeVisible() passes for a positional locator over an ambiguous set', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await texpect(handle.getByText('A').first()).toBeVisible();
    });

    it('toBeHidden() is an absence check — evaluates over all matches without throwing', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: false },
      ]);
      await texpect(handle.getByText('A')).toBeHidden();
    });

    it('not.toBeVisible() is exempt and passes when every match is hidden', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: false },
      ]);
      await texpect(handle.getByText('A')).not.toBeVisible();
    });

    it('toBeHidden() fails while any match is still visible', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: true },
      ]);
      await expect(
        texpect(handle.getByText('A')).toBeHidden({ timeout: 100 }),
      ).rejects.toThrow('to be hidden in WebView');
    });

    it('toExist() throws a strict violation on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(texpect(handle.getByText('A')).toExist()).rejects.toThrow('strict mode violation');
    });

    it('not.toExist() is exempt and passes when nothing matches', async () => {
      const { handle } = makeHandle([]);
      await texpect(handle.getByText('A')).not.toExist();
    });

    it('toHaveText() propagates a strict violation instead of burning the timeout', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const start = Date.now();
      const err = await texpect(handle.getByText('A')).toHaveText('A').catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('toHaveText() passes with a single match', async () => {
      const { handle } = makeHandle([{ tag: 'h1', text: 'Welcome' }], 'Welcome');
      await texpect(handle.getByText('Welcome')).toHaveText('Welcome');
    });

    it('toHaveText(RegExp) tests the text (PILOT-548)', async () => {
      const { handle } = makeHandle([{ tag: 'h1', text: 'Welcome' }], 'Welcome back');
      await texpect(handle.getByText('Welcome')).toHaveText(/^welcome\sBACK$/i);
      await expect(
        texpect(handle.getByText('Welcome')).toHaveText(/^back/, { timeout: 100 }),
      ).rejects.toThrow('to have text /^back/');
    });

    it('array texts are refused at once in a WebView (PILOT-548)', async () => {
      const { handle } = makeHandle([{ text: 'A' }], 'A');
      const start = Date.now();
      await expect(
        texpect(handle.getByText('A')).toHaveText(['A'] as unknown as string),
      ).rejects.toThrow(/WebView toHaveText\(\) does not support an array of texts yet/);
      await expect(
        texpect(handle.getByText('A')).toContainText(['A'] as unknown as string),
      ).rejects.toThrow(/WebView toContainText\(\) does not support an array of texts yet/);
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('toHaveText() on a positional locator reads the narrowed target without a strict throw', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }], 'second');
      await texpect(handle.getByText('A').nth(1)).toHaveText('second');
    });

    it('toHaveText() on an out-of-range positional locator fails as not-found, not strict', async () => {
      const { handle } = makeHandle([{ text: 'A' }], 'x');
      await expect(
        texpect(handle.getByText('A').nth(3)).toHaveText('x', { timeout: 100 }),
      ).rejects.toThrow('to have text');
    });

    it('value assertion ticks honor the assertion timeout instead of the locator auto-wait', async () => {
      // No matches: each tick is a non-waiting probe, so a 100ms assertion
      // timeout fails in ~100ms rather than blocking a full locator
      // auto-wait (TIMEOUT_MS) inside the first tick.
      const { handle } = makeHandle([]);
      const start = Date.now();
      await expect(
        texpect(handle.getByText('Missing')).toHaveText('x', { timeout: 100 }),
      ).rejects.toThrow('to have text');
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('toHaveAttribute() and toHaveValue() throw strict violations on ambiguous locators', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(
        texpect(handle.getByText('A')).toHaveAttribute('href', '/x', { timeout: 100 }),
      ).rejects.toThrow('strict mode violation');
      await expect(
        texpect(handle.getByText('A')).toHaveValue('x', { timeout: 100 }),
      ).rejects.toThrow('strict mode violation');
    });
  });

  describe('StrictModeViolationError metadata', () => {
    it('exposes totalCount when elements is a truncated sample', async () => {
      const matches = Array.from({ length: 14 }, (_, i) => ({ tag: 'li', text: `Row ${i}` }));
      const { handle } = makeHandle(matches);
      const err = await handle.locator('li').click().catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
      if (isStrictModeViolation(err)) {
        expect(err.totalCount).toBe(14);
        expect(err.elements.length).toBe(10);
      }
    });
  });
});

describe('WebView hierarchy dump (PILOT-666)', () => {
  it('writes the aria-label attribute apart from the computed accessible name', async () => {
    const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, TIMEOUT_MS);
    handle._platform = 'ios';
    (handle as unknown as { _webviewNativeBounds: unknown })._webviewNativeBounds = { left: 0, top: 0, right: 100, bottom: 100 };
    const bounds = { left: 0, top: 0, right: 10, bottom: 10 };
    const leaf = (over: Record<string, unknown>) => ({
      tag: 'input', id: '', cls: '', text: '', placeholder: '', role: '', ariaLabel: '', ariaLabelAttr: '',
      testId: '', type: '', href: '', bounds, children: [], ...over,
    });
    vi.spyOn(handle as unknown as { _evaluate: () => Promise<unknown> }, '_evaluate').mockResolvedValue(
      leaf({
        tag: 'body',
        children: [
          leaf({ id: 'email', ariaLabel: 'Email' }),
          leaf({ id: 'search', ariaLabel: 'Search', ariaLabelAttr: 'Search' }),
        ],
      }),
    );
    const xml = (await handle._dumpDomHierarchy())!;
    expect(xml).toMatch(/webview-id="email"[^>]*content-desc="Email"[^>]*webview-aria-label=""/);
    expect(xml).toMatch(/webview-id="search"[^>]*content-desc="Search"[^>]*webview-aria-label="Search"/);
  });
});

describe('WebView live matches (PILOT-848)', () => {
  function liveHandle(findElement: () => Promise<unknown>, found: unknown) {
    const handle = new WebViewHandle({ findElement: vi.fn(findElement) } as unknown as TapsmithGrpcClient, 0, TIMEOUT_MS);
    handle._platform = 'android';
    const evaluate = vi.spyOn(handle as unknown as { _evaluate: (js: string, t?: number) => Promise<unknown> }, '_evaluate').mockResolvedValue(found);
    return { handle, evaluate };
  }
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('maps each match into screen coordinates beside the WebView', async () => {
    const { handle, evaluate } = liveHandle(
      async () => ({ found: true, element: { bounds: rect(0, 300, 1080, 2000) } }),
      { total: 2, matches: [{ tag: 'a', id: 'x', testId: '', rect: rect(10.4, 20, 110, 70) }, { tag: 'a', id: '', testId: '', rect: rect(0, 100, 50, 150) }] },
    );
    const r = await handle._liveMatches(handle.locator('a'), 5_000);
    expect(r.count).toBe(2);
    expect(r.matches[0]).toEqual({ tag: 'a', id: 'x', testId: '', bounds: rect(10, 320, 110, 370) });
    expect(evaluate.mock.calls[0][1]).toBe(5_000);
  });

  it('counts a positional locator as its one target, and leaves bounds unknown without the WebView\'s place', async () => {
    const { handle, evaluate } = liveHandle(
      async () => { throw new Error('agent busy'); },
      { total: 4, matches: [{ tag: 'li', id: '', testId: '', rect: rect(0, 0, 10, 10) }] },
    );
    // A place cached by an earlier call is no evidence the WebView is still on screen.
    (handle as unknown as { _webviewNativeBounds: unknown })._webviewNativeBounds = rect(0, 300, 1080, 2000);
    const r = await handle._liveMatches(handle.locator('li').last(), 5_000);
    expect(r).toEqual({ count: 1, total: 4, matches: [{ tag: 'li', id: '', testId: '', bounds: undefined }] });
    expect(evaluate.mock.calls[0][0]).toContain('const idx = els.length - 1;');
  });
});
