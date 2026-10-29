import { describe, it, expect } from 'vitest';
import { filesToRediscover } from '../ui-mode/ui-rediscovery.js';

// PILOT-836: UI-mode MCP calls sync the test files with the disk rather than
// waiting on the watcher. Only what the watcher itself would have picked up:
// a session started on a file selection (`tapsmith test --ui login.test.ts`)
// must not grow to the whole suite on the first MCP call.

const START = 1_000_000;

function pick(opts: {
  globbed: string[]
  known: string[]
  mtimes?: Record<string, number>
  ignored?: string[]
}): string[] {
  return filesToRediscover({
    globbed: opts.globbed,
    known: opts.known,
    since: START,
    mtimeOf: (f) => opts.mtimes?.[f],
    isIgnored: (f) => (opts.ignored ?? []).includes(f),
  });
}

describe('filesToRediscover', () => {
  it('queues a test file written since the session started', () => {
    expect(pick({ globbed: ['/a.test.ts', '/new.test.ts'], known: ['/a.test.ts'], mtimes: { '/new.test.ts': START + 10 } }))
      .toEqual(['/new.test.ts']);
  });

  it('leaves out a file the session\'s selection excluded, untouched since it started', () => {
    expect(pick({ globbed: ['/login.test.ts', '/cart.test.ts'], known: ['/login.test.ts'], mtimes: { '/cart.test.ts': START - 60_000 } }))
      .toEqual([]);
  });

  it('queues a known file gone from the glob, so it is dropped', () => {
    expect(pick({ globbed: [], known: ['/gone.test.ts'] })).toEqual(['/gone.test.ts']);
  });

  it('skips ignored paths and files it cannot stat', () => {
    expect(pick({
      globbed: ['/out/x.test.ts', '/vanished.test.ts'],
      known: [],
      mtimes: { '/out/x.test.ts': START + 1 },
      ignored: ['/out/x.test.ts'],
    })).toEqual([]);
  });

  it('queues nothing when the disk matches the session', () => {
    expect(pick({ globbed: ['/a.test.ts'], known: ['/a.test.ts'] })).toEqual([]);
  });
});
