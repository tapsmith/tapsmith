import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DETERMINISTIC_CAPTURE_REFUSALS, isRecoverableInfrastructureError } from '../worker-protocol.js';

// The deterministic-refusal patterns are substrings of daemon messages; read
// the Rust source so a reworded message fails here instead of silently making
// the refusal recoverable again (session restart → failed retry → retired
// worker, PILOT-319). Comment lines are stripped so a phrase that survives
// only in a comment doesn't count, and `\`-continued string lines are joined
// the way Rust joins them (continuation drops the next line's indentation).
const CORE = path.resolve(import.meta.dirname, '../../../tapsmith-core/src');
const rustCode = ['grpc_server.rs', 'ios/system_proxy.rs']
  .map((f) => fs.readFileSync(path.join(CORE, f), 'utf-8'))
  .join('\n')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')
  .replace(/\\\n\s*/g, '');

describe('network capture refusals and session recovery', () => {
  it('keeps a transient capture failure recoverable', () => {
    expect(isRecoverableInfrastructureError(new Error('Network capture disabled: proxy failed to bind'))).toBe(true);
  });

  it('still recovers a real agent failure that arrives alongside a refusal', () => {
    const err = new Error(
      'Agent connection dropped\n\n--- Additionally ---\nNetwork capture disabled: … so it is only used on CI …',
    );
    expect(isRecoverableInfrastructureError(err)).toBe(true);
  });

  for (const phrase of DETERMINISTIC_CAPTURE_REFUSALS) {
    it(`does not recover from a deterministic refusal ("${phrase}")`, () => {
      expect(rustCode).toContain(phrase);
      const err = new Error(`Network capture disabled: iOS network capture unavailable for SIM: … ${phrase} …`);
      expect(isRecoverableInfrastructureError(err)).toBe(false);
    });
  }
});
