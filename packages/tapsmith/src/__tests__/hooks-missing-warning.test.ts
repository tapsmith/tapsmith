import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPreflightContext } from '../session-preflight.js';

// The warning is once per process, so every test loads a fresh module.
async function loadPreflight(): Promise<typeof import('../session-preflight.js')> {
  vi.resetModules();
  return import('../session-preflight.js');
}

const NO_MARKER = '<hierarchy><node package="com.example.app" text="Home" /></hierarchy>';
const MARKER = '<hierarchy><node package="com.example.app" text="tapsmith-hooks:1;epoch=0;nav=0;boot=ab;url=exp://x/" /></hierarchy>';

function makeContext(rootDir: string | undefined, config: Partial<SessionPreflightContext['config']> = {}, xml = NO_MARKER): SessionPreflightContext {
  return {
    label: 'Worker 0 (emulator-5554)',
    notices: [],
    config: { package: 'com.example.app', rootDir, ...config },
    device: {} as SessionPreflightContext['device'],
    client: {
      ping: vi.fn(),
      getUiHierarchy: vi.fn(async () => ({ requestId: '1', hierarchyXml: xml, errorMessage: '' })),
    } as unknown as SessionPreflightContext['client'],
  };
}

function writePackageJson(dir: string, deps: Record<string, string>, devDeps: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: deps, devDependencies: devDeps }));
}

describe('warning when @tapsmith/react-native is installed but its hooks are never seen', () => {
  let tmp: string;
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-hooks-warn-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const hooksWarnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes('@tapsmith/react-native'));

  it('warns once, naming the likely cause and the fix', async () => {
    writePackageJson(tmp, { expo: '~58.0.0', 'react-native': '0.85.0', '@tapsmith/react-native': '^0.7.1' });
    const { probeResetCapabilities } = await loadPreflight();

    expect(await probeResetCapabilities(makeContext(tmp), { pollMs: 0 })).toEqual({ hooksDetected: false });
    await probeResetCapabilities(makeContext(tmp), { pollMs: 0 });

    const messages = hooksWarnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Worker 0 (emulator-5554)');
    expect(messages[0]).toContain('EXPO_PUBLIC_TAPSMITH_HOOKS');
    expect(messages[0]).toContain('enabled={__DEV__ || process.env.EXPO_PUBLIC_TAPSMITH_HOOKS === "1"}');
    expect(messages[0]).toContain('node_modules');
    expect(messages[0]).toContain('https://tapsmith.dev/guides/warm-reset/');
  });

  it('finds the app package.json above a config in a subfolder', async () => {
    writePackageJson(tmp, { expo: '~58.0.0' }, { '@tapsmith/react-native': '^0.7.1' });
    const e2e = path.join(tmp, 'e2e');
    writePackageJson(e2e, { tapsmith: '^0.7.1' });
    const { probeResetCapabilities } = await loadPreflight();

    await probeResetCapabilities(makeContext(e2e), { pollMs: 0 });

    expect(hooksWarnings()).toHaveLength(1);
  });

  it('stays quiet when the app does not depend on the package', async () => {
    writePackageJson(tmp, { expo: '~58.0.0', 'react-native': '0.85.0' });
    const { probeResetCapabilities } = await loadPreflight();

    await probeResetCapabilities(makeContext(tmp), { pollMs: 0 });

    expect(hooksWarnings()).toEqual([]);
  });

  it('stays quiet without a known rootDir', async () => {
    const { probeResetCapabilities } = await loadPreflight();
    await probeResetCapabilities(makeContext(undefined), { pollMs: 0 });
    expect(hooksWarnings()).toEqual([]);
  });

  it('stays quiet when the hooks are seen', async () => {
    writePackageJson(tmp, { expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' });
    const { probeResetCapabilities } = await loadPreflight();

    expect(await probeResetCapabilities(makeContext(tmp, {}, MARKER), { pollMs: 0 })).toEqual({ hooksDetected: true });

    expect(hooksWarnings()).toEqual([]);
  });

  it('stays quiet when appReset is set explicitly (the hooks would not be used)', async () => {
    writePackageJson(tmp, { expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' });
    const { probeResetCapabilities } = await loadPreflight();

    await probeResetCapabilities(makeContext(tmp, { appReset: 'clear' }), { pollMs: 0 });

    expect(hooksWarnings()).toEqual([]);
  });

  it('does not repeat in a process seeded with the answer (watch and MCP re-runs)', async () => {
    writePackageJson(tmp, { expo: '~58.0.0', '@tapsmith/react-native': '^0.7.1' });
    const { probeResetCapabilities } = await loadPreflight();
    const ctx = makeContext(tmp);
    ctx.capabilities = { hooksDetected: false };

    await probeResetCapabilities(ctx, { pollMs: 0 });

    expect(hooksWarnings()).toEqual([]);
  });
});
