import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { beginTestFileImport } from '../test-file-import.js';

// PILOT-953: the runner imports a test file fresh every time one process runs
// it again, and refuses to report an unchanged file that suddenly registers
// nothing as an empty, passing one.

let tempDir: string | undefined;

function writeFile(name: string, source: string): string {
  tempDir ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-file-import-')));
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, source);
  return filePath;
}

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('beginTestFileImport', () => {
  it('imports a file by its own path the first time, and by a URL never used before every later time', () => {
    const file = writeFile('a.test.mjs', '');
    expect(beginTestFileImport(file).url).toBe(file);
    const urls = Array.from({ length: 20 }, () => beginTestFileImport(file).url);
    expect(new Set(urls).size).toBe(20);
    for (const url of urls) expect(url).toMatch(/^.+\?tapsmithImport=\d+$/);
  });

  it('treats a path and its file URL as the same file', () => {
    const file = writeFile('b.test.mjs', '');
    beginTestFileImport(file);
    expect(beginTestFileImport(`file://${file}`).url).toMatch(/\?tapsmithImport=\d+$/);
  });

  it('re-imports a file whose earlier import threw', () => {
    const file = writeFile('c.test.mjs', '');
    beginTestFileImport(file); // never reaches registered(): the import threw
    expect(beginTestFileImport(file).url).not.toBe(file);
  });

  it('offers one fresh reload when the first import of a file registers nothing', () => {
    const file = writeFile('r.test.mjs', '');
    const first = beginTestFileImport(file);
    expect(first.reloadUrl(2)).toBeUndefined();
    const empty = beginTestFileImport(writeFile('r2.test.mjs', ''));
    expect(empty.reloadUrl(0)).toMatch(/\?tapsmithImport=\d+$/);
    // A re-import is already fresh.
    expect(beginTestFileImport(file).reloadUrl(0)).toBeUndefined();
  });

  /** `n` tests declared in `file` itself. */
  const own = (file: string, n: number): string[] => Array.from({ length: n }, () => file);

  describe('a re-import that registers no tests', () => {
    it('fails loudly when the unchanged file registered tests before', () => {
      const file = writeFile('e.test.mjs', '');
      beginTestFileImport(file).registered(own(file, 3));
      const again = beginTestFileImport(file);
      expect(() => again.registered([])).toThrow(
        /e\.test\.mjs registered no tests on this run, but 3 when this process loaded it before, and the file has not changed since/,
      );
    });

    it('keeps failing every later import of the unchanged file, not only the first', () => {
      const file = writeFile('e2.test.mjs', '');
      beginTestFileImport(file).registered(own(file, 3));
      expect(() => beginTestFileImport(file).registered([])).toThrow(/registered no tests/);
      expect(() => beginTestFileImport(file).registered([])).toThrow(/registered no tests/);
      expect(() => beginTestFileImport(file).registered(own(file, 3))).not.toThrow();
    });

    it('is held to the same record through a symlinked spelling of the file', () => {
      const file = writeFile('e4.test.mjs', '');
      const link = path.join(path.dirname(file), 'linked');
      fs.symlinkSync(path.dirname(file), link, 'dir');
      beginTestFileImport(file).registered(own(file, 2));
      const viaLink = beginTestFileImport(path.join(link, 'e4.test.mjs'));
      expect(viaLink.url).toMatch(/\?tapsmithImport=\d+$/);
      expect(() => viaLink.registered([])).toThrow(/registered no tests/);
    });

    it('is believed when the file changed in between (its tests were deleted)', () => {
      const file = writeFile('f.test.mjs', '');
      beginTestFileImport(file).registered(own(file, 3));
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(file, later, later);
      expect(() => beginTestFileImport(file).registered([])).not.toThrow();
    });

    it('is believed when the file never registered a test', () => {
      const file = writeFile('g.test.mjs', '');
      beginTestFileImport(file).registered([]);
      expect(() => beginTestFileImport(file).registered([])).not.toThrow();
    });

    it('is compared with the latest import, not the first', () => {
      const file = writeFile('h.test.mjs', '');
      beginTestFileImport(file).registered(own(file, 2));
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(file, later, later);
      beginTestFileImport(file).registered([]);
      expect(() => beginTestFileImport(file).registered([])).not.toThrow();
    });
  });

  describe('a re-import that loses the tests a module it imports declared', () => {
    it('fails, naming the module, when the unchanged file registers fewer of them', () => {
      const file = writeFile('i.test.mjs', '');
      const suite = writeFile('shared-suite.mjs', '');
      beginTestFileImport(file).registered([suite, suite, file]);
      expect(() => beginTestFileImport(file).registered([file])).toThrow(
        /i\.test\.mjs imports shared-suite\.mjs, which declares tests at its top level[\s\S]*Declare the tests in a function that i\.test\.mjs calls/,
      );
      // And keeps failing: the record still holds the module's tests.
      expect(() => beginTestFileImport(file).registered([file])).toThrow(/shared-suite\.mjs/);
    });

    it('lets the file\'s own test count change freely, as a data-driven file\'s does', () => {
      const file = writeFile('j.test.mjs', '');
      beginTestFileImport(file).registered(own(file, 5));
      expect(() => beginTestFileImport(file).registered(own(file, 4))).not.toThrow();
    });

    it('is not held to modules the file stopped importing after an edit', () => {
      const file = writeFile('k.test.mjs', '');
      const suite = writeFile('old-suite.mjs', '');
      beginTestFileImport(file).registered([suite, file]);
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(file, later, later);
      expect(() => beginTestFileImport(file).registered([file])).not.toThrow();
    });
  });
});
