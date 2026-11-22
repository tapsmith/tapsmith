import { describe, expect, it } from 'vitest';
import { loopbackCaptureWarning, loopbackUnfiredRouteReason } from '../loopback-capture-warning.js';

describe('loopbackCaptureWarning()', () => {
  it('names the servers, why capture misses them, and the fix', () => {
    const msg = loopbackCaptureWarning(['127.0.0.1:4610', '[::1]:4611']);
    expect(msg).toContain('127.0.0.1:4610, [::1]:4611');
    expect(msg).toContain('localhost');
    expect(msg).toContain('iOS simulator');
    expect(msg).toContain('device.route()');
    expect(msg).toContain('waitForRequest()');
    expect(msg).toContain('ipconfig getifaddr en0');
    expect(msg).toContain('https://tapsmith.dev/platform/ios-network-capture/#requests-to-localhost-are-not-captured');
    expect(msg).not.toContain('\n');
  });

  it('summarises a long list', () => {
    const msg = loopbackCaptureWarning(Array.from({ length: 7 }, (_, i) => `127.0.0.1:${5000 + i}`));
    expect(msg).toContain('127.0.0.1:5004 and 2 more');
    expect(msg).not.toContain('127.0.0.1:5005');
  });
});

describe('loopbackUnfiredRouteReason()', () => {
  it('says the route could not see requests to those servers', () => {
    const reason = loopbackUnfiredRouteReason(['127.0.0.1:4610']);
    expect(reason).toContain('127.0.0.1:4610');
    expect(reason).toContain('routes cannot see');
    expect(reason).toContain("Mac's LAN address");
  });
});
