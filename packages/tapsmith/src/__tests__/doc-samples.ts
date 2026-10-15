/**
 * Markdown sample extraction shared by the docs guards: docs-snippets.test.ts
 * (TypeScript samples, PILOT-720) and docs-workflows.test.ts (GitHub Actions
 * samples, PILOT-719).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { glob } from 'glob';
import { marked, type Token } from 'marked';

export const REPO = path.resolve(import.meta.dirname, '../../../..');

const SOURCES = ['docs/**/*.md', '*.md', 'packages/*/README.md'];

export interface FencedBlock {
  file: string;
  /** 1-based line of the block's first code line in `file`. */
  line: number;
  code: string;
  lang: string;
}

/** A token's children: list items, inline tokens, and table cells (`header[]` / `rows[][]`). */
export function childTokens(token: Token): Token[] {
  const t = token as { tokens?: Token[]; items?: Token[]; header?: Array<{ tokens: Token[] }>; rows?: Array<Array<{ tokens: Token[] }>> };
  return [
    ...(t.items ?? []),
    ...(t.tokens ?? []),
    ...(t.header ?? []).flatMap((cell) => cell.tokens),
    ...(t.rows ?? []).flatMap((row) => row.flatMap((cell) => cell.tokens)),
  ];
}

/**
 * Fenced code blocks of a markdown file, with their language (the info
 * string's first word, lowercased) and the line of their first code line. Tokens arrive in document order, so each code token is the next fence
 * after the previous one; a fence is found by its own line rather than by the
 * token's `raw`, which marked dedents for a block nested in a list.
 */
export function fencedBlocksIn(file: string, source: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  let searchFrom = 0;
  const lineOf = (offset: number): number => source.slice(0, offset).split('\n').length;
  const visit = (token: Token): void => {
    if (token.type === 'code') {
      const lang = (token.lang ?? '').trim().split(/\s+/)[0]!.toLowerCase();
      const open = /^[ \t>]*(`{3,}|~{3,})[^\n]*$/gm;
      open.lastIndex = searchFrom;
      const fence = token.codeBlockStyle === 'indented' ? null : open.exec(source);
      let line = 0;
      if (fence) {
        line = lineOf(fence.index) + 1;
        const close = new RegExp(`^[ \\t>]*\\${fence[1]![0]}{${fence[1]!.length},}[ \\t]*$`, 'gm');
        close.lastIndex = fence.index + fence[0].length;
        const end = close.exec(source);
        searchFrom = end ? end.index + end[0].length : source.length;
      } else {
        const at = source.indexOf(token.raw, searchFrom);
        if (at >= 0) {
          line = lineOf(at);
          searchFrom = at + token.raw.length;
        }
      }
      out.push({ file, line, code: token.text as string, lang });
    }
    for (const child of childTokens(token)) visit(child);
  };
  for (const token of marked.lexer(source)) visit(token);
  return out;
}

/** Files git tracks, plus new ones not yet added — never ignored ones (local plans, session notes). */
function repoFiles(): Set<string> | undefined {
  try {
    return new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').filter(Boolean),
    );
  } catch {
    return undefined; // not a git checkout: scan what the globs find
  }
}

export function docFiles(): string[] {
  const tracked = repoFiles();
  return glob.sync(SOURCES, { cwd: REPO, nodir: true, ignore: ['**/node_modules/**'] })
    .filter((rel) => !tracked || tracked.has(rel)).sort();
}
