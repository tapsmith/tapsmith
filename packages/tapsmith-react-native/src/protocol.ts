/**
 * Wire format shared with the Tapsmith daemon (`packages/tapsmith-core/src/app_reset.rs`)
 * and SDK (`packages/tapsmith/src/app-reset.ts`). Framework-agnostic: a
 * Kotlin or Swift implementation follows the same three rules.
 *
 *   marker (always-present a11y text):
 *     tapsmith-hooks:<version>;epoch=<n>;nav=<n>;boot=<token>;url=<prefix>[;writes=<n>][;err=<urlencoded>]
 *
 *   `boot` is a random token generated once per app process. The epoch counter
 *   lives in memory and restarts at 0 after a cold relaunch, so a reset that
 *   is delivered cold (the daemon's periodic cold-launch valve, or a retry) can
 *   never satisfy "epoch greater than before" — a changed `boot` tells the
 *   daemon it is looking at a fresh process, where any epoch ≥ 1 is the ack.
 *   `writes` counts the persisted writes the hooks saw in this process (see
 *   writes.ts). It is present only when the app can reset while keeping its
 *   data (`onReload`), and lets Tapsmith keep a restored `appState` between
 *   tests instead of restoring it again. Unknown fields are ignored by every
 *   reader, so it needs no protocol version bump.
 *   request (deep link the daemon opens):
 *     <prefix><target>?__tapsmith_reset=1&nonce=<opaque>[&__tapsmith_keep=1]
 *   `__tapsmith_keep=1`: reset in-memory state only (`onReload`), keeping the
 *   app's persisted data — no `clear`, no `onReset`.
 *   ack:
 *     the marker's epoch is strictly greater than it was before the request
 */

export const PROTOCOL_VERSION = 1;
export const MARKER_PREFIX = 'tapsmith-hooks:';
export const RESET_QUERY_FLAG = '__tapsmith_reset';
export const KEEP_DATA_QUERY_FLAG = '__tapsmith_keep';

export interface MarkerFields {
  epoch: number;
  /**
   * Counts every URL this process has received (reset links included).
   * Lets Tapsmith acknowledge a plain navigation deep link — even one to the
   * screen already showing, which the hierarchy-change heuristic can never
   * verify — the same way resets are acknowledged by `epoch`.
   */
  nav?: number;
  /** URL prefix the daemon should build reset links from (ends with `/`). */
  urlPrefix: string;
  /** Per-process token (see the module comment); omitted only by pre-boot markers. */
  boot?: string;
  /**
   * Persisted writes counted in this process; omitted when the app cannot
   * reset while keeping its data (no `onReload`) or its stores cannot be
   * tracked.
   */
  writes?: number;
  /** Last reset error, if the handler threw. */
  error?: string;
}

/** Random per-process token; regenerated only when the app process restarts. */
export const BOOT_TOKEN: string = Math.random().toString(16).slice(2, 10).padStart(8, '0');

/**
 * `err=` cap: the marker is rendered into every accessibility snapshot until
 * the next clean reset, so a runaway handler error must not inflate them.
 */
const MAX_ERROR_LENGTH = 200;

/** Render the marker text. Keep it a single line with no quotes — it lives in an XML attribute. */
export function formatMarker(fields: MarkerFields): string {
  const parts = [
    `${MARKER_PREFIX}${PROTOCOL_VERSION}`,
    `epoch=${fields.epoch}`,
    ...(fields.nav !== undefined ? [`nav=${fields.nav}`] : []),
    ...(fields.boot ? [`boot=${fields.boot}`] : []),
    `url=${fields.urlPrefix}`,
    ...(fields.writes !== undefined ? [`writes=${fields.writes}`] : []),
  ];
  if (fields.error) {
    // Truncate by code point, not UTF-16 unit: a cut through a surrogate pair
    // makes encodeURIComponent throw, and this runs during render.
    const chars = Array.from(fields.error);
    const error = chars.length > MAX_ERROR_LENGTH ? `${chars.slice(0, MAX_ERROR_LENGTH).join('')}…` : fields.error;
    parts.push(`err=${encodeURIComponent(error).replace(/'/g, '%27').replace(/"/g, '%22')}`);
  }
  return parts.join(';');
}

/** Parse a marker string (inverse of {@link formatMarker}); `undefined` when it isn't one. */
export function parseMarker(text: string): (MarkerFields & { version: number }) | undefined {
  const start = text.indexOf(MARKER_PREFIX);
  if (start < 0) return undefined;
  const body = text.slice(start + MARKER_PREFIX.length);
  const [versionRaw, ...rest] = body.split(';');
  const version = Number.parseInt(versionRaw, 10);
  // A different protocol version has unknown semantics — safer to report "no
  // marker" (Tapsmith falls back to cold resets) than to misparse it. The
  // daemon and agents apply the same rule.
  if (version !== PROTOCOL_VERSION) return undefined;
  let epoch: number | undefined;
  let nav: number | undefined;
  let urlPrefix = '';
  let boot: string | undefined;
  let writes: number | undefined;
  let error: string | undefined;
  for (const field of rest) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    const key = field.slice(0, eq).trim();
    const value = field.slice(eq + 1).trim();
    if (key === 'epoch') epoch = Number.parseInt(value, 10);
    else if (key === 'nav') nav = Number.parseInt(value, 10);
    else if (key === 'url') urlPrefix = value;
    else if (key === 'boot' && value) boot = value;
    else if (key === 'writes') writes = Number.parseInt(value, 10);
    else if (key === 'err' && value) {
      try { error = decodeURIComponent(value); } catch { error = value; }
    }
  }
  if (epoch === undefined || !Number.isFinite(epoch)) return undefined;
  return {
    version, epoch, urlPrefix, error,
    ...(nav !== undefined && Number.isFinite(nav) ? { nav } : {}),
    ...(boot ? { boot } : {}),
    ...(writes !== undefined && Number.isFinite(writes) ? { writes } : {}),
  };
}

export interface ResetRequest {
  /** Route the reset should land on, e.g. `/`, `/login`. */
  target: string;
  nonce: string;
  /**
   * Keep the app's persisted data: reset in-memory state only (`onReload`).
   * Tapsmith asks for it between tests that restore the same `appState`.
   */
  keepData?: boolean;
}

/**
 * Recognise a reset request in an incoming URL. Any URL carrying the
 * `__tapsmith_reset` query flag is one; the path (relative to the app's URL
 * prefix) is the target route.
 */
export function parseResetRequest(url: string): ResetRequest | undefined {
  const q = url.indexOf('?');
  if (q < 0) return undefined;
  const query = url.slice(q + 1).split('#')[0];
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? '' : pair.slice(eq + 1);
    params.set(safeDecode(k), safeDecode(v));
  }
  if (!params.has(RESET_QUERY_FLAG)) return undefined;
  return {
    target: routeOf(url.slice(0, q)),
    nonce: params.get('nonce') ?? '',
    ...(params.get(KEEP_DATA_QUERY_FLAG) === '1' ? { keepData: true } : {}),
  };
}

/**
 * Key a redelivered reset request dedupes on. Tapsmith always sends a fresh
 * nonce per reset; a hand-crafted link without one dedupes on the URL itself,
 * so a double delivery (initial URL + listener, or a refired intent) resets
 * once either way.
 */
export function resetDedupeKey(request: ResetRequest, url: string): string {
  return request.nonce || url;
}

/**
 * The route part of a URL, normalised to a leading slash. Handles
 * `scheme:///path`, `scheme://path`, `scheme://host/--/path` (Expo Go) and
 * `https://host/path`.
 */
export function routeOf(urlWithoutQuery: string): string {
  const schemeEnd = urlWithoutQuery.indexOf('://');
  let rest = schemeEnd >= 0 ? urlWithoutQuery.slice(schemeEnd + 3) : urlWithoutQuery;
  const expoGo = rest.indexOf('/--/');
  if (expoGo >= 0) rest = rest.slice(expoGo + 3);
  else if (schemeEnd >= 0) {
    // `scheme://host/path` — drop a host segment only when the scheme is a
    // web one; custom schemes (`myapp://login`) treat the first segment as
    // the route itself.
    const scheme = urlWithoutQuery.slice(0, schemeEnd);
    if (scheme === 'http' || scheme === 'https' || scheme === 'exp' || scheme === 'exps') {
      const slash = rest.indexOf('/');
      rest = slash >= 0 ? rest.slice(slash) : '/';
    } else if (!rest.startsWith('/')) {
      rest = `/${rest}`;
    }
  }
  if (!rest.startsWith('/')) rest = `/${rest}`;
  return rest === '' ? '/' : rest;
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}
