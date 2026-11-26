import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { missingConfigFix } from '../missing-config.js';

let dir: string;

beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-missing-config-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function write(file: string, text = ''): void {
  const abs = path.join(dir, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

const APK = 'android/app/build/outputs/apk/release/app-release.apk';
const IOS_APP = 'ios/build/Build/Products/Release-iphonesimulator/Acme.app/Info.plist';
const expo = (): void => {
  write('package.json', '{"dependencies":{"expo":"54.0.0","react-native":"0.81.5"}}');
  write('app.json', '{"expo":{}}');
};
const NO_AGENT = { codingAgents: [], agentRunning: false } as const;
const fix = (cli = 'npx tapsmith', isMacOS = true, agents: Parameters<typeof missingConfigFix>[3] = NO_AGENT): string =>
  missingConfigFix(dir, cli, isMacOS, agents);
const lines = (text: string): string[] => text.split('\n');

describe('missingConfigFix()', () => {
  it('runs init when the app is built, and says what init writes', () => {
    write(APK);
    expect(lines(fix())[0]).toBe('Run: npx tapsmith init --yes --json');
    expect(lines(fix())[1]).toMatch(/^It writes the config, and the AGENTS\.md section .*\(npx tapsmith init is the wizard\)\. Edit the config it writes rather than writing one by hand\.$/);
    expect(fix()).not.toContain('Build');
  });

  // An agent read one 1.5 KB line, with the init command in the middle of the build recipe (PILOT-1523).
  it('puts the init command on a line of its own, before the build steps', () => {
    expo();
    const [first, second, ...rest] = lines(fix());
    expect(first).toBe('Run, once the app is built: npx tapsmith init --yes --json');
    expect(second).toMatch(/^It writes the config/);
    expect(rest.join('\n')).toMatch(/^Build the app first: init needs a build to point at\. /);
    expect(rest.join('\n')).toContain('npx expo prebuild --platform android');
    expect(first + second).not.toMatch(/prebuild|gradlew|xcodebuild/);
  });

  it('ends with the plugin for the coding agent running doctor, for the user to install', () => {
    write(APK);
    const last = lines(fix('pnpm exec tapsmith', true, { codingAgents: ['claude'], agentRunning: true })).at(-1);
    expect(last).toMatch(/^After init, tell the user, in your reply, to install the Claude Code plugin \(the Tapsmith MCP server and a test-writing skill\), then start a new session to use it: claude plugin marketplace add tapsmith\/tapsmith/);
    expect(lines(fix('npx tapsmith', true, { codingAgents: ['codex', 'cursor'], agentRunning: false })).slice(-2)).toEqual([
      'After init, install the Codex plugin (the Tapsmith MCP server and a test-writing skill): codex plugin marketplace add tapsmith/tapsmith && codex plugin add tapsmith@tapsmith',
      'After init, install the Cursor plugin (the Tapsmith MCP server and a test-writing skill): see "Install the plugin" in node_modules/tapsmith/docs/mcp-server.md',
    ]);
  });

  it('with no coding agent found, ends with registering the MCP server, run the project\'s way', () => {
    write(APK);
    expect(lines(fix('pnpm exec tapsmith')).at(-1)).toBe('After init, register the MCP server for richer agent tooling (it works in UI mode when that runs, headless otherwise): claude mcp add tapsmith -- pnpm exec tapsmith mcp-server --prefer-ui');
  });

  it('uses the project\'s own way to run Tapsmith', () => {
    expect(fix('pnpm exec tapsmith')).toContain('pnpm exec tapsmith init --yes --json');
    expect(fix('pnpm exec tapsmith')).not.toContain('npx tapsmith');
  });

  // `init --yes` fails there with NO_PLATFORM, which an agent took as "later" and never came back (PILOT-1442).
  it('builds an Expo project with no native folders first, for each platform this host can build', () => {
    expo();
    expect(fix()).toMatch(/^Run, once the app is built: npx tapsmith init --yes --json\n/);
    expect(fix()).toContain('npx expo prebuild --platform android');
    expect(fix()).toContain('npx expo prebuild --platform ios');
    expect(fix('npx tapsmith', false)).not.toContain('npx expo prebuild --platform ios');
  });

  it('builds every platform that has no build yet', () => {
    write('package.json', '{"dependencies":{"react-native":"0.84.0"}}');
    write('android/settings.gradle');
    write('ios/Acme.xcodeproj/project.pbxproj');
    expect(fix()).toMatch(/^Run, once the app is built: /);
    expect(fix()).toContain('./gradlew assembleDebug');
    expect(fix()).toContain('xcodebuild -project Acme.xcodeproj');
    expect(fix('npx tapsmith', false)).not.toContain('xcodebuild');
    write(APK);
    write(IOS_APP);
    expect(fix()).toMatch(/^Run: .*\n/);
  });

  it('offers a build made elsewhere before building again', () => {
    expo();
    expect(fix()).toMatch(/Already built somewhere else\?.*--apk <path> or --package <id>.* or --app <path>/);
    write('ios/Acme.xcodeproj/project.pbxproj');
    write('android/settings.gradle');
    // init wants a build of each platform in the project, unless told one.
    expect(fix()).toMatch(/add --apk <path> or --package <id> \(.*\), and --app <path> \(.*\) to the init command \(with only one of the two, also add --platform android or --platform ios\)/);
    fs.rmSync(path.join(dir, 'ios'), { recursive: true });
    expect(fix()).toContain('add --apk <path> or --package <id>');
    expect(fix()).not.toContain('--app <path>');
    fs.rmSync(path.join(dir, 'app.json'));
    expect(fix()).toContain('add --apk <path> or --package <id>');
  });

  it('says how to set up only the platform that is built', () => {
    expo();
    write(APK);
    write('ios/Acme.xcodeproj/project.pbxproj');
    expect(fix()).toMatch(/^Run, once the app is built: /);
    expect(fix()).toContain('To set up only Android, which is built: npx tapsmith init --yes --json --platform android.');
    expect(fix()).not.toContain('./gradlew');
    // Off macOS init leaves iOS out, so the APK is all it needs.
    expect(fix('npx tapsmith', false)).toMatch(/^Run: .*\n/);
  });

  const METRO = 'https://tapsmith.dev/getting-started/#debug-and-dev-client-builds-with-metro';

  it('offers a dev-client project its Debug build and a Release one, and runs init once a Debug one is found', () => {
    expo();
    write('package.json', '{"dependencies":{"expo":"54.0.0","expo-dev-client":"6.0.0","react-native":"0.81.5"}}');
    expect(fix()).toContain('Build the Debug app with `npx expo run:android`');
    expect(fix()).toMatch(/-configuration Debug -sdk iphonesimulator -derivedDataPath build build`.*`npx expo run:ios`/);
    expect(fix().split(METRO)).toHaveLength(2);
    expect(fix()).toContain('./gradlew assembleRelease');
    write('android/settings.gradle');
    write('android/app/build/outputs/apk/debug/app-debug.apk');
    expect(fix()).toMatch(/^Run: .*\n/);
  });

  it.each<[string, () => void]>([
    ['native', () => undefined],
    ['Flutter', () => { write('pubspec.yaml', 'name: acme\nflutter:\n  uses-material-design: true\n'); }],
    ['bare React Native', () => write('package.json', '{"dependencies":{"react-native":"0.84.0"}}')],
    ['Expo', expo],
  ])('adds no Metro advice of its own to a %s project', (_name, setUp) => {
    setUp();
    write('android/settings.gradle');
    write('ios/Acme.xcodeproj/project.pbxproj');
    expect(fix()).toMatch(/^Run, once the app is built: /);
    expect(fix()).not.toContain(METRO);
    expect(fix()).not.toMatch(/dev client|expo-dev-client|run:android`|run:ios`/);
    // init needs a simulator .app for iOS: --package names an Android package.
    expect(fix()).toMatch(/--package <id> \(an Android app already installed/);
  });

  it('asks for the build\'s path where there is no app project', () => {
    expect(fix()).toMatch(/^Run, once the app is built: /);
    expect(fix()).toContain('--apk <path>');
    expect(fix()).toContain('--app <path>');
  });
});
