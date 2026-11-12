/**
 * The Tapsmith plugin for coding agents (plugins/tapsmith in the repo): which
 * agents a project uses, and how to install the plugin in each. `tapsmith
 * init` lists the install for every agent it finds; docs/mcp-server.md has
 * the full instructions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Detection ───

export type CodingAgent = 'claude' | 'codex' | 'cursor';

/** In the order init lists them. */
const AGENTS: ReadonlyArray<{ agent: CodingAgent; markers: string[]; cli: string }> = [
  { agent: 'claude', markers: ['.claude', 'CLAUDE.md'], cli: 'claude' },
  { agent: 'codex', markers: ['.codex'], cli: 'codex' },
  { agent: 'cursor', markers: ['.cursor', '.cursorrules'], cli: 'cursor' },
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
 * The coding agents a project uses: each whose project files (`.claude/`,
 * `CLAUDE.md`, `.codex/`, `.cursor/`, `.cursorrules`) are in `cwd`, or whose
 * command (`claude`, `codex`, `cursor`) is on PATH.
 */
export function detectCodingAgents(cwd: string, onPath: (cli: string) => boolean = (cli) => isOnPath(cli)): CodingAgent[] {
  return AGENTS
    .filter(({ markers, cli }) => markers.some((m) => fs.existsSync(path.join(cwd, m))) || onPath(cli))
    .map(({ agent }) => agent);
}

// ─── Install steps ───

/** The GitHub repository whose marketplaces list the plugin. */
const MARKETPLACE_REPO = 'tapsmith/tapsmith';

/** How to install the plugin in each agent, as `[label, command or where to read]`. */
export function pluginInstallSteps(agents: readonly CodingAgent[]): Array<[string, string]> {
  return agents.map((agent): [string, string] => {
    switch (agent) {
      case 'claude':
        return ['Claude Code plugin', `claude plugin marketplace add ${MARKETPLACE_REPO} && claude plugin install tapsmith@tapsmith`];
      case 'codex':
        return ['Codex plugin', `codex plugin marketplace add ${MARKETPLACE_REPO} && codex plugin add tapsmith@tapsmith`];
      case 'cursor':
        // Cursor installs plugins from its marketplace UI, not a command.
        return ['Cursor plugin', 'see "Install the plugin" in node_modules/tapsmith/docs/mcp-server.md'];
    }
  });
}
