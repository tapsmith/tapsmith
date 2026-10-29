import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── A tsconfig.json for the tests (PILOT-838) ───

/**
 * The tsconfig.json init writes into a project that has none. Type-aware
 * tools need one that includes the tests: typescript-eslint's
 * `projectService`, which the documented ESLint setup uses for
 * `no-floating-promises`, refuses a file no tsconfig includes, and an
 * editor checks a file outside any project only loosely.
 *
 * `Bundler` resolution reads `tapsmith`'s `exports` without NodeNext's
 * CommonJS-or-ESM rules, which in a package without `"type": "module"` make
 * older TypeScript versions reject importing the ESM-only `tapsmith`. Plain
 * JSON, without comments, so any tool can parse it.
 */
export const TSCONFIG_JSON = `${JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['tapsmith.config.ts', 'tests', '**/*.tapsmith.ts'],
}, null, 2)}\n`;

/**
 * Writes TSCONFIG_JSON to the project's tsconfig.json, unless the project
 * already has one, or a jsconfig.json, which a new tsconfig.json beside it
 * would take over from in the editor: `'present'` leaves both untouched.
 * Throws when the file cannot be written.
 */
export function writeTsconfig(cwd: string): 'created' | 'present' {
  if (['tsconfig.json', 'jsconfig.json'].some((name) => fs.existsSync(path.join(cwd, name)))) return 'present';
  // `wx`: never replace a file that appeared since the check.
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), TSCONFIG_JSON, { flag: 'wx' });
  return 'created';
}

/** writeTsconfig(), with a failure turned into the warning init prints. */
export function writeTsconfigOrWarn(cwd: string): 'created' | 'present' | { warning: string } {
  try {
    return writeTsconfig(cwd);
  } catch (err) {
    return {
      warning: `Could not write tsconfig.json (${err instanceof Error ? err.message : String(err)}): type-aware tools such as typescript-eslint need one that includes your tests`,
    };
  }
}
