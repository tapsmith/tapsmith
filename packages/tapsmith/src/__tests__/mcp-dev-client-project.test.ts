import { describe, expect, it } from 'vitest';
import { devClientProjectIn } from '../mcp/connection.js';

describe('devClientProjectIn (where an MCP launch looks for a dev client)', () => {
  it('uses the config folder and its build, not the server\'s working folder', () => {
    const config = { rootDir: '/repo/apps/mobile', package: 'com.example', platform: 'android' as const, apk: 'android/app-debug.apk' };
    expect(devClientProjectIn(config, 'com.example', 'android')).toEqual({ rootDir: '/repo/apps/mobile', apk: 'android/app-debug.apk' });
  });

  it('takes the build of the project that names the app on that platform', () => {
    const config = {
      rootDir: '/repo',
      projects: [
        { name: 'android', use: { platform: 'android' as const, package: 'com.example', apk: 'a.apk' } },
        { name: 'ios', use: { platform: 'ios' as const, package: 'com.example', app: 'A.app' } },
      ],
    };
    expect(devClientProjectIn(config, 'com.example', 'ios')).toEqual({ rootDir: '/repo', app: 'A.app' });
    expect(devClientProjectIn(config, 'com.example', 'android')).toEqual({ rootDir: '/repo', apk: 'a.apk' });
  });

  it('prefers the project for the platform over a top level that shares the package', () => {
    const config = {
      rootDir: '/repo/e2e',
      package: 'com.example',
      projects: [
        { name: 'android', use: { platform: 'android' as const, apk: 'a.apk' } },
        { name: 'ios', use: { platform: 'ios' as const, app: 'A.app' } },
      ],
    };
    expect(devClientProjectIn(config, 'com.example', 'ios')).toEqual({ rootDir: '/repo/e2e', app: 'A.app' });
    expect(devClientProjectIn(config, 'com.example', 'android')).toEqual({ rootDir: '/repo/e2e', apk: 'a.apk' });
  });

  it('keeps the config folder for an app the config does not name', () => {
    expect(devClientProjectIn({ rootDir: '/repo', package: 'com.example' }, 'com.other', 'android')).toEqual({ rootDir: '/repo' });
  });
});
