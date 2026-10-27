import { describe, expect, it } from 'vitest';
import {
  appResetAction,
  appResetPolicyEquals,
  describeAction,
  parseHooksMarker,
  resolveAppResetPolicy,
  satisfies,
  type AppResetPolicy,
} from '../app-reset.js';

const base = { rootDir: '/proj' };

describe('resolveAppResetPolicy', () => {
  it('defaults to clear · per file with no hooks (today\'s behaviour, zero config)', () => {
    expect(resolveAppResetPolicy(undefined, base)).toEqual({ mode: 'clear', scope: 'file' });
  });

  it('auto resolves to clear · per file on macOS, which has no warm reset', () => {
    // Hooks or a deep link would make it warm elsewhere: macOS has neither path.
    expect(resolveAppResetPolicy(undefined, { ...base, platform: 'macos' }, { hooksDetected: true }))
      .toEqual({ mode: 'clear', scope: 'file' });
  });

  it('a configured reset deep link makes auto resolve to warm · per file', () => {
    expect(resolveAppResetPolicy(undefined, { ...base, resetAppDeepLink: 'app:///__reset' }))
      .toEqual({ mode: 'warm', scope: 'file' });
  });

  it('detected in-app hooks make auto resolve to warm · per file', () => {
    // Per-test isolation is an explicit opt-in (appResetScope: 'test') —
    // even warm resets cost ~1-2 s each, which roughly doubled suite time
    // when auto defaulted to per-test.
    expect(resolveAppResetPolicy(undefined, base, { hooksDetected: true }))
      .toEqual({ mode: 'warm', scope: 'file' });
  });

  it('an explicit per-test scope opts a scope into warm per-test resets', () => {
    const p = resolveAppResetPolicy(undefined, { ...base, appResetScope: 'test' }, { hooksDetected: true });
    expect(p).toEqual({ mode: 'warm', scope: 'test' });
  });

  it('appState keeps auto isolation per file — restore and clear are cold, not warm', () => {
    expect(resolveAppResetPolicy({ appState: 'auth.tar.gz' }, base, { hooksDetected: true }))
      .toEqual({ mode: 'warm', scope: 'file', appState: '/proj/auth.tar.gz' });
    expect(resolveAppResetPolicy({ appState: '' }, base, { hooksDetected: true }))
      .toEqual({ mode: 'warm', scope: 'file', appState: '' });
  });

  it('an explicit cold mode keeps auto isolation per file even with hooks detected', () => {
    expect(resolveAppResetPolicy(undefined, { ...base, appReset: 'clear' }, { hooksDetected: true }))
      .toEqual({ mode: 'clear', scope: 'file' });
  });

  it('explicit mode and scope win over auto', () => {
    expect(resolveAppResetPolicy(undefined, { ...base, appReset: 'restart', appResetScope: 'test' }, { hooksDetected: true }))
      .toEqual({ mode: 'restart', scope: 'test' });
    // 'none' never resets, so its auto scope stays the per-file default.
    expect(resolveAppResetPolicy(undefined, { ...base, appReset: 'none' }, { hooksDetected: true }))
      .toEqual({ mode: 'none', scope: 'file' });
  });

  it('resolves a relative appState against rootDir and keeps "" as clear', () => {
    expect(resolveAppResetPolicy({ appState: './auth.tar.gz' }, base).appState).toBe('/proj/auth.tar.gz');
    expect(resolveAppResetPolicy({ appState: '/abs/auth.tar.gz' }, base).appState).toBe('/abs/auth.tar.gz');
    expect(resolveAppResetPolicy({ appState: '' }, base).appState).toBe('');
    expect(resolveAppResetPolicy({}, base).appState).toBeUndefined();
  });
});

describe('appResetAction', () => {
  it('appState takes precedence over mode', () => {
    expect(appResetAction({ mode: 'warm', scope: 'test', appState: '/a.tar.gz' })).toEqual({ kind: 'restore', archive: '/a.tar.gz' });
    expect(appResetAction({ mode: 'warm', scope: 'test', appState: '' })).toEqual({ kind: 'clear' });
    expect(appResetAction({ mode: 'warm', scope: 'test' })).toEqual({ kind: 'warm' });
  });
});

describe('satisfies', () => {
  const p = (mode: AppResetPolicy['mode'], appState?: string): AppResetPolicy => ({ mode, scope: 'file', ...(appState !== undefined ? { appState } : {}) });

  it('clear satisfies every mode-only policy', () => {
    for (const want of ['clear', 'restart', 'warm', 'none'] as const) {
      expect(satisfies(p('clear'), p(want))).toBe(true);
    }
  });

  it('restart and warm satisfy themselves and none, not clear or each other', () => {
    expect(satisfies(p('restart'), p('restart'))).toBe(true);
    expect(satisfies(p('restart'), p('none'))).toBe(true);
    expect(satisfies(p('restart'), p('clear'))).toBe(false);
    expect(satisfies(p('restart'), p('warm'))).toBe(false);
    expect(satisfies(p('warm'), p('warm'))).toBe(true);
    expect(satisfies(p('warm'), p('none'))).toBe(true);
    expect(satisfies(p('warm'), p('clear'))).toBe(false);
  });

  it('none satisfies only none', () => {
    expect(satisfies(p('none'), p('none'))).toBe(true);
    expect(satisfies(p('none'), p('restart'))).toBe(false);
  });

  it('a restore satisfies only the identical archive; clear never satisfies a restore', () => {
    expect(satisfies(p('clear', '/a.tar.gz'), p('clear', '/a.tar.gz'))).toBe(true);
    expect(satisfies(p('clear', '/a.tar.gz'), p('clear', '/b.tar.gz'))).toBe(false);
    expect(satisfies(p('clear'), p('clear', '/a.tar.gz'))).toBe(false);
    expect(satisfies(p('clear', '/a.tar.gz'), p('clear'))).toBe(false);
    expect(satisfies(p('clear', '/a.tar.gz'), p('none'))).toBe(true);
  });

  it('scope does not affect satisfaction', () => {
    expect(satisfies({ mode: 'clear', scope: 'file' }, { mode: 'clear', scope: 'test' })).toBe(true);
  });
});

describe('appResetPolicyEquals / describeAction', () => {
  it('compares all three fields', () => {
    expect(appResetPolicyEquals({ mode: 'clear', scope: 'file' }, { mode: 'clear', scope: 'file' })).toBe(true);
    expect(appResetPolicyEquals({ mode: 'clear', scope: 'file' }, { mode: 'clear', scope: 'test' })).toBe(false);
    expect(appResetPolicyEquals({ mode: 'clear', scope: 'file', appState: '' }, { mode: 'clear', scope: 'file' })).toBe(false);
    expect(appResetPolicyEquals(undefined, undefined)).toBe(true);
    expect(appResetPolicyEquals(undefined, { mode: 'clear', scope: 'file' })).toBe(false);
  });

  it('labels the effective action', () => {
    expect(describeAction({ mode: 'clear', scope: 'file' })).toBe('App reset (clear)');
    expect(describeAction({ mode: 'warm', scope: 'test', appState: '/x/auth.tar.gz' })).toBe('App reset (restore auth.tar.gz)');
  });
});

describe('parseHooksMarker', () => {
  it('ignores fields it does not use (boot token from newer modules)', () => {
    const m = parseHooksMarker('<node label="tapsmith-hooks:1;epoch=3;boot=c0ffee42;url=app:///" />');
    expect(m).toMatchObject({ epoch: 3, urlPrefix: 'app:///' });
  });

  it('parses the Android text attribute and the iOS label attribute', () => {
    expect(parseHooksMarker('<node text="tapsmith-hooks:1;epoch=4;url=myapp:///" class="android.widget.TextView"/>'))
      .toEqual({ version: 1, epoch: 4, urlPrefix: 'myapp:///' });
    expect(parseHooksMarker('<XCUIElementTypeStaticText label="tapsmith-hooks:1;epoch=7;url=exp://10.0.0.5:8081/--/" />'))
      .toEqual({ version: 1, epoch: 7, urlPrefix: 'exp://10.0.0.5:8081/--/' });
  });

  it('decodes XML escapes and percent-encoded errors', () => {
    const m = parseHooksMarker('<node text="tapsmith-hooks:1;epoch=2;url=a:///;err=AsyncStorage%20failed%3A%20boom&amp;x"/>');
    expect(m).toEqual({ version: 1, epoch: 2, urlPrefix: 'a:///', error: 'AsyncStorage failed: boom&x' });
  });

  it('returns undefined for missing or malformed markers', () => {
    expect(parseHooksMarker('<node text="hello"/>')).toBeUndefined();
    expect(parseHooksMarker('<node text="tapsmith-hooks:1;url=x"/>')).toBeUndefined();
    expect(parseHooksMarker('<node text="tapsmith-hooks:abc;epoch=1"/>')).toBeUndefined();
  });

  it('treats an unknown protocol version as no marker', () => {
    expect(parseHooksMarker('<node text="tapsmith-hooks:2;epoch=3;url=a:///"/>')).toBeUndefined();
    expect(parseHooksMarker('<node text="tapsmith-hooks:0;epoch=3;url=a:///"/>')).toBeUndefined();
  });
});
