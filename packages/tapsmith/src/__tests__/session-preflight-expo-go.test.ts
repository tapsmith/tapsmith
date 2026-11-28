import { describe, expect, it } from 'vitest';
import { checkExpoGo, isExpoGo, type SessionPreflightContext } from '../session-preflight.js';

// PILOT-1533: a config whose package is Expo Go launched Expo's home screen
// and failed 34 s later on a locator for the user's own screen, with no hint
// that Expo Go cannot be the app under test as it stands.

const ctx = (pkg: string, platform: 'android' | 'ios' = 'android') => ({
  config: { package: pkg, platform },
  notices: [],
  capabilities: {},
}) as unknown as SessionPreflightContext;

describe('isExpoGo', () => {
  it('knows Expo Go by its id on either platform, in any case', () => {
    expect(isExpoGo('host.exp.exponent')).toBe(true);
    expect(isExpoGo('host.exp.Exponent')).toBe(true);
    expect(isExpoGo('host.exp.exponent.dev')).toBe(false);
    expect(isExpoGo('com.lqh.alexshop')).toBe(false);
    expect(isExpoGo(undefined)).toBe(false);
  });
});

describe('checkExpoGo', () => {
  it('leaves one notice per session saying what Expo Go is, how to open the project, and what to test instead', () => {
    const session = ctx('host.exp.exponent');
    checkExpoGo(session);
    // The runner hands every reset a fresh spread of the context, sharing its capabilities.
    checkExpoGo({ ...session });
    expect(session.notices).toHaveLength(1);
    const [notice] = session.notices;
    expect(notice.kind).toBe('expo-go');
    expect(notice.message).toBe('host.exp.exponent is Expo Go, which opens its own home screen, not your project: it runs your JavaScript '
      + 'inside Expo\'s app, so locators for your screens find nothing until the test opens the project with '
      + 'device.openDeepLink(\'exp://<your computer\'s LAN IP>:8081\'). Recommended: test a build of your app instead, with '
      + '`apk` set to it and `package` to its applicationId. https://tapsmith.dev/getting-started/#react-native-and-expo');
    // MCP clips each warning line at 500 characters.
    expect(notice.message.length).toBeLessThan(500);
  });

  it('names `app` and the bundle identifier on iOS', () => {
    const session = ctx('host.exp.Exponent', 'ios');
    checkExpoGo(session);
    expect(session.notices[0].message).toContain('`app` set to it and `package` to its bundle identifier');
  });

  it('says nothing for any other app', () => {
    const session = ctx('com.lqh.alexshop');
    checkExpoGo(session);
    expect(session.notices).toEqual([]);
  });
});
