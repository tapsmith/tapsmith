import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { networkCaptureRouteFromProto } from '../grpc-client.js';

// The proto loader delivers enums by name, so a value added to the proto but
// not to the SDK map would silently drop the route from trace metadata.
const PROTO = fs.readFileSync(path.resolve(import.meta.dirname, '../../../../proto/tapsmith.proto'), 'utf-8');

function protoRouteNames(): string[] {
  const body = /enum NetworkCaptureRoute \{([\s\S]*?)\}/.exec(PROTO)?.[1] ?? '';
  return [...body.matchAll(/^\s*(NETWORK_CAPTURE_ROUTE_[A-Z_]+)\s*=/gm)].map((m) => m[1]);
}

describe('networkCaptureRouteFromProto()', () => {
  it('maps every route the proto declares', () => {
    const names = protoRouteNames();
    expect(names.length).toBeGreaterThan(1);
    for (const name of names.filter((n) => n !== 'NETWORK_CAPTURE_ROUTE_UNSPECIFIED')) {
      expect(networkCaptureRouteFromProto(name), name).toBeDefined();
    }
  });

  it('maps the host-wide iOS fallback', () => {
    expect(networkCaptureRouteFromProto('NETWORK_CAPTURE_ROUTE_IOS_SYSTEM_PROXY')).toBe('ios-system-proxy');
  });

  it('returns undefined for UNSPECIFIED, unknown and missing values', () => {
    expect(networkCaptureRouteFromProto('NETWORK_CAPTURE_ROUTE_UNSPECIFIED')).toBeUndefined();
    expect(networkCaptureRouteFromProto('NETWORK_CAPTURE_ROUTE_FUTURE')).toBeUndefined();
    expect(networkCaptureRouteFromProto(undefined)).toBeUndefined();
  });
});
