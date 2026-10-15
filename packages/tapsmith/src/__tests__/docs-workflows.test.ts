/**
 * Docs guard (PILOT-719): every GitHub Actions sample in the docs and READMEs
 * is linted with actionlint, so a sample with a constant `if:`, a bad
 * expression, an unknown key or a shell bug in a `run:` script fails here
 * instead of in a newcomer's first CI run.
 *
 * Samples come in four shapes: whole workflows, a map of jobs, the inside of
 * one job (`strategy:` + `steps:`), and a list of steps. Each fragment is
 * wrapped into the smallest workflow that holds it — a job that `needs:` a job
 * the fragment does not show gets a stub — and actionlint's findings are
 * mapped back to the line in the doc.
 *
 * actionlint is not an npm package: CI installs a pinned release (ci.yml,
 * `typescript` job) and this test fails there without it; a local run without
 * `actionlint` on the PATH skips with a warning.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { docFiles, fencedBlocksIn, REPO, type FencedBlock } from './doc-samples.js';

// ─── Classification ───

const YAML_LANGS = new Set(['yaml', 'yml']);

/** YAML samples that are not GitHub Actions (package-manager and Maestro config). */
const NOT_ACTIONS = ['docs/getting-started.md', 'docs/migrating-from-maestro.md'];

/** Keys a job may have (https://docs.github.com/actions/reference/workflow-syntax-for-github-actions). */
const JOB_KEYS = new Set([
  'name', 'permissions', 'needs', 'if', 'runs-on', 'environment', 'concurrency', 'outputs', 'env',
  'defaults', 'steps', 'timeout-minutes', 'strategy', 'continue-on-error', 'container', 'services',
  'uses', 'with', 'secrets',
]);

type Shape = 'workflow' | 'jobs' | 'job' | 'steps';

function contentLines(code: string): string[] {
  return code.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The sample with its common indentation removed (a steps fragment is often shown at its in-job depth). */
function dedent(code: string): string {
  const lines = code.split('\n');
  const min = Math.min(...contentLines(code).map(indentOf));
  return lines.map((l) => (l.trim() === '' ? '' : l.slice(min))).join('\n');
}

/** What part of a workflow a YAML sample is, or `null` when it is not GitHub Actions at all. */
function shapeOf(code: string): Shape | null {
  const lines = contentLines(dedent(code));
  if (lines.length === 0) return null;
  if (lines[0]!.startsWith('- ')) {
    return lines.some((l) => /^\s*-?\s*(uses|run):/.test(l)) ? 'steps' : null;
  }
  const topKeys = lines.filter((l) => indentOf(l) === 0).map((l) => /^([\w-]+):/.exec(l)?.[1]).filter((k): k is string => !!k);
  if (topKeys.includes('jobs')) return 'workflow';
  if (topKeys.length > 0 && topKeys.every((k) => JOB_KEYS.has(k)) && (topKeys.includes('steps') || topKeys.includes('runs-on'))) {
    return 'job';
  }
  const secondLevel = lines.filter((l) => indentOf(l) > 0);
  const depth = Math.min(...secondLevel.map(indentOf));
  if (secondLevel.some((l) => indentOf(l) === depth && /^\s*(runs-on|steps):/.test(l))) return 'jobs';
  return null;
}

// ─── Wrapping ───

interface Wrapped {
  text: string;
  /** Lines added before the sample's own lines. */
  offset: number;
}

function indent(code: string, by: number): string {
  const pad = ' '.repeat(by);
  return code.split('\n').map((l) => (l === '' ? l : pad + l)).join('\n');
}

/** The smallest workflow that holds a sample of `shape`. */
function wrap(code: string, shape: Shape): Wrapped {
  const body = dedent(code).replace(/\n+$/, '');
  if (shape === 'workflow') return { text: `${body}\n`, offset: 0 };
  if (shape === 'steps') {
    const header = ['on: push', 'jobs:', '  sample:', '    runs-on: ubuntu-latest', '    steps:'];
    return { text: `${header.join('\n')}\n${indent(body, 6)}\n`, offset: header.length };
  }
  if (shape === 'job') {
    const header = ['on: push', 'jobs:', '  sample:'];
    if (!/^runs-on:/m.test(body)) header.push('    runs-on: ubuntu-latest');
    return { text: `${header.join('\n')}\n${indent(body, 4)}\n`, offset: header.length };
  }
  // A map of jobs: stub every job one of them needs that the sample does not define.
  const header = ['on: push', 'jobs:'];
  const defined = new Set(contentLines(body).filter((l) => indentOf(l) === 0).map((l) => l.replace(/:.*$/, '')));
  const needed = [...body.matchAll(/^\s+needs:\s*(.+)$/gm)]
    .flatMap((m) => m[1]!.replace(/[[\]]/g, '').split(','))
    .map((n) => n.trim())
    .filter((n) => n && !defined.has(n));
  const stubs = [...new Set(needed)].map((n) => `  ${n}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo stub`);
  return { text: `${header.join('\n')}\n${indent(body, 2)}\n${stubs.join('\n')}\n`, offset: header.length };
}

// ─── Linting ───

interface Finding {
  file: string;
  line: number;
  message: string;
}

function findActionlint(): string | null {
  const probe = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
  return probe.status === 0 ? 'actionlint' : null;
}

const ACTIONLINT = findActionlint();

if (!ACTIONLINT && !process.env.CI) {
  console.warn('docs-workflows.test.ts: skipped the actionlint checks — `actionlint` is not on the PATH (brew install actionlint).');
}

/** actionlint's findings for each sample, at the sample's line in its doc. */
function lint(samples: Array<FencedBlock & { shape: Shape }>): Finding[] {
  if (samples.length === 0) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-workflows-'));
  try {
    const byPath = new Map<string, { sample: FencedBlock; offset: number }>();
    const paths = samples.map((sample, i) => {
      const { text, offset } = wrap(sample.code, sample.shape);
      const file = path.join(dir, `${i}.yml`);
      fs.writeFileSync(file, text);
      byPath.set(file, { sample, offset });
      return file;
    });
    let out: string;
    try {
      out = execFileSync(ACTIONLINT!, ['-no-color', '-format', '{{json .}}', ...paths], { encoding: 'utf8', cwd: dir });
    } catch (err) {
      // Exit 1 means "found problems"; anything else is actionlint failing to run.
      const e = err as { status?: number; stdout?: string; stderr?: string };
      if (e.status !== 1 || !e.stdout) throw new Error(`actionlint failed (exit ${e.status}): ${e.stderr ?? ''}`);
      out = e.stdout;
    }
    const errors = JSON.parse(out || '[]') as Array<{ filepath: string; line: number; message: string; kind: string }>;
    return errors.map((e) => {
      const at = byPath.get(path.resolve(dir, e.filepath))!;
      const line = at.sample.line + Math.max(e.line - at.offset - 1, 0);
      return { file: at.sample.file, line, message: `${e.message} [${e.kind}]` };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function yamlBlocksIn(file: string, source: string): FencedBlock[] {
  return fencedBlocksIn(file, source).filter((b) => YAML_LANGS.has(b.lang));
}

function collectYamlBlocks(): FencedBlock[] {
  return docFiles().flatMap((rel) => yamlBlocksIn(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')));
}

// ─── Tests ───

describe('GitHub Actions samples in the docs', () => {
  const blocks = collectYamlBlocks();
  const classified = blocks.map((b) => ({ ...b, shape: shapeOf(b.code) }));

  it('recognises every YAML sample outside the non-Actions docs as part of a workflow', () => {
    const unrecognised = classified.filter((b) => b.shape === null);
    expect(unrecognised.filter((b) => !NOT_ACTIONS.includes(b.file)).map((b) => `${b.file}:${b.line}`)).toEqual([]);
    // An entry nothing matches fails, so the list cannot rot.
    expect(NOT_ACTIONS.filter((f) => !unrecognised.some((b) => b.file === f))).toEqual([]);
    expect(classified.filter((b) => b.shape !== null && NOT_ACTIONS.includes(b.file)).map((b) => `${b.file}:${b.line}`)).toEqual([]);
  });

  it.skipIf(!ACTIONLINT && !process.env.CI)('pass actionlint', () => {
    expect(ACTIONLINT, 'actionlint must be on the PATH in CI (see the typescript job in ci.yml)').not.toBeNull();
    const samples = classified.filter((b): b is FencedBlock & { shape: Shape } => b.shape !== null);
    expect(samples.length).toBeGreaterThan(5);
    const findings = lint(samples).map((f) => `${f.file}:${f.line}: ${f.message}`);
    expect(findings).toEqual([]);
  }, 60_000);
});

describe('docs-workflows guard', () => {
  it('classifies the shapes samples come in', () => {
    expect(shapeOf('name: CI\non: push\njobs:\n  a:\n    runs-on: x\n    steps: []\n')).toBe('workflow');
    expect(shapeOf('merge:\n  needs: test\n  runs-on: ubuntu-latest\n  steps:\n    - run: x\n')).toBe('jobs');
    expect(shapeOf('strategy:\n  matrix:\n    shard: [1, 2]\n\nsteps:\n  - run: x\n')).toBe('job');
    expect(shapeOf('      - name: A\n        run: x\n\n      - uses: y@v1\n')).toBe('steps');
    expect(shapeOf('# .yarnrc.yml\nnodeLinker: node-modules\n')).toBeNull();
    expect(shapeOf('appId: x\n---\n- launchApp:\n    clearState: true\n')).toBeNull();
    expect(shapeOf('allowBuilds:\n  esbuild: false\n')).toBeNull();
  });

  it('stubs the jobs a jobs fragment needs', () => {
    const { text } = wrap('merge:\n  needs: [test, build]\n  runs-on: ubuntu-latest\n  steps:\n    - run: x\n', 'jobs');
    expect(text).toContain('\n  test:\n    runs-on: ubuntu-latest');
    expect(text).toContain('\n  build:\n    runs-on: ubuntu-latest');
    expect(text).not.toContain('\n  merge:\n    runs-on');
  });

  it.skipIf(!ACTIONLINT)('reports a finding at its line in the doc', () => {
    const md = [
      'Some prose.', // 1
      '', // 2
      '```yaml', // 3
      '      - name: Always', // 4
      '        if: ${{ true }}', // 5
      '        run: echo hi', // 6
      '```', // 7
      '',
      '```yaml',
      'merge:',
      '  needs: test',
      '  runs-on: ubuntu-latest',
      '  steps:',
      '    - uses: actions/checkout@v4',
      '```',
    ].join('\n');
    const samples = yamlBlocksIn('t.md', md).map((b) => ({ ...b, shape: shapeOf(b.code)! }));
    const findings = lint(samples);
    expect(findings.map((f) => [f.file, f.line])).toEqual([['t.md', 5]]);
    expect(findings[0]!.message).toMatch(/constant/);
  });
});
