import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HtmlReporter } from '../reporters/html.js';
import type { TapsmithConfig } from '../config.js';
import type { FullResult } from '../reporter.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

let tmpDir: string;
let child: EventEmitter & { unref: () => void };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-html-open-'));
  child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  spawnMock.mockReset().mockReturnValue(child);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const failed: FullResult = {
  status: 'failed',
  duration: 1,
  tests: [{ name: 't', fullName: 't', status: 'failed', durationMs: 1, error: { message: 'boom' } }],
  suites: [],
} as unknown as FullResult;

async function report(open: string): Promise<void> {
  const reporter = new HtmlReporter({ outputFolder: tmpDir, open });
  reporter.onRunStart({ rootDir: tmpDir } as TapsmithConfig, 1);
  await reporter.onRunEnd(failed);
}

describe('HtmlReporter opening the report', () => {
  it('opens a failed run\'s report outside CI', async () => {
    vi.stubEnv('CI', '');
    await report('on-failure');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each(['on-failure', 'always'])('never opens it in CI (open: %s), as Playwright does', async (open) => {
    vi.stubEnv('CI', 'true');
    await report(open);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, 'index.html'))).toBe(true);
  });

  it('survives a missing opener (no xdg-open on the machine) instead of crashing', async () => {
    vi.stubEnv('CI', '');
    await report('always');
    expect(() => child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))).not.toThrow();
  });
});
