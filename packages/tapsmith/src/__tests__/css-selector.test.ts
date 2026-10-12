import { describe, it, expect } from 'vitest';
import { cssIdSelector, idOfAttributeSelector, isCssIdentifier } from '../css-selector.js';

// PILOT-666: WebView locator suggestions must be selectors querySelectorAll
// accepts and that select the element they name.

describe('cssIdSelector', () => {
  it('uses #id for a plain CSS identifier', () => {
    expect(cssIdSelector('email')).toBe('#email');
    expect(cssIdSelector('save-2_b')).toBe('#save-2_b');
    expect(cssIdSelector('-x')).toBe('#-x');
  });

  it('uses an attribute selector for any other id', () => {
    expect(cssIdSelector('1st')).toBe('[id="1st"]');
    expect(cssIdSelector(':r1:')).toBe('[id=":r1:"]');
    expect(cssIdSelector('order.total')).toBe('[id="order.total"]');
    expect(cssIdSelector('say "hi"')).toBe('[id="say \\"hi\\""]');
    expect(cssIdSelector('a\\b')).toBe('[id="a\\\\b"]');
    expect(cssIdSelector('a\nb')).toBe('[id="a\\a b"]');
  });

  it.each(['email', '1st', ':r1:', 'order.total', 'say "hi"', 'a\\b', 'a\nb', 'x\\a y', 'ünï', ''])(
    'round-trips %j through the playground parser',
    (id) => {
      const css = cssIdSelector(id);
      const parsed = css.startsWith('#') ? css.slice(1) : idOfAttributeSelector(css);
      expect(parsed).toBe(id);
    },
  );
});

describe('isCssIdentifier', () => {
  it('rejects names that start with a digit or hold selector syntax', () => {
    for (const name of ['1st', ':r1:', 'a.b', 'a b', 'md:flex', 'w-1/2', '--x', '']) {
      expect(isCssIdentifier(name)).toBe(false);
    }
  });
});

describe('idOfAttributeSelector', () => {
  it('is null for any other selector', () => {
    expect(idOfAttributeSelector('#email')).toBeNull();
    expect(idOfAttributeSelector('[data-id="x"]')).toBeNull();
    expect(idOfAttributeSelector('[id="x"] span')).toBeNull();
  });
});
