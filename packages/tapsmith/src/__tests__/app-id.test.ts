import { describe, it, expect } from 'vitest';
import { appIdProblem } from '../app-id.js';

// The same cases as tapsmith-core's validate_app_id tests: the two rules must agree.
const HOSTILE = [
  '', 'com.example app', 'com.example;reboot', 'com.example$(id)', 'com.example`id`', "com.example'x",
  'com.example"x', 'com.example|sh', 'com.example&x', 'com.example>x', 'com.example/x', 'com.example\nx',
  '-com.example', '--help',
];

describe('appIdProblem()', () => {
  it('accepts hyphenated iOS bundle ids, as Expo writes them', () => {
    for (const id of ['com.anonymous.priya-app', 'com.example.my-app', 'dev.tapsmith.testapp', 'com.legacy.my_app']) {
      expect(appIdProblem(id, 'ios'), id).toBeUndefined();
    }
  });

  it("keeps Android's package-name rule", () => {
    for (const id of ['dev.tapsmith.testapp', 'com.example.my_app', 'com.example.App2']) {
      expect(appIdProblem(id, 'android'), id).toBeUndefined();
    }
    expect(appIdProblem('com.anonymous.priya-app', 'android')).toBe(
      '"com.anonymous.priya-app" is not a valid Android package name: it may contain only letters, digits, dots and underscores',
    );
  });

  it('refuses spaces, quotes, shell metacharacters and a leading hyphen on both platforms', () => {
    for (const platform of ['ios', 'android'] as const) {
      for (const id of HOSTILE) expect(appIdProblem(id, platform), `${JSON.stringify(id)} on ${platform}`).toBeDefined();
    }
    expect(appIdProblem('com.example app', 'ios')).toContain('not a valid iOS bundle identifier');
  });
});
