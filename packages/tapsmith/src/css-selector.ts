/**
 * CSS selectors for WebView locator suggestions (PILOT-666). An id or class
 * is only safe after `#` or `.` when it is a plain CSS identifier: `#1st` and
 * `#:r1:` (React's useId) throw in querySelectorAll, and `#order.total`
 * selects something else. Any other id is suggested as an attribute selector.
 */

/**
 * A CSS identifier with no escapes: a letter, `_` or non-ASCII character
 * (after an optional `-`), or `--`, then those, digits and `-`.
 */
const CSS_IDENTIFIER = /^(?:--|-?[A-Za-z_\u{80}-\u{10FFFF}])[\w\u{80}-\u{10FFFF}-]*$/u;

/** Whether `name` can follow `#` or `.` in a selector unescaped. */
export function isCssIdentifier(name: string): boolean {
  return CSS_IDENTIFIER.test(name);
}

/** A CSS selector for the element with this id: `#id`, else `[id="…"]`. */
export function cssIdSelector(id: string): string {
  if (isCssIdentifier(id)) return `#${id}`;
  return `[id="${id.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"]`;
}

/** The id a {@link cssIdSelector} attribute selector names, or null for any other selector. */
export function idOfAttributeSelector(css: string): string | null {
  const m = /^\[id="((?:[^"\\]|\\.)*)"\]$/s.exec(css);
  if (!m) return null;
  return m[1].replace(/\\(a |.)/gs, (_, c: string) => (c === 'a ' ? '\n' : c));
}
