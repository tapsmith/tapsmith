import type { WebViewHandle } from './webview-handle.js';
import { checkNoArguments, checkOptions, checkTimeout, type TimeoutOptions } from './action-options.js';

const COUNT_HINT = 'It reads the page as it is now; to wait for the matches, use expect(locator).toHaveCount(n, { timeout }).';

/**
 * Lazy reference to an element within a WebView.
 *
 * Created via `webview.locator(css)`, `webview.getByText(text)`,
 * `webview.getByRole(role)`, etc. Compatible with `expect()` assertions.
 *
 * `_selector` is used for display/tracing. `_finderAllJs` is a JS expression
 * evaluated via CDP that returns an Array of ALL matching elements in
 * document order (defaults to `querySelectorAll(selector)` when not
 * explicitly set); `_finderJs` derives the single target element from it.
 *
 * Strict mode (PILOT-227): like native locators, an action, single-element
 * query, or positive assertion on a locator that resolves to more than one
 * element throws a StrictModeViolationError. Narrow with `.first()`,
 * `.last()`, or `.nth(n)` to target one match positionally.
 */
/** @internal Brand key for cross-instance type checks (CJS/ESM dual-package). */
export const WEBVIEW_LOCATOR_BRAND = Symbol.for('tapsmith.WebViewLocator');

export class WebViewLocator {
  /** @internal */
  readonly [WEBVIEW_LOCATOR_BRAND] = true;
  /** @internal */
  readonly _handle: WebViewHandle;
  /** @internal */
  readonly _selector: string;
  /** @internal */
  readonly _timeoutMs: number;
  /** @internal — JS expression returning an Array of all matched elements (document order). */
  readonly _finderAllJs: string;
  /** @internal — Positional index from first()/last()/nth(); negative counts
   * from the end. `undefined` means the locator is strict (single-match). */
  readonly _nthIndex: number | undefined;

  /** @internal */
  constructor(
    handle: WebViewHandle,
    selector: string,
    timeoutMs: number,
    finderAllJs?: string,
    nthIndex?: number,
  ) {
    this._handle = handle;
    this._selector = selector;
    this._timeoutMs = timeoutMs;
    this._finderAllJs = finderAllJs ?? `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`;
    this._nthIndex = nthIndex;
  }

  /** @internal — JS expression that returns the single target element (or null). */
  get _finderJs(): string {
    const n = this._nthIndex ?? 0;
    if (n >= 0) {
      return `((${this._finderAllJs})[${n}] ?? null)`;
    }
    // Negative index counts from the end (last() = nth(-1)).
    return `((els) => els[els.length - ${-n}] ?? null)(${this._finderAllJs})`;
  }

  // ─── Positional narrowing (strict mode exempt) ───

  /** Narrow to the first match. Exempt from strict mode. */
  first(): WebViewLocator {
    return this.nth(0);
  }

  /** Narrow to the last match. Exempt from strict mode. */
  last(): WebViewLocator {
    return this.nth(-1);
  }

  /**
   * Narrow to the nth match (0-based; negative counts from the end).
   * Exempt from strict mode.
   */
  nth(index: number): WebViewLocator {
    if (!Number.isInteger(index)) {
      throw new Error(`nth(${index}): index must be an integer`);
    }
    // Chaining onto an already-narrowed locator narrows the narrowed set
    // (Playwright semantics): the base set becomes the single target element,
    // so e.g. `.first().nth(1)` resolves to nothing rather than silently
    // re-indexing the original match set.
    const baseAllJs = this._nthIndex === undefined
      ? this._finderAllJs
      : `((el) => el ? [el] : [])(${this._finderJs})`;
    return new WebViewLocator(
      this._handle,
      `${this._selector} >> nth=${index}`,
      this._timeoutMs,
      baseAllJs,
      index,
    );
  }

  // ─── Multi-element queries (strict mode exempt) ───

  /** Return the number of elements currently matching (no auto-wait). */
  count(): Promise<number>;
  // The arguments are only checked (PILOT-840), as on native locators.
  async count(...args: unknown[]): Promise<number> {
    checkNoArguments('count()', args, COUNT_HINT);
    return this._handle._countLocator(this);
  }

  /** Return one positionally-narrowed locator per current match (no auto-wait). */
  all(): Promise<WebViewLocator[]>;
  async all(...args: unknown[]): Promise<WebViewLocator[]> {
    checkNoArguments('all()', args, COUNT_HINT);
    const n = await this.count();
    if (this._nthIndex !== undefined) {
      return n > 0 ? [this] : [];
    }
    return Array.from({ length: n }, (_, i) => this.nth(i));
  }

  // ─── Actions and single-element queries (strict) ───

  /**
   * Click the element, once exactly one element matches (or the positional
   * one exists).
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the WebView's timeout.
   */
  async click(options?: TimeoutOptions): Promise<void> {
    await this._handle._clickLocator(this, timedCall('click()', options));
  }

  /**
   * Set the element's value to `value`, firing `input` and `change` events.
   *
   * @param options.timeout - Maximum time in milliseconds for the whole call,
   *   auto-wait included. Defaults to the WebView's timeout.
   */
  async fill(value: string, options?: TimeoutOptions): Promise<void> {
    await this._handle._fillLocator(this, value, timedCall('fill()', options));
  }

  /**
   * The element's `textContent`.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the WebView's timeout.
   */
  async textContent(options?: TimeoutOptions): Promise<string> {
    return this._handle._textContentLocator(this, timedCall('textContent()', options));
  }

  /**
   * The element's `innerHTML`.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the WebView's timeout.
   */
  async innerHTML(options?: TimeoutOptions): Promise<string> {
    return this._handle._innerHTMLLocator(this, timedCall('innerHTML()', options));
  }

  /**
   * The value of the element's form control.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the WebView's timeout.
   */
  async inputValue(options?: TimeoutOptions): Promise<string> {
    return this._handle._inputValueLocator(this, timedCall('inputValue()', options));
  }

  /**
   * The value of the element's `name` attribute, or `null` when it has none.
   *
   * @param options.timeout - Maximum time in milliseconds to wait for the
   *   element. Defaults to the WebView's timeout.
   */
  async getAttribute(name: string, options?: TimeoutOptions): Promise<string | null> {
    return this._handle._getAttributeLocator(this, name, timedCall('getAttribute()', options));
  }

  /**
   * Whether the target is visible right now (single read, no auto-wait).
   *
   * @param options.timeout - Accepted, and checked, for Playwright parity;
   *   like Playwright's, it has no effect, since the call never waits.
   */
  async isVisible(options?: TimeoutOptions): Promise<boolean> {
    timedCall('isVisible()', options);
    return this._handle._isVisibleLocator(this);
  }

  /**
   * The opposite of {@link isVisible}: `true` when nothing matches or the
   * target is not visible. One DOM read, no auto-wait; strict like `isVisible`
   * (an ambiguous locator throws rather than reporting the first match).
   * Mirrors `ElementHandle.isHidden()` so native and WebView locators share
   * one reader vocabulary. (Goes through the handle rather than
   * `this.isVisible()` so the trace row is named `isHidden`.)
   *
   * @param options.timeout - Accepted, and checked, for Playwright parity;
   *   it has no effect, since the call never waits.
   */
  async isHidden(options?: TimeoutOptions): Promise<boolean> {
    timedCall('isHidden()', options);
    return !(await this._handle._isVisibleLocator(this, 'isHidden'));
  }
}

/** A WebView locator call's checked per-call timeout (PILOT-840), or undefined for the WebView's own. */
function timedCall(method: string, options: TimeoutOptions | undefined): number | undefined {
  return checkTimeout(method, checkOptions(method, options, ['timeout'])?.timeout);
}
