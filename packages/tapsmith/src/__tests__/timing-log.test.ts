import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { timingLog } from '../timing-log.js';

describe('timingLog', () => {
  const saved = process.env.TAPSMITH_TIMING_LOG;
  const dirs: string[] = [];
  afterEach(() => {
    if (saved === undefined) delete process.env.TAPSMITH_TIMING_LOG;
    else process.env.TAPSMITH_TIMING_LOG = saved;
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines in the daemon\'s format, creating the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-timing-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'ios-timing-1.log');
    process.env.TAPSMITH_TIMING_LOG = file;
    timingLog('kind=boot name=app_install dur_ms=12');
    timingLog('kind=boot name=app_install dur_ms=34');
    expect(fs.readFileSync(file, 'utf8')).toBe(
      `[TIMING] pid=${process.pid} kind=boot name=app_install dur_ms=12\n`
      + `[TIMING] pid=${process.pid} kind=boot name=app_install dur_ms=34\n`,
    );
  });

  it('does nothing when the log is not set', () => {
    delete process.env.TAPSMITH_TIMING_LOG;
    expect(() => timingLog('kind=boot name=x dur_ms=1')).not.toThrow();
  });

  it('never throws when the log cannot be written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-timing-'));
    dirs.push(dir);
    // A directory where the file should be: the append fails.
    process.env.TAPSMITH_TIMING_LOG = dir;
    expect(() => timingLog('kind=boot name=x dur_ms=1')).not.toThrow();
  });
});
