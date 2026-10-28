import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { derivedDataBuildWarning, detectGradleApplicationId, detectProjectLayout, findDerivedDataApps, nativeBuildHint, parseAapt2Badging, findApkCandidates, findIosAppCandidates, findIosDeviceAppCandidates, preferDebugApk, resolveAapt2 } from '../init-detect.js';

describe('parseAapt2Badging()', () => {
  it('extracts the package name', () => {
    const out = "package: name='com.example.app' versionCode='1' versionName='1.0'";
    expect(parseAapt2Badging(out)).toBe('com.example.app');
  });

  it('returns undefined when no package line present', () => {
    expect(parseAapt2Badging('garbage output')).toBeUndefined();
  });
});

describe('findApkCandidates()', () => {
  it('finds APKs under android/ build outputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const apkDir = path.join(tmp, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, 'app-debug.apk'), '');
    try {
      const found = findApkCandidates(tmp);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('app-debug.apk');
      expect(path.isAbsolute(found[0])).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('excludes instrumentation APK outputs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const appDir = path.join(tmp, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
    const androidTestDir = path.join(tmp, 'android', 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug');
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(androidTestDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'app-debug.apk'), '');
    fs.writeFileSync(path.join(androidTestDir, 'app-debug-androidTest.apk'), '');
    try {
      expect(findApkCandidates(tmp)).toEqual(['android/app/build/outputs/apk/debug/app-debug.apk']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty array when nothing matches', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    try {
      expect(findApkCandidates(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('preferDebugApk()', () => {
  it('narrows to debug APKs when both exist', () => {
    const candidates = ['android/app/build/outputs/apk/release/app-release.apk', 'android/app/build/outputs/apk/debug/app-debug.apk'];
    expect(preferDebugApk(candidates)).toEqual(['android/app/build/outputs/apk/debug/app-debug.apk']);
  });

  it('returns all candidates when none are debug', () => {
    const candidates = ['a/app-release.apk', 'b/app-prod.apk'];
    expect(preferDebugApk(candidates)).toEqual(candidates);
  });
});

describe('findIosAppCandidates()', () => {
  it('finds simulator .app bundles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const appDir = path.join(tmp, 'ios', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app');
    fs.mkdirSync(appDir, { recursive: true });
    try {
      const found = findIosAppCandidates(tmp);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('MyApp.app');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('findIosDeviceAppCandidates() (PILOT-513)', () => {
  it('finds device (iphoneos) .app bundles and leaves simulator builds out', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-'));
    const products = path.join(tmp, 'ios', 'build', 'Build', 'Products');
    fs.mkdirSync(path.join(products, 'Release-iphoneos', 'MyApp.app'), { recursive: true });
    fs.mkdirSync(path.join(products, 'Debug-iphonesimulator', 'MyApp.app'), { recursive: true });
    try {
      expect(findIosDeviceAppCandidates(tmp)).toEqual(['ios/build/Build/Products/Release-iphoneos/MyApp.app']);
      expect(findIosAppCandidates(tmp)).toEqual(['ios/build/Build/Products/Debug-iphonesimulator/MyApp.app']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── Native project layouts (PILOT-832) ───

function withTmp(fn: (dir: string) => void): void {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-detect-')));
  try {
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function touch(file: string, content = ''): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

describe('detectProjectLayout() (PILOT-832)', () => {
  it('reads a React Native layout from android/ and ios/', () => withTmp((tmp) => {
    touch(path.join(tmp, 'android', 'settings.gradle'));
    fs.mkdirSync(path.join(tmp, 'ios', 'MyApp.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'ios', 'MyApp.xcodeproj'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: 'android', iosProjects: ['ios/MyApp.xcworkspace', 'ios/MyApp.xcodeproj'], hasIosDir: true });
  }));

  it('reads a native Xcode project at the root (xcodegen, Xcode\'s App template)', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'Notekeeper.xcodeproj', 'project.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'Notekeeper'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: undefined, iosProjects: ['Notekeeper.xcodeproj'], hasIosDir: false });
  }));

  it('reads a native Gradle project at the root (Android Studio\'s templates), Kotlin or Groovy DSL', () => {
    for (const settings of ['settings.gradle.kts', 'settings.gradle']) {
      withTmp((tmp) => {
        touch(path.join(tmp, settings));
        touch(path.join(tmp, 'app', 'build.gradle.kts'));
        expect(detectProjectLayout(tmp)).toEqual({ androidRoot: '.', iosProjects: [], hasIosDir: false });
      });
    }
  });

  it('finds an Xcode project one folder down beside a root Gradle project (Kotlin Multiplatform)', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle.kts'));
    fs.mkdirSync(path.join(tmp, 'iosApp', 'iosApp.xcodeproj'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: '.', iosProjects: ['iosApp/iosApp.xcodeproj'], hasIosDir: false });
  }));

  it('ignores Xcode projects inside node_modules, Pods and build output', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'some-lib', 'Lib.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'Pods', 'Pods.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build', 'Thing.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.hidden', 'Thing.xcodeproj'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: undefined, iosProjects: [], hasIosDir: false });
  }));

  it('finds nothing in an empty directory', () => withTmp((tmp) => {
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: undefined, iosProjects: [], hasIosDir: false });
  }));
});

describe('build discovery in native layouts (PILOT-832)', () => {
  it('finds an Android Studio project\'s APK at <module>/build/outputs/apk', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle.kts'));
    touch(path.join(tmp, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    touch(path.join(tmp, 'app', 'build', 'outputs', 'apk', 'androidTest', 'debug', 'app-debug-androidTest.apk'));
    touch(path.join(tmp, 'composeApp', 'build', 'outputs', 'apk', 'release', 'composeApp-release-unsigned.apk'));
    expect(findApkCandidates(tmp)).toEqual([
      'app/build/outputs/apk/debug/app-debug.apk',
      'composeApp/build/outputs/apk/release/composeApp-release-unsigned.apk',
    ]);
  }));

  it('leaves APKs inside node_modules out', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle.kts'));
    touch(path.join(tmp, 'node_modules', 'lib', 'android', 'build', 'outputs', 'apk', 'debug', 'lib-debug.apk'));
    expect(findApkCandidates(tmp)).toEqual([]);
  }));

  it('finds a simulator build written by -derivedDataPath build at the root', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'Notekeeper.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'Notekeeper.app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build', 'Build', 'Products', 'Debug-iphoneos', 'Notekeeper.app'), { recursive: true });
    expect(findIosAppCandidates(tmp)).toEqual(['build/Build/Products/Debug-iphonesimulator/Notekeeper.app']);
    expect(findIosDeviceAppCandidates(tmp)).toEqual(['build/Build/Products/Debug-iphoneos/Notekeeper.app']);
  }));

  it('leaves XCUITest runners, nested bundles and node_modules builds out', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'Notekeeper.xcodeproj'), { recursive: true });
    const products = path.join(tmp, 'build', 'Build', 'Products', 'Debug-iphonesimulator');
    fs.mkdirSync(path.join(products, 'Notekeeper.app', 'Watch', 'Debug-iphonesimulator', 'Inner.app'), { recursive: true });
    fs.mkdirSync(path.join(products, 'NotekeeperUITests-Runner.app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'x', 'Debug-iphonesimulator', 'X.app'), { recursive: true });
    expect(findIosAppCandidates(tmp)).toEqual(['build/Build/Products/Debug-iphonesimulator/Notekeeper.app']);
  }));
});

describe('findDerivedDataApps() (PILOT-832)', () => {
  function derivedData(root: string, dir: string, workspacePath: string | undefined, apps: string[]): void {
    const base = path.join(root, dir);
    fs.mkdirSync(base, { recursive: true });
    if (workspacePath !== undefined) {
      fs.writeFileSync(path.join(base, 'info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>LastAccessedDate</key>
	<date>2026-10-21T12:00:00Z</date>
	<key>WorkspacePath</key>
	<string>${workspacePath}</string>
</dict>
</plist>
`);
    }
    for (const app of apps) fs.mkdirSync(path.join(base, 'Build', 'Products', app), { recursive: true });
  }

  it('finds this project\'s builds in Xcode\'s default DerivedData, matched by WorkspacePath', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'Notekeeper.xcodeproj'), { recursive: true });
    const dd = path.join(tmp, 'DerivedData');
    derivedData(dd, 'Notekeeper-abcdefghijklmnopqrstuvwxyzab', path.join(project, 'Notekeeper.xcodeproj'), ['Debug-iphonesimulator/Notekeeper.app', 'Debug-iphoneos/Notekeeper.app', 'Debug-iphonesimulator/NotekeeperUITests-Runner.app']);
    // Another checkout of a project with the same name, and a folder with no info.plist.
    derivedData(dd, 'Notekeeper-zzzzzzzzzzzzzzzzzzzzzzzzzzzz', '/elsewhere/Notekeeper.xcodeproj', ['Debug-iphonesimulator/Notekeeper.app']);
    derivedData(dd, 'Notekeeper-yyyyyyyyyyyyyyyyyyyyyyyyyyyy', undefined, ['Debug-iphonesimulator/Notekeeper.app']);
    const base = path.join(dd, 'Notekeeper-abcdefghijklmnopqrstuvwxyzab', 'Build', 'Products');
    expect(findDerivedDataApps(project, ['Notekeeper.xcodeproj'], 'iphonesimulator', dd)).toEqual([path.join(base, 'Debug-iphonesimulator', 'Notekeeper.app')]);
    expect(findDerivedDataApps(project, ['Notekeeper.xcodeproj'], 'iphoneos', dd)).toEqual([path.join(base, 'Debug-iphoneos', 'Notekeeper.app')]);
  }));

  it('matches a workspace by its own path', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'ios', 'MyApp.xcworkspace'), { recursive: true });
    const dd = path.join(tmp, 'DerivedData');
    derivedData(dd, 'MyApp-abcdefghijklmnopqrstuvwxyzab', path.join(project, 'ios', 'MyApp.xcworkspace'), ['Release-iphonesimulator/MyApp.app']);
    expect(findDerivedDataApps(project, ['ios/MyApp.xcworkspace'], 'iphonesimulator', dd)).toHaveLength(1);
  }));

  it('returns nothing without DerivedData or without an Xcode project', () => withTmp((tmp) => {
    expect(findDerivedDataApps(tmp, ['A.xcodeproj'], 'iphonesimulator', path.join(tmp, 'missing'))).toEqual([]);
    expect(findDerivedDataApps(tmp, [], 'iphonesimulator', tmp)).toEqual([]);
  }));
});

describe('resolveAapt2() (PILOT-832, PILOT-516)', () => {
  const notOnPath = (): boolean => false;

  it('finds the newest aapt2 in Android Studio\'s default SDK without ANDROID_HOME', () => withTmp((home) => {
    const buildTools = path.join(home, 'Library', 'Android', 'sdk', 'build-tools');
    touch(path.join(buildTools, '34.0.0', 'aapt2'));
    touch(path.join(buildTools, '35.0.0', 'aapt2'));
    fs.mkdirSync(path.join(buildTools, '36.0.0'), { recursive: true }); // no aapt2 in it
    expect(resolveAapt2({ env: {}, platform: 'darwin', home, onPath: notOnPath })).toBe(path.join(buildTools, '35.0.0', 'aapt2'));
  }));

  it('prefers aapt2 on PATH, then ANDROID_HOME, over the default SDK', () => withTmp((home) => {
    touch(path.join(home, 'Library', 'Android', 'sdk', 'build-tools', '35.0.0', 'aapt2'));
    const custom = path.join(home, 'custom-sdk');
    touch(path.join(custom, 'build-tools', '30.0.3', 'aapt2'));
    expect(resolveAapt2({ env: { ANDROID_HOME: custom }, platform: 'darwin', home, onPath: notOnPath })).toBe(path.join(custom, 'build-tools', '30.0.3', 'aapt2'));
    expect(resolveAapt2({ env: { ANDROID_HOME: custom }, platform: 'darwin', home, onPath: () => true })).toBe('aapt2');
  }));

  it('uses ~/Android/Sdk on Linux, and falls back to a bare aapt2 when no SDK has it', () => withTmp((home) => {
    expect(resolveAapt2({ env: {}, platform: 'linux', home, onPath: notOnPath })).toBe('aapt2');
    touch(path.join(home, 'Android', 'Sdk', 'build-tools', '35.0.0', 'aapt2'));
    expect(resolveAapt2({ env: {}, platform: 'linux', home, onPath: notOnPath })).toBe(path.join(home, 'Android', 'Sdk', 'build-tools', '35.0.0', 'aapt2'));
  }));
});

describe('searching a project in a folder with a skipped name (PILOT-832)', () => {
  it('still searches a project whose own folder is named build', () => withTmp((tmp) => {
    const project = path.join(tmp, 'build');
    fs.mkdirSync(path.join(project, 'App.xcodeproj'), { recursive: true });
    touch(path.join(project, 'settings.gradle.kts'));
    touch(path.join(project, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    expect(detectProjectLayout(project).iosProjects).toEqual(['App.xcodeproj']);
    expect(findApkCandidates(project)).toEqual(['app/build/outputs/apk/debug/app-debug.apk']);
  }));
});

describe('names with spaces and nested iOS projects (PILOT-832)', () => {
  it('quotes a project, scheme or folder with a space in the xcodebuild hint', () => {
    const hint = nativeBuildHint('ios', { androidRoot: undefined, iosProjects: ['My Apps/My App.xcodeproj'], hasIosDir: false }, false);
    expect(hint).toContain("`cd 'My Apps' && xcodebuild -project 'My App.xcodeproj' -scheme 'My App' -configuration Debug");
    expect(hint).toContain('under My Apps/build/Build/Products/Debug-iphonesimulator/');
  });

  it('finds a DerivedData build of a project whose name has a space (Xcode writes My_App-<hash>)', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'My App.xcodeproj'), { recursive: true });
    const dir = path.join(tmp, 'DerivedData', 'My_App-abcdefghijklmnopqrstuvwxyzab');
    fs.mkdirSync(path.join(dir, 'Build', 'Products', 'Debug-iphonesimulator', 'My App.app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'info.plist'), `<plist version="1.0"><dict><key>WorkspacePath</key><string>${path.join(project, 'My App.xcodeproj')}</string></dict></plist>`);
    expect(findDerivedDataApps(project, ['My App.xcodeproj'], 'iphonesimulator', path.join(tmp, 'DerivedData')))
      .toEqual([path.join(dir, 'Build', 'Products', 'Debug-iphonesimulator', 'My App.app')]);
  }));

  it('finds an Xcode project one folder down inside ios/ (Capacitor\'s ios/App/App.xcworkspace)', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'ios', 'App', 'App.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'ios', 'App', 'Pods', 'Pods.xcodeproj'), { recursive: true });
    expect(detectProjectLayout(tmp).iosProjects).toEqual(['ios/App/App.xcworkspace', 'ios/App/App.xcodeproj']);
  }));
});

describe('where builds are searched for (PILOT-832)', () => {
  it('searches nothing outside an Android or iOS project (a home directory, say)', () => withTmp((tmp) => {
    touch(path.join(tmp, 'Downloads', 'other', 'build', 'outputs', 'apk', 'debug', 'x.apk'));
    fs.mkdirSync(path.join(tmp, 'Downloads', 'Debug-iphonesimulator', 'X.app'), { recursive: true });
    expect(findApkCandidates(tmp)).toEqual([]);
    expect(findIosAppCandidates(tmp)).toEqual([]);
  }));

  it('searches only android/ and ios/ in a React Native project', () => withTmp((tmp) => {
    touch(path.join(tmp, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    touch(path.join(tmp, 'vendor', 'lib', 'build', 'outputs', 'apk', 'debug', 'lib-debug.apk'));
    fs.mkdirSync(path.join(tmp, 'ios', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'vendor', 'Debug-iphonesimulator', 'Other.app'), { recursive: true });
    expect(findApkCandidates(tmp)).toEqual(['android/app/build/outputs/apk/debug/app-debug.apk']);
    expect(findIosAppCandidates(tmp)).toEqual(['ios/build/Build/Products/Debug-iphonesimulator/App.app']);
  }));

  it('finds a build in a project folder named DerivedData (-derivedDataPath DerivedData)', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'ios', 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app'), { recursive: true });
    expect(findIosAppCandidates(tmp)).toEqual(['ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app']);
  }));

  it('prefers the workspace\'s DerivedData build over the bare project\'s beside it', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'ios', 'App.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(project, 'ios', 'App.xcodeproj'), { recursive: true });
    const dd = path.join(tmp, 'DerivedData');
    for (const [dir, ws] of [['App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'App.xcworkspace'], ['App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'App.xcodeproj']]) {
      fs.mkdirSync(path.join(dd, dir, 'Build', 'Products', 'Debug-iphonesimulator', 'App.app'), { recursive: true });
      fs.writeFileSync(path.join(dd, dir, 'info.plist'), `<plist><dict><key>WorkspacePath</key><string>${path.join(project, 'ios', ws)}</string></dict></plist>`);
    }
    expect(findDerivedDataApps(project, ['ios/App.xcworkspace', 'ios/App.xcodeproj'], 'iphonesimulator', dd))
      .toEqual([path.join(dd, 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app')]);
  }));

  it('hints a Release iOS build for React Native, whose Debug build needs Metro', () => {
    const layout = { androidRoot: 'android' as const, iosProjects: ['ios/App.xcworkspace'], hasIosDir: true };
    const hint = nativeBuildHint('ios', layout, true);
    expect(hint).toContain('`cd ios && xcodebuild -workspace App.xcworkspace -scheme App -configuration Release -sdk iphonesimulator -derivedDataPath build build`');
    expect(hint).toContain('under ios/build/Build/Products/Release-iphonesimulator/');
    expect(hint).toContain('Metro');
    expect(nativeBuildHint('ios', layout, false)).toContain('-configuration Debug');
  });
});

describe('case and React Native corners (PILOT-832)', () => {
  it('does not take a native project\'s iOS/ source folder for React Native\'s ios/ (case-insensitive disks)', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'MyApp.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'iOS'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'Shared'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: undefined, iosProjects: ['MyApp.xcodeproj'], hasIosDir: false });
    expect(findIosAppCandidates(tmp)).toEqual(['build/Build/Products/Debug-iphonesimulator/MyApp.app']);
  }));

  it('gives the Release build in the DerivedData warning for React Native', () => {
    const layout = { androidRoot: 'android' as const, iosProjects: ['ios/App.xcworkspace'], hasIosDir: true };
    expect(derivedDataBuildWarning('/dd/App.app', layout, 'iphonesimulator', true)).toContain('-configuration Release');
    expect(derivedDataBuildWarning('/dd/App.app', layout, 'iphonesimulator', false)).toContain('-configuration Debug');
  });
});

describe('DerivedData workspace preference with an unbuilt workspace (PILOT-832)', () => {
  it('keeps the bare project\'s build when the workspace\'s DerivedData folder holds none', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'ios', 'App.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(project, 'ios', 'App.xcodeproj'), { recursive: true });
    const dd = path.join(tmp, 'DerivedData');
    const plist = (ws: string): string => `<plist><dict><key>WorkspacePath</key><string>${path.join(project, 'ios', ws)}</string></dict></plist>`;
    fs.mkdirSync(path.join(dd, 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa'), { recursive: true });
    fs.writeFileSync(path.join(dd, 'App-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'info.plist'), plist('App.xcworkspace'));
    const app = path.join(dd, 'App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(dd, 'App-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'info.plist'), plist('App.xcodeproj'));
    expect(findDerivedDataApps(project, ['ios/App.xcworkspace', 'ios/App.xcodeproj'], 'iphonesimulator', dd)).toEqual([app]);
  }));
});

describe('DerivedData workspace preference is per project (PILOT-832)', () => {
  it('keeps an unrelated project\'s build beside a workspace of another name', () => withTmp((tmp) => {
    const project = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(project, 'Main.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(project, 'Sample.xcodeproj'), { recursive: true });
    const dd = path.join(tmp, 'DerivedData');
    const apps: string[] = [];
    for (const [dir, ws, app] of [['Main-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Main.xcworkspace', 'Main.app'], ['Sample-bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Sample.xcodeproj', 'Sample.app']]) {
      const appDir = path.join(dd, dir, 'Build', 'Products', 'Debug-iphonesimulator', app);
      fs.mkdirSync(appDir, { recursive: true });
      apps.push(appDir);
      fs.writeFileSync(path.join(dd, dir, 'info.plist'), `<plist><dict><key>WorkspacePath</key><string>${path.join(project, ws)}</string></dict></plist>`);
    }
    expect(findDerivedDataApps(project, ['Main.xcworkspace', 'Sample.xcodeproj'], 'iphonesimulator', dd)).toEqual(apps);
  }));
});

describe('a native repository\'s Android/ Gradle project (PILOT-832)', () => {
  it('detects Android/ beside iOS/ when it is a Gradle project, and finds its APK', () => withTmp((tmp) => {
    touch(path.join(tmp, 'Android', 'settings.gradle'));
    touch(path.join(tmp, 'Android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    fs.mkdirSync(path.join(tmp, 'iOS', 'App.xcodeproj'), { recursive: true });
    const layout = detectProjectLayout(tmp);
    expect(layout).toEqual({ androidRoot: 'Android', iosProjects: ['iOS/App.xcodeproj'], hasIosDir: false });
    expect(findApkCandidates(tmp)).toEqual(['Android/app/build/outputs/apk/debug/app-debug.apk']);
    expect(nativeBuildHint('android', layout, false)).toContain('`cd Android && ./gradlew assembleDebug`');
  }));

  it('does not take an Android/ folder of sources for a Gradle project', () => withTmp((tmp) => {
    touch(path.join(tmp, 'Android', 'Notes.md'));
    expect(detectProjectLayout(tmp).androidRoot).toBeUndefined();
  }));
});

describe('root Gradle projects with an android/ module, and iOS/<App>/ projects (PILOT-832)', () => {
  it('keeps the root as the Gradle project when android/ is one of its modules (libGDX)', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle'));
    touch(path.join(tmp, 'gradlew'));
    touch(path.join(tmp, 'android', 'build.gradle'));
    touch(path.join(tmp, 'android', 'build', 'outputs', 'apk', 'debug', 'android-debug.apk'));
    touch(path.join(tmp, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'));
    const layout = detectProjectLayout(tmp);
    expect(layout.androidRoot).toBe('.');
    expect(findApkCandidates(tmp)).toEqual(['android/build/outputs/apk/debug/android-debug.apk', 'app/build/outputs/apk/debug/app-debug.apk']);
    expect(nativeBuildHint('android', layout, false)).not.toContain('cd android');
  }));

  it('still takes android/ when it has its own settings.gradle (React Native, or a repo root with android/ and ios/)', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle.kts'));
    touch(path.join(tmp, 'android', 'settings.gradle'));
    expect(detectProjectLayout(tmp).androidRoot).toBe('android');
  }));

  it('finds an Xcode project two folders down in a native iOS/ folder', () => withTmp((tmp) => {
    fs.mkdirSync(path.join(tmp, 'iOS', 'MyApp', 'MyApp.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'iOS', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app'), { recursive: true });
    expect(detectProjectLayout(tmp)).toEqual({ androidRoot: undefined, iosProjects: ['iOS/MyApp/MyApp.xcodeproj'], hasIosDir: false });
    expect(findIosAppCandidates(tmp)).toEqual(['iOS/build/Build/Products/Debug-iphonesimulator/MyApp.app']);
  }));
});

describe('iOS build search stays inside the Xcode project\'s folder (PILOT-832)', () => {
  it('in a home directory with a project one folder down, never walks Library/ (other projects\' DerivedData)', () => withTmp((home) => {
    fs.mkdirSync(path.join(home, 'MyApp', 'MyApp.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(home, 'MyApp', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'MyApp.app'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Library', 'Developer', 'Xcode', 'DerivedData', 'Other-abc', 'Build', 'Products', 'Debug-iphonesimulator', 'Other.app'), { recursive: true });
    fs.mkdirSync(path.join(home, 'Downloads', 'Debug-iphonesimulator', 'Stray.app'), { recursive: true });
    expect(findIosAppCandidates(home)).toEqual(['MyApp/build/Build/Products/Debug-iphonesimulator/MyApp.app']);
  }));

  it('also searches a root build/ beside a project one folder down (KMP built from the root)', () => withTmp((tmp) => {
    touch(path.join(tmp, 'settings.gradle.kts'));
    fs.mkdirSync(path.join(tmp, 'iosApp', 'iosApp.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'iosApp.app'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'iosApp', 'build', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app'), { recursive: true });
    expect(findIosAppCandidates(tmp)).toEqual([
      'build/Build/Products/Debug-iphonesimulator/iosApp.app',
      'iosApp/build/Build/Products/Debug-iphonesimulator/App.app',
    ]);
  }));
});

describe('detectGradleApplicationId() (PILOT-778)', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-gradle-id-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it('reads a Groovy applicationId from a React Native android/app/build.gradle', () => {
    write('android/settings.gradle', '');
    write('android/app/build.gradle', 'android {\n    defaultConfig {\n        applicationId "com.acme.rn"\n    }\n}\n');
    expect(detectGradleApplicationId(root)).toBe('com.acme.rn');
  });

  it('reads a Kotlin DSL applicationId from a native app/build.gradle.kts', () => {
    write('settings.gradle.kts', '');
    write('app/build.gradle.kts', 'android {\n  defaultConfig {\n    applicationId = "com.acme.compose"\n  }\n}\n');
    expect(detectGradleApplicationId(root)).toBe('com.acme.compose');
  });

  it('reads an id on the same line as its block', () => {
    write('settings.gradle', '');
    write('app/build.gradle', 'android { defaultConfig { applicationId "com.acme.oneline" } }\n');
    expect(detectGradleApplicationId(root)).toBe('com.acme.oneline');
  });

  it('ignores an id computed from a variable, a commented-out line, and a project with no Gradle root', () => {
    write('settings.gradle', '');
    write('app/build.gradle', '// applicationId "com.acme.old"\nandroid { defaultConfig { applicationId rootProject.ext.appId } }\n');
    expect(detectGradleApplicationId(root)).toBeUndefined();
    expect(detectGradleApplicationId(fs.mkdtempSync(path.join(root, 'empty-')))).toBeUndefined();
  });
});
