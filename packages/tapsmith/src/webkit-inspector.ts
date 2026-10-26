/**
 * WebKit Remote Inspector Protocol client for iOS simulator WebViews.
 *
 * Connects to the simulator's webinspectord Unix domain socket and speaks
 * the binary-plist RPC protocol to discover inspectable pages and forward
 * WebKit Inspector messages (which are JSON, similar to CDP).
 *
 * Protocol: 4-byte big-endian length prefix + binary plist message.
 * Messages use __selector / __argument keys for RPC dispatch.
 */

import * as net from 'node:net';
import { execSync } from 'node:child_process';
import * as bplistParser from 'bplist-parser';
import bplistCreator from 'bplist-creator';

interface WebKitApp {
  pid: string
  name: string
  bundleId: string
  isActive: boolean
  pages: Map<number, WebKitPage>
}

interface WebKitPage {
  id: number
  title: string
  url: string
  type: string
}

interface PendingMessage {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export class WebKitInspectorClient {
  private _socket: net.Socket | null = null;
  private _connectionId: string;
  private _apps = new Map<string, WebKitApp>();
  private _buffer = Buffer.alloc(0);
  private _ready = false;
  private _readyResolve: (() => void) | null = null;
  private _messageHandlers: Array<(selector: string, argument: Record<string, unknown>) => void> = [];
  private _pendingEval = new Map<string, PendingMessage>();
  private _senderKey: string | null = null;
  private _targetId: string | null = null;
  private _outerMsgId = 0;
  private _connectedPageId: number | null = null;
  private _pageReplaced = false;

  constructor() {
    this._connectionId = `tapsmith-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async connect(socketPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      // Store immediately so close() during a still-pending connect destroys
      // the socket instead of leaking the connection attempt.
      this._socket = socket;
      socket.on('connect', () => {
        this._setupDataHandler();
        this._sendReport().then(resolve).catch(reject);
      });
      socket.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this._teardown(error);
        reject(error);
      });
      socket.on('close', () => {
        const error = new Error('WebKit Inspector connection closed');
        this._teardown(error);
        // Settle a still-pending connect — a handshake-time close would
        // otherwise leave connect() hanging until the caller's deadline.
        // No-op once the promise is settled.
        reject(error);
      });
    });
  }

  /** Whether the webinspectord socket is still usable. */
  isConnected(): boolean {
    return this._socket !== null && !this._socket.destroyed;
  }

  /** Whether the connected page has been replaced out from under this session. */
  get pageReplaced(): boolean {
    return this._pageReplaced;
  }

  private static _pageReplacedError(): Error {
    return new Error(
      'The connected WebView page was replaced (the app remounted its WebView, ' +
      'the page loaded into a new WebKit page, or the web content process crashed). ' +
      'Reconnect with device.webview().',
    );
  }

  private _markPageReplaced(): void {
    this._pageReplaced = true;
    for (const [, p] of this._pendingEval) {
      p.reject(WebKitInspectorClient._pageReplacedError());
    }
    this._pendingEval.clear();
  }

  /** Drop the socket and fail all in-flight inspector messages. */
  private _teardown(reason: Error): void {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    // A teardown mid-handshake must not let _sendReport() resolve a connect()
    // whose socket is already gone — connect() is rejected by its own
    // close/error handler instead.
    this._readyResolve = null;
    for (const [, p] of this._pendingEval) {
      p.reject(reason);
    }
    this._pendingEval.clear();
  }

  private _setupDataHandler(): void {
    this._socket!.on('data', (chunk) => {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this._processBuffer();
    });
  }

  private _processBuffer(): void {
    while (this._buffer.length >= 4) {
      const msgLen = this._buffer.readUInt32BE(0);
      if (this._buffer.length < 4 + msgLen) break;

      const plistData = this._buffer.subarray(4, 4 + msgLen);
      this._buffer = this._buffer.subarray(4 + msgLen);

      try {
        const parsed = bplistParser.parseBuffer(plistData);
        const msg = parsed[0] as Record<string, unknown>;
        this._handleMessage(msg);
      } catch {
        // Skip unparseable messages
      }
    }
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const selector = msg.__selector as string;
    const argument = (msg.__argument ?? {}) as Record<string, unknown>;

    if (selector === '_rpc_reportCurrentState:') {
      // Initial state report
      return;
    }

    if (selector === '_rpc_reportConnectedApplicationList:') {
      this._parseApplicationList(argument);
      if (this._readyResolve) {
        this._readyResolve();
        this._readyResolve = null;
      }
      return;
    }

    if (selector === '_rpc_applicationConnected:') {
      this._addApp(argument);
      return;
    }

    if (selector === '_rpc_applicationDisconnected:') {
      const appId = argument.WIRApplicationIdentifierKey as string;
      this._apps.delete(appId);
      if (appId === this._senderKey && this._connectedPageId !== null) {
        this._markPageReplaced();
      }
      return;
    }

    if (selector === '_rpc_applicationUpdated:') {
      this._updateApp(argument);
      return;
    }

    if (selector === '_rpc_applicationSentListing:') {
      const appId = argument.WIRApplicationIdentifierKey as string;
      const listing = argument.WIRListingKey as Record<string, Record<string, unknown>> | undefined;
      const app = this._apps.get(appId);
      if (app && listing) {
        app.pages.clear();
        for (const [, pageData] of Object.entries(listing)) {
          const page: WebKitPage = {
            id: pageData.WIRPageIdentifierKey as number,
            title: (pageData.WIRTitleKey as string) ?? '',
            url: (pageData.WIRURLKey as string) ?? '',
            type: (pageData.WIRTypeKey as string) ?? '',
          };
          app.pages.set(page.id, page);
        }
        // webinspectord pushes listing updates once we've requested one. A
        // page id never comes back after vanishing, so our connected page
        // dropping out of its app's listing means the page was replaced
        // (WebView remount, reload into a new page, or WebContent crash).
        // Detect it here: a replaced page can keep answering evaluates
        // against its frozen DOM indefinitely, so callers polling through
        // this session would otherwise never notice (PILOT-288).
        if (
          appId === this._senderKey &&
          this._connectedPageId !== null &&
          !app.pages.has(this._connectedPageId)
        ) {
          this._markPageReplaced();
        }
      }
      return;
    }

    if (selector === '_rpc_applicationSentData:') {
      const dataStr = argument.WIRMessageDataKey as Buffer | string;
      const messageStr = typeof dataStr === 'string'
        ? dataStr
        : dataStr?.toString('utf-8');
      if (messageStr) {
        try {
          const parsed = JSON.parse(messageStr) as Record<string, unknown>;

          // Handle Target.targetCreated — store the page target ID
          if (parsed.method === 'Target.targetCreated') {
            const info = (parsed.params as Record<string, unknown>)?.targetInfo as Record<string, unknown>;
            if (info?.type === 'page') {
              this._targetId = info.targetId as string;
            }
            return;
          }

          // Handle Target.dispatchMessageFromTarget — unwrap inner response
          if (parsed.method === 'Target.dispatchMessageFromTarget') {
            const params = parsed.params as Record<string, unknown>;
            const innerStr = params?.message as string;
            if (innerStr) {
              try {
                const inner = JSON.parse(innerStr) as Record<string, unknown>;
                const innerId = inner.id as number | undefined;
                if (innerId !== undefined) {
                  const key = `${argument.WIRApplicationIdentifierKey}:${innerId}`;
                  const pending = this._pendingEval.get(key);
                  if (pending) {
                    this._pendingEval.delete(key);
                    pending.resolve(inner);
                  }
                }
              } catch { /* not JSON */ }
            }
            return;
          }

          // Direct responses (e.g., to Target.sendMessageToTarget itself)
          const id = parsed.id as number | undefined;
          if (id !== undefined) {
            // These are responses to our outer Target.sendMessageToTarget calls — ignore
          }
        } catch { /* not JSON */ }
      }
      return;
    }

    for (const handler of this._messageHandlers) {
      handler(selector, argument);
    }
  }

  private _parseApplicationList(argument: Record<string, unknown>): void {
    const dict = argument.WIRApplicationDictionaryKey as Record<string, Record<string, unknown>>;
    if (!dict) return;
    for (const [appId, appData] of Object.entries(dict)) {
      this._apps.set(appId, {
        pid: appId,
        name: (appData.WIRApplicationNameKey as string) ?? '',
        bundleId: (appData.WIRApplicationBundleIdentifierKey as string) ?? '',
        isActive: (appData.WIRIsApplicationActiveKey as number) > 0,
        pages: new Map(),
      });
    }
  }

  private _addApp(data: Record<string, unknown>): void {
    const appId = data.WIRApplicationIdentifierKey as string;
    this._apps.set(appId, {
      pid: appId,
      name: (data.WIRApplicationNameKey as string) ?? '',
      bundleId: (data.WIRApplicationBundleIdentifierKey as string) ?? '',
      isActive: (data.WIRIsApplicationActiveKey as number) > 0,
      pages: new Map(),
    });
  }

  private _updateApp(data: Record<string, unknown>): void {
    const appId = data.WIRApplicationIdentifierKey as string;
    const app = this._apps.get(appId);
    if (app) {
      app.name = (data.WIRApplicationNameKey as string) ?? app.name;
      app.bundleId = (data.WIRApplicationBundleIdentifierKey as string) ?? app.bundleId;
      app.isActive = (data.WIRIsApplicationActiveKey as number) > 0;
    }
  }

  private async _sendReport(): Promise<void> {
    return new Promise((resolve) => {
      this._readyResolve = resolve;
      this._sendMessage({
        __selector: '_rpc_reportIdentifier:',
        __argument: {
          WIRConnectionIdentifierKey: this._connectionId,
        },
      });

      // Also request the application list
      setTimeout(() => {
        // The socket may have been torn down in the meantime — a throw here
        // would be an uncaught exception in a timer callback.
        if (!this._socket || this._socket.destroyed) return;
        this._sendMessage({
          __selector: '_rpc_getConnectedApplications:',
          __argument: {
            WIRConnectionIdentifierKey: this._connectionId,
          },
        });
      }, 100);

      // Timeout if we don't get a response
      setTimeout(() => {
        if (this._readyResolve) {
          this._readyResolve();
          this._readyResolve = null;
        }
      }, 3000);
    });
  }

  private _sendMessage(msg: Record<string, unknown>): void {
    if (!this._socket) throw new Error('Not connected');
    const plistData = bplistCreator(msg);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(plistData.length, 0);
    this._socket.write(Buffer.concat([header, plistData]));
  }

  /** Wait for page listings to arrive, then return all apps with pages. */
  async listTargets(): Promise<Array<{ appId: string; bundleId: string; name: string; pages: WebKitPage[] }>> {
    // Request page listings for all known apps. The simulator only
    // sends _rpc_applicationSentListing: in response to this request —
    // it does NOT push listings automatically after reporting the app
    // list. Without this, pages stay empty on fresh CI simulators.
    for (const [appId] of this._apps) {
      this._sendMessage({
        __selector: '_rpc_forwardGetListing:',
        __argument: {
          WIRConnectionIdentifierKey: this._connectionId,
          WIRApplicationIdentifierKey: appId,
        },
      });
    }

    // Wait for listing responses to arrive
    await new Promise(r => setTimeout(r, 1000));

    const results: Array<{ appId: string; bundleId: string; name: string; pages: WebKitPage[] }> = [];
    for (const [appId, app] of this._apps) {
      if (app.pages.size > 0 || app.bundleId.startsWith('dev.tapsmith') || !app.bundleId.startsWith('com.apple')) {
        results.push({
          appId,
          bundleId: app.bundleId,
          name: app.name,
          pages: Array.from(app.pages.values()),
        });
      }
    }
    return results;
  }

  /** Set up forwarding to a specific page for inspector messages. */
  async connectToPage(appId: string, pageId: number): Promise<void> {
    this._senderKey = appId;
    this._connectedPageId = pageId;
    this._pageReplaced = false;
    // Reset any target from a previous connectToPage on this client (e.g. a
    // page that connected but failed its liveness probe) — otherwise the
    // wait below exits immediately and messages route to the stale target.
    this._targetId = null;

    // Indicate we want to inspect a WebView
    this._sendMessage({
      __selector: '_rpc_forwardIndicateWebView:',
      __argument: {
        WIRApplicationIdentifierKey: appId,
        WIRIndicateEnabledKey: true,
        WIRConnectionIdentifierKey: this._connectionId,
        WIRPageIdentifierKey: pageId,
      },
    });

    await new Promise(r => setTimeout(r, 200));

    // Set up the forwarding socket
    this._sendMessage({
      __selector: '_rpc_forwardSocketSetup:',
      __argument: {
        WIRConnectionIdentifierKey: this._connectionId,
        WIRApplicationIdentifierKey: appId,
        WIRPageIdentifierKey: pageId,
        WIRSenderKey: this._connectionId,
        WIRAutomaticallyPause: false,
      },
    });

    // Wait for Target.targetCreated to arrive with the page targetId
    const deadline = Date.now() + 5000;
    while (!this._targetId && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (!this._targetId) {
      throw new Error('Timed out waiting for WebView target — no Target.targetCreated received');
    }
  }

  /** Send a WebKit Inspector command to the connected page and wait for response. */
  async sendInspectorMessage(appId: string, message: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this._pageReplaced) {
      throw WebKitInspectorClient._pageReplacedError();
    }
    if (!this._targetId) {
      throw new Error('No WebView target available — Target.targetCreated not received');
    }

    const innerId = message.id as number;
    const pageId = this._connectedPageId ?? 1;
    const key = `${appId}:${innerId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingEval.delete(key);
        reject(new Error(`WebKit Inspector message timed out (id=${innerId})`));
      }, timeoutMs);

      this._pendingEval.set(key, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as Record<string, unknown>);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      // Wrap the command in Target.sendMessageToTarget
      const outerCmd = {
        id: ++this._outerMsgId,
        method: 'Target.sendMessageToTarget',
        params: {
          targetId: this._targetId,
          message: JSON.stringify(message),
        },
      };

      this._sendMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {
          WIRConnectionIdentifierKey: this._connectionId,
          WIRApplicationIdentifierKey: appId,
          WIRPageIdentifierKey: pageId,
          WIRSenderKey: this._connectionId,
          WIRSocketDataKey: Buffer.from(JSON.stringify(outerCmd)),
        },
      });
    });
  }

  close(): void {
    this._teardown(new Error('Connection closed'));
  }
}

/** Resolve a simulator name to a UDID among BOOTED simulators. Returns null
 * unless exactly one booted simulator has that name. */
function resolveBootedSimulatorByName(name: string, timeoutMs: number): string | null {
  try {
    const out = execSync('xcrun simctl list devices booted -j', { encoding: 'utf-8', timeout: timeoutMs });
    const parsed = JSON.parse(out) as { devices?: Record<string, Array<{ udid: string; name?: string }>> } | null;
    // Tolerate casing/whitespace drift between the config name and simctl —
    // a near-miss here would otherwise surface as an opaque connect failure.
    const wanted = name.trim().toLowerCase();
    const matches: string[] = [];
    for (const devices of Object.values(parsed?.devices ?? {})) {
      for (const d of devices) {
        if (d.name?.trim().toLowerCase() === wanted) matches.push(d.udid);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

/**
 * Find the webinspectord Unix socket for a given iOS simulator UDID (or name).
 *
 * `budgetMs` caps the cumulative time spent in the synchronous subprocess
 * calls (ps/simctl/lsof) so discovery cannot blow through a caller's shorter
 * connect deadline; each command gets the remaining budget with a 1s floor.
 */
export function findSimulatorInspectorSocket(udidOrName: string, budgetMs = 25_000): string | null {
  const budgetDeadline = Date.now() + budgetMs;
  const cap = (maxMs: number) => Math.max(1_000, Math.min(maxMs, budgetDeadline - Date.now()));
  try {
    // Bounded: connection setup runs inside the device timeout, and lsof in
    // particular can stall for a long time on a loaded machine.
    const psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: cap(5_000) });

    // Collect all launchd_sim PIDs and their UDIDs
    const sims: Array<{ pid: string; udid: string }> = [];
    for (const line of psOutput.split('\n')) {
      if (!line.includes('launchd_sim')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[1];
      // Extract UDID from the path: .../CoreSimulator/Devices/<UDID>/data/...
      const udidMatch = line.match(/CoreSimulator\/Devices\/([A-F0-9-]{36})\//);
      if (pid && udidMatch) {
        sims.push({ pid, udid: udidMatch[1] });
      }
    }

    if (sims.length === 0) return null;

    // Match by UDID, resolving a simulator NAME to a UDID first. Without an
    // unambiguous identity, only a SINGLE booted simulator is acceptable —
    // silently picking the first of several attaches to the wrong
    // simulator's WebViews (with parallel workers, two sessions end up
    // driving the SAME page — PILOT-288).
    let udid = udidOrName;
    if (udid && !udid.match(/^[A-F0-9-]{36}$/i)) {
      udid = resolveBootedSimulatorByName(udid, cap(10_000)) ?? '';
    }
    let targetPid: string;
    if (udid) {
      const match = sims.find(s => s.udid.toUpperCase() === udid.toUpperCase());
      if (!match) return null;
      targetPid = match.pid;
    } else if (sims.length === 1) {
      targetPid = sims[0].pid;
    } else {
      return null;
    }

    // Find the webinspectord socket owned by this specific launchd_sim PID.
    // lsof -U shows ALL Unix sockets — match the PID column to filter correctly.
    const lsofOutput = execSync('lsof -U 2>/dev/null', { encoding: 'utf-8', timeout: cap(10_000) });
    for (const line of lsofOutput.split('\n')) {
      if (!line.includes('webinspectord_sim.socket')) continue;
      const cols = line.trim().split(/\s+/);
      if (cols[1] === targetPid) {
        const match = line.match(/\s(\/\S+webinspectord_sim\.socket)/);
        if (match) return match[1];
      }
    }

    return null;
  } catch {
    return null;
  }
}
