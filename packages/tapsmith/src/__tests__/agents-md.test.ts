import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderAgentsSection, mergeAgentsMd, installedDocsDir, writeAgentsMd, refreshAgentsMdDocsDir, updateAgentsMd, AGENTS_BEGIN, AGENTS_END } from '../agents-md.js';

describe('renderAgentsSection()', () => {
  it('renders fenced section with run/debug/MCP guidance', () => {
    const section = renderAgentsSection();
    expect(section.startsWith(AGENTS_BEGIN)).toBe(true);
    expect(section.trimEnd().endsWith(AGENTS_END)).toBe(true);
    expect(section).toContain('npx tapsmith test');
    expect(section).toContain('npx tapsmith test --ui');
    expect(section).toContain('tapsmith-ui');
    expect(section).toContain('tapsmith-headless');
    // The by-hand path leads with the server that follows UI mode.
    const byHand = section.slice(section.indexOf('Without the plugin'));
    expect(byHand.indexOf('claude mcp add tapsmith -- npx tapsmith mcp-server --prefer-ui')).toBeGreaterThan(-1);
    expect(byHand.indexOf('--prefer-ui')).toBeLessThan(byHand.indexOf('tapsmith-ui'));
    expect(byHand.indexOf('--prefer-ui')).toBeLessThan(byHand.indexOf('tapsmith-headless'));
    expect(section).toContain('Do not start a long-lived UI session yourself unless the user asks you to');
    expect(section).toContain('getByRole');
    expect(section).toContain('getByDescription');
    expect(section).toContain('screen object');
    expect(section).toContain('Prefer a custom fixture module');
    expect(section).toContain('Projects and authenticated state');
    expect(section).toContain('auth.setup.ts');
    expect(section).toContain("dependencies: ['auth-setup']");
    expect(section).toContain('appState');
    expect(section).toContain('tapsmith_snapshot');
    expect(section).toContain('tapsmith_test_locator');
    expect(section).toContain('waitForTimeout');
    expect(section).toContain('tapsmith doctor --json');
  });

  it('gives commands and defaults that match the product (PILOT-517)', () => {
    const section = renderAgentsSection();
    // Codex registers a Streamable HTTP server with --url; a bare URL is
    // taken as a command to launch.
    expect(section).toContain('codex mcp add tapsmith-ui --url http://localhost:<port>/mcp');
    expect(section).not.toMatch(/codex mcp add tapsmith-ui http/);
    // trace defaults to 'off': traces exist only when the config or flag asks.
    expect(section).not.toContain('Failed runs record traces');
    expect(section).toContain('--trace retain-on-failure');
    // The default reset scope is per file, hooks or not.
    expect(section).not.toMatch(/before every test, automatically/);
    expect(section).toContain("appResetScope: 'test'");
  });
});

describe('the locator loop and Playwright habits (PILOT-849)', () => {
  it('points the agent at the docs of the installed version, and at the plugin', () => {
    const section = renderAgentsSection();
    expect(section).toContain('`node_modules/tapsmith/docs/<page>.md`');
    expect(section).toContain('The Tapsmith plugin for Claude Code, Codex and Cursor registers one MCP server, `tapsmith`');
    expect(section).toContain('works in the user\'s running `npx tapsmith test --ui` session when there is one');
    expect(section).toContain('`node_modules/tapsmith/docs/mcp-server.md`');
  });

  it('states the loop as a rule', () => {
    const section = renderAgentsSection();
    expect(section).toContain('### The locator loop');
    expect(section).toContain("Never put a locator in a test that \`tapsmith_test_locator\` hasn't confirmed.");
    const order = ['tapsmith_snapshot\` on the screen under test', 'tapsmith_test_locator\` with it', 'Only then put it in test code', 'tapsmith_run_tests\`.', 'On failure, \`tapsmith_read_trace\`'];
    const at = order.map((s) => section.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('maps the Playwright methods agents reach for to Tapsmith\'s', () => {
    const section = renderAgentsSection();
    expect(section).toContain('\`.click()\` → \`.tap()\`');
    expect(section).toContain('\`.fill(text)\` → \`.clearAndType(text)\`');
    expect(section).toContain('\`.check()\` / \`.uncheck()\` → \`.setChecked(true)\` / \`.setChecked(false)\`');
  });
});

describe('mergeAgentsMd()', () => {
  const section = renderAgentsSection();

  it('creates a new file body when no existing content', () => {
    const merged = mergeAgentsMd(undefined, section);
    expect(merged).toContain(AGENTS_BEGIN);
    expect(merged.trimEnd().endsWith(AGENTS_END)).toBe(true);
  });

  it('appends to existing content without touching it', () => {
    const merged = mergeAgentsMd('# My project\n\nStuff.\n', section);
    expect(merged.startsWith('# My project')).toBe(true);
    expect(merged).toContain('Stuff.');
    expect(merged).toContain(AGENTS_BEGIN);
  });

  it('replaces an existing tapsmith section idempotently', () => {
    const v1 = mergeAgentsMd('# Mine\n', section);
    const v2 = mergeAgentsMd(v1, section);
    expect(v2).toBe(v1);
    expect(v2.match(new RegExp(AGENTS_BEGIN, 'g'))).toHaveLength(1);
  });

  it('preserves content after the end marker', () => {
    const existing = `# Top\n\n${AGENTS_BEGIN}\nold stuff\n${AGENTS_END}\n\n# Bottom\n`;
    const merged = mergeAgentsMd(existing, section);
    expect(merged).toContain('# Top');
    expect(merged).toContain('# Bottom');
    expect(merged).not.toContain('old stuff');
  });
});

describe('the docs path init writes', () => {
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-docs-dir-')));
  const install = (dir: string) => {
    fs.mkdirSync(path.join(dir, 'node_modules', 'tapsmith'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'tapsmith', 'package.json'), '{"name":"tapsmith"}');
  };

  it('points at the project\'s own install', () => {
    const root = tmp();
    install(root);
    expect(installedDocsDir(root)).toBe('node_modules/tapsmith/docs');
  });

  it('points at the install a workspace hoisted to its root', () => {
    const root = tmp();
    install(root);
    const pkg = path.join(root, 'packages', 'e2e');
    fs.mkdirSync(pkg, { recursive: true });
    expect(installedDocsDir(pkg)).toBe('../../node_modules/tapsmith/docs');
  });

  it('prefers the nearest install, as Node resolves it', () => {
    const root = tmp();
    install(root);
    const pkg = path.join(root, 'e2e');
    install(pkg);
    expect(installedDocsDir(pkg)).toBe('node_modules/tapsmith/docs');
  });

  it('keeps the node_modules path of a symlinked (pnpm) install', () => {
    const root = tmp();
    const store = path.join(root, 'node_modules', '.pnpm', 'tapsmith@1.0.0', 'node_modules', 'tapsmith');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'package.json'), '{"name":"tapsmith"}');
    fs.symlinkSync(store, path.join(root, 'node_modules', 'tapsmith'), 'dir');
    const pkg = path.join(root, 'e2e');
    fs.mkdirSync(pkg);
    expect(installedDocsDir(pkg)).toBe('../node_modules/tapsmith/docs');
  });

  it('falls back to the project\'s node_modules when Tapsmith is not installed yet', () => {
    expect(installedDocsDir(tmp())).toBe('node_modules/tapsmith/docs');
  });

  it('writes that path into the AGENTS.md section, and only that path', () => {
    const section = renderAgentsSection('../../node_modules/tapsmith/docs');
    expect(section).toContain('`../../node_modules/tapsmith/docs/<page>.md`');
    expect(section).toContain('`../../node_modules/tapsmith/docs/mcp-server.md`');
    expect(section.replaceAll('../../node_modules/tapsmith/docs/', '')).not.toContain('node_modules/tapsmith/docs');
  });

  it('writeAgentsMd() resolves the path from the folder it writes to', () => {
    const root = tmp();
    install(root);
    const pkg = path.join(root, 'packages', 'e2e');
    fs.mkdirSync(pkg, { recursive: true });
    const written = fs.readFileSync(writeAgentsMd(pkg), 'utf8');
    expect(written).toContain('`../../node_modules/tapsmith/docs/<page>.md`');
  });

  it('refreshAgentsMdDocsDir() repoints a section written before a hoisting install', () => {
    const root = tmp();
    const pkg = path.join(root, 'packages', 'e2e');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'AGENTS.md'), '# Mine\n\n');
    writeAgentsMd(pkg);
    expect(fs.readFileSync(path.join(pkg, 'AGENTS.md'), 'utf8')).toContain('`node_modules/tapsmith/docs/<page>.md`');
    install(root); // the wizard's install, hoisted to the workspace root
    refreshAgentsMdDocsDir(pkg);
    const after = fs.readFileSync(path.join(pkg, 'AGENTS.md'), 'utf8');
    expect(after).toContain('`../../node_modules/tapsmith/docs/<page>.md`');
    expect(after.startsWith('# Mine\n')).toBe(true);
    expect(after.match(new RegExp(AGENTS_BEGIN, 'g'))).toHaveLength(1);
  });

  it('refreshAgentsMdDocsDir() leaves an AGENTS.md without a Tapsmith section alone', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mine\n');
    refreshAgentsMdDocsDir(dir);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe('# Mine\n');
    refreshAgentsMdDocsDir(tmp()); // no AGENTS.md at all: nothing written
  });

  it('refreshAgentsMdDocsDir() leaves a file with mismatched markers alone, rather than replace the user\'s text', () => {
    const root = tmp();
    const pkg = path.join(root, 'e2e');
    fs.mkdirSync(pkg);
    // The user deleted the end marker of an old section and wrote below it;
    // init's write then appended a whole new section.
    fs.writeFileSync(path.join(pkg, 'AGENTS.md'), `Intro\n${AGENTS_BEGIN}\nMY OWN NOTES\n`);
    writeAgentsMd(pkg);
    const written = fs.readFileSync(path.join(pkg, 'AGENTS.md'), 'utf8');
    install(root);
    refreshAgentsMdDocsDir(pkg);
    expect(fs.readFileSync(path.join(pkg, 'AGENTS.md'), 'utf8')).toBe(written);
    // An end marker before the begin marker.
    fs.writeFileSync(path.join(pkg, 'AGENTS.md'), `Intro\n${AGENTS_END}\nmid\n${AGENTS_BEGIN}\nNOTES\n`);
    refreshAgentsMdDocsDir(pkg);
    expect(fs.readFileSync(path.join(pkg, 'AGENTS.md'), 'utf8')).toBe(`Intro\n${AGENTS_END}\nmid\n${AGENTS_BEGIN}\nNOTES\n`);
  });
});

describe('updateAgentsMd()', () => {
  const inTmp = (body: (dir: string, file: string) => void): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-agents-update-'));
    try {
      body(dir, path.join(dir, 'AGENTS.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('adds the section once, keeping the rest of the file', () => inTmp((dir, file) => {
    fs.writeFileSync(file, '# Team rules\n');
    expect(updateAgentsMd(dir)).toBe('written');
    expect(fs.readFileSync(file, 'utf8')).toBe(`# Team rules\n\n${renderAgentsSection()}`);
    expect(updateAgentsMd(dir)).toBe('unchanged');
  }));

  it('replaces an outdated section', () => inTmp((dir, file) => {
    fs.writeFileSync(file, `# A\n\n${AGENTS_BEGIN}\nold\n${AGENTS_END}\n\n# B\n`);
    expect(updateAgentsMd(dir)).toBe('written');
    expect(fs.readFileSync(file, 'utf8')).toBe(`# A\n\n${renderAgentsSection()}\n# B\n`);
  }));

  it.each([
    ['a begin without an end', `${AGENTS_BEGIN}\nmine\n`],
    ['two sections', `${AGENTS_BEGIN}\n${AGENTS_END}\nmine\n${AGENTS_BEGIN}\n${AGENTS_END}\n`],
    ['an end before the begin', `${AGENTS_END}\nmine\n${AGENTS_BEGIN}\n`],
  ])('leaves a file with %s alone', (_, text) => inTmp((dir, file) => {
    fs.writeFileSync(file, text);
    expect(updateAgentsMd(dir)).toBe('malformed');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  }));

  it.skipIf(process.platform === 'win32')('replaces the file rather than truncating it, keeping its mode and a symlink to it', () => inTmp((dir, file) => {
    const target = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(target, '# Mine\n');
    fs.chmodSync(target, 0o640);
    fs.symlinkSync('CLAUDE.md', file);
    const before = fs.statSync(target).ino;
    expect(updateAgentsMd(dir)).toBe('written');
    expect(fs.statSync(target).ino).not.toBe(before);
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('# Mine');
    expect(fs.readdirSync(dir).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
  }));

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('leaves the file as it was when it cannot be replaced', () => inTmp((dir, file) => {
    fs.writeFileSync(file, '# Mine\n');
    fs.chmodSync(dir, 0o555);
    try {
      expect(() => updateAgentsMd(dir)).toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe('# Mine\n');
      expect(fs.readdirSync(dir)).toEqual(['AGENTS.md']);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  }));
});
