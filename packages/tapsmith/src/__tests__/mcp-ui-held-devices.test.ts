import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DeviceInfoProto } from '../grpc-client.js';
import { assertNotHeldByUi, chooseDevice, noDeviceMessage, uiSessionHoldings } from '../mcp/connection.js';
import { ensureDaemonStateDir, uiPortFilePath } from '../mcp/port-file.js';

// A headless `tapsmith mcp-server` beside a running `tapsmith test --ui`
// refused that session's daemons — and then started its own daemon and agent
// on that session's devices. The UI server now publishes the devices it holds
// alongside the addresses it owns, and the headless side keeps off both.

function device(serial: string, overrides: Partial<DeviceInfoProto> = {}): DeviceInfoProto {
  return { serial, model: 'Pixel', state: 'online', isEmulator: true, platform: 'android', osVersion: '14', ...overrides };
}

describe('chooseDevice', () => {
  const devices = [device('emulator-5554', { state: 'Active' }), device('emulator-5556'), device('SIM-1', { platform: 'ios' })];

  it('auto-picks past the devices a UI session holds', () => {
    expect(chooseDevice(devices, { platform: 'android' })?.serial).toBe('emulator-5554');
    expect(chooseDevice(devices, { platform: 'android', heldByUi: new Set(['emulator-5554']) })?.serial).toBe('emulator-5556');
    expect(chooseDevice(devices, { platform: 'android', heldByUi: new Set(['emulator-5554', 'emulator-5556']) })).toBeUndefined();
  });

  it('does not honour a pin on a held device', () => {
    expect(chooseDevice(devices, { wantedSerial: 'emulator-5556' })?.serial).toBe('emulator-5556');
    expect(chooseDevice(devices, { wantedSerial: 'emulator-5556', heldByUi: new Set(['emulator-5556']) })).toBeUndefined();
  });

  it('keeps excluding the group\'s other members, and still reports the daemon\'s active device', () => {
    const choice = chooseDevice(devices, { platform: 'android', exclude: ['emulator-5554'], heldByUi: new Set(['SIM-1']) });
    expect(choice).toEqual({ serial: 'emulator-5556', activeSerial: 'emulator-5554' });
  });
});

describe('assertNotHeldByUi', () => {
  const held = new Set(['emulator-5554']);

  it('lets a free or absent pin through', () => {
    expect(() => assertNotHeldByUi(undefined, held)).not.toThrow();
    expect(() => assertNotHeldByUi('emulator-5556', held)).not.toThrow();
  });

  it('refuses a pin on a held device, naming the UI session and the member', () => {
    expect(() => assertNotHeldByUi('emulator-5554', held))
      .toThrow(/Device "emulator-5554" is pinned in your config, but a running `tapsmith test --ui` session is driving it/);
    expect(() => assertNotHeldByUi('emulator-5554', held, 'bob'))
      .toThrow(/pinned for group member "bob" in your config/);
  });

  // A run_tests `device` is the caller's, not the config's.
  it('names a run_tests device as requested, not as pinned in the config', () => {
    expect(() => assertNotHeldByUi('emulator-5554', held, undefined, 'run_tests'))
      .toThrow(/Device "emulator-5554", requested with `device`, is being driven by a running `tapsmith test --ui` session/);
  });
});

describe('noDeviceMessage with UI-held devices', () => {
  it('says who has the devices when every visible one is held', () => {
    expect(noDeviceMessage('android', undefined, [], ['emulator-5554']))
      .toMatch(/^No android device is available\. The only one visible \(emulator-5554\) is being driven by a running `tapsmith test --ui` session/);
    expect(noDeviceMessage(undefined, undefined, [], ['emulator-5554', 'emulator-5556']))
      .toMatch(/Every visible device \(emulator-5554, emulator-5556\) is being driven/);
  });

  it('leaves the existing messages alone when a free device or a pin is involved', () => {
    expect(noDeviceMessage('android', undefined, ['emulator-5556'], ['emulator-5554'])).toBe(noDeviceMessage('android'));
    expect(noDeviceMessage('android', 'X', [], ['emulator-5554'])).toBe(noDeviceMessage('android', 'X'));
    expect(noDeviceMessage('android')).toMatch(/Start an emulator/);
  });
});

describe('uiSessionHoldings', () => {
  let originalHome: string | undefined;
  let root: string;
  const servers: http.Server[] = [];

  // HOME, because the UI port file lives beside the daemon registry under the
  // home directory (see port-file.ts for why not TMPDIR).
  beforeEach(() => {
    originalHome = process.env.HOME;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-ui-held-'));
    process.env.HOME = root;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.close(() => resolve()); })));
  });

  /** A stand-in UI server answering `/api/daemon-ports` with `payload`, registered in this project's port file. */
  async function publishUiServer(payload: unknown): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/daemon-ports') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    ensureDaemonStateDir();
    fs.writeFileSync(uiPortFilePath(), String((server.address() as AddressInfo).port));
  }

  it('is empty when no UI session is running', async () => {
    expect(await uiSessionHoldings()).toEqual({ addresses: new Set(), devices: new Set() });
  });

  it('collects the devices the UI server publishes, primary and members included', async () => {
    await publishUiServer({
      daemons: [{ address: '127.0.0.1:50061', deviceSerial: 'emulator-5556', platform: 'android' }],
      owned: ['127.0.0.1:50061', 'localhost:50051'],
      // The whole provisioned set: the primary's worker has not spawned yet.
      devices: ['emulator-5554', 'emulator-5556'],
    });
    expect(await uiSessionHoldings()).toEqual({
      addresses: new Set(['127.0.0.1:50061', '127.0.0.1:50051']),
      devices: new Set(['emulator-5554', 'emulator-5556']),
    });
  });

  it('falls back to the worker daemons\' serials for a UI server that predates `devices`', async () => {
    await publishUiServer({
      daemons: [{ address: '127.0.0.1:50061', deviceSerial: 'emulator-5556' }],
      owned: ['127.0.0.1:50061'],
    });
    expect((await uiSessionHoldings()).devices).toEqual(new Set(['emulator-5556']));
  });
});
