import { describe, it, expect } from 'vitest';
import { renderAgentsSection, mergeAgentsMd, AGENTS_BEGIN, AGENTS_END } from '../agents-md.js';

describe('renderAgentsSection()', () => {
  it('renders fenced section with run/debug/MCP guidance', () => {
    const section = renderAgentsSection();
    expect(section.startsWith(AGENTS_BEGIN)).toBe(true);
    expect(section.trimEnd().endsWith(AGENTS_END)).toBe(true);
    expect(section).toContain('npx tapsmith test');
    expect(section).toContain('npx tapsmith test --ui');
    expect(section).toContain('tapsmith-ui');
    expect(section).toContain('tapsmith-headless');
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
