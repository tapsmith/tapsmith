import { describe, expect, it } from 'vitest';
import { TlsRejectWarnings, tlsRejectWarning } from '../tls-reject-warning.js';

describe('tlsRejectWarning()', () => {
  it('names the hosts, the CA file and both likely causes', () => {
    const msg = tlsRejectWarning(['api.example.com', 'cdn.example.com']);
    expect(msg).toContain('api.example.com, cdn.example.com');
    expect(msg).toContain('~/.tapsmith/ca.pem');
    expect(msg).toContain('device.route()');
    expect(msg).toContain('trace.networkPassthroughHosts');
    expect(msg).toContain('trace.networkIgnoreHosts');
    expect(msg).not.toMatch(/the app rejected/);
  });

  it('summarises a long host list', () => {
    const hosts = Array.from({ length: 8 }, (_, i) => `h${i}.example.com`);
    const msg = tlsRejectWarning(hosts);
    expect(msg).toContain('h4.example.com and 3 more');
    expect(msg).not.toContain('h5.example.com');
  });
});

describe('TlsRejectWarnings', () => {
  it('returns each host once per device', () => {
    const w = new TlsRejectWarnings();
    expect(w.takeNew('a', ['x', 'y'])).toEqual(['x', 'y']);
    expect(w.takeNew('a', ['x', 'y'])).toEqual([]);
    expect(w.takeNew('a', ['y', 'z'])).toEqual(['z']);
    expect(w.takeNew('b', ['x'])).toEqual(['x']);
  });
});
