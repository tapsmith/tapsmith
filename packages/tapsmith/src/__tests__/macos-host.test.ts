import { describe, it, expect } from 'vitest';
import { MACOS_HOST_SERIAL, macosTargetSerial } from '../macos-host.js';

describe('macosTargetSerial()', () => {
  it('runs on this Mac, pinned to it or not', () => {
    expect(macosTargetSerial(undefined)).toBe(MACOS_HOST_SERIAL);
    expect(macosTargetSerial('macos-host')).toBe('macos-host');
  });

  it('refuses a pin naming another device, rather than ignoring it', () => {
    expect(() => macosTargetSerial('emulator-5554')).toThrow(
      "platform: 'macos' runs on this Mac (macos-host), but `device` names emulator-5554. Remove `device`.",
    );
  });
});
