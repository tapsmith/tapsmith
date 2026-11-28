/**
 * Every `TAPSMITH_*` environment variable the docs and READMEs name must be
 * one something Tapsmith ships actually reads: a variable that was renamed or
 * removed leaves users setting a name nothing looks at, silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';
import { REPO } from './doc-samples.js';

const ENV_NAME = /\bTAPSMITH_[A-Z0-9_]*[A-Z0-9]\b/g;

/** Where shipped code lives: the SDK and CLI, the daemon, both agents, the RN hooks and the agent plugins. */
const SOURCE_GLOBS = [
  'packages/tapsmith/src/**/*.{ts,tsx,mjs}',
  'packages/tapsmith/scripts/**/*.{mjs,js}',
  'packages/tapsmith-core/src/**/*.rs',
  'packages/tapsmith-react-native/src/**/*.{ts,tsx}',
  'agent/**/*.kt',
  'ios-agent/**/*.swift',
  'plugins/source/**/*.{mjs,js}',
];

const DOC_GLOBS = ['docs/**/*.md', 'README.md', 'packages/*/README.md'];

/** The `TAPSMITH_*` names in `text`, without repeats. */
function envNamesIn(text: string): string[] {
  return [...new Set(text.match(ENV_NAME) ?? [])];
}

function read(globs: string[], ignore: string[] = []): Array<{ rel: string; text: string }> {
  return globs
    .flatMap((pattern) => glob.sync(pattern, { cwd: REPO, nodir: true, ignore: ['**/node_modules/**', ...ignore] }))
    .sort()
    .map((rel) => ({ rel, text: fs.readFileSync(path.join(REPO, rel), 'utf8') }));
}

describe('environment variables in the docs', () => {
  it('names only TAPSMITH_* variables that shipped code reads', () => {
    const sources = read(SOURCE_GLOBS, ['**/__tests__/**', '**/*.test.*', '**/build/**', '**/.build*/**']);
    expect(sources.length).toBeGreaterThan(100);
    const known = new Set(sources.flatMap(({ text }) => envNamesIn(text)));
    const unknown = read(DOC_GLOBS).flatMap(({ rel, text }) =>
      envNamesIn(text).filter((name) => !known.has(name)).map((name) => `${rel}: ${name}`));
    expect(unknown).toEqual([]);
  });

  it('finds whole names only', () => {
    expect(envNamesIn('Set `TAPSMITH_DEBUG=1`, or TAPSMITH_TELEMETRY. Not TAPSMITH_ or XTAPSMITH_FOO.')).toEqual([
      'TAPSMITH_DEBUG', 'TAPSMITH_TELEMETRY',
    ]);
  });
});
