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
export function launcherScript(source) {
  return `${source.replace(/^export /gm, '').trimEnd()}\n\nawait main();\n`;
}

/** The plugin's icon, maintained in the plugin (Claude Code finds it there by name). */
const ICON = './assets/icon.png';

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

  const mcp = {
    mcpServers: {
      [manifest.mcpServerName]: {
        command: 'node',
        // `--` ends Node's own options, so arguments added after it (`--config <file>`) reach the launcher.
        args: ['--input-type=module', '-e', launcherScript(read('plugins/source/mcp-launcher.mjs')), '--'],
      },
    },
  };

  const entry = { name: manifest.name, source: `./${plugin}`, description: manifest.description };

  return {
    // Claude Code reads .mcp.json at the plugin root by default.
    [`${plugin}/.claude-plugin/plugin.json`]: json(common),
    // Cursor looks for mcp.json without the dot unless told.
    [`${plugin}/.cursor-plugin/plugin.json`]: json({
      ...common,
      displayName: manifest.displayName,
      logo: ICON,
      mcpServers: './.mcp.json',
    }),
    [`${plugin}/.codex-plugin/plugin.json`]: json({
      ...common,
      mcpServers: './.mcp.json',
      interface: { displayName: manifest.displayName, ...manifest.codexInterface, composerIcon: ICON, logo: ICON },
    }),
    [`${plugin}/.mcp.json`]: json(mcp),
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
