import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebKitInspectorClient, parseSimulatorLaunchctlPids } from '../webkit-inspector.js';

/**
 * Drives the client's message handler directly (no socket) to verify the
 * page-replacement detection added for PILOT-288: a connected page vanishing
 * from its app's pushed listing marks the session dead, since a replaced
 * page can keep answering evaluates against its frozen DOM indefinitely.
 */

interface ClientInternals {
  _senderKey: string | null
  _connectedPageId: number | null
  _targetId: string | null
  _pendingEval: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>
  _handleMessage(msg: Record<string, unknown>): void
}

function makeAttachedClient(appId = 'PID:100', pageId = 2): { client: WebKitInspectorClient; internals: ClientInternals } {
  const client = new WebKitInspectorClient();
  const internals = client as unknown as ClientInternals;
  internals._handleMessage({
    __selector: '_rpc_applicationConnected:',
    __argument: {
      WIRApplicationIdentifierKey: appId,
      WIRApplicationNameKey: 'TestApp',
      WIRApplicationBundleIdentifierKey: 'dev.tapsmith.testapp',
      WIRIsApplicationActiveKey: 1,
    },
  });
  internals._senderKey = appId;
  internals._connectedPageId = pageId;
  internals._targetId = 'page-1';
  return { client, internals };
}

function listingMessage(appId: string, pageIds: number[]): Record<string, unknown> {
  const listing: Record<string, Record<string, unknown>> = {};
  for (const id of pageIds) {
    listing[String(id)] = {
      WIRPageIdentifierKey: id,
      WIRTitleKey: '',
      WIRURLKey: 'about:blank',
      WIRTypeKey: 'WIRTypeWeb',
    };
  }
  return {
    __selector: '_rpc_applicationSentListing:',
    __argument: { WIRApplicationIdentifierKey: appId, WIRListingKey: listing },
  };
}

describe('WebKitInspectorClient connection lifecycle', () => {
  it('rejects connect() when the socket closes during the handshake', async () => {
    const socketPath = path.join(os.tmpdir(), `tapsmith-inspector-test-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
    const server = net.createServer((conn) => conn.destroy());
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new WebKitInspectorClient();
    try {
      // Without close-handler rejection this hangs until the 3s report
      // fallback (or forever, had teardown not cleared _readyResolve).
      // Whether the write (EPIPE/ECONNRESET) or the close event settles the
      // promise first is a race — both are the wanted fail-fast outcome.
      await expect(client.connect(socketPath)).rejects.toThrow(/connection closed|EPIPE|ECONNRESET/);
      expect(client.isConnected()).toBe(false);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects connect() when nothing is listening on the socket path', async () => {
    const client = new WebKitInspectorClient();
    await expect(
      client.connect(path.join(os.tmpdir(), `tapsmith-inspector-test-nonexistent-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)),
    ).rejects.toThrow();
    expect(client.isConnected()).toBe(false);
  });
});

describe('WebKitInspectorClient page-replacement detection (PILOT-288)', () => {
  it('stays live while the connected page is still listed', () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage(listingMessage('PID:100', [2]));
    expect(client.pageReplaced).toBe(false);
  });

  it('marks the page replaced when it vanishes from its app listing', () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage(listingMessage('PID:100', [3]));
    expect(client.pageReplaced).toBe(true);
  });

  it('marks the page replaced when the listing goes empty', () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage(listingMessage('PID:100', []));
    expect(client.pageReplaced).toBe(true);
  });

  it('ignores listings for other apps', () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage({
      __selector: '_rpc_applicationConnected:',
      __argument: {
        WIRApplicationIdentifierKey: 'PID:999',
        WIRApplicationNameKey: 'Other',
        WIRApplicationBundleIdentifierKey: 'com.other.app',
        WIRIsApplicationActiveKey: 1,
      },
    });
    internals._handleMessage(listingMessage('PID:999', [7]));
    expect(client.pageReplaced).toBe(false);
  });

  it('marks the page replaced when its app disconnects', () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage({
      __selector: '_rpc_applicationDisconnected:',
      __argument: { WIRApplicationIdentifierKey: 'PID:100' },
    });
    expect(client.pageReplaced).toBe(true);
  });

  it('rejects in-flight messages with a guided error on replacement', async () => {
    const { internals } = makeAttachedClient('PID:100', 2);
    const pending = new Promise((resolve, reject) => {
      internals._pendingEval.set('PID:100:1', { resolve, reject });
    });
    internals._handleMessage(listingMessage('PID:100', [3]));
    await expect(pending).rejects.toThrow(/WebView page was replaced.*Reconnect with device\.webview\(\)/s);
  });

  it('fails subsequent sends fast with the guided error', async () => {
    const { client, internals } = makeAttachedClient('PID:100', 2);
    internals._handleMessage(listingMessage('PID:100', [3]));
    await expect(
      client.sendInspectorMessage('PID:100', { id: 1, method: 'Runtime.evaluate', params: {} }, 1_000),
    ).rejects.toThrow(/WebView page was replaced/);
  });
});

describe('parseSimulatorLaunchctlPids', () => {
  // `xcrun simctl spawn <udid> launchctl list` as an iOS 26.5 simulator prints it.
  const output = [
    'PID\tStatus\tLabel',
    '-\t0\tcom.apple.UIKit.KeyboardManagement',
    '57805\t0\tUIKitApplication:com.apple.family[fbaa][rb-legacy]',
    '83587\t0\tUIKitApplication:dev.jordan.onboardc[4bee][rb-legacy]',
    '-\t0\tUIKitApplication:dev.jordan.onboardc.widget[11aa][rb-legacy]',
    '83600\t0\tUIKitApplication:dev.jordan.onboardcx[22bb][rb-legacy]',
    '-\t-9\tUIKitApplication:dev.tapsmith.stopped[33cc][rb-legacy]',
  ].join('\n');

  it('returns the running pid of exactly that bundle id', () => {
    expect(parseSimulatorLaunchctlPids(output, 'dev.jordan.onboardc')).toEqual([83587]);
  });

  it('returns nothing for an app that is not running or not listed', () => {
    expect(parseSimulatorLaunchctlPids(output, 'dev.tapsmith.stopped')).toEqual([]);
    expect(parseSimulatorLaunchctlPids(output, 'dev.example.absent')).toEqual([]);
    expect(parseSimulatorLaunchctlPids('', 'dev.jordan.onboardc')).toEqual([]);
  });
});
