/**
 * JavaScript string-literal escaping for generated locator code.
 *
 * A suggested locator is meant to be copied — by a person from the locator
 * playground or a strict mode error, or by an agent from `tapsmith_snapshot`
 * — into `tapsmith_test_locator` or a test file. A character that does not
 * survive that copy turns an exact locator into one that matches nothing:
 * React Navigation names an icon-font tab "<glyph>, Library", and the glyph
 * (a private-use code point) renders as nothing, so the copied locator reads
 * `", Library"`. Such characters are written as `\uXXXX` (or `\u{X…}` above
 * U+FFFF) escapes, which JavaScript and the locator parser
 * (`unescapeJsString`) both read back to the same raw value.
 */

/**
 * Characters that do not survive copy-paste: private use (icon-font glyphs),
 * controls, format characters (zero-width spaces, bidi marks), line and
 * paragraph separators, lone surrogates, and every space other than U+0020
 * (a no-break space pastes as a plain one). ZERO WIDTH JOINER is kept raw:
 * it holds emoji sequences together and copies with them.
 */
const COPY_UNSAFE_RE = /[\p{Co}\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Zs}\p{Cf}]/gu;

const NAMED_ESCAPES: Record<string, string> = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** Whether `s` contains a private-use (icon-font glyph) character. */
export function hasPrivateUseChar(s: string): boolean {
  return /\p{Co}/u.test(s);
}

/**
 * Escape a raw value for the inside of a double-quoted JavaScript string
 * literal: backslash, double quote, and every copy-unsafe character (see
 * {@link COPY_UNSAFE_RE}). Visible text — accents, CJK, symbols, emoji — is
 * left as is. {@link unescapeJsString} is the inverse.
 */
export function escapeJsString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(COPY_UNSAFE_RE, (ch) => {
      if (ch === ' ' || ch === '\u200D') return ch;
      const named = NAMED_ESCAPES[ch];
      if (named) return named;
      const cp = ch.codePointAt(0)!;
      return cp > 0xffff
        ? `\\u{${cp.toString(16).toUpperCase()}}`
        : `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    });
}

const SINGLE_CHAR_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

/**
 * Undo source-string escaping — `\" \' \\ \n \r \t`, `\uXXXX` and `\u{X…}`
 * — so a parsed locator value compares against raw node attribute values.
 * Any other escaped character stands for itself (JavaScript's `\x`, `\0`,
 * `\b`, `\f` and `\v` escapes are not read; the emitter never writes them).
 */
export function unescapeJsString(s: string): string {
  return s.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(.))/g, (match, braced: string | undefined, four: string | undefined, c: string | undefined) => {
    if (braced !== undefined) {
      const cp = Number.parseInt(braced, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (four !== undefined) return String.fromCharCode(Number.parseInt(four, 16));
    return SINGLE_CHAR_ESCAPES[c!] ?? c!;
  });
}
