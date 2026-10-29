/**
 * RegExp locators — `getByText(/…/)`, `getByLabel(/…/)` and getByRole's
 * `{ name: /…/ }`, the way Playwright accepts them.
 *
 * The regex is matched on the device, by ICU on both platforms (Android's
 * `java.util.regex` is ICU-backed; iOS's NSRegularExpression and NSPredicate
 * `MATCHES` are ICU). ICU's defaults differ from JavaScript's in ways a test
 * author would trip over — `\s`, `\d`, `\w` and `\b` are Unicode-aware, `$`
 * also matches before a final line break, `.` excludes NEL, `[` and `&&`
 * are set operators inside a class, `\a` and `\e` are control characters,
 * a lone `{` is an error. So rather than hand ICU the JavaScript source, the
 * SDK translates it into a pattern that spells each of those out explicitly,
 * and ICU then gives JavaScript's answer:
 *
 * - `\s`/`\S` become JavaScript's whitespace set (NBSP, U+202F and the other
 *   Unicode spaces included); `\d`/`\w` are ASCII; `\b`/`\B` are ASCII
 *   word-boundary lookarounds.
 * - `^`/`$` become `\A`/`\z`, or line-terminator lookarounds under `m`; `.`
 *   becomes "anything but a JavaScript line terminator", or anything under
 *   `s`. So only the `i` flag travels to the device.
 * - Literals and class members are written as code-point escapes, Annex B
 *   forms (a lone `{`, `\8`, legacy octal, identity escapes) become the
 *   literals JavaScript reads them as, named groups become numbered ones,
 *   and a negated class containing `\S`/`\D`/`\W` becomes a lookahead (no
 *   nested negated sets).
 *
 * The conformance table in `__tests__/text-regex.test.ts` pins the
 * translation; both agents replay it through their real engines.
 *
 * @internal
 */

// ─── Types ───

/** A getBy* RegExp: as written, plus the translation the agents compile. */
export interface TextRegexValue {
  /** `RegExp.source`, as written. */
  readonly source: string;
  /** `RegExp.flags`, as written. */
  readonly flags: string;
  /** The device pattern (see the module comment). */
  readonly pattern: string;
  /** The `i` flag — the only flag the device applies itself. */
  readonly ignoreCase: boolean;
}

// ─── Public helpers ───

/** Flags with a meaning on device. */
const SUPPORTED_FLAGS = 'imsu';
/** Flags accepted with no effect: a locator tests each element afresh. */
const NO_OP_FLAGS = 'gd';

/**
 * Validate and translate a RegExp passed to a getBy* call. Throws a
 * TypeError naming `what` (e.g. "getByText()") for an unsupported flag or a
 * construct the device engines can't run.
 */
export function textRegexValue(re: RegExp, what: string): TextRegexValue {
  for (const flag of re.flags) {
    if (SUPPORTED_FLAGS.includes(flag) || NO_OP_FLAGS.includes(flag)) continue;
    throw new TypeError(
      `${what} does not support the RegExp flag "${flag}". Supported flags: i, m, s, u (g and d are accepted and have no effect).`,
    );
  }
  let translated: { pattern: string; ignoreCase: boolean };
  try {
    translated = translateRegex(re.source, re.flags);
  } catch (err) {
    throw new TypeError(`${what}: ${(err as Error).message}`);
  }
  return { source: re.source, flags: re.flags, ...translated };
}

/** The RegExp as a literal, for error messages and generated code: `/a\s+b/i`. */
export function formatRegex(v: Pick<TextRegexValue, 'source' | 'flags'>): string {
  return `/${v.source}/${v.flags}`;
}

/** A fresh, stateless JavaScript RegExp for host-side matching (playground). */
export function toJsRegExp(v: Pick<TextRegexValue, 'source' | 'flags'>): RegExp {
  return new RegExp(v.source, v.flags.replace(/[gd]/g, ''));
}

// ─── Translation ───

/** JavaScript's LineTerminator set, as ICU class members. */
const LT = '\\u000A\\u000D\\u2028\\u2029';
/** JavaScript's `\s` (WhiteSpace + LineTerminator), as ICU class members. */
const WS = '\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const DIGIT = '0-9';
const WORD = 'A-Za-z0-9_';
const WORD_BOUNDARY = `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`;
const NOT_WORD_BOUNDARY = `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`;
const ANY = '(?s:.)';

function hex(cp: number, width: number): string {
  return cp.toString(16).toUpperCase().padStart(width, '0');
}

/** A code point as an ICU escape: `\uXXXX`, or `\x{XXXXX}` beyond the BMP. */
function cpEscape(cp: number): string {
  return cp <= 0xffff ? `\\u${hex(cp, 4)}` : `\\x{${hex(cp, 1)}}`;
}

const isAlnum = (cp: number): boolean =>
  (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);

/** A literal outside a class. */
function literal(cp: number): string {
  if (isAlnum(cp)) return String.fromCodePoint(cp);
  // ASCII punctuation: a backslash makes it literal in ICU.
  if (cp > 0x20 && cp < 0x7f) return `\\${String.fromCodePoint(cp)}`;
  return cpEscape(cp);
}

/** A literal inside a class: never a bare set-syntax character. */
function classLiteral(cp: number): string {
  return isAlnum(cp) ? String.fromCodePoint(cp) : cpEscape(cp);
}

const HEX = /^[0-9A-Fa-f]+$/;

interface Mode { m: boolean; s: boolean }
interface Frame { prev: Mode; lookbehind: boolean }

/** A class member: a code point, or a set (`nested` when it is `[^…]`). */
type ClassAtom = { cp: number } | { set: string; nested: boolean };

/**
 * Translate a JavaScript RegExp (its `source` and `flags`, already valid for
 * JavaScript) into the device pattern. Throws an Error for a construct the
 * device engines can't run (an unbounded lookbehind).
 */
export function translateRegex(source: string, flags: string): { pattern: string; ignoreCase: boolean } {
  const unicode = flags.includes('u');
  const src = source;
  const n = src.length;
  const { groupCount, namedGroups } = scanGroups(src);
  const hasNamedGroups = namedGroups.size > 0;

  const out: string[] = [];
  const stack: Frame[] = [];
  let mode: Mode = { m: flags.includes('m'), s: flags.includes('s') };
  let lookbehindDepth = 0;
  let i = 0;

  const unboundedLookbehind = (): never => {
    throw new Error(
      'a lookbehind must have a bounded length on device (no *, +, {n,} or backreference inside (?<=…) / (?<!…)).',
    );
  };

  const cpAt = (at: number): number => src.codePointAt(at) ?? 0;
  const cpLen = (cp: number): number => (cp > 0xffff ? 2 : 1);

  /**
   * Read the escape at `at` (pointing at the backslash) that denotes one code
   * point — control, hex, unicode, NUL, legacy octal or identity escape —
   * returning the code point and the index after it.
   */
  const readCharEscape = (at: number, inClass: boolean): { cp: number; end: number } => {
    const c = src[at + 1];
    switch (c) {
      case 't': return { cp: 0x09, end: at + 2 };
      case 'n': return { cp: 0x0a, end: at + 2 };
      case 'v': return { cp: 0x0b, end: at + 2 };
      case 'f': return { cp: 0x0c, end: at + 2 };
      case 'r': return { cp: 0x0d, end: at + 2 };
      case 'c': {
        const next = src[at + 2] ?? '';
        // In a class, Annex B also accepts a digit or underscore.
        if (/[A-Za-z]/.test(next) || (inClass && /[0-9_]/.test(next))) {
          return { cp: next.charCodeAt(0) % 32, end: at + 3 };
        }
        // Not a control escape: the backslash is itself a literal.
        return { cp: 0x5c, end: at + 1 };
      }
      case 'x': {
        const h = src.slice(at + 2, at + 4);
        if (h.length === 2 && HEX.test(h)) return { cp: parseInt(h, 16), end: at + 4 };
        return { cp: 0x78, end: at + 2 };
      }
      case 'u': {
        if (unicode && src[at + 2] === '{') {
          const close = src.indexOf('}', at + 3);
          return { cp: parseInt(src.slice(at + 3, close), 16), end: close + 1 };
        }
        const h = src.slice(at + 2, at + 6);
        if (h.length === 4 && HEX.test(h)) {
          const unit = parseInt(h, 16);
          // A surrogate pair written as two escapes is one code point.
          if (unit >= 0xd800 && unit <= 0xdbff && src.slice(at + 6, at + 8) === '\\u') {
            const l = src.slice(at + 8, at + 12);
            const low = l.length === 4 && HEX.test(l) ? parseInt(l, 16) : -1;
            if (low >= 0xdc00 && low <= 0xdfff) {
              return { cp: 0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00), end: at + 12 };
            }
          }
          return { cp: unit, end: at + 6 };
        }
        return { cp: 0x75, end: at + 2 };
      }
      default: {
        if (c !== undefined && c >= '0' && c <= '9') {
          // NUL, or (Annex B, no `u`) a legacy octal escape; \8 and \9 are
          // the digits themselves.
          if (c === '8' || c === '9') return { cp: c.charCodeAt(0), end: at + 2 };
          const oct = /^[0-7]{1,3}/.exec(src.slice(at + 1))![0];
          const digits = parseInt(oct, 8) > 0o377 ? oct.slice(0, 2) : oct;
          return { cp: parseInt(digits, 8), end: at + 1 + digits.length };
        }
        // Identity escape: the character itself.
        const cp = cpAt(at + 1);
        return { cp, end: at + 1 + cpLen(cp) };
      }
    }
  };

  /** `\p{…}` / `\P{…}` (with `u`), passed through. */
  const readProperty = (at: number): { text: string; end: number } => {
    const close = src.indexOf('}', at + 3);
    return { text: src.slice(at, close + 1), end: close + 1 };
  };

  const parseClass = (start: number): number => {
    let j = start + 1;
    const negated = src[j] === '^';
    if (negated) j++;

    const readAtom = (): ClassAtom => {
      if (src[j] !== '\\') {
        const cp = cpAt(j);
        j += cpLen(cp);
        return { cp };
      }
      const c = src[j + 1];
      const set = (text: string, nested: boolean, len = 2): ClassAtom => {
        j += len;
        return { set: text, nested };
      };
      switch (c) {
        case 'd': return set(DIGIT, false);
        case 'D': return set(`[^${DIGIT}]`, true);
        case 'w': return set(WORD, false);
        case 'W': return set(`[^${WORD}]`, true);
        case 's': return set(WS, false);
        case 'S': return set(`[^${WS}]`, true);
        case 'b': j += 2; return { cp: 0x08 };
        case '-': j += 2; return { cp: 0x2d };
        case 'p': case 'P':
          if (unicode) {
            const prop = readProperty(j);
            j = prop.end;
            return { set: prop.text, nested: false };
          }
          break;
        default:
          break;
      }
      const esc = readCharEscape(j, true);
      j = esc.end;
      return { cp: esc.cp };
    };

    const parts: string[] = [];
    let hasNested = false;
    while (j < n && src[j] !== ']') {
      const a = readAtom();
      if (src[j] === '-' && j + 1 < n && src[j + 1] !== ']') {
        j++; // the hyphen
        const b = readAtom();
        if ('cp' in a && 'cp' in b) {
          parts.push(`${classLiteral(a.cp)}-${classLiteral(b.cp)}`);
          continue;
        }
        // Annex B: a class escape on either side makes the hyphen literal.
        for (const atom of [a, { cp: 0x2d } as ClassAtom, b]) {
          if ('cp' in atom) parts.push(classLiteral(atom.cp));
          else { parts.push(atom.set); hasNested ||= atom.nested; }
        }
        continue;
      }
      if ('cp' in a) parts.push(classLiteral(a.cp));
      else { parts.push(a.set); hasNested ||= a.nested; }
    }
    const end = j + 1; // past ']'

    if (parts.length === 0) {
      out.push(negated ? ANY : '(?!)');
    } else if (!negated) {
      out.push(`[${parts.join('')}]`);
    } else if (!hasNested) {
      out.push(`[^${parts.join('')}]`);
    } else {
      // No negated class around nested sets: engines disagree on what the
      // negation covers. "Not any of these" as a lookahead is unambiguous.
      out.push(`(?:(?![${parts.join('')}])${ANY})`);
    }
    return end;
  };

  const escapeOutside = (at: number): number => {
    const c = src[at + 1];
    switch (c) {
      case 'd': out.push(`[${DIGIT}]`); return at + 2;
      case 'D': out.push(`[^${DIGIT}]`); return at + 2;
      case 'w': out.push(`[${WORD}]`); return at + 2;
      case 'W': out.push(`[^${WORD}]`); return at + 2;
      case 's': out.push(`[${WS}]`); return at + 2;
      case 'S': out.push(`[^${WS}]`); return at + 2;
      case 'b': out.push(WORD_BOUNDARY); return at + 2;
      case 'B': out.push(NOT_WORD_BOUNDARY); return at + 2;
      case 'k':
        if (hasNamedGroups && src[at + 2] === '<') {
          const close = src.indexOf('>', at + 3);
          const group = namedGroups.get(src.slice(at + 3, close));
          if (group !== undefined) {
            if (lookbehindDepth > 0) unboundedLookbehind();
            out.push(`(?:\\${group})`);
            return close + 1;
          }
        }
        break;
      case 'p': case 'P':
        if (unicode) {
          const prop = readProperty(at);
          out.push(prop.text);
          return prop.end;
        }
        break;
      default:
        if (c !== undefined && c >= '1' && c <= '9') {
          const digits = /^\d+/.exec(src.slice(at + 1))![0];
          const group = parseInt(digits, 10);
          if (group <= groupCount) {
            if (lookbehindDepth > 0) unboundedLookbehind();
            // Wrapped so a following digit isn't read as part of the number.
            out.push(`(?:\\${group})`);
            return at + 1 + digits.length;
          }
        }
        break;
    }
    const esc = readCharEscape(at, false);
    out.push(literal(esc.cp));
    return esc.end;
  };

  const MODIFIERS = /^\(\?([ims]*)(?:-([ims]*))?:/;
  const QUANTIFIER = /^\{(\d+)(?:(,)(\d*))?\}/;

  while (i < n) {
    const c = src[i];
    switch (c) {
      case '\\':
        i = escapeOutside(i);
        break;
      case '[':
        i = parseClass(i);
        break;
      case '(': {
        const rest = src.slice(i);
        if (rest.startsWith('(?<=') || rest.startsWith('(?<!')) {
          stack.push({ prev: mode, lookbehind: true });
          lookbehindDepth++;
          out.push(rest.slice(0, 4));
          i += 4;
        } else if (rest.startsWith('(?<')) {
          // Named group → plain capturing group (backreferences numbered).
          stack.push({ prev: mode, lookbehind: false });
          out.push('(');
          i = src.indexOf('>', i) + 1;
        } else if (rest.startsWith('(?:') || rest.startsWith('(?=') || rest.startsWith('(?!')) {
          stack.push({ prev: mode, lookbehind: false });
          out.push(rest.slice(0, 3));
          i += 3;
        } else if (rest.startsWith('(?')) {
          const mod = MODIFIERS.exec(rest);
          if (!mod) throw new Error(`unsupported group syntax at "${rest.slice(0, 6)}".`);
          const on = mod[1] ?? '';
          const off = mod[2] ?? '';
          stack.push({ prev: mode, lookbehind: false });
          mode = {
            m: on.includes('m') ? true : off.includes('m') ? false : mode.m,
            s: on.includes('s') ? true : off.includes('s') ? false : mode.s,
          };
          // Only `i` is left to the engine; m and s are applied here.
          out.push(`(?${on.includes('i') ? 'i' : ''}${off.includes('i') ? '-i' : ''}:`);
          i += mod[0].length;
        } else {
          stack.push({ prev: mode, lookbehind: false });
          out.push('(');
          i++;
        }
        break;
      }
      case ')': {
        const frame = stack.pop();
        if (frame) {
          mode = frame.prev;
          if (frame.lookbehind) lookbehindDepth--;
        }
        out.push(')');
        i++;
        break;
      }
      case '^':
        out.push(mode.m ? `(?<![^${LT}])` : '\\A');
        i++;
        break;
      case '$':
        out.push(mode.m ? `(?![^${LT}])` : '\\z');
        i++;
        break;
      case '.':
        out.push(mode.s ? ANY : `[^${LT}]`);
        i++;
        break;
      case '*':
      case '+':
        if (lookbehindDepth > 0) unboundedLookbehind();
        out.push(c);
        i++;
        break;
      case '?':
      case '|':
        out.push(c);
        i++;
        break;
      case '{': {
        const q = QUANTIFIER.exec(src.slice(i));
        if (q) {
          if (lookbehindDepth > 0 && q[2] && !q[3]) unboundedLookbehind();
          out.push(q[0]);
          i += q[0].length;
        } else {
          out.push('\\{'); // Annex B: a lone brace is literal
          i++;
        }
        break;
      }
      case '}':
      case ']':
        out.push(`\\${c}`);
        i++;
        break;
      default: {
        const cp = cpAt(i);
        out.push(literal(cp));
        i += cpLen(cp);
      }
    }
  }

  return { pattern: out.join(''), ignoreCase: flags.includes('i') };
}

/** Count capturing groups and number the named ones, in source order. */
function scanGroups(src: string): { groupCount: number; namedGroups: Map<string, number> } {
  let groupCount = 0;
  const namedGroups = new Map<string, number>();
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c !== '(') continue;
    if (src[i + 1] !== '?') { groupCount++; continue; }
    if (src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!') {
      groupCount++;
      namedGroups.set(src.slice(i + 3, src.indexOf('>', i + 3)), groupCount);
    }
  }
  return { groupCount, namedGroups };
}
