#!/usr/bin/env node
// Generates the Tapsmith plugin for Claude Code, Cursor and Codex, and the
// three marketplaces that list it, from one source so they cannot drift:
//
//   plugins/source/manifest.json       name, description, keywords, Codex UI
//   plugins/source/mcp-launcher.mjs    the MCP server command (inlined)
//   packages/tapsmith/package.json     the version (each release's)
//   LICENSE
//
// Maintained by hand, and read by all three tools as they are:
// plugins/tapsmith/skills/, plugins/tapsmith/assets/icon.png and
// plugins/tapsmith/README.md.
//
// Run `node plugins/source/sync.mjs` after changing any source (bump-version.sh
// runs it on every release); `--check` reports stale files and exits 1. A unit
// test in packages/tapsmith runs the same comparison in CI.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The `node -e` source of the MCP server command: the launcher with its exports made local, then run. */
export function launcherScript(source, extraArgsFrom = 2) {
  return `${source.replace(/^export /gm, '').trimEnd()}\n\nawait main(process.argv.slice(${extraArgsFrom}));\n`;
}

/**
 * The launcher for `node -e`: without its comments, since the agents show a
 * server's whole command line in their MCP server lists.
 */
export function inlineLauncherScript(source) {
  // Under `node -e`, the arguments after `--` start at argv[1].
  return launcherScript(source, 1)
    .replace(/^\s*\/\*\*[\s\S]*?\*\/\n/gm, '')
    .replace(/^\s*\/\/.*\n/gm, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/^\n+/, '');
}

/** The plugin's icon, maintained in the plugin (Claude Code finds it there by name). */
const ICON = './assets/icon.png';

/** The launcher as a file in the plugin (Claude Code's MCP config runs it). */
const LAUNCHER = 'scripts/mcp-server.mjs';

/**
 * Cursor's and Codex's MCP config. Not `mcp.json` or `.mcp.json`, the names
 * each tool would also find by itself in another format.
 */
const INLINE_MCP = 'mcp-inline.json';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file, as `{ <repo-relative path>: <content> }`. */
export function generatedFiles(root = ROOT) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const manifest = JSON.parse(read('plugins/source/manifest.json'));
  const { version } = JSON.parse(read('packages/tapsmith/package.json'));
  const plugin = `plugins/${manifest.name}`;

  const common = {
    name: manifest.name,
    version,
    description: manifest.description,
    author: manifest.author,
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords,
    skills: './skills/',
  };

  const server = manifest.mcpServerName;
  const launcher = read('plugins/source/mcp-launcher.mjs');
  // Claude Code: the launcher as a file in the plugin, at ${CLAUDE_PLUGIN_ROOT}.
  const claudeMcp = {
    mcpServers: { [server]: { command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${LAUNCHER}`] } },
  };
  // Codex's plugin MCP config has no variable for the plugin's directory, and
  // Cursor's is documented only for another format, so both get the launcher
  // inline. `--` ends Node's own options, so arguments added after it
  // (`--config <file>`) reach the launcher.
  const inlineMcp = {
    mcpServers: {
      [server]: { command: 'node', args: ['--input-type=module', '-e', inlineLauncherScript(launcher), '--'] },
    },
  };

  const entry = { name: manifest.name, source: `./${plugin}`, description: manifest.description };

  return {
    // Claude Code reads .mcp.json at the plugin root by default.
    [`${plugin}/.claude-plugin/plugin.json`]: json(common),
    [`${plugin}/.mcp.json`]: json(claudeMcp),
    [`${plugin}/${LAUNCHER}`]: launcherScript(launcher),
    [`${plugin}/.cursor-plugin/plugin.json`]: json({
      ...common,
      displayName: manifest.displayName,
      logo: ICON,
      mcpServers: `./${INLINE_MCP}`,
    }),
    [`${plugin}/.codex-plugin/plugin.json`]: json({
      ...common,
      mcpServers: `./${INLINE_MCP}`,
      interface: { displayName: manifest.displayName, ...manifest.codexInterface, composerIcon: ICON, logo: ICON },
    }),
    [`${plugin}/${INLINE_MCP}`]: json(inlineMcp),
    [`${plugin}/LICENSE`]: read('LICENSE'),
    '.claude-plugin/marketplace.json': json({
      name: manifest.marketplace.name,
      description: manifest.marketplace.description,
      owner: manifest.marketplace.owner,
      plugins: [entry],
    }),
    '.cursor-plugin/marketplace.json': json({
      name: manifest.marketplace.name,
      owner: manifest.marketplace.owner,
      metadata: { description: manifest.marketplace.description },
      plugins: [entry],
    }),
    '.agents/plugins/marketplace.json': json({
      name: manifest.marketplace.name,
      interface: { displayName: manifest.displayName },
      plugins: [
        {
          name: manifest.name,
          source: { source: 'local', path: `./${plugin}` },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: manifest.codexInterface.category,
        },
      ],
    }),
  };
}

/** Generated files that are missing or differ on disk under `root`. */
export function staleFiles(root = ROOT) {
  return Object.entries(generatedFiles(root))
    .filter(([rel, content]) => {
      const file = path.join(root, rel);
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content;
    })
    .map(([rel]) => rel);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length > 0) {
      console.error(`The plugin files are out of date; run \`node plugins/source/sync.mjs\`:\n${stale.join('\n')}`);
      process.exitCode = 1;
    } else {
      console.log('plugins: up to date');
    }
  } else {
    const files = generatedFiles();
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, rel), content);
    }
    console.log(`plugins: wrote ${Object.keys(files).length} files`);
  }
}
