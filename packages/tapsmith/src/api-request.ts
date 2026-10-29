/**
 * API request fixture for Tapsmith tests.
 *
 * Provides an `APIRequestContext` (modeled after Playwright's) that wraps
 * Node's built-in `fetch`. Each HTTP call emits a trace event and accumulates
 * a `NetworkEntry` so requests appear in the trace viewer / UI mode.
 */

import type { NetworkEntry } from './trace/types.js';
import { getActiveTraceCollector, extractStack } from './trace/trace-collector.js';

// ─── Types ───

/** Options for one `request.get()` / `post()` / … call. */
export interface APIRequestOptions {
  /** Request body. Objects are JSON-serialized automatically. */
  data?: unknown
  /** Per-request headers (override `extraHTTPHeaders`). */
  headers?: Record<string, string>
  /** Query parameters appended to the URL. */
  params?: Record<string, string> | URLSearchParams
  /** Per-request timeout in milliseconds. */
  timeout?: number
  /** Form-encoded body (sets Content-Type to application/x-www-form-urlencoded). */
  form?: Record<string, string>
}

// ─── TapsmithAPIResponse ───

/**
 * Response wrapper with an eagerly-buffered body so it can be read multiple
 * times (unlike the native single-read `Response` stream).
 */
export class TapsmithAPIResponse {
  /** The HTTP status code. */
  readonly status: number;
  /** The HTTP status text. */
  readonly statusText: string;
  /** Whether the status is in the 200–299 range. */
  readonly ok: boolean;
  /** The final URL of the response, after redirects. */
  readonly url: string;
  /** The response headers. */
  readonly headers: Headers;

  private _body: Buffer;

  /** @internal */
  constructor(status: number, statusText: string, ok: boolean, url: string, headers: Headers, body: Buffer) {
    this.status = status;
    this.statusText = statusText;
    this.ok = ok;
    this.url = url;
    this.headers = headers;
    this._body = body;
  }

  /** Parse the response body as JSON. Returns `null` for empty bodies. */
  async json(): Promise<unknown> {
    const text = this._body.toString('utf-8').trim();
    return text ? JSON.parse(text) : null;
  }

  /** Return the response body as a UTF-8 string. */
  async text(): Promise<string> {
    return this._body.toString('utf-8');
  }

  /** Return the raw response body buffer. */
  async body(): Promise<Buffer> {
    return this._body;
  }

  /** Flatten response headers to a plain object. */
  headersObject(): Record<string, string> {
    const result: Record<string, string> = {};
    this.headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  /** Explicit cleanup (no-op for now; reserved for future pooling). */
  dispose(): void {
    // intentionally empty
  }
}

// ─── APIRequestContext ───

export interface APIRequestContextOptions {
  baseURL?: string
  extraHTTPHeaders?: Record<string, string>
}

/**
 * Built-in fixture for making HTTP requests during tests.
 * Wraps `globalThis.fetch` with URL resolution, header merging,
 * body serialization, and trace integration.
 */
export class APIRequestContext {
  private _baseURL: string | undefined;
  private _extraHTTPHeaders: Record<string, string>;
  private _networkEntries: NetworkEntry[] = [];
  private _abortController = new AbortController();

  constructor(options: APIRequestContextOptions = {}) {
    this._baseURL = options.baseURL;
    this._extraHTTPHeaders = options.extraHTTPHeaders ?? {};
  }

  /** Send a GET request. */
  async get(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('GET', url, options);
  }

  /** Send a POST request. */
  async post(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('POST', url, options);
  }

  /** Send a PUT request. */
  async put(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('PUT', url, options);
  }

  /** Send a PATCH request. */
  async patch(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('PATCH', url, options);
  }

  /** Send a DELETE request. */
  async delete(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('DELETE', url, options);
  }

  /** Send a HEAD request. */
  async head(url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    return this._fetch('HEAD', url, options);
  }

  /** Send a request with an explicit method. */
  async fetch(url: string, options?: APIRequestOptions & { method?: string }): Promise<TapsmithAPIResponse> {
    return this._fetch(options?.method ?? 'GET', url, options);
  }

  /** Return accumulated network entries for trace merging. */
  getNetworkEntries(): NetworkEntry[] {
    return this._networkEntries;
  }

  /** Abort any in-flight requests and clean up. */
  dispose(): void {
    this._abortController.abort();
  }

  // ─── Internal ───

  private async _fetch(method: string, url: string, options?: APIRequestOptions): Promise<TapsmithAPIResponse> {
    // Capture source location before any async work
    const stack = extractStack(new Error().stack ?? '');
    const sourceLocation = stack[0];

    // Resolve URL
    const resolvedUrl = this._resolveUrl(url, options?.params);

    // Merge headers (lowercase keys so per-request headers override globals
    // regardless of casing — HTTP header names are case-insensitive)
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(this._extraHTTPHeaders)) headers[k.toLowerCase()] = v;
    for (const [k, v] of Object.entries(options?.headers ?? {})) headers[k.toLowerCase()] = v;

    // Build body
    let body: BodyInit | undefined;
    if (options?.form) {
      body = new URLSearchParams(options.form).toString();
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (options?.data !== undefined) {
      if (typeof options.data === 'string') {
        body = options.data;
      } else if (Buffer.isBuffer(options.data)) {
        body = new Uint8Array(options.data);
      } else {
        body = JSON.stringify(options.data);
        headers['content-type'] ??= 'application/json';
      }
    }

    // Timeout
    const ac = new AbortController();
    const parentSignal = this._abortController.signal;
    const onParentAbort = () => ac.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      ac.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeout) {
      timer = setTimeout(() => ac.abort(new Error(`Request timed out after ${options.timeout}ms`)), options.timeout);
    }

    const startTime = Date.now();

    // Stream a "started" lifecycle signal so UI mode shows an in-flight row
    // for the duration of the HTTP request. The matching addActionEvent on
    // either the success or failure path below carries the completed signal
    // at the same actionIndex — reserved here so a device action landing
    // mid-request cannot take it.
    let apiActionIndex: number | undefined;
    {
      const collector = getActiveTraceCollector();
      if (collector) {
        apiActionIndex = collector._reserveActionIndex();
        collector._emitActionStarted({
          category: 'api',
          action: `request.${method.toLowerCase()}`,
          selector: resolvedUrl.toString(),
          sourceLocation,
          stack,
          log: [`${method} ${resolvedUrl.toString()}`],
          hasScreenshotBefore: false,
          hasHierarchyBefore: false,
        }, apiActionIndex);
      }
    }

    let response: Response;
    let responseBuffer: Buffer;
    try {
      response = await globalThis.fetch(resolvedUrl.toString(), {
        method,
        headers,
        body,
        signal: ac.signal,
      });
      responseBuffer = Buffer.from(await response.arrayBuffer());
    } catch (fetchError) {
      // Emit a failed trace event so network errors are visible in the
      // trace viewer / UI mode (timeouts, DNS failures, aborts, etc.)
      const duration = Date.now() - startTime;
      const collector = getActiveTraceCollector();
      if (collector) {
        const errMsg = fetchError instanceof Error ? fetchError.message : String(fetchError);
        collector.addActionEvent({
          category: 'api',
          action: `request.${method.toLowerCase()}`,
          duration,
          success: false,
          error: errMsg,
          log: [
            `${method} ${resolvedUrl.toString()}`,
            `FAILED: ${errMsg} (${duration}ms)`,
          ],
          hasScreenshotBefore: false,
          hasScreenshotAfter: false,
          hasHierarchyBefore: false,
          hasHierarchyAfter: false,
          sourceLocation,
          stack,
        }, apiActionIndex);

        // Also record a NetworkEntry so failed requests appear in the Network tab
        const requestBodyBuf = body !== undefined
          ? Buffer.from(typeof body === 'string' ? body : body as Uint8Array)
          : undefined;
        this._networkEntries.push({
          index: this._networkEntries.length,
          actionIndex: apiActionIndex ?? collector.currentActionIndex - 1,
          startTime,
          endTime: startTime + duration,
          method,
          url: resolvedUrl.toString(),
          status: 0,
          contentType: '',
          requestSize: requestBodyBuf?.length ?? 0,
          responseSize: 0,
          duration,
          requestHeaders: { ...headers },
          responseHeaders: {},
          requestBody: requestBodyBuf,
          responseBody: undefined,
        });
      }
      throw fetchError;
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
    const endTime = Date.now();
    const duration = endTime - startTime;

    // Build response wrapper
    const tapsmithResponse = new TapsmithAPIResponse(
      response.status,
      response.statusText,
      response.ok,
      response.url,
      response.headers,
      responseBuffer,
    );

    // ── Trace integration (success path) ──
    const collector = getActiveTraceCollector();
    if (collector) {
      const action = `request.${method.toLowerCase()}`;
      const success = response.ok;
      const log = [
        `${method} ${resolvedUrl.toString()}`,
        `${response.status} ${response.statusText} (${duration}ms)`,
      ];

      collector.addActionEvent({
        category: 'api',
        action,
        duration,
        success,
        error: success ? undefined : `${response.status} ${response.statusText}`,
        log,
        hasScreenshotBefore: false,
        hasScreenshotAfter: false,
        hasHierarchyBefore: false,
        hasHierarchyAfter: false,
        sourceLocation,
        stack,
      }, apiActionIndex);

      const requestHeaders: Record<string, string> = { ...headers };
      const responseHeaders = tapsmithResponse.headersObject();
      const requestBodyBuf = APIRequestContext._bodyToBuffer(body);
      this._networkEntries.push({
        index: this._networkEntries.length,
        actionIndex: apiActionIndex ?? collector.currentActionIndex - 1,
        startTime,
        endTime,
        method,
        url: resolvedUrl.toString(),
        status: response.status,
        contentType: responseHeaders['content-type'] ?? '',
        requestSize: requestBodyBuf?.length ?? 0,
        responseSize: responseBuffer.length,
        duration,
        requestHeaders,
        responseHeaders,
        requestBody: requestBodyBuf,
        responseBody: responseBuffer,
      });
    }

    return tapsmithResponse;
  }

  /** Convert a fetch body to a Buffer for trace serialization. */
  private static _bodyToBuffer(body: BodyInit | undefined): Buffer | undefined {
    if (body === undefined) return undefined;
    if (typeof body === 'string') return Buffer.from(body);
    if (body instanceof Uint8Array) return Buffer.from(body);
    return undefined;
  }

  private _resolveUrl(url: string, params?: Record<string, string> | URLSearchParams): URL {
    let resolved: URL;
    if (this._baseURL && !url.startsWith('http://') && !url.startsWith('https://')) {
      // Ensure baseURL ends with / for proper relative resolution
      const base = this._baseURL.endsWith('/') ? this._baseURL : this._baseURL + '/';
      resolved = new URL(url.startsWith('/') ? url.slice(1) : url, base);
    } else {
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(
          `Relative URL "${url}" requires baseURL to be configured. ` +
          'Set baseURL in defineConfig() or test.use().',
        );
      }
      resolved = new URL(url);
    }

    if (params) {
      const entries = params instanceof URLSearchParams ? params : new URLSearchParams(params);
      entries.forEach((value, key) => {
        resolved.searchParams.append(key, value);
      });
    }

    return resolved;
  }
}
