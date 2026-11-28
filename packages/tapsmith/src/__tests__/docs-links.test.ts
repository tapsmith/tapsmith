/**
 * Links between the docs pages must work as relative file links, because the
 * package ships the pages in node_modules/tapsmith/docs/ for coding agents to
 * read offline, and GitHub renders them the same way. Every relative link in
 * docs/*.md must name a page (or an image) in docs/ and, when it has an
 * anchor, a heading on that page; and once bundled (images become website
 * URLs), every relative link must name a page the package ships. The
 * repo-root README's relative links are checked the same way, against the repo.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import GithubSlugger from 'github-slugger';
import { marked, type Token } from 'marked';
import { describe, expect, it } from 'vitest';
import { bundledPage, docPages } from '../../scripts/docs-bundle.mjs';
import { REPO, childTokens } from './doc-samples.js';

const DOCS = path.join(REPO, 'docs');
const PAGES = docPages(DOCS);

interface Link {
  href: string;
  /** The link as written, for the failure message. */
  raw: string;
}

/** Plain text of inline tokens, as GitHub renders a heading before slugging it. */
function plainText(tokens: Token[]): string {
  return tokens
    .map((t) => {
      const children = (t as { tokens?: Token[] }).tokens;
      if (children && children.length > 0) return plainText(children);
      return (t as { text?: string }).text ?? '';
    })
    .join('');
}

/** Every link and image in a markdown source, including reference-style ones. */
function linksIn(source: string): Link[] {
  const links: Link[] = [];
  const visit = (token: Token): void => {
    if (token.type === 'link' || token.type === 'image') {
      links.push({ href: (token as { href: string }).href, raw: token.raw });
    }
    if (token.type !== 'code' && token.type !== 'codespan') {
      for (const child of childTokens(token)) visit(child);
    }
  };
  for (const token of marked.lexer(source)) visit(token);
  return links;
}

/** The anchors GitHub gives a page's headings (repeats numbered, as GitHub does). */
function anchorsOf(source: string): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  const visit = (token: Token): void => {
    if (token.type === 'heading') anchors.add(slugger.slug(plainText((token as { tokens: Token[] }).tokens)));
    for (const child of childTokens(token)) visit(child);
  };
  for (const token of marked.lexer(source)) visit(token);
  return anchors;
}

const isExternal = (href: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');

const sources = new Map(PAGES.map((page) => [page, fs.readFileSync(path.join(DOCS, page), 'utf8')]));
const anchors = new Map([...sources].map(([page, source]) => [page, anchorsOf(source)]));

/** Why a relative link from `page` is broken, or undefined when it works. */
function brokenReason(page: string, href: string, shipped: (target: string) => boolean): string | undefined {
  const [rawTarget, anchor] = href.split('#', 2) as [string, string | undefined];
  const target = decodeURIComponent(rawTarget);
  const targetPage = target === '' ? page : path.posix.normalize(target);
  if (targetPage.startsWith('../') || path.posix.isAbsolute(targetPage)) {
    return 'points outside docs/: the package ships only the docs/ pages, so link a page in docs/ or a full URL';
  }
  if (!shipped(targetPage)) return `there is no docs/${targetPage}`;
  if (anchor !== undefined && targetPage.endsWith('.md') && !anchors.get(targetPage)?.has(anchor)) {
    return `docs/${targetPage} has no heading with the anchor #${anchor}`;
  }
  return undefined;
}

describe('docs links work as relative file links', () => {
  it('finds the pages', () => {
    expect(PAGES).toEqual(expect.arrayContaining(['getting-started.md', 'api-reference.md', 'locators.md', 'mcp-server.md']));
  });

  it('every relative link names a docs page or image, and an anchor names a heading on it', () => {
    const broken: string[] = [];
    for (const [page, source] of sources) {
      for (const link of linksIn(source)) {
        if (isExternal(link.href)) continue;
        const reason = brokenReason(page, link.href, (target) => fs.existsSync(path.join(DOCS, target)));
        if (reason) broken.push(`docs/${page}: ${link.raw} — ${reason}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every relative link in the bundled pages names a page the package ships', () => {
    const shippedPages = new Set(PAGES);
    const broken: string[] = [];
    for (const [page, source] of sources) {
      for (const link of linksIn(bundledPage(source))) {
        if (isExternal(link.href)) continue;
        const reason = brokenReason(page, link.href, (target) => shippedPages.has(target));
        if (reason) broken.push(`bundled docs/${page}: ${link.raw} — ${reason}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every relative link in the README names a file in the repo, and an anchor into docs/ names a heading', () => {
    const broken: string[] = [];
    for (const link of linksIn(fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'))) {
      if (isExternal(link.href)) continue;
      const reason = readmeLinkBrokenReason(link.href, (target) => fs.existsSync(path.join(REPO, target)));
      if (reason) broken.push(`README.md: ${link.raw} — ${reason}`);
    }
    expect(broken).toEqual([]);
  });
});

/** Why a relative link from the repo-root README is broken, or undefined when it works. */
function readmeLinkBrokenReason(href: string, exists: (target: string) => boolean): string | undefined {
  const [rawTarget, anchor] = href.split('#', 2) as [string, string | undefined];
  const target = path.posix.normalize(decodeURIComponent(rawTarget) || '.').replace(/\/$/, '');
  if (target.startsWith('../') || path.posix.isAbsolute(target)) return 'points outside the repo';
  if (!exists(target)) return `there is no ${target}`;
  if (anchor !== undefined && target.startsWith('docs/') && target.endsWith('.md')) {
    const page = target.slice('docs/'.length);
    if (!anchors.get(page)?.has(anchor)) return `${target} has no heading with the anchor #${anchor}`;
  }
  return undefined;
}

describe('the self-test', () => {
  it('reads inline, reference-style and image links but not code', () => {
    const source = [
      '# Title',
      '',
      'See [a](locators.md#strict-mode), ![b](images/x.png) and [c][ref].',
      '',
      '`[not](a-link.md)`',
      '',
      '```md',
      '[not](either.md)',
      '```',
      '',
      '[ref]: ./ui-mode.md',
    ].join('\n');
    expect(linksIn(source).map((l) => l.href)).toEqual(['locators.md#strict-mode', 'images/x.png', './ui-mode.md']);
  });

  it('slugs headings as GitHub does, code spans and repeats included', () => {
    const got = anchorsOf('# `device.tap()`: taps\n\n## Configuration\n\n## Configuration\n');
    expect([...got]).toEqual(['devicetap-taps', 'configuration', 'configuration-1']);
  });

  it('turns image links into website URLs once bundled', () => {
    expect(bundledPage('![x](images/a.png) ![y](./images/b.png)\n\n[r]: images/c.png\n')).toBe(
      '![x](https://tapsmith.dev/a.png) ![y](https://tapsmith.dev/b.png)\n\n[r]: https://tapsmith.dev/c.png\n',
    );
  });

  it('flags a link outside docs/, a missing page and a missing anchor', () => {
    const exists = (t: string): boolean => PAGES.includes(t);
    expect(brokenReason('a.md', '../README.md', exists)).toMatch(/outside docs/);
    expect(brokenReason('a.md', 'nope.md', exists)).toMatch(/no docs\/nope\.md/);
    expect(brokenReason('a.md', 'locators.md#no-such-heading', exists)).toMatch(/no heading/);
    expect(brokenReason('locators.md', '#no-such-heading', exists)).toMatch(/no heading/);
    expect(brokenReason('a.md', 'locators.md', exists)).toBeUndefined();
  });

  it('flags a README link to a missing file or a missing docs anchor', () => {
    const exists = (t: string): boolean => t === 'LICENSE' || t === 'docs' || PAGES.includes(t.replace(/^docs\//, ''));
    expect(readmeLinkBrokenReason('LICENSE', exists)).toBeUndefined();
    expect(readmeLinkBrokenReason('docs/', exists)).toBeUndefined();
    expect(readmeLinkBrokenReason('docs/locators.md#finding-locators', exists)).toBeUndefined();
    expect(readmeLinkBrokenReason('docs/nope.md', exists)).toMatch(/no docs\/nope\.md/);
    expect(readmeLinkBrokenReason('docs/locators.md#no-such-heading', exists)).toMatch(/no heading/);
    expect(readmeLinkBrokenReason('../elsewhere.md', exists)).toMatch(/outside the repo/);
  });
});
