import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetCaptureFailures,
  captureFailureNotice,
  knownCaptureFailures,
  rememberCaptureFailures,
} from '../capture-warnings.js';

describe('capture failure notices', () => {
  afterEach(() => _resetCaptureFailures());

  it('prints a failure in full once per process', () => {
    expect(captureFailureNotice('NE did not connect')).toBe('full');
    expect(captureFailureNotice('NE did not connect')).toBeUndefined();
    // A different failure is its own notice.
    expect(captureFailureNotice('not approved')).toBe('full');
  });

  it('reports a failure an earlier run printed in one line, once', () => {
    // The parent hands a fresh watch/MCP child what earlier runs printed.
    rememberCaptureFailures(['NE did not connect']);
    expect(captureFailureNotice('NE did not connect')).toBe('repeat');
    expect(captureFailureNotice('NE did not connect')).toBeUndefined();
    expect(captureFailureNotice('something new')).toBe('full');
  });

  it('hands back everything reported this session for the next run', () => {
    rememberCaptureFailures(['earlier']);
    captureFailureNotice('this run');
    captureFailureNotice('earlier');
    expect(knownCaptureFailures().sort()).toEqual(['earlier', 'this run']);
    rememberCaptureFailures(undefined);
    expect(knownCaptureFailures()).toHaveLength(2);
  });
});
