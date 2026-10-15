/**
 * The pure checks behind `npm run check:clean-install` (PILOT-405, PILOT-437,
 * PILOT-438). The script itself needs a packed tarball and the network, so it
 * runs as a CI step; these pin what it counts as a failure, so a check that
 * silently stops firing (a changed npm label, a scoped name the parser drops)
 * is caught here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_INSTALL_SCRIPTS,
  deprecationLines,
  disallowedInstallScripts,
  installScriptsOf,
  nonExecutableFiles,
  npmReportsInstallScripts,
  packEntry,
  parseInstallScriptWarnings,
  testPaths,
  undeclaredPlatformFields,
} from '../../scripts/clean-install-checks.mjs';

// ─── Fixtures: real npm output (npm 11.17.0 and 12.2.0, Oct 2026) ───

const NPM_11_17 = `npm warn deprecated glob@11.1.0: Old versions of glob are not supported
added 173 packages, and audited 174 packages in 7s
npm warn allow-scripts 3 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   @tapsmith/core-darwin-arm64@0.5.0 (postinstall: node -e "for(const f of ['tapsmith-core','tapsmith-ios-hid']){try{require('fs').chmodSync(f,0o755)}catch(e){console.warn('tapsmith: chmod '+f+' failed:',e.message)}}")
npm warn allow-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
npm warn allow-scripts   esbuild@0.28.2 (postinstall: node install.js)
npm warn allow-scripts
npm warn allow-scripts Run \`npm approve-scripts --allow-scripts-pending\` to review, or \`npm approve-scripts <pkg>\` to allow.
`;

const NPM_12_2 = `npm warn install-scripts 4 packages had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   @tapsmith/core-darwin-arm64@0.5.0 (postinstall: node -e "chmod")
npm warn install-scripts   protobufjs@7.6.6 (postinstall: node scripts/postinstall)
npm warn install-scripts   esbuild@0.28.2 (postinstall: node install.js)
npm warn install-scripts   fsevents@2.3.3 (install: node-gyp rebuild)
npm warn install-scripts
npm warn install-scripts Run \`npm install-scripts ls\` to review, or \`npm install-scripts approve <pkg>\` to allow.
`;

// ─── Install-script warnings ───

describe('parseInstallScriptWarnings', () => {
  it('reads every package from the npm 11.17 allow-scripts warning, scoped names included', () => {
    expect(parseInstallScriptWarnings(NPM_11_17)).toEqual({
      entries: [
        { name: '@tapsmith/core-darwin-arm64', version: '0.5.0', line: expect.stringContaining('@tapsmith/core-darwin-arm64@0.5.0') },
        { name: 'protobufjs', version: '7.6.6', line: expect.stringContaining('protobufjs@7.6.6') },
        { name: 'esbuild', version: '0.28.2', line: expect.stringContaining('esbuild@0.28.2') },
      ],
      unrecognised: [],
    });
  });

  it('reads the npm 12 install-scripts (blocked) warning too', () => {
    const { entries, unrecognised } = parseInstallScriptWarnings(NPM_12_2);
    expect(entries.map((e) => e.name)).toEqual(['@tapsmith/core-darwin-arm64', 'protobufjs', 'esbuild', 'fsevents']);
    expect(unrecognised).toEqual([]);
  });

  it('reads an entry whose script npm only describes', () => {
    expect(parseInstallScriptWarnings('npm warn allow-scripts   fsevents@2.3.3 (install: (install scripts present))\n').entries)
      .toEqual([{ name: 'fsevents', version: '2.3.3', line: expect.any(String) }]);
  });

  it('ignores the header (singular too), blank and advice lines, and CRLF output', () => {
    const output = [
      'npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:',
      'npm warn allow-scripts   esbuild@0.28.2 (postinstall: node install.js)',
      'npm warn allow-scripts',
      'npm warn allow-scripts Run `npm approve-scripts --allow-scripts-pending` to review.',
    ].join('\r\n');
    expect(parseInstallScriptWarnings(output)).toEqual({
      entries: [{ name: 'esbuild', version: '0.28.2', line: expect.any(String) }],
      unrecognised: [],
    });
  });

  it('reports the lines of a multi-line script instead of dropping the entry (real npm 11.17 output)', () => {
    const output = [
      'npm warn allow-scripts 1 package has install scripts not yet covered by allowScripts:',
      'npm warn allow-scripts   @x/pp@1.0.0 (postinstall: echo a',
      'npm warn allow-scripts echo b)',
      'npm warn allow-scripts',
    ].join('\n');
    const { entries, unrecognised } = parseInstallScriptWarnings(output);
    expect(entries.map((e) => e.name)).toEqual(['@x/pp']);
    expect(unrecognised).toEqual(['npm warn allow-scripts echo b)']);
  });

  it('reports an entry line in a format it does not know', () => {
    expect(parseInstallScriptWarnings('npm warn install-scripts   - weird-format entry\n').unrecognised)
      .toEqual(['npm warn install-scripts   - weird-format entry']);
  });
});

describe('disallowedInstallScripts', () => {
  it('passes the documented third-party packages and fails our own', () => {
    const { entries } = parseInstallScriptWarnings(NPM_12_2);
    expect(disallowedInstallScripts(entries).map((e) => e.name)).toEqual(['@tapsmith/core-darwin-arm64']);
  });

  it('fails a package nobody has vetted', () => {
    const { entries } = parseInstallScriptWarnings('npm warn allow-scripts   left-pad@1.0.0 (postinstall: node x.js)\n');
    expect(disallowedInstallScripts(entries).map((e) => e.name)).toEqual(['left-pad']);
  });

  it('never allows a @tapsmith package, even if one were added to the allowlist', () => {
    const allow = { ...ALLOWED_INSTALL_SCRIPTS, '@tapsmith/agent-android': 'oops' };
    const entries = [{ name: '@tapsmith/agent-android', version: '1.0.0', line: '' }];
    expect(disallowedInstallScripts(entries, allow)).toEqual(entries);
  });

  it('gives every allowlisted package a reason', () => {
    for (const [name, reason] of Object.entries(ALLOWED_INSTALL_SCRIPTS)) {
      expect(name.startsWith('@tapsmith/')).toBe(false);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe('npmReportsInstallScripts', () => {
  it.each([
    ['11.17.0', true],
    ['11.17.3', true],
    ['11.18.0', true],
    ['12.2.0', true],
    ['11.16.9', false],
    ['10.9.2', false],
    ['11.17.0-pre.1', false],
    ['not-a-version', false],
  ])('npm %s → %s', (version, expected) => {
    expect(npmReportsInstallScripts(version)).toBe(expected);
  });
});

// ─── Deprecations (PILOT-405) ───

describe('deprecationLines', () => {
  it('returns only the deprecation warnings', () => {
    expect(deprecationLines(NPM_11_17)).toEqual([expect.stringMatching(/^npm warn deprecated glob@11\.1\.0/)]);
    expect(deprecationLines(NPM_12_2)).toEqual([]);
  });
});

// ─── Package contents ───

describe('packEntry', () => {
  const entry = { filename: 'tapsmith-0.5.0.tgz', files: [], entryCount: 0, size: 1, unpackedSize: 1 };

  it('reads npm 11 output (an array) and npm 12 output (keyed by name)', () => {
    expect(packEntry(JSON.stringify([entry]))).toEqual(entry);
    expect(packEntry(JSON.stringify({ tapsmith: entry }))).toEqual(entry);
  });

  it('refuses output it does not recognise rather than checking nothing', () => {
    expect(() => packEntry('[]')).toThrow(/unexpected `npm pack --json` output/);
    expect(() => packEntry(JSON.stringify({ a: entry, b: entry }))).toThrow(/unexpected/);
    expect(() => packEntry(JSON.stringify({ tapsmith: { files: [] } }))).toThrow(/unexpected/);
  });
});

describe('testPaths', () => {
  it('finds a __tests__ directory at any depth, and nothing else', () => {
    expect(testPaths([
      { path: 'dist/index.js' },
      { path: 'dist/__tests__/device.test.js' },
      { path: 'dist/trace/__tests__/x.js' },
      { path: 'dist/not__tests__x.js' },
    ])).toEqual(['dist/__tests__/device.test.js', 'dist/trace/__tests__/x.js']);
  });
});

describe('installScriptsOf', () => {
  it('names each lifecycle script npm runs on install', () => {
    expect(installScriptsOf({ scripts: { postinstall: 'x', preinstall: 'y', install: 'z', build: 'tsc' } }))
      .toEqual(['preinstall', 'install', 'postinstall']);
    expect(installScriptsOf({ scripts: { test: 'vitest' } })).toEqual([]);
    expect(installScriptsOf({})).toEqual([]);
  });
});

describe('nonExecutableFiles', () => {
  const packed = [
    { path: 'package.json', mode: 0o644 },
    { path: 'tapsmith-core', mode: 0o755 },
    { path: 'tapsmith-ios-hid', mode: 0o744 },
  ];

  it('flags a binary that is not executable by everyone', () => {
    expect(nonExecutableFiles(packed, ['tapsmith-core', 'tapsmith-ios-hid'])).toEqual(['tapsmith-ios-hid (mode 744)']);
  });

  it('flags a binary that is missing from the tarball', () => {
    expect(nonExecutableFiles(packed, ['tapsmith-core', 'gone'])).toEqual(['gone (not in the tarball)']);
  });
});

describe('undeclaredPlatformFields (PILOT-709)', () => {
  it('names the field pnpm 11+ would infer from a platform word in the name', () => {
    // pnpm reads `-android` as `os: ["android"]` and skips the optional
    // dependency on every machine that can run Tapsmith.
    expect(undeclaredPlatformFields({ name: '@tapsmith/agent-android' })).toEqual(['os']);
    expect(undeclaredPlatformFields({ name: '@tapsmith/core-linux-x64' })).toEqual(['os', 'cpu']);
    expect(undeclaredPlatformFields({ name: 'some_pkg.win32.musl' })).toEqual(['os', 'libc']);
  });

  it('is satisfied once the inferable fields are declared', () => {
    expect(undeclaredPlatformFields({ name: '@tapsmith/agent-android', os: ['darwin', 'linux', 'win32'] })).toEqual([]);
    expect(undeclaredPlatformFields({ name: '@tapsmith/core-linux-x64', os: ['linux'], cpu: ['x64'] })).toEqual([]);
  });

  it('ignores the scope and words that are not platform tokens', () => {
    expect(undeclaredPlatformFields({ name: '@android/tools' })).toEqual([]);
    expect(undeclaredPlatformFields({ name: 'tapsmith' })).toEqual([]);
    expect(undeclaredPlatformFields({ name: 'androidx-thing' })).toEqual([]);
  });

  it('holds for every package under npm-packages/', () => {
    const root = path.resolve(import.meta.dirname, '../../../../npm-packages');
    const offenders = fs.readdirSync(root)
      .map((dir) => path.join(root, dir, 'package.json'))
      .filter((file) => fs.existsSync(file))
      .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string })
      .flatMap((pkg) => undeclaredPlatformFields(pkg).map((field) => `${pkg.name}: ${field}`));
    expect(offenders).toEqual([]);
  });
});
