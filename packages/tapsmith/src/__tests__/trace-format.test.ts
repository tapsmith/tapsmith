import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TRACE_FORMAT_VERSION, traceFormatProblem } from '../trace/trace-format.js';
import { archivePathMapper, toArchivePath, withPortablePaths } from '../trace/archive-paths.js';
import type { AnyTraceEvent } from '../trace/types.js';

describe('toArchivePath', () => {
  let root: string;

  beforeEach(() => {
    // realpath so the lexical and physical roots agree; the symlink case
    // below builds its own divergence deliberately.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-trace-format-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('makes a file under rootDir relative, with forward slashes', () => {
    expect(toArchivePath(path.join(root, 'e2e', 'login.test.ts'), root)).toBe('e2e/login.test.ts');
  });

  it('ignores a trailing separator on rootDir', () => {
    expect(toArchivePath(path.join(root, 'a.ts'), root + path.sep)).toBe('a.ts');
  });

  it('keeps a file outside rootDir relative, climbing with ..', () => {
    const sibling = path.join(path.dirname(root), 'shared', 'helpers.ts');
    expect(toArchivePath(sibling, root)).toBe('../shared/helpers.ts');
  });

  it('leaves an already-relative path relative (it is rootDir-relative by convention)', () => {
    expect(toArchivePath('./states/logged-in.tar.gz', root)).toBe('states/logged-in.tar.gz');
    expect(toArchivePath('states\\logged-in.tar.gz', root)).toBe('states/logged-in.tar.gz');
  });

  it('returns an empty path unchanged', () => {
    expect(toArchivePath('', root)).toBe('');
  });

  it('maps rootDir itself to "."', () => {
    expect(toArchivePath(root, root)).toBe('.');
  });

  it('normalises backslash-separated absolute paths', () => {
    const file = path.join(root, 'e2e', 'a.ts').replace(/\//g, '\\');
    // Only meaningful where backslashes are separators; on POSIX the
    // normalisation to "/" is what makes the path resolvable at all.
    expect(toArchivePath(file, root)).toBe('e2e/a.ts');
  });

  describe('with a symlinked rootDir', () => {
    let link: string;

    beforeEach(() => {
      fs.mkdirSync(path.join(root, 'real', 'e2e'), { recursive: true });
      fs.writeFileSync(path.join(root, 'real', 'e2e', 'a.ts'), '');
      link = path.join(root, 'link');
      fs.symlinkSync(path.join(root, 'real'), link, 'dir');
    });

    // Node reports module paths realpath'd (preserveSymlinks is off), so a
    // stack frame names the physical file while a config's rootDir may name
    // the link. Both spellings must land on the same archive path, or
    // sources.json keys and stack frames stop matching.
    it('relativises a realpath frame against a symlinked root', () => {
      expect(toArchivePath(path.join(root, 'real', 'e2e', 'a.ts'), link)).toBe('e2e/a.ts');
    });

    it('relativises a symlink-spelled frame against a physical root', () => {
      expect(toArchivePath(path.join(link, 'e2e', 'a.ts'), path.join(root, 'real'))).toBe('e2e/a.ts');
    });

    it('relativises a file that no longer exists without throwing', () => {
      expect(toArchivePath(path.join(root, 'real', 'gone.ts'), link)).toBe('gone.ts');
    });

    // A monorepo helper beside a rootDir reached through a link: the frame is
    // realpath'd, so the lexical answer climbs out of the link's prefix and
    // spells the whole physical tree. The short physical answer is portable.
    it('climbs the short way to a sibling of a symlinked root', () => {
      fs.mkdirSync(path.join(root, 'real', 'app'));
      fs.mkdirSync(path.join(root, 'real', 'shared'));
      fs.writeFileSync(path.join(root, 'real', 'shared', 'h.ts'), '');
      const linkedApp = path.join(link, 'app');
      expect(toArchivePath(path.join(root, 'real', 'shared', 'h.ts'), linkedApp)).toBe('../shared/h.ts');
    });

    // ~/proj → ~/code/proj with a helper at ~/code/shared: the lexical and
    // physical answers climb equally far, and only the physical one matches
    // what an unlinked checkout of the same tree records.
    it('spells a sibling of a linked root the way an unlinked checkout does, even when the climbs tie', () => {
      fs.mkdirSync(path.join(root, 'code', 'proj'), { recursive: true });
      fs.mkdirSync(path.join(root, 'code', 'shared'));
      fs.writeFileSync(path.join(root, 'code', 'shared', 'x.ts'), '');
      const projLink = path.join(root, 'proj');
      fs.symlinkSync(path.join(root, 'code', 'proj'), projLink, 'dir');
      const helper = path.join(root, 'code', 'shared', 'x.ts');

      expect(toArchivePath(helper, path.join(root, 'code', 'proj'))).toBe('../shared/x.ts');
      expect(toArchivePath(helper, projLink)).toBe('../shared/x.ts');
    });
  });
});

describe('archivePathMapper', () => {
  let base: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-mapper-')));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('learns nothing from a known file spelled outside rootDir through nested links', () => {
    // rootDir base/phys/proj; base/L → base/phys; base/phys/alias → rootDir/e2e/deep.
    // The test path base/L/alias/a.test.ts escapes rootDir lexically, so its
    // lexical ancestors (base/L, …) do not line up with any rootDir-relative
    // directory — seeding them would claim unrelated files.
    const rootDir = path.join(base, 'phys', 'proj');
    fs.mkdirSync(path.join(rootDir, 'e2e', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'e2e', 'deep', 'a.test.ts'), '');
    fs.writeFileSync(path.join(rootDir, 'src', 'h.ts'), '');
    fs.symlinkSync(path.join(base, 'phys'), path.join(base, 'L'), 'dir');
    fs.symlinkSync(path.join(rootDir, 'e2e', 'deep'), path.join(base, 'phys', 'alias'), 'dir');

    const toPath = archivePathMapper(rootDir, [path.join(base, 'L', 'alias', 'a.test.ts')]);

    expect(toPath(path.join(rootDir, 'src', 'h.ts'))).toBe('src/h.ts');
    expect(toPath(path.join(rootDir, 'e2e', 'deep', 'a.test.ts'))).toBe('e2e/deep/a.test.ts');
  });
});

describe('withPortablePaths', () => {
  const root = path.resolve('/work/app');

  it('rewrites sourceLocation and every stack frame of actions and assertions', () => {
    const events: AnyTraceEvent[] = [
      {
        type: 'action', actionIndex: 0, timestamp: 1, category: 'tap', action: 'tap',
        duration: 1, success: true,
        hasScreenshotBefore: false, hasScreenshotAfter: false,
        hasHierarchyBefore: false, hasHierarchyAfter: false,
        sourceLocation: { file: path.join(root, 'e2e/a.ts'), line: 3 },
        stack: [
          { file: path.join(root, 'e2e/a.ts'), line: 3, column: 5 },
          { file: path.join(root, 'e2e/screens/login.ts'), line: 9 },
        ],
      },
      {
        type: 'assertion', actionIndex: 1, timestamp: 2, assertion: 'toBeVisible',
        passed: true, soft: false, negated: false, duration: 1, attempts: 1,
        sourceLocation: { file: path.join(root, 'e2e/a.ts'), line: 4 },
      },
      { type: 'console', actionIndex: 1, timestamp: 3, level: 'log', message: '/work/app/x', source: 'test' },
    ];

    const out = withPortablePaths(events, archivePathMapper(root));

    expect(out[0]).toMatchObject({
      sourceLocation: { file: 'e2e/a.ts', line: 3 },
      stack: [
        { file: 'e2e/a.ts', line: 3, column: 5 },
        { file: 'e2e/screens/login.ts', line: 9 },
      ],
    });
    expect(out[1]).toMatchObject({ sourceLocation: { file: 'e2e/a.ts', line: 4 } });
    // Free text is display-only and left alone.
    expect(out[2]).toEqual(events[2]);
  });

  it('does not mutate the collector-owned events (UI mode streams them with absolute paths)', () => {
    const file = path.join(root, 'e2e/a.ts');
    const events: AnyTraceEvent[] = [{
      type: 'action', actionIndex: 0, timestamp: 1, category: 'tap', action: 'tap',
      duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
      sourceLocation: { file, line: 1 }, stack: [{ file, line: 1 }],
    }];

    withPortablePaths(events, archivePathMapper(root));

    expect(events[0]).toMatchObject({ sourceLocation: { file }, stack: [{ file }] });
  });
});

describe('traceFormatProblem', () => {
  it('accepts the current version and every earlier one', () => {
    for (let v = 1; v <= TRACE_FORMAT_VERSION; v++) {
      expect(traceFormatProblem({ version: v })).toBeUndefined();
    }
  });

  it('refuses a newer version with an upgrade hint naming both versions', () => {
    const problem = traceFormatProblem({ version: TRACE_FORMAT_VERSION + 1, tapsmithVersion: '9.0.0' });
    expect(problem).toMatch(new RegExp(`format version ${TRACE_FORMAT_VERSION + 1}`));
    expect(problem).toMatch(new RegExp(`up to ${TRACE_FORMAT_VERSION}`));
    expect(problem).toContain('Tapsmith 9.0.0');
    expect(problem).toMatch(/upgrade/i);
  });

  it('refuses metadata with no usable version', () => {
    for (const metadata of [{}, { version: '2' }, { version: 0 }, { version: 1.5 }, { version: null }, null, 'x']) {
      expect(traceFormatProblem(metadata)).toMatch(/not a Tapsmith trace|no format version/i);
    }
  });
});
