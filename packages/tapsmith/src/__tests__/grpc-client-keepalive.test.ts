import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DAEMON_CHANNEL_OPTIONS } from '../grpc-client.js';

// The client pings the daemon every 30 s and drops the connection when the
// ping is not answered within its keepalive timeout. A daemon (or SDK
// process) starved of CPU on a loaded CI runner can take longer than 10 s to
// answer; a call issued meanwhile then fails "14 UNAVAILABLE: Connection
// dropped" before the daemon ever sees it (PILOT-948: it spent the agent
// start's one retry on iOS CI). The daemon itself waits 30 s for its own
// pings to be answered, so the client is never the stricter side.

const DAEMON_MAIN = path.resolve(import.meta.dirname, '../../../tapsmith-core/src/main.rs');

function daemonKeepaliveTimeoutMs(): number {
  const source = fs.readFileSync(DAEMON_MAIN, 'utf8');
  const match = /\.http2_keepalive_timeout\(Some\(Duration::from_secs\((\d+)\)\)\)/.exec(source);
  if (!match) throw new Error('http2_keepalive_timeout not found in the daemon main.rs');
  return Number(match[1]) * 1000;
}

describe('daemon channel keepalive', () => {
  it('waits at least as long for a ping answer as the daemon does', () => {
    expect(DAEMON_CHANNEL_OPTIONS['grpc.keepalive_timeout_ms']).toBeGreaterThanOrEqual(daemonKeepaliveTimeoutMs());
  });

  it('still pings an idle connection', () => {
    expect(DAEMON_CHANNEL_OPTIONS['grpc.keepalive_time_ms']).toBe(30_000);
    expect(DAEMON_CHANNEL_OPTIONS['grpc.keepalive_permit_without_calls']).toBe(1);
  });
});
