import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import {
  cmdlineToolsPlatform,
  extractCmdlineTools,
  findSdkTool,
  latestCmdlineToolsZip,
  resolveCreateAvdOptions,
  systemImageDir,
  systemImagePackage,
} from '../create-avd.js';
import { DEFAULT_API_LEVEL, DEFAULT_DEVICE_PROFILE, defaultAbi, defaultAvdName } from '../avd-defaults.js';
import type { CreateAvdCommandOptions } from '../cli-program.js';

describe('resolveCreateAvdOptions()', () => {
  const raw = (over: Partial<CreateAvdCommandOptions> = {}): CreateAvdCommandOptions => ({ force: false, installTools: false, ...over });

  it('applies defaults when no flags are given', () => {
    expect(resolveCreateAvdOptions(raw())).toEqual({
      api: DEFAULT_API_LEVEL,
      name: `Tapsmith_Phone_API_${DEFAULT_API_LEVEL}`,
      device: DEFAULT_DEVICE_PROFILE,
      abi: defaultAbi(),
      force: false,
      installTools: false,
    });
  });

  it('derives the default name from a custom API level', () => {
    expect(resolveCreateAvdOptions(raw({ api: '34' }))).toMatchObject({ api: 34, name: 'Tapsmith_Phone_API_34' });
  });

  it('keeps explicit name, device, abi, force, and install-tools', () => {
    const opts = resolveCreateAvdOptions(raw({ name: 'My_AVD', device: 'pixel_7', abi: 'x86_64', force: true, installTools: true }));
    expect(opts).toMatchObject({ name: 'My_AVD', device: 'pixel_7', abi: 'x86_64', force: true, installTools: true });
  });

  it('rejects invalid API levels', () => {
    for (const api of ['banana', '-3', '34.5', '0']) {
      expect(() => resolveCreateAvdOptions(raw({ api })), api).toThrow(/Invalid API level/);
    }
  });

  it('rejects invalid AVD names', () => {
    expect(() => resolveCreateAvdOptions(raw({ name: 'has spaces' }))).toThrow(/Invalid AVD name/);
  });

  it('accepts real avdmanager device ids, including ones with spaces and parens', () => {
    expect(resolveCreateAvdOptions(raw({ device: 'Nexus 5' })).device).toBe('Nexus 5');
    expect(resolveCreateAvdOptions(raw({ device: '7in WSVGA (Tablet)' })).device).toBe('7in WSVGA (Tablet)');
  });

  it('rejects device profiles and ABIs containing shell metacharacters', () => {
    expect(() => resolveCreateAvdOptions(raw({ device: 'pixel_7"&calc' }))).toThrow(/Invalid device profile/);
    expect(() => resolveCreateAvdOptions(raw({ device: 'a|b' }))).toThrow(/Invalid device profile/);
    expect(() => resolveCreateAvdOptions(raw({ abi: 'x86_64;rm -rf /' }))).toThrow(/Invalid ABI/);
    expect(() => resolveCreateAvdOptions(raw({ abi: '%PATH%' }))).toThrow(/Invalid ABI/);
  });
});

describe('defaultAbi()', () => {
  it('maps host architectures to emulator ABIs', () => {
    expect(defaultAbi('arm64')).toBe('arm64-v8a');
    expect(defaultAbi('x64')).toBe('x86_64');
  });
});

describe('systemImagePackage()', () => {
  it('always selects the rootable google_apis image', () => {
    expect(systemImagePackage(36, 'arm64-v8a')).toBe('system-images;android-36;google_apis;arm64-v8a');
    expect(systemImagePackage(33, 'x86_64')).toBe('system-images;android-33;google_apis;x86_64');
  });
});

describe('cmdlineToolsPlatform()', () => {
  it('maps Node platforms to Google zip platform keys', () => {
    expect(cmdlineToolsPlatform('darwin')).toBe('mac');
    expect(cmdlineToolsPlatform('linux')).toBe('linux');
    expect(cmdlineToolsPlatform('win32')).toBe('win');
  });
});

describe('latestCmdlineToolsZip()', () => {
  const xml = `
    <sdk:url>commandlinetools-linux-11076708_latest.zip</sdk:url>
    <sdk:url>commandlinetools-mac-6200805_latest.zip</sdk:url>
    <sdk:url>commandlinetools-mac-15641748_latest.zip</sdk:url>
    <sdk:url>commandlinetools-mac-11076708_latest.zip</sdk:url>
    <sdk:url>commandlinetools-win-15641748_latest.zip</sdk:url>
  `;

  it('picks the highest build number for the requested platform', () => {
    expect(latestCmdlineToolsZip(xml, 'mac')).toBe('commandlinetools-mac-15641748_latest.zip');
    expect(latestCmdlineToolsZip(xml, 'linux')).toBe('commandlinetools-linux-11076708_latest.zip');
  });

  it('returns undefined when the platform has no package', () => {
    expect(latestCmdlineToolsZip('<sdk/>', 'mac')).toBeUndefined();
  });
});

describe('extractCmdlineTools()', () => {
  it('unpacks into cmdline-tools/latest and marks bin/ entries executable', () => {
    const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdkroot-test-'));
    const zipData = zipSync({
      'cmdline-tools/bin/sdkmanager': new TextEncoder().encode('#!/bin/sh\necho hi\n'),
      'cmdline-tools/bin/avdmanager': new TextEncoder().encode('#!/bin/sh\necho hi\n'),
      'cmdline-tools/lib/tool.jar': new Uint8Array([1, 2, 3]),
      'cmdline-tools/source.properties': new TextEncoder().encode('Pkg.Revision=1\n'),
    });

    const dest = extractCmdlineTools(zipData, sdkRoot);

    expect(dest).toBe(path.join(sdkRoot, 'cmdline-tools', 'latest'));
    const sdkmanager = path.join(dest, 'bin', 'sdkmanager');
    expect(fs.existsSync(sdkmanager)).toBe(true);
    expect(fs.existsSync(path.join(dest, 'lib', 'tool.jar'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'source.properties'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(sdkmanager).mode & 0o100).toBeTruthy();
    }
  });

  it('ignores entries outside cmdline-tools/ and path traversal attempts', () => {
    const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdkroot-test-'));
    const zipData = zipSync({
      'other/evil.txt': new Uint8Array([1]),
      'cmdline-tools/../escape.txt': new Uint8Array([1]),
      'cmdline-tools/..\\..\\escape-win.txt': new Uint8Array([1]),
      'cmdline-tools/bin/ok': new Uint8Array([1]),
    });

    extractCmdlineTools(zipData, sdkRoot);

    expect(fs.existsSync(path.join(sdkRoot, 'escape.txt'))).toBe(false);
    expect(fs.existsSync(path.join(sdkRoot, 'escape-win.txt'))).toBe(false);
    expect(fs.existsSync(path.join(sdkRoot, 'other'))).toBe(false);
    const extracted = fs.readdirSync(path.join(sdkRoot, 'cmdline-tools', 'latest'));
    expect(extracted).toEqual(['bin']);
  });
});

describe('systemImageDir()', () => {
  it('matches where sdkmanager unpacks the image', () => {
    expect(systemImageDir('/sdk', 36, 'arm64-v8a'))
      .toBe(path.join('/sdk', 'system-images', 'android-36', 'google_apis', 'arm64-v8a'));
  });
});

describe('defaultAvdName()', () => {
  it('embeds the API level', () => {
    expect(defaultAvdName(36)).toBe('Tapsmith_Phone_API_36');
  });
});

describe('findSdkTool()', () => {
  it('prefers cmdline-tools/latest under ANDROID_HOME', () => {
    const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdk-test-'));
    const binDir = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const tool = path.join(binDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
    fs.writeFileSync(tool, '');
    expect(findSdkTool('sdkmanager', { ANDROID_HOME: sdkRoot })).toBe(tool);
  });

  it('falls back to the bare tool name when not found under the SDK root', () => {
    expect(findSdkTool('sdkmanager', { ANDROID_HOME: '/nonexistent' }))
      .toBe(process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
    expect(findSdkTool('avdmanager', {})).toBe(process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager');
  });
});
