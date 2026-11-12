import { describe, expect, it } from 'vitest';
import { formatMarker, parseMarker, parseResetRequest, resetDedupeKey, routeOf } from '../protocol.js';

describe('marker', () => {
  it('round-trips, including an error message', () => {
    const text = formatMarker({ epoch: 4, urlPrefix: 'myapp:///' });
    expect(text).toBe('tapsmith-hooks:1;epoch=4;url=myapp:///');
    expect(parseMarker(text)).toEqual({ version: 1, epoch: 4, urlPrefix: 'myapp:///', error: undefined });

    const withErr = formatMarker({ epoch: 5, urlPrefix: 'exp://10.0.0.5:8081/--/', error: 'AsyncStorage failed: boom & "x"' });
    expect(withErr).not.toMatch(/["']/); // must be safe inside an XML attribute
    expect(parseMarker(withErr)).toMatchObject({ epoch: 5, urlPrefix: 'exp://10.0.0.5:8081/--/', error: 'AsyncStorage failed: boom & "x"' });
  });

  it('parses when embedded in surrounding text and rejects non-markers', () => {
    expect(parseMarker('label: tapsmith-hooks:1;epoch=2;url=a:///')?.epoch).toBe(2);
  });

  it('treats an unknown protocol version as no marker', () => {
    expect(parseMarker('tapsmith-hooks:2;epoch=3;url=a:///')).toBeUndefined();
    expect(parseMarker('tapsmith-hooks:;epoch=3;url=a:///')).toBeUndefined();
  });

  it('caps a runaway error message so the marker stays small', () => {
    // Truncation must not split a surrogate pair (encodeURIComponent would throw mid-render).
    const emoji = formatMarker({ epoch: 1, urlPrefix: 'a:///', error: 'x'.repeat(199) + '💥'.repeat(10) });
    expect(parseMarker(emoji)?.error).toBe('x'.repeat(199) + '💥…');
    const text = formatMarker({ epoch: 1, urlPrefix: 'a:///', error: 'x'.repeat(5000) });
    expect(text.length).toBeLessThan(400);
    expect(parseMarker(text)?.error).toBe(`${'x'.repeat(200)}…`);
  });

  it('carries the per-process boot token so a relaunch is recognisable', () => {
    const text = formatMarker({ epoch: 1, boot: 'c0ffee42', urlPrefix: 'myapp:///' });
    expect(text).toBe('tapsmith-hooks:1;epoch=1;boot=c0ffee42;url=myapp:///');
    expect(parseMarker(text)).toMatchObject({ epoch: 1, boot: 'c0ffee42' });
    // Older markers simply have no token.
    expect(parseMarker('tapsmith-hooks:1;epoch=2;url=a:///')?.boot).toBeUndefined();
    expect(parseMarker('hello')).toBeUndefined();
    expect(parseMarker('tapsmith-hooks:1;url=a:///')).toBeUndefined();
  });
});

describe('persisted writes field', () => {
  it('round-trips through the marker', () => {
    const marker = formatMarker({ epoch: 2, nav: 1, boot: 'b00710ad', urlPrefix: 'app:///', writes: 3 });
    expect(marker).toBe('tapsmith-hooks:1;epoch=2;nav=1;boot=b00710ad;url=app:///;writes=3');
    expect(parseMarker(marker)).toMatchObject({ epoch: 2, writes: 3, urlPrefix: 'app:///' });
  });

  it('is omitted when the app does not report writes', () => {
    const marker = formatMarker({ epoch: 0, urlPrefix: 'app:///' });
    expect(marker).not.toContain('writes=');
    expect(parseMarker(marker)).not.toHaveProperty('writes');
  });
});

describe('reset requests', () => {
  it('recognises a request to keep persisted data', () => {
    expect(parseResetRequest('myapp:///?__tapsmith_reset=1&nonce=n&__tapsmith_keep=1')).toEqual({ target: '/', nonce: 'n', keepData: true });
    expect(parseResetRequest('myapp:///?__tapsmith_reset=1&nonce=n&__tapsmith_keep=0')).toEqual({ target: '/', nonce: 'n' });
  });

  it('recognises the flag and extracts target + nonce', () => {
    expect(parseResetRequest('myapp:///login?__tapsmith_reset=1&nonce=abc')).toEqual({ target: '/login', nonce: 'abc' });
    expect(parseResetRequest('myapp:///?__tapsmith_reset=1&nonce=n')).toEqual({ target: '/', nonce: 'n' });
    expect(parseResetRequest('exp://10.0.0.5:8081/--/settings?tab=2&__tapsmith_reset=1&nonce=z')).toEqual({ target: '/settings', nonce: 'z' });
    expect(parseResetRequest('myapp://login?__tapsmith_reset=1')).toEqual({ target: '/login', nonce: '' });
  });

  it('ignores ordinary deep links', () => {
    expect(parseResetRequest('myapp:///login')).toBeUndefined();
    expect(parseResetRequest('myapp:///login?tab=2')).toBeUndefined();
  });

  it('dedupes a nonce-less link on the URL itself', () => {
    const url = 'myapp:///login?__tapsmith_reset=1';
    const request = parseResetRequest(url)!;
    expect(resetDedupeKey(request, url)).toBe(url);
    const withNonce = parseResetRequest(`${url}&nonce=abc`)!;
    expect(resetDedupeKey(withNonce, `${url}&nonce=abc`)).toBe('abc');
  });
});

describe('routeOf', () => {
  it('normalises the common URL shapes', () => {
    expect(routeOf('myapp:///')).toBe('/');
    expect(routeOf('myapp:///login')).toBe('/login');
    expect(routeOf('myapp://login')).toBe('/login');
    expect(routeOf('exp://10.0.0.5:8081/--/settings')).toBe('/settings');
    expect(routeOf('https://example.com/profile')).toBe('/profile');
    expect(routeOf('https://example.com')).toBe('/');
  });
});

describe('nav counter', () => {
  it('round-trips through the marker', () => {
    const text = formatMarker({ epoch: 2, nav: 7, boot: 'abcd1234', urlPrefix: 'app:///' });
    expect(text).toContain(';nav=7;');
    const parsed = parseMarker(text);
    expect(parsed?.nav).toBe(7);
    expect(parsed?.epoch).toBe(2);
  });

  it('is omitted when absent (older markers still parse)', () => {
    const text = formatMarker({ epoch: 2, boot: 'abcd1234', urlPrefix: 'app:///' });
    expect(text).not.toContain('nav=');
    expect(parseMarker(text)?.nav).toBeUndefined();
  });
});
