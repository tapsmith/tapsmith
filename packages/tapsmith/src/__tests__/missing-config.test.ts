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
const fix = (cli = 'npx tapsmith', isMacOS = true): string => missingConfigFix(dir, cli, isMacOS);

describe('missingConfigFix()', () => {
  it('runs init when the app is built, and says what init writes', () => {
    write(APK);
    expect(fix()).toMatch(/^Run: npx tapsmith init --yes --json \(or npx tapsmith init for the wizard\)\. It writes the config, and the AGENTS\.md section/);
    expect(fix()).not.toContain('Build');
  });

  it('uses the project\'s own way to run Tapsmith', () => {
    expect(fix('pnpm exec tapsmith')).toContain('pnpm exec tapsmith init --yes --json');
    expect(fix('pnpm exec tapsmith')).not.toContain('npx tapsmith');
  });

  // `init --yes` fails there with NO_PLATFORM, which an agent took as "later" and never came back (PILOT-1442).
  it('builds an Expo project with no native folders first, for each platform this host can build', () => {
    expo();
    expect(fix()).toMatch(/^Build the app first, then run: npx tapsmith init --yes --json/);
    expect(fix()).toContain('npx expo prebuild --platform android');
    expect(fix()).toContain('npx expo prebuild --platform ios');
    expect(fix('npx tapsmith', false)).not.toContain('npx expo prebuild --platform ios');
  });

  it('builds every platform that has no build yet', () => {
    write('package.json', '{"dependencies":{"react-native":"0.84.0"}}');
    write('android/settings.gradle');
    write('ios/Acme.xcodeproj/project.pbxproj');
    expect(fix()).toMatch(/^Build the app first/);
    expect(fix()).toContain('./gradlew assembleDebug');
    expect(fix()).toContain('xcodebuild -project Acme.xcodeproj');
    expect(fix('npx tapsmith', false)).not.toContain('xcodebuild');
    write(APK);
    write(IOS_APP);
    expect(fix()).toMatch(/^Run: /);
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
    expect(fix()).toMatch(/^Build the app first/);
    expect(fix()).toContain('To set up only Android, which is built: npx tapsmith init --yes --json --platform android.');
    expect(fix()).not.toContain('./gradlew');
    // Off macOS init leaves iOS out, so the APK is all it needs.
    expect(fix('npx tapsmith', false)).toMatch(/^Run: /);
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
    expect(fix()).toMatch(/^Run: /);
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
    expect(fix()).toMatch(/^Build the app first/);
    expect(fix()).not.toContain(METRO);
    expect(fix()).not.toMatch(/dev client|expo-dev-client|run:android`|run:ios`/);
    // init needs a simulator .app for iOS: --package names an Android package.
    expect(fix()).toMatch(/--package <id> \(an Android app already installed/);
  });

  it('asks for the build\'s path where there is no app project', () => {
    expect(fix()).toMatch(/^Build the app first/);
    expect(fix()).toContain('--apk <path>');
    expect(fix()).toContain('--app <path>');
  });
});
