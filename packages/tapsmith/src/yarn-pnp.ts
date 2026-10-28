/**
 * Yarn Plug'n'Play (PILOT-560).
 *
 * Under PnP, packages stay inside zip archives in Yarn's cache and Node reaches
 * them only through the `.pnp.cjs` runtime Yarn loads into the process. Running
 * tests means starting tsx, the daemon and the device agents as programs from
 * files on disk, so a test run there fails with `spawn ENOTDIR` (tsx inside a
 * zip) or worse. Until that is supported, the commands that run tests refuse
 * up front with the one fix that works: the node-modules linker.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTapsmithResolvableFrom } from './config.js';

/** The commands that start tests, and with them tsx, the daemon and an agent. */
const TEST_RUNNING_COMMANDS = new Set(['test', 'verify', 'mcp-server']);

interface CliRefusal {
  code: string;
  message: string;
  fix: string;
}

const YARN_PNP_MESSAGE = "Tapsmith can't run tests in a Yarn Plug'n'Play install: it starts tsx, its daemon and "
  + "its device agents from files on disk, and Plug'n'Play keeps packages inside zip archives.";

export const YARN_PNP_FIX = 'Add `nodeLinker: node-modules` to .yarnrc.yml, run `yarn install`, then run the command again.';

interface PnpEnv {
  versions: Readonly<Record<string, string | undefined>>;
  /** Where the command runs: the project. */
  cwd: string;
}

const processEnv = (): PnpEnv => ({ versions: process.versions, cwd: process.cwd() });

/**
 * Whether Tapsmith is running in a Plug'n'Play install. Yarn's `.pnp.cjs`
 * runtime sets `process.versions.pnp` wherever it is loaded (`yarn tapsmith …`).
 * `npx tapsmith …` in such a project runs a downloaded copy under plain Node
 * instead, so that also counts: a `.pnp.cjs` at or above `cwd`, a project
 * that declares tapsmith, and no `tapsmith` that resolves from `node_modules`.
 * The last two keep a stray `.pnp.cjs` in a parent directory (a `yarn` run in
 * $HOME) from turning an installed node-modules project, or one that has not
 * added Tapsmith, into a Plug'n'Play refusal. Best effort: a project below such
 * a stray file that declares Tapsmith but has not run its install yet still
 * reads as Plug'n'Play.
 */
export function isYarnPnp(env: PnpEnv = processEnv()): boolean {
  if (typeof env.versions.pnp === 'string') return true;
  return hasPnpManifestAbove(env.cwd) && declaresTapsmith(env.cwd) && !isTapsmithResolvableFrom(env.cwd);
}

/**
 * Whether `tapsmith init` is setting up a Plug'n'Play project (PILOT-778):
 * {@link isYarnPnp}, or the project's own `.pnp.cjs` — before Tapsmith is
 * added, which is when init usually runs, isYarnPnp cannot tell a project
 * from one under a stray parent `.pnp.cjs`, but a `.pnp.cjs` beside it is the
 * project's own install.
 */
export function projectUsesYarnPnp(env: PnpEnv = processEnv()): boolean {
  return isYarnPnp(env) || fs.existsSync(path.join(env.cwd, '.pnp.cjs'));
}

/** What init says in a Plug'n'Play project, before anything else goes wrong (PILOT-778). */
export const YARN_PNP_INIT_WARNING = "This is a Yarn Plug'n'Play install, where Tapsmith can't run tests: it starts tsx, its "
  + 'daemon and its device agents from files on disk. Add `nodeLinker: node-modules` to .yarnrc.yml and run `yarn install` before running tests.';

/** init's next step for a Plug'n'Play project. */
export const YARN_PNP_INIT_STEP = 'add `nodeLinker: node-modules` to .yarnrc.yml, then run `yarn install`';

/** Whether the nearest package.json at or above `dir` depends on tapsmith. */
function declaresTapsmith(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as Record<string, unknown>;
        return ['dependencies', 'devDependencies'].some((field) => {
          const deps = pkg[field];
          return typeof deps === 'object' && deps !== null && 'tapsmith' in deps;
        });
      } catch {
        return false;
      }
    }
    if (path.dirname(current) === current) return false;
  }
}

function hasPnpManifestAbove(dir: string): boolean {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.pnp.cjs'))) return true;
    if (path.dirname(current) === current) return false;
  }
}

/** Why `command` cannot run here, or undefined when it can. */
export function yarnPnpRefusal(command: string, env: PnpEnv = processEnv()): CliRefusal | undefined {
  if (!TEST_RUNNING_COMMANDS.has(command) || !isYarnPnp(env)) return undefined;
  return { code: 'YARN_PNP_UNSUPPORTED', message: YARN_PNP_MESSAGE, fix: YARN_PNP_FIX };
}
