/**
 * Warning for HTTPS hosts whose client rejected Tapsmith's MITM certificate
 * (PILOT-712). The daemon reports them per test drain
 * (`StopNetworkCaptureResponse.tlsRejectedHosts`); without this the run just
 * captured nothing for them — no entries, `device.route()` never firing,
 * `waitForResponse` timing out — with no hint why.
 */

// ─── Message ───

/** Hosts named before the list is summarised as "and N more". */
const MAX_NAMED_HOSTS = 5;

export function tlsRejectWarning(hosts: readonly string[]): string {
  const named = hosts.slice(0, MAX_NAMED_HOSTS).join(', ');
  const more = hosts.length > MAX_NAMED_HOSTS ? ` and ${hosts.length - MAX_NAMED_HOSTS} more` : '';
  return (
    `an HTTPS client on the device rejected Tapsmith's certificate for ${named}${more}, so those requests ` +
    'were not captured and device.route() could not intercept them. If every host your app uses is ' +
    'rejected, the device or app does not trust the current Tapsmith CA (~/.tapsmith/ca.pem): for example ' +
    'the device trusts a CA from an earlier ~/.tapsmith, or the CA is only in Android\'s user store, which ' +
    'apps ignore unless their network_security_config.xml opts in. If only some hosts are rejected, those ' +
    'clients probably pin their certificates: list your app\'s pinned hosts in trace.networkPassthroughHosts, ' +
    'and background services you do not need in trace.networkIgnoreHosts.'
  );
}

// ─── Per-run dedupe ───

/**
 * Tracks which rejected hosts the terminal has already been told about, per
 * device, so a persistent cause prints once per run rather than once per
 * test, while a host that starts failing later is still named.
 */
export class TlsRejectWarnings {
  private readonly _warned = new Map<string, Set<string>>();

  /** The hosts of `hosts` not yet warned about for `deviceKey`, now marked warned. */
  takeNew(deviceKey: string, hosts: readonly string[]): string[] {
    let seen = this._warned.get(deviceKey);
    if (!seen) {
      seen = new Set();
      this._warned.set(deviceKey, seen);
    }
    const fresh = hosts.filter((h) => !seen.has(h));
    for (const h of fresh) seen.add(h);
    return fresh;
  }
}
