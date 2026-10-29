import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { preflightLoadError, preflightTestFiles } from '../selection-preflight.js';

// Forks the real child (under tsx, from src/), so allow for a cold start.
describe('preflightTestFiles', { timeout: 60_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-preflight-')));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    return file;
  };

  it('reads each file, and returns the error a file failed to load with, prepared for a report', async () => {
    const empty = write('empty.test.mjs', 'export {};\n');
    const broken = write('broken.test.mjs', 'throw new Error("boom");\n');
    const syntax = write('syntax.test.mjs', 'export const a = 1;\nconst x = ;\n');
    const found = await preflightTestFiles([empty, broken, syntax]);
    expect(found.get(empty)).toEqual({ names: [] });
    const thrown = found.get(broken);
    expect(thrown && 'error' in thrown && thrown.error).toMatchObject({ name: 'Error', message: 'boom' });
    expect(thrown && 'error' in thrown && thrown.error.stack).toContain(`${broken}:1:7`);
    // The location Node leaves out of a JavaScript syntax error, found in the child.
    const located = found.get(syntax);
    expect(located && 'error' in located && located.error.name).toBe('SyntaxError');
    expect(located && 'error' in located && located.error.stack).toContain(`at ${syntax}:2:11`);
  });

  it('rebuilds a load error as an Error with its name and stack', () => {
    const error = preflightLoadError({ name: 'SyntaxError', message: 'Unexpected token', stack: 'SyntaxError: Unexpected token\n    at /p/a.test.js:2:11' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SyntaxError');
    expect(error.message).toBe('Unexpected token');
    expect(error.stack).toBe('SyntaxError: Unexpected token\n    at /p/a.test.js:2:11');
  });

  it('gives up on a file whose import never finishes, marking every file unknown, and leaves no process behind', async () => {
    const marker = path.join(dir, 'pid');
    const hang = write('hang.test.mjs',
      `import * as fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n`);
    const found = await preflightTestFiles([hang], 3_000);
    expect([...found]).toEqual([[hang, undefined]]);
    const pid = Number(fs.readFileSync(marker, 'utf-8'));
    // The process importing the file — under tsx, a grandchild — is gone too.
    await new Promise((r) => setTimeout(r, 500));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('leaves no process behind when Ctrl-C reaches the terminal\'s process group mid-import', async () => {
    // The terminal sends SIGINT to its whole foreground group. The process
    // importing the file — under tsx, a grandchild — must be in that group.
    const marker = path.join(dir, 'pid');
    const hang = write('hang.test.mjs',
      `import * as fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n`);
    const driver = write('driver.mts',
      `import { preflightTestFiles } from ${JSON.stringify(path.resolve(__dirname, '..', 'selection-preflight.ts'))};\n`
      // As the CLI dies on Ctrl-C: the signal re-raised (signal-exit's way),
      // so the process ends by the signal and no 'exit' event fires.
      + `process.once('SIGINT', () => process.kill(process.pid, 'SIGINT'));\n`
      + `await preflightTestFiles([${JSON.stringify(hang)}]);\n`);
    const tsx = path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx');
    // detached: its own process group, standing in for the terminal's.
    const logFd = fs.openSync(path.join(dir, 'driver.log'), 'w');
    const parent = spawn(tsx, [driver], { detached: true, stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(marker)) throw new Error(fs.readFileSync(path.join(dir, 'driver.log'), 'utf-8'));
    const pid = Number(fs.readFileSync(marker, 'utf-8'));
    process.kill(-parent.pid!, 'SIGINT');
    await new Promise((r) => setTimeout(r, 1_000));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) process.kill(pid, 'SIGKILL');
    expect(alive).toBe(false);
  });
});
