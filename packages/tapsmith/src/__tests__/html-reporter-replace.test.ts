import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HtmlReporter } from '../reporters/html.js';
import type { TapsmithConfig } from '../config.js';
import type { FullResult } from '../reporter.js';

let rootDir: string;
let folder: string;

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-html-replace-'));
  folder = path.join(rootDir, 'report');
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function artifact(rel: string): string {
  const file = path.join(rootDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rel);
  return file;
}

async function report(test: Record<string, string> = {}): Promise<void> {
  const reporter = new HtmlReporter({ outputFolder: 'report', open: 'never' });
  reporter.onRunStart({ rootDir } as TapsmithConfig, 1);
  await reporter.onRunEnd({
    status: 'passed', duration: 1, suites: [],
    tests: [{ name: 't', fullName: 't', status: 'passed', durationMs: 1, ...test }],
  } as unknown as FullResult);
}

const visible = (): string[] => fs.readdirSync(folder).filter((f) => !f.startsWith('.')).sort();

describe('HtmlReporter replacing the previous report', () => {
  it('leaves only the current report\'s files', async () => {
    await report({ screenshotPath: artifact('r/a.png'), tracePath: artifact('r/a.zip'), videoPath: artifact('r/a.mp4') });
    expect(visible()).toEqual(['a.mp4', 'a.png', 'a.zip', 'index.html']);
    await report({ tracePath: artifact('r/b.zip') });
    expect(visible()).toEqual(['b.zip', 'index.html']);
  });

  it('keeps files it did not write, and ones replaced since', async () => {
    await report({ tracePath: artifact('r/a.zip') });
    artifact('report/favicon.ico');
    fs.writeFileSync(path.join(folder, 'a.zip'), 'something of the user\'s own');
    await report();
    expect(visible()).toEqual(['a.zip', 'favicon.ico', 'index.html']);

    await report({ tracePath: artifact('r/b.zip') });
    fs.writeFileSync(path.join(folder, 'b.zip'), 'R/B.ZIP'); // the same length
    fs.utimesSync(path.join(folder, 'b.zip'), new Date(), new Date(Date.now() + 5_000));
    await report();
    expect(visible()).toContain('b.zip');
  });

  it('never removes the artifacts it is reporting, or ones that were in the folder already', async () => {
    const inFolder = ['a.png', 'a.zip', 'a.mp4'].map((f) => artifact(`report/${f}`));
    const [screenshotPath, tracePath, videoPath] = inFolder;
    await report({ screenshotPath, tracePath, videoPath });
    await report();
    expect(inFolder.every((f) => fs.existsSync(f))).toBe(true);

    await report({ tracePath: artifact('r/b.zip') });
    await report({ tracePath: path.join(folder, 'b.zip') });
    expect(visible()).toContain('b.zip');
  });

  it('ignores ledger entries that are not plain file names, and a malformed ledger', async () => {
    const outside = artifact('app.ts');
    await report();
    fs.writeFileSync(path.join(folder, '.tapsmith-report.json'), JSON.stringify({
      files: [{ name: '../app.ts', size: 6 }, { name: outside, size: 6 }, { name: '..', size: 1 }, null, 'x'],
    }));
    await report();
    expect(fs.existsSync(outside)).toBe(true);
    fs.writeFileSync(path.join(folder, '.tapsmith-report.json'), 'nonsense');
    await report();
    expect(visible()).toEqual(['index.html']);
  });
});
