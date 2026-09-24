import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecoverableInfrastructureError } from '../worker-protocol.js';

// The deterministic-refusal patterns are substrings of daemon messages; read
// the Rust source so a reworded message fails here instead of silently making
// the refusal recoverable again (session restart → failed retry → retired
// worker, PILOT-319).
const CORE = path.resolve(import.meta.dirname, '../../../tapsmith-core/src');
const rust = [
  fs.readFileSync(path.join(CORE, 'grpc_server.rs'), 'utf-8'),
  fs.readFileSync(path.join(CORE, 'ios/system_proxy.rs'), 'utf-8'),
].join('\n');

describe('network capture refusals and session recovery', () => {
  it('keeps a transient capture failure recoverable', () => {
    expect(isRecoverableInfrastructureError(new Error('Network capture disabled: proxy failed to bind'))).toBe(true);
  });

  const refusals = [
    'so it is only used on CI',
    'already routes the macOS system proxy',
    'Tapsmith will not overwrite it',
  ];
  for (const phrase of refusals) {
    it(`does not recover from a deterministic refusal ("${phrase}")`, () => {
      expect(rust).toContain(phrase);
      const err = new Error(`Network capture disabled: iOS network capture unavailable for SIM: … ${phrase} …`);
      expect(isRecoverableInfrastructureError(err)).toBe(false);
    });
  }
});
