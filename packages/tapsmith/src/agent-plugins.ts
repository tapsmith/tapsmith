/**
 * The Tapsmith plugin for coding agents (plugins/tapsmith in the repo): which
 * agents a project uses, and how to install the plugin in each. `tapsmith
 * init` lists the install for each agent it finds; docs/mcp-server.md has
 * the full instructions.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_DOCS_DIR } from './agents-md.js';

// ─── Detection ───

export type CodingAgent = 'claude' | 'codex' | 'cursor';

/** In the order init lists them. */
const AGENTS: ReadonlyArray<{ agent: CodingAgent; markers: string[]; cli: string; running: (env: NodeJS.ProcessEnv) => boolean }> = [
  // Claude Code sets CLAUDECODE=1 in the shell its tools run.
  { agent: 'claude', markers: ['.claude', 'CLAUDE.md'], cli: 'claude', running: (env) => env['CLAUDECODE'] === '1' },
  // Codex sets these in the sandboxed shell its commands run in.
  {
    agent: 'codex',
    markers: ['.codex'],
    cli: 'codex',
    running: (env) => ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID'].some((name) => !!env[name]),
  },
  // Cursor's agent sets CURSOR_AGENT; its integrated terminal, CURSOR_TRACE_ID.
  { agent: 'cursor', markers: ['.cursor', '.cursorrules'], cli: 'cursor', running: (env) => !!env['CURSOR_AGENT'] || !!env['CURSOR_TRACE_ID'] },
];

/** Whether `name` is an executable file in a directory of `env.PATH`. */
export function isOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  const suffixes = platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : [''];
  return dirs.some((dir) => suffixes.some((suffix) => {
    try {
      const file = path.join(dir, name + suffix);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }));
}

/**
 * The folders whose agent project files count for `cwd`: `cwd` and each
 * folder above it up to the git root, so an `e2e/` folder in a repository
 * finds the repository's `CLAUDE.md`. Outside a repository, `cwd` alone. The
 * home folder never counts unless it is `cwd`: `~/.claude` and `~/.codex`
 * hold the agents' user settings, not a project's.
 */
function projectFolders(cwd: string): string[] {
  const start = path.resolve(cwd);
  const home = os.homedir();
  const folders: string[] = [];
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (dir === start || dir !== home) folders.push(dir);
    if (fs.existsSync(path.join(dir, '.git'))) return folders;
    if (path.dirname(dir) === dir) return [start];
  }
}

/**
 * The coding agents a project uses, in the order init lists their plugin
 * installs: the agent running init (from its environment) first, then each
 * whose project files (`.claude/`, `CLAUDE.md`, `.codex/`, `.cursor/`,
 * `.cursorrules`) are in `cwd` or a folder above it up to the git root. Only
 * when neither names one does a command on PATH (`claude`, `codex`,
 * `cursor`) count: many machines have several installed, and listing every
 * one tells a user of one agent to install the others' plugins.
 */
export function detectCodingAgents(
  cwd: string,
  { env = process.env, onPath = (cli: string) => isOnPath(cli) }: { env?: NodeJS.ProcessEnv; onPath?: (cli: string) => boolean } = {},
): CodingAgent[] {
  const folders = projectFolders(cwd);
  const running = AGENTS.filter(({ running: isRunning }) => isRunning(env));
  const inProject = AGENTS.filter(({ markers }) => folders.some((dir) => markers.some((m) => fs.existsSync(path.join(dir, m)))));
  const found = [...new Set([...running, ...inProject])];
  return (found.length > 0 ? found : AGENTS.filter(({ cli }) => onPath(cli))).map(({ agent }) => agent);
}

// ─── Install steps ───

/** The GitHub repository whose marketplaces list the plugin. */
const MARKETPLACE_REPO = 'tapsmith/tapsmith';

/**
 * How to install the plugin in each agent, as `[label, command or where to
 * read]`; `docsDir` is where the installed docs are, from the project
 * (`installedDocsDir`).
 */
export function pluginInstallSteps(agents: readonly CodingAgent[], docsDir: string = DEFAULT_DOCS_DIR): Array<[string, string]> {
  return agents.map((agent): [string, string] => {
    switch (agent) {
      case 'claude':
        return ['Claude Code plugin', `claude plugin marketplace add ${MARKETPLACE_REPO} && claude plugin install tapsmith@tapsmith`];
      case 'codex':
        return ['Codex plugin', `codex plugin marketplace add ${MARKETPLACE_REPO} && codex plugin add tapsmith@tapsmith`];
      case 'cursor':
        // Cursor installs plugins from its marketplace UI, not a command.
        return ['Cursor plugin', `see "Install the plugin" in ${docsDir}/mcp-server.md`];
    }
  });
}
