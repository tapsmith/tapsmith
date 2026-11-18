/**
 * Docs guard (PILOT-259): every `tapsmith …` invocation the docs or the CLI's
 * own output show must be one the CLI accepts, and every command and flag the
 * CLI has must be documented in the api-reference.md CLI section.
 *
 * The command table is never written down here. It is `cliCommandTree()`, the
 * commander tree `runCli` parses with, walked recursively — so nested
 * subcommands (`tapsmith ios network verify`) and renames need doc edits, not
 * test edits.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { glob } from 'glob';
import { marked, type Token } from 'marked';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { cliCommandTree, prepareCommandArgs } from '../cli-program.js';

// ─── Extraction ───

/** A piece of text that may hold invocations, and where it came from. */
interface Snippet {
  file: string;
  line: number;
  text: string;
  /**
   * Exact command lines (markdown code, astro code): a positional the command
   * does not take is an error. Source strings embed commands in prose, so
   * there only commands and flags are checked.
   */
  strict: boolean;
  /**
   * A whole command line (a line of a code block): a required argument left
   * out is an error. Inline code often names a command without its arguments
   * ("run `tapsmith show-trace`"), so there it is not.
   */
  complete: boolean;
}

interface Invocation {
  file: string;
  line: number;
  /** From `tapsmith` to the end of the invocation, as written. */
  text: string;
  tokens: string[];
  strict: boolean;
  complete: boolean;
}

/** Stand-in for a `${…}` substitution in a template literal. */
const SUBSTITUTION = '${…}';

const lineAt = (source: string, offset: number): number => source.slice(0, Math.max(0, offset)).split('\n').length;

/** Code blocks and inline code spans of a markdown file. */
function markdownSnippets(file: string, source: string): Snippet[] {
  const out: Snippet[] = [];
  const visit = (token: Token, searchFrom: number): void => {
    if (token.type === 'code' || token.type === 'codespan') {
      const text = token.text as string;
      let base: number;
      const at = source.indexOf(token.raw, searchFrom);
      if (at >= 0) {
        // A fenced block's text starts on the line after its fence.
        base = lineAt(source, at) + (token.type === 'code' && /^\s*(```|~~~)/.test(token.raw) ? 1 : 0);
      } else {
        // Nested in a list or quote: marked dedents `raw`, so find the first line instead.
        const first = text.split('\n')[0]!;
        const found = source.indexOf(first, searchFrom);
        base = found >= 0 ? lineAt(source, found) : lineAt(source, searchFrom);
      }
      // `\` continues a command on the next line.
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = base + i;
        let joined = lines[i]!;
        while (/\\\s*$/.test(joined) && i + 1 < lines.length) joined = `${joined.replace(/\\\s*$/, '')} ${lines[++i]!.trim()}`;
        // A shell `#` or `//` comment in a code block is prose, not a command.
        if (token.type === 'code') joined = stripShellComment(joined);
        out.push({ file, line, text: joined, strict: true, complete: token.type === 'code' });
      }
      return;
    }
    const record = token as unknown as Record<string, unknown>;
    const children: Token[] = [];
    for (const key of ['tokens', 'items']) {
      const value = record[key];
      if (Array.isArray(value)) children.push(...(value as Token[]));
    }
    if (token.type === 'table') {
      const table = token as unknown as { header: Array<{ tokens: Token[] }>; rows: Array<Array<{ tokens: Token[] }>> };
      for (const cell of table.header) children.push(...cell.tokens);
      for (const row of table.rows) for (const cell of row) children.push(...cell.tokens);
    }
    for (const child of children) visit(child, searchFrom);
  };
  let offset = 0;
  for (const token of marked.lexer(source)) {
    visit(token, offset);
    offset += token.raw.length;
  }
  // Raw HTML in markdown: `<code>…</code>`.
  out.push(...codeTagSnippets(file, source));
  return out;
}

/** Drop an unquoted `#` or `//` comment that starts a word; quoted text (`--grep "a #b"`) stays. */
function stripShellComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    const wordStart = i === 0 || /\s/.test(line[i - 1]!);
    if (wordStart && (ch === '#' || line.startsWith('//', i))) return line.slice(0, i);
  }
  return line;
}

/** `<code>…</code>` contents: inline code in HTML. */
function codeTagSnippets(file: string, source: string): Snippet[] {
  return [...source.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map((match) => ({
    file, line: lineAt(source, match.index), text: match[1]!, strict: true, complete: false,
  }));
}

/** `<code>` contents and `code="…"` / `code={'…'}` attributes (whole command lines) of an astro page. */
function astroSnippets(file: string, source: string): Snippet[] {
  const out = codeTagSnippets(file, source);
  for (const match of source.matchAll(/\bcode=(?:(["'])([\s\S]*?)\1|\{\s*([`'"])([\s\S]*?)\3\s*\})/g)) {
    const text = match[2] ?? match[4] ?? '';
    out.push({ file, line: lineAt(source, match.index), text, strict: true, complete: true });
  }
  return out;
}

/** String and template literals of a TypeScript file (comments are not output). */
function sourceSnippets(file: string, source: string): Snippet[] {
  const out: Snippet[] = [];
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const push = (node: ts.Node, text: string): void => {
    const base = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    text.split('\n').forEach((lineText, i) => out.push({ file, line: base + i, text: lineText, strict: false, complete: false }));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!ts.isImportDeclaration(node.parent) && !ts.isExportDeclaration(node.parent)) push(node, node.text);
      return;
    }
    if (ts.isJsxText(node)) {
      push(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // Substitutions stay glued to their neighbours, so `--x=${v}` is still flag --x.
      push(node, node.head.text + node.templateSpans.map((s) => `${SUBSTITUTION}${s.literal.text}`).join(''));
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * String literals of a Rust file (the daemon's messages): a small lexer that
 * skips comments and char literals, joins `\`-newline continuations, and
 * turns `{…}` format arguments into substitutions.
 */
function rustSnippets(file: string, source: string): Snippet[] {
  const out: Snippet[] = [];
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i, i + 3);
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    const charLiteral = /^'(?:\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'/.exec(source.slice(i, i + 12));
    if (charLiteral) {
      i += charLiteral[0].length;
      continue;
    }
    const raw = /^b?r(#*)"/.exec(source.slice(i, i + 12));
    if (raw && !/[\w]/.test(source[i - 1] ?? '')) {
      const close = `"${raw[1]}`;
      const start = i + raw[0].length;
      const end = source.indexOf(close, start);
      const body = source.slice(start, end < 0 ? source.length : end);
      pushRust(out, file, source, start, body);
      i = end < 0 ? source.length : end + close.length;
      continue;
    }
    if (source[i] === '"') {
      let j = i + 1;
      let body = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const next = source[j + 1];
          if (next === '\n') {
            j += 2;
            while (/\s/.test(source[j] ?? '')) j++;
            continue;
          }
          body += next === 'n' ? '\n' : next === 't' ? '\t' : next ?? '';
          j += 2;
          continue;
        }
        body += source[j];
        j++;
      }
      pushRust(out, file, source, i + 1, body);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out;
}

function pushRust(out: Snippet[], file: string, source: string, offset: number, body: string): void {
  const text = body.replace(/\{\{/g, '\u0000').replace(/\}\}/g, '\u0001').replace(/\{[^{}]*\}/g, SUBSTITUTION)
    .replace(/\u0000/g, '{').replace(/\u0001/g, '}');
  const base = lineAt(source, offset);
  text.split('\n').forEach((lineText, k) => out.push({ file, line: base + k, text: lineText, strict: false, complete: false }));
}

/**
 * Split a command line into words, keeping quoted values whole. A quote that
 * does not open a word (or a value, after `=`) closes the text the command sat
 * in — "Run 'tapsmith doctor' first" — so the words stop there.
 */
function shellWords(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === '\'') {
      if (current && !current.endsWith('=')) {
        words.push(current);
        return words;
      }
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
    }
  }
  if (started || current) words.push(current);
  return words;
}

/** Words that end a command: shell operators, redirections and comments. */
const SHELL_STOP = /^(?:&&|\|\||\||;|&|&>>?\S*|\d?>>?\S*|\d?>&\d|<|#.*)$/;

/**
 * `npm install … tapsmith` and `<agent> mcp add [flags] tapsmith …` name the
 * package or the server, not the CLI. Neither reaches past a shell operator
 * or a `--`, so `npm ci && npx tapsmith test` is still checked.
 */
const NOT_THE_CLI = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|view|info|ls|link)\s+(?:(?:-\S+|\S*[@/]\S*)\s+)*$/,
  /\bmcp\s+add\s+(?:(?!--(?:\s|$))(?!npx\b)\S+\s+)*$/,
];

function invocationsIn(snippet: Snippet): Invocation[] {
  const found: Invocation[] = [];
  // `tapsmith`, `npx tapsmith@1.2.3`, `./node_modules/.bin/tapsmith`; not `@tapsmith/core`, `tapsmith.config.ts`, a URL path.
  const pattern = /(?<![\w@.$=-])(?:(?<=\.bin\/)|(?<!\/))tapsmith(?:@[\w.^~${}…-]+)?(?=\s|$)/g;
  for (const match of snippet.text.matchAll(pattern)) {
    const before = snippet.text.slice(0, match.index);
    if (NOT_THE_CLI.some((re) => re.test(before))) continue;
    const rest = snippet.text.slice(match.index + match[0].length);
    const tokens: string[] = [];
    for (const raw of shellWords(rest)) {
      if (SHELL_STOP.test(raw) || raw.startsWith('(') || raw === '—' || raw === '·' || raw === '--->') break;
      // Prose after a command ("run tapsmith doctor, then …") or the end of
      // inline code inside a string ("`tapsmith test`").
      const trimmed = raw.replace(/[.,;:!?)`]+$/, '');
      if (trimmed !== raw && !/^[.]+$/.test(raw)) {
        if (trimmed) tokens.push(trimmed);
        break;
      }
      tokens.push(raw);
    }
    // The next invocation on the same line starts its own match.
    const next = tokens.findIndex((t) => t === 'tapsmith' || t === 'npx');
    const own = next >= 0 ? tokens.slice(0, next) : tokens;
    found.push({
      file: snippet.file,
      line: snippet.line,
      text: ['tapsmith', ...own].join(' '),
      tokens: own,
      strict: snippet.strict,
      complete: snippet.complete,
    });
  }
  return found;
}

// ─── Resolution against the command tree ───

/**
 * The help flags of `cmd`, read from the tree: commander keeps the help option
 * out of `cmd.options`, so it is the visible option that is not one of them.
 */
function helpFlags(cmd: Command): Set<string> {
  const help = cmd.createHelp().visibleOptions(cmd).find((o) => !cmd.options.includes(o));
  return new Set([help?.long, help?.short].filter((f): f is string => !!f));
}

/** Values the docs write as placeholders: `N`, `x/y`, `enable|disable`, `${{ matrix.shard }}`. */
const isValuePlaceholder = (value: string): boolean =>
  isPlaceholder(value) || /\{\{|\||^[A-Z_]+$|^[a-z]\/[a-z]$/.test(value);

/**
 * Run a value through the tree's own parser (choices, positive ints, trace
 * modes, regexes); the message if it refuses.
 */
function refusedValue(target: { parseArg?: (value: string, previous: unknown) => unknown }, value: string): string | undefined {
  if (!target.parseArg || isValuePlaceholder(value)) return undefined;
  try {
    target.parseArg(value, undefined);
    return undefined;
  } catch (err) {
    if (err instanceof CommanderError) return err.message;
    throw err;
  }
}

/** `<udid>`, `[options]`, `…`, `${…}`: stands for a value, not a literal word. */
const isPlaceholder = (token: string): boolean =>
  /^[<[{]/.test(token) || token.includes('…') || token === '...' || token.includes(SUBSTITUTION);

/** `[options]`-style placeholders that stand for flags, not arguments. */
const isFlagsPlaceholder = (token: string): boolean => /^\[(?:options|flags|opts|\.\.\.|…)\]$/i.test(token);

/**
 * Unwrap synopsis notation so its flags are checked like any other:
 * `[--api <level>]` → `--api <level>`, `[--json]` → `--json`, and each side of
 * `[--device|--simulator]`. `[status|enable|disable]` stays a placeholder.
 */
function unwrapSynopsis(tokens: string[]): string[] {
  return tokens.flatMap((token) => {
    const flags = /^\[(-[^\]]*?)\]?$/.exec(token);
    if (flags) return flags[1]!.split('|');
    const value = /^(<[^>]*>)\]$/.exec(token);
    if (value) return [value[1]!];
    return [token];
  });
}

const takesValue = (option: Option): boolean => option.required || option.optional;

function findOption(cmd: Command, flag: string): Option | undefined {
  return cmd.options.find((o) => o.long === flag || o.short === flag);
}

function findSubcommand(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

const commandPath = (cmd: Command): string[] => {
  const names: string[] = [];
  for (let c: Command | null = cmd; c?.parent; c = c.parent) names.unshift(c.name());
  return names;
};

interface Resolution {
  /** The command the invocation lands on; undefined when it cannot be known (a placeholder command). */
  command?: Command;
  /** Every flag it uses, as written up to any `=`. */
  flags: string[];
  errors: string[];
}

/**
 * Walk an invocation's words down the tree: each level's flags, then a
 * subcommand while the current command has them, then the leaf's flags and
 * arguments. `help <command…>` resolves the command path it asks about, as
 * runCli does. The leaf's words also go through `prepareCommandArgs`, the
 * rules `runCli` adds on top of commander (a value flag given a flag, `-grep`).
 */
function resolveInvocation(root: Command, written: string[], mode: { strict: boolean; complete: boolean }): Resolution {
  const tokens = unwrapSynopsis(written);
  const flags: string[] = [];
  const errors: string[] = [];
  let cmd = root;
  let i = 0;
  let leafStart = 0;
  let positionals = 0;
  let flagsEnded = false;
  let sawHelp = false;
  let helpAt: Command | undefined;
  let helpTarget: Command | undefined;

  const where = (): string => (cmd === root ? 'tapsmith' : `tapsmith ${commandPath(cmd).join(' ')}`);

  const checkValue = (option: Option, flag: string, value: string): void => {
    const refused = refusedValue(option, value);
    if (refused) errors.push(`${where()} ${flag} '${value}': ${refused}`);
  };
  /** A value flag with nothing after it, on a whole command line. */
  const missingValue = (flag: string): void => {
    if (mode.complete) errors.push(`${where()} ${flag} needs a value`);
  };

  /** Check the flag at tokens[i]; returns how many words it used. */
  const readFlag = (token: string): number => {
    if (token.startsWith('--')) {
      const [name] = token.split('=', 1) as [string];
      if (name.includes(SUBSTITUTION)) return 1; // `--${flag}`: cannot be known
      flags.push(name);
      if (helpFlags(cmd).has(name)) {
        sawHelp = true;
        return 1;
      }
      const option = findOption(cmd, name);
      if (!option) {
        errors.push(`${where()} has no flag ${name}`);
        // `--team <id>`: the placeholder is that unknown flag's value.
        return !token.includes('=') && /^<.*>$/.test(tokens[i + 1] ?? '') ? 2 : 1;
      }
      if (token.includes('=')) {
        checkValue(option, name, token.slice(token.indexOf('=') + 1));
        return 1;
      }
      if (option.required) {
        if (tokens[i + 1] === undefined) {
          missingValue(name);
          return 1;
        }
        checkValue(option, name, tokens[i + 1]!);
        return 2;
      }
      if (option.optional && tokens[i + 1] !== undefined && !tokens[i + 1]!.startsWith('-')) {
        checkValue(option, name, tokens[i + 1]!);
        return 2;
      }
      return 1;
    }
    // Short flags: -j 2, -j2, -j=4, bundles like -wd <serial>.
    const letters = token.slice(1).split('=', 1)[0]!;
    if (letters.includes(SUBSTITUTION)) return 1;
    const hasEquals = token.includes('=');
    for (let k = 0; k < letters.length; k++) {
      const flag = `-${letters[k]}`;
      flags.push(flag);
      if (helpFlags(cmd).has(flag)) {
        sawHelp = true;
        continue;
      }
      const option = findOption(cmd, flag);
      if (!option) {
        errors.push(`${where()} has no flag ${flag}`);
        return 1;
      }
      if (takesValue(option)) {
        if (hasEquals && k === letters.length - 1) {
          checkValue(option, flag, token.slice(token.indexOf('=') + 1));
          return 1;
        }
        if (k < letters.length - 1) {
          checkValue(option, flag, token.slice(k + 2));
          return 1;
        }
        if (option.required) {
          if (tokens[i + 1] === undefined) {
            missingValue(flag);
            return 1;
          }
          checkValue(option, flag, tokens[i + 1]!);
          return 2;
        }
        return 1;
      }
    }
    return 1;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (!flagsEnded && token === '--') {
      flagsEnded = true;
      i++;
      continue;
    }
    // A flag, unless the whole word is a placeholder (`<serial>`); `--x=${v}` is flag --x.
    if (!flagsEnded && token.startsWith('-') && token !== '-' && !/^[<[{]/.test(token) && !token.startsWith(SUBSTITUTION)) {
      i += readFlag(token);
      continue;
    }
    if (isFlagsPlaceholder(token)) {
      i++;
      continue;
    }
    if (helpAt) {
      // `help <command…>`: runCli resolves the whole path, git-style
      // (`tapsmith help ios network configure`). runCli ignores words after a
      // leaf; the guard deliberately refuses them in docs, as it refuses
      // stray arguments elsewhere.
      const group = helpTarget ?? cmd;
      if (token === 'help' && helpTarget && helpTarget.commands.length > 0) {
        i++; // `help ios network help verify`: redundant, as runCli reads it
        continue;
      }
      if (helpTarget && helpTarget.commands.length === 0) {
        errors.push(`\`tapsmith ${commandPath(helpTarget).join(' ')}\` has no subcommands (got '${token}' after \`help\`)`);
        return { flags, errors };
      }
      if (isPlaceholder(token)) return { flags, errors };
      const sub = findSubcommand(group, token);
      if (!sub) {
        errors.push(`${group === root ? 'tapsmith' : `tapsmith ${commandPath(group).join(' ')}`} has no command '${token}'`);
        return { flags, errors };
      }
      helpTarget = sub;
      i++;
      continue;
    }
    // A word: a subcommand, `help`, or an argument.
    // After a help flag, commander (and runCli) show the current command's
    // page: `tapsmith ios --help network` is the ios page.
    if (sawHelp && cmd.commands.length > 0) return { command: cmd, flags, errors };
    if (cmd.commands.length > 0 && positionals === 0) {
      if (isPlaceholder(token)) return { flags, errors }; // `tapsmith <command> --help`
      if (token === 'help') {
        helpAt = cmd;
        i++;
        continue;
      }
      const sub = findSubcommand(cmd, token);
      if (sub) {
        cmd = sub;
        i++;
        leafStart = i;
        continue;
      }
      if (cmd.registeredArguments.length === 0) {
        errors.push(`${where()} has no command '${token}'`);
        return { flags, errors };
      }
    }
    positionals++;
    const args = cmd.registeredArguments;
    const variadic = args.some((a) => a.variadic);
    const argument = args[Math.min(positionals, args.length) - 1];
    const refused = argument && refusedValue(argument, token);
    if (refused) errors.push(`${where()} '${token}': ${refused}`);
    if (mode.strict && !variadic && positionals > args.length) {
      errors.push(args.length === 0
        ? `${where()} takes no arguments (got '${token}')`
        : `${where()} takes at most ${args.length} argument${args.length === 1 ? '' : 's'} (got '${token}')`);
    }
    i++;
  }
  if (helpAt) return { command: helpTarget ?? helpAt, flags, errors };

  try {
    prepareCommandArgs(cmd, tokens.slice(leafStart));
  } catch (err) {
    if (!(err instanceof CommanderError)) throw err;
    errors.push(`${where()}: ${err.message.replace(/^error: /, '').split('\n')[0]}`);
  }
  const required = cmd.registeredArguments.filter((a) => a.required).length;
  if (mode.complete && !sawHelp && cmd !== root && positionals < required) {
    errors.push(`${where()} needs ${cmd.registeredArguments.filter((a) => a.required).map((a) => `<${a.name()}>`).join(' ')}`);
  }
  return { command: cmd, flags, errors };
}

// ─── Allowed non-invocations ───

/**
 * Text that reads like `tapsmith <word>` but is not a command line: the exact
 * invocation text, the files it may appear in, and why. An entry nothing
 * matches fails the guard, so the list cannot rot.
 */
const NOT_COMMANDS: Array<{ text: string; files: string[]; reason: string; lineIncludes?: string }> = [
  { text: 'tapsmith run', files: ['docs/telemetry.md', 'packages/tapsmith/src/telemetry.ts'], reason: 'telemetry event name' },
  { text: 'tapsmith install', files: ['docs/telemetry.md', 'packages/tapsmith/src/telemetry.ts'], reason: 'telemetry event name' },
  { text: 'tapsmith show-trace t.zip --force-install', files: ['docs/api-reference.md'], reason: 'the documented example of a refused flag' },
  { text: 'tapsmith test --device --workers 2', files: ['docs/api-reference.md'], reason: 'the documented example of a value flag given a flag' },
  { text: 'tapsmith setup-ios-device', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
  { text: 'tapsmith build-ios-agent', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
  { text: 'tapsmith setup-ios', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
  { text: 'tapsmith configure-ios-network <udid>', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
  { text: 'tapsmith refresh-ios-network <udid>', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
  { text: 'tapsmith verify-ios-network <udid>', files: ['docs/api-reference.md'], reason: 'the 0.5.0 name in the iOS rename table (PILOT-271)', lineIncludes: '| `tapsmith ios ' },
];

// ─── Sources ───

const REPO = path.resolve(import.meta.dirname, '../../../..');

const SOURCE_SETS = {
  markdown: [
    'docs/**/*.md', '*.md', 'packages/*/README.md', 'tools/**/*.md', 'web-tests/**/*.md', 'website/*.md',
    '.github/**/*.md', '.claude/skills/**/*.md', 'plugins/**/*.md',
  ],
  astro: ['website/src/pages/**/*.astro'],
  source: ['packages/tapsmith/src/**/*.{ts,tsx}'],
  daemon: ['packages/tapsmith-core/src/**/*.rs'],
} as const;

/** Files git tracks, plus new ones not yet added — never ignored ones (venvs, build output, local skills). */
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
const REPO_FILES = repoFiles();

function filesOf(patterns: readonly string[]): string[] {
  return glob.sync([...patterns], {
    cwd: REPO,
    nodir: true,
    dot: true,
    ignore: ['**/node_modules/**', '**/__tests__/**'],
  }).filter((rel) => (REPO_FILES ? REPO_FILES.has(rel) : !/(^|\/)(dist|target|venv)\//.test(rel)) && fs.existsSync(path.join(REPO, rel))).sort();
}

function collectInvocations(): Invocation[] {
  const all: Invocation[] = [];
  const read = (rel: string): string => fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const rel of filesOf(SOURCE_SETS.markdown)) all.push(...markdownSnippets(rel, read(rel)).flatMap(invocationsIn));
  for (const rel of filesOf(SOURCE_SETS.astro)) all.push(...astroSnippets(rel, read(rel)).flatMap(invocationsIn));
  for (const rel of filesOf(SOURCE_SETS.source)) all.push(...sourceSnippets(rel, read(rel)).flatMap(invocationsIn));
  for (const rel of filesOf(SOURCE_SETS.daemon)) all.push(...rustSnippets(rel, read(rel)).flatMap(invocationsIn));
  return all;
}

const sourceLine = (file: string, line: number): string => fs.readFileSync(path.join(REPO, file), 'utf8').split('\n')[line - 1] ?? '';

function allowedBy(invocation: Invocation, lineOf: (file: string, line: number) => string = sourceLine): (typeof NOT_COMMANDS)[number] | undefined {
  return NOT_COMMANDS.find((entry) => entry.text === invocation.text && entry.files.includes(invocation.file)
    && (entry.lineIncludes === undefined || lineOf(invocation.file, invocation.line).includes(entry.lineIncludes)));
}

function drift(root: Command, invocations: Invocation[]): string[] {
  const problems: string[] = [];
  for (const invocation of invocations) {
    if (allowedBy(invocation)) continue;
    const { errors } = resolveInvocation(root, invocation.tokens, invocation);
    for (const error of errors) problems.push(`${invocation.file}:${invocation.line}  \`${invocation.text}\`  → ${error}`);
  }
  return problems;
}

// ─── Reverse coverage: the api-reference CLI section ───

interface DocBlock {
  heading: string;
  text: string;
  line: number;
}

/** The `## CLI` section of api-reference.md, one block per `###`/`####` heading. */
function cliSectionBlocks(source: string): DocBlock[] {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^## CLI\s*$/.test(l));
  if (start < 0) throw new Error('docs/api-reference.md has no "## CLI" section');
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const blocks: DocBlock[] = [];
  let inFence = false;
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && /^#{3,4} /.test(line)) blocks.push({ heading: line, text: line, line: i + 1 });
    else if (blocks.length > 0) blocks[blocks.length - 1]!.text += `\n${line}`;
  }
  return blocks;
}

function visibleCommands(cmd: Command): Command[] {
  const help = cmd.createHelp();
  const children = help.visibleCommands(cmd).filter((c) => c.name() !== 'help' || findSubcommand(cmd, 'help') === c);
  return children.flatMap((c) => [c, ...visibleCommands(c)]);
}

function visibleOptions(cmd: Command): Option[] {
  return cmd.options.filter((o) => !o.hidden);
}

const mentions = (text: string, flag: string): boolean =>
  new RegExp(`(?<![\\w-])${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text);

/**
 * Every visible command needs a block whose heading resolves to it, and every
 * visible flag of it (long or short form) must be mentioned in those blocks.
 */
function undocumented(root: Command, blocks: DocBlock[], file: string): string[] {
  const byCommand = new Map<Command, DocBlock[]>();
  for (const block of blocks) {
    const snippets = markdownSnippets(file, block.heading).flatMap(invocationsIn);
    for (const invocation of snippets) {
      const { command } = resolveInvocation(root, invocation.tokens, { strict: false, complete: false });
      if (!command) continue;
      byCommand.set(command, [...(byCommand.get(command) ?? []), block]);
    }
  }
  const problems: string[] = [];
  for (const cmd of [root, ...visibleCommands(root)]) {
    const name = cmd === root ? 'tapsmith' : `tapsmith ${commandPath(cmd).join(' ')}`;
    const docs = byCommand.get(cmd) ?? [];
    if (docs.length === 0) {
      // The root needs a block only for flags of its own (--version).
      if (cmd !== root || visibleOptions(cmd).length > 0) problems.push(`${name}: no heading in the CLI section names it`);
      continue;
    }
    const text = docs.map((b) => b.text).join('\n');
    for (const option of visibleOptions(cmd)) {
      const forms = [option.long, option.short].filter((f): f is string => !!f);
      if (!forms.some((f) => mentions(text, f))) {
        problems.push(`${name}: flag ${option.flags} is not documented under ${docs.map((b) => `line ${b.line}`).join(', ')}`);
      }
    }
  }
  return problems;
}

// ─── The guard ───

describe('CLI docs guard', () => {
  const root = cliCommandTree();
  const invocations = collectInvocations();

  it('finds invocations in every source set', () => {
    for (const [set, patterns] of Object.entries(SOURCE_SETS)) {
      const files = new Set(filesOf(patterns));
      expect(invocations.filter((inv) => files.has(inv.file)).length, `no invocations found in ${set} sources`).toBeGreaterThan(0);
    }
  });

  it('every documented or printed `tapsmith …` invocation is one the CLI accepts', () => {
    expect(drift(root, invocations)).toEqual([]);
  });

  it('every allowlisted non-command phrase still occurs', () => {
    const used = new Set(invocations.map((inv) => allowedBy(inv)));
    expect(NOT_COMMANDS.filter((entry) => !used.has(entry)).map((entry) => entry.text)).toEqual([]);
  });

  it('every command and flag is documented in the api-reference CLI section', () => {
    const file = 'docs/api-reference.md';
    const blocks = cliSectionBlocks(fs.readFileSync(path.join(REPO, file), 'utf8'));
    expect(undocumented(root, blocks, file)).toEqual([]);
  });
});

// ─── The guard's own behaviour, on a synthetic tree ───

/** A tree shaped like the one PILOT-271 plans: nested subcommands beside flat ones. */
function syntheticTree(): Command {
  const program = new Command('tapsmith').version('1.0.0', '-v, --version').helpCommand('help [command]').enablePositionalOptions()
    .exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} });
  program.command('test')
    .argument('[files...]')
    .option('-d, --device <serial>')
    .option('-j, --workers <n>', '', (v: string) => {
      if (!/^\d+$/.test(v)) throw new InvalidArgumentError('--workers must be a positive integer.');
      return Number(v);
    })
    .option('-w, --watch')
    .option('-g, --grep <pattern>')
    // Like the real --trace: a custom parser, not .choices().
    .addOption(new Option('--trace [mode]').argParser((v: string) => {
      if (!['on', 'off', 'retain-on-failure'].includes(v)) throw new InvalidArgumentError('--trace must be one of: on, off, retain-on-failure.');
      return v;
    }))
    .addOption(new Option('--secret').hideHelp());
  program.command('doctor').option('--json');
  program.command('telemetry').addArgument(new Argument('[action]').choices(['status', 'enable', 'disable']));
  program.command('init').option('--no-example-test').option('-y, --yes');
  const ios = program.command('ios');
  const network = ios.command('network');
  network.command('verify').argument('<udid>').option('--timeout <s>');
  network.command('configure').argument('<udid>').option('--refresh');
  ios.command('build-agent').option('--team-id <id>').helpOption('-H, --help').option('-h, --host <name>');
  return program;
}

const errorsFor = (line: string, strict = true, complete = false): string[] => {
  const invocations = invocationsIn({ file: 'x.md', line: 1, text: line, strict, complete });
  return invocations.flatMap((inv) => resolveInvocation(syntheticTree(), inv.tokens, inv).errors);
};

describe('CLI docs guard: resolution', () => {
  it('accepts every flag form commander does', () => {
    for (const line of [
      'npx tapsmith test',
      'tapsmith test a.test.ts b.test.ts --device emulator-5554',
      'tapsmith test --device=emulator-5554 -j 2',
      'tapsmith test -j2',
      'tapsmith test -j=4',
      'tapsmith test -wd emulator-5554',
      'tapsmith test --trace',
      'tapsmith test --trace retain-on-failure',
      'tapsmith test -- --not-a-flag.test.ts',
      'tapsmith test --secret',
      'tapsmith init --no-example-test -y',
      'npx tapsmith@latest init --yes',
      'tapsmith --version',
      'tapsmith -v',
      'tapsmith --help',
      'tapsmith',
      'tapsmith help test',
      'tapsmith doctor --help',
      'tapsmith test -h',
    ]) {
      expect(errorsFor(line), line).toEqual([]);
    }
  });

  it('resolves nested subcommands and their flags', () => {
    expect(errorsFor('tapsmith ios network verify <udid> --timeout 30')).toEqual([]);
    expect(errorsFor('tapsmith ios network configure 0000-ABC --refresh')).toEqual([]);
    expect(errorsFor('tapsmith ios build-agent --team-id ABC')).toEqual([]);
    expect(errorsFor('tapsmith ios network help verify')).toEqual([]);
    expect(errorsFor('tapsmith help ios')).toEqual([]);
    expect(errorsFor('tapsmith ios network --help')).toEqual([]);
  });

  it('stops at a help flag, as commander does: the page is the current command\'s', () => {
    const root = syntheticTree();
    const at = (line: string): string | undefined => {
      const { command } = resolveInvocation(root, line.split(' ').slice(1), { strict: true, complete: false });
      return command ? commandPath(command).join(' ') : undefined;
    };
    expect(at('tapsmith ios --help network')).toBe('ios');
    expect(at('tapsmith ios network --help')).toBe('ios network');
  });

  it('reports unknown commands and subcommands', () => {
    expect(errorsFor('tapsmith tset')).toEqual(['tapsmith has no command \'tset\'']);
    expect(errorsFor('tapsmith ios network refresh <udid>')).toEqual(['tapsmith ios network has no command \'refresh\'']);
    expect(errorsFor('tapsmith help nope')).toEqual(['tapsmith has no command \'nope\'']);
    // runCli resolves the whole path after `help`, git-style.
    expect(errorsFor('tapsmith help ios network verify')).toEqual([]);
    expect(errorsFor('tapsmith help ios network help verify')).toEqual([]);
    // runCli reads a second `help` only after a resolved group, never straight after `help`.
    expect(errorsFor('tapsmith help help test')).toEqual(['tapsmith has no command \'help\'']);
    expect(errorsFor('tapsmith help ios netwrk')).toEqual(['tapsmith ios has no command \'netwrk\'']);
    expect(errorsFor('tapsmith help doctor extra')).toEqual(['`tapsmith doctor` has no subcommands (got \'extra\' after `help`)']);
  });

  it('reports unknown flags, and flags given to the wrong command', () => {
    expect(errorsFor('tapsmith test --network')).toEqual(['tapsmith test has no flag --network']);
    expect(errorsFor('tapsmith doctor --device')).toEqual(['tapsmith doctor has no flag --device']);
    expect(errorsFor('tapsmith test -x')).toEqual(['tapsmith test has no flag -x']);
    expect(errorsFor('tapsmith ios network verify <udid> --refresh')).toEqual(['tapsmith ios network verify has no flag --refresh']);
    expect(errorsFor('tapsmith init --example-test')).toEqual(['tapsmith init has no flag --example-test']);
    // Root flags go before the command.
    expect(errorsFor('tapsmith doctor --version')).toEqual(['tapsmith doctor has no flag --version']);
  });

  it('reports arguments a command does not take, in exact command lines only', () => {
    expect(errorsFor('tapsmith doctor [udid]')).toEqual(['tapsmith doctor takes no arguments (got \'[udid]\')']);
    expect(errorsFor('tapsmith ios network verify a b')).toEqual(['tapsmith ios network verify takes at most 1 argument (got \'b\')']);
    expect(errorsFor('tapsmith doctor [options]')).toEqual([]);
    expect(errorsFor('tapsmith doctor for the details', false)).toEqual([]);
  });

  it('checks the flags inside synopsis brackets', () => {
    expect(errorsFor('tapsmith test [--device <serial>] [-w] [files...]')).toEqual([]);
    expect(errorsFor('tapsmith init [--yes|--no-example-test]')).toEqual([]);
    // The drift PILOT-259 found in api-reference.md.
    expect(errorsFor('tapsmith ios build-agent [--team <id>] [--device|--simulator]')).toEqual([
      'tapsmith ios build-agent has no flag --team',
      'tapsmith ios build-agent has no flag --device',
      'tapsmith ios build-agent has no flag --simulator',
    ]);
    expect(errorsFor('tapsmith doctor [udid]')).toEqual(['tapsmith doctor takes no arguments (got \'[udid]\')']);
  });

  it('ends a command at the quote that closes the text around it', () => {
    expect(errorsFor('Run \'tapsmith doctor --help\' for usage.', false)).toEqual([]);
    expect(errorsFor('tapsmith test --grep "a b" --nope')).toEqual(['tapsmith test has no flag --nope']);
    expect(errorsFor('tapsmith test --device=\'x y\' --nope')).toEqual(['tapsmith test has no flag --nope']);
  });

  it('applies runCli\'s own argument rules', () => {
    expect(errorsFor('tapsmith test --device --watch')).toEqual([
      'tapsmith test: option \'-d, --device <serial>\' argument missing (got the flag \'--watch\'). If \'--watch\' really is the value, write --device=--watch',
    ]);
    expect(errorsFor('tapsmith test -grep foo')).toEqual(['tapsmith test: unknown option \'-grep\'']);
    expect(errorsFor('tapsmith ios network verify <udid> --timeout --refresh')[0]).toMatch(/argument missing/);
  });

  it('reports a missing required argument on whole command lines only', () => {
    expect(errorsFor('tapsmith ios network verify', true, true)).toEqual(['tapsmith ios network verify needs <udid>']);
    expect(errorsFor('tapsmith ios network verify <udid>', true, true)).toEqual([]);
    expect(errorsFor('tapsmith ios network verify --help', true, true)).toEqual([]);
    expect(errorsFor('tapsmith ios network verify')).toEqual([]);
    expect(errorsFor('tapsmith', true, true)).toEqual([]);
  });

  it('checks values with the tree\'s own parsers and choices', () => {
    expect(errorsFor('tapsmith test --trace retain-on-falure')).toEqual([
      'tapsmith test --trace \'retain-on-falure\': --trace must be one of: on, off, retain-on-failure.',
    ]);
    // A bare --trace takes the next word as its mode, as commander does.
    expect(errorsFor('tapsmith test --trace login.test.ts')[0]).toMatch(/--trace must be one of/);
    expect(errorsFor('tapsmith test --trace on login.test.ts')).toEqual([]);
    expect(errorsFor('tapsmith test -j2x')[0]).toMatch(/--workers must be a positive integer/);
    expect(errorsFor('tapsmith test --workers=1.5')[0]).toMatch(/--workers must be a positive integer/);
    expect(errorsFor('tapsmith test -j <n> --workers 4 -j=2 --workers N')).toEqual([]);
    expect(errorsFor('tapsmith test --workers 0x')[0]).toMatch(/--workers must be a positive integer/);
    expect(errorsFor('tapsmith telemetry off')[0]).toMatch(/Allowed choices are status, enable, disable/);
    expect(errorsFor('tapsmith telemetry [status|enable|disable]')).toEqual([]);
  });

  it('reports a value flag with no value on whole command lines only', () => {
    expect(errorsFor('tapsmith test --device', true, true)).toEqual(['tapsmith test --device needs a value']);
    expect(errorsFor('tapsmith test -wd', true, true)).toEqual(['tapsmith test -d needs a value']);
    expect(errorsFor('tapsmith test --trace', true, true)).toEqual([]);
    expect(errorsFor('see tapsmith test --device', false, false)).toEqual([]);
  });

  it('reads help flags from the tree', () => {
    expect(errorsFor('tapsmith ios build-agent -H')).toEqual([]);
    expect(errorsFor('tapsmith ios build-agent -h example.com')).toEqual([]);
    expect(errorsFor('tapsmith doctor -H')).toEqual(['tapsmith doctor has no flag -H']);
  });

  it('does not read a value as a flag', () => {
    expect(errorsFor('tapsmith test --device <serial>')).toEqual([]);
    expect(errorsFor('tapsmith test -d=-weird-serial')).toEqual([]);
    expect(errorsFor('tapsmith test --grep=-slow')).toEqual([]);
    expect(errorsFor('tapsmith test -g=-slow --nope')).toEqual(['tapsmith test has no flag --nope']);
  });

  it('skips placeholders it cannot resolve', () => {
    expect(errorsFor('tapsmith <command> --help')).toEqual([]);
    expect(errorsFor(`tapsmith ${SUBSTITUTION} --help`, false)).toEqual([]);
  });

  it('stops at shell operators, comments and prose', () => {
    expect(errorsFor('npx tapsmith init && npx tapsmith doctor --json')).toEqual([]);
    expect(errorsFor('npx tapsmith doctor | tee log --nope')).toEqual([]);
    expect(errorsFor('npx tapsmith test   # --nope')).toEqual([]);
    expect(errorsFor('Run: npx tapsmith init --yes (or npx tapsmith init for the wizard)', false)).toEqual([]);
    expect(errorsFor('run tapsmith doctor, then --nope', false)).toEqual([]);
    expect(errorsFor('npx tapsmith init && npx tapsmith dcotor')).toEqual(['tapsmith has no command \'dcotor\'']);
  });

  it('checks commands after an install step and in other launcher forms', () => {
    expect(errorsFor('npm install then run tapsmith tset', false)).toEqual(['tapsmith has no command \'tset\'']);
    expect(errorsFor('npm i -D @tapsmith/react-native tapsmith')).toEqual([]);
    expect(errorsFor('npm ci && npx tapsmith dcotor')).toEqual(['tapsmith has no command \'dcotor\'']);
    expect(errorsFor('npm i -D tapsmith && npx tapsmith tset')).toEqual(['tapsmith has no command \'tset\'']);
    expect(errorsFor('./node_modules/.bin/tapsmith dcotor')).toEqual(['tapsmith has no command \'dcotor\'']);
    expect(errorsFor('node node_modules/.bin/tapsmith test --nope')).toEqual(['tapsmith test has no flag --nope']);
    expect(errorsFor(`npx tapsmith@${SUBSTITUTION} dcotor`, false)).toEqual(['tapsmith has no command \'dcotor\'']);
    expect(errorsFor('claude mcp add -s user tapsmith -- npx tapsmith dcotor')).toEqual(['tapsmith has no command \'dcotor\'']);
    expect(errorsFor('gh api -f o=tapsmith -f r=tapsmith')).toEqual([]);
  });

  it('stops at redirections', () => {
    expect(errorsFor('npx tapsmith doctor &> doctor.log')).toEqual([]);
    expect(errorsFor('npx tapsmith doctor 2>/dev/null')).toEqual([]);
    expect(errorsFor('npx tapsmith doctor >out.json')).toEqual([]);
    expect(errorsFor('npx tapsmith doctor &')).toEqual([]);
  });

  it('checks flags whose value is a template substitution', () => {
    const errors = (src: string): string[] => sourceSnippets('x.ts', src).flatMap(invocationsIn)
      .flatMap((inv) => resolveInvocation(syntheticTree(), inv.tokens, inv).errors);
    expect(errors('const a = `Run: npx tapsmith test --shrd=${i}/${n}`;')).toEqual(['tapsmith test has no flag --shrd']);
    expect(errors('const a = `Run: npx tapsmith test --device=${serial} -j${n}`;')).toEqual([]);
    expect(errors('const a = `Run: npx tapsmith test --${flag}`;')).toEqual([]);
  });

  it('ignores the package name and MCP server names', () => {
    expect(errorsFor('npm install -D tapsmith @tapsmith/react-native')).toEqual([]);
    expect(errorsFor('claude mcp add tapsmith -- npx tapsmith mcp-server')).toEqual(['tapsmith has no command \'mcp-server\'']);
    expect(errorsFor('codex mcp add tapsmith http://localhost:9274/mcp')).toEqual([]);
    expect(errorsFor('import { test } from "tapsmith"')).toEqual([]);
    expect(errorsFor('@tapsmith/core tapsmith.config.ts tapsmith-results')).toEqual([]);
  });
});

describe('CLI docs guard: extraction', () => {
  it('reads code blocks, inline code and tables from markdown, not prose', () => {
    const md = [
      'Use your tapsmith config here.',
      '',
      '```bash',
      'npx tapsmith test --nope',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| `tapsmith doctor --nope` | x |',
      '',
      '- item with `tapsmith verify --nope`',
    ].join('\n');
    const found = markdownSnippets('x.md', md).flatMap(invocationsIn).map((inv) => [inv.line, inv.text]);
    expect(found).toEqual([
      [4, 'tapsmith test --nope'],
      [9, 'tapsmith doctor --nope'],
      [11, 'tapsmith verify --nope'],
    ]);
  });

  it('reads string and template literals from source, not comments', () => {
    const src = [
      '// tapsmith test --comment',
      'const a = \'Run: npx tapsmith doctor --json\';',
      'const b = `Run tapsmith ${cmd} --help or tapsmith init --yes`;',
    ].join('\n');
    const found = sourceSnippets('x.ts', src).flatMap(invocationsIn).map((inv) => [inv.line, inv.text]);
    expect(found).toEqual([
      [2, 'tapsmith doctor --json'],
      [3, `tapsmith ${SUBSTITUTION} --help or`],
      [3, 'tapsmith init --yes'],
    ]);
  });

  it('skips comments in code blocks', () => {
    const md = ['```bash', 'npm ci   # installs tapsmith deps', 'npx tapsmith test  # tapsmith picks the device', '```', '```ts', '// tapsmith picks one', '```'].join('\n');
    expect(markdownSnippets('x.md', md).flatMap(invocationsIn).map((inv) => inv.text)).toEqual(['tapsmith test']);
    const quoted = ['```bash', 'npx tapsmith test --grep "a #b" --nope', '```'].join('\n');
    expect(markdownSnippets('x.md', quoted).flatMap(invocationsIn).map((inv) => inv.tokens)).toEqual([['test', '--grep', 'a #b', '--nope']]);
  });

  it('gives nested code blocks their line, and joins continuation lines', () => {
    const md = ['# T', '', '1. Step:', '', '   ```sh', '   tapsmith tset', '   ```', '', '```bash', 'npx tapsmith test \\', '  --nope', '```'].join('\n');
    expect(markdownSnippets('x.md', md).flatMap(invocationsIn).map((inv) => [inv.line, inv.text])).toEqual([
      [6, 'tapsmith tset'],
      [10, 'tapsmith test --nope'],
    ]);
  });

  it('reads raw HTML <code> in markdown and JSX text in .tsx', () => {
    expect(markdownSnippets('x.md', '<p>Run <code>tapsmith doctor --nope</code></p>\n').flatMap(invocationsIn).map((inv) => inv.text))
      .toEqual(['tapsmith doctor --nope']);
    expect(sourceSnippets('x.tsx', 'const a = <p>Run npx tapsmith show-trace to open it</p>;').flatMap(invocationsIn).map((inv) => inv.text))
      .toEqual(['tapsmith show-trace to open it']);
  });

  it('reads string literals from Rust, not comments or char literals', () => {
    const rs = [
      '// run `tapsmith test --comment`',
      'let q = \'"\';',
      'let m = format!("Run `tapsmith configure-ios-network {serial}` first, then \\',
      '    `tapsmith doctor --json`. {{literal}}");',
      '/* tapsmith block --comment */',
      'let r = r#"npx tapsmith setup-ios"#;',
    ].join('\n');
    expect(rustSnippets('x.rs', rs).flatMap(invocationsIn).map((inv) => [inv.line, inv.text])).toEqual([
      [3, `tapsmith configure-ios-network ${SUBSTITUTION}`],
      [3, 'tapsmith doctor --json'],
      [6, 'tapsmith setup-ios'],
    ]);
  });

  it('scopes allowlist entries to their files and exact text', () => {
    const inv = (text: string, file: string): Invocation => ({ file, line: 1, text, tokens: text.split(' ').slice(1), strict: true, complete: false });
    expect(allowedBy(inv('tapsmith run', 'docs/telemetry.md'))).toBeDefined();
    expect(allowedBy(inv('tapsmith run', 'docs/getting-started.md'))).toBeUndefined();
    expect(allowedBy(inv('tapsmith run --nope', 'docs/telemetry.md'))).toBeUndefined();
    // A rename-table entry excuses the old name in its table row only, not in prose.
    const renamed = inv('tapsmith setup-ios', 'docs/api-reference.md');
    expect(allowedBy(renamed, () => '| `tapsmith setup-ios` | `tapsmith ios network setup-simulator` |')).toBeDefined();
    expect(allowedBy(renamed, () => 'Run `tapsmith setup-ios` first.')).toBeUndefined();
  });

  it('reads <code> and code= attributes from astro pages', () => {
    const astro = 'body: \'<code>tapsmith init</code> writes it\'\n<Code code="npx tapsmith test --ui" />\n<Code code={`npx tapsmith doctor`} />';
    expect(astroSnippets('x.astro', astro).flatMap(invocationsIn).map((inv) => inv.text)).toEqual([
      'tapsmith init',
      'tapsmith test --ui',
      'tapsmith doctor',
    ]);
  });
});

describe('CLI docs guard: reverse coverage', () => {
  const doc = (body: string): DocBlock[] => cliSectionBlocks(`# API\n\n## CLI\n\n${body}\n\n## Next\n\n### \`tapsmith doctor --json\`\n`);

  it('requires a heading per visible command, nested ones included', () => {
    const problems = undocumented(syntheticTree(), doc('### `tapsmith test`\n--device -j --watch --trace'), 'x.md');
    expect(problems).toEqual(expect.arrayContaining([
      'tapsmith: no heading in the CLI section names it',
      'tapsmith doctor: no heading in the CLI section names it',
      'tapsmith ios network verify: no heading in the CLI section names it',
    ]));
    // Blocks after the CLI section do not count.
    expect(problems.some((p) => p.startsWith('tapsmith doctor:'))).toBe(true);
  });

  it('requires every visible flag, long or short form, and exempts hidden ones', () => {
    const body = [
      '### `tapsmith --version`',
      '### `tapsmith test [files...]`',
      '`-d` and `--workers` and `-w` and `-g`',
      '### `tapsmith test --trace [mode]`',
      '### `tapsmith doctor --json`',
      '### `tapsmith init`',
      '`--no-example-test`, `--yes`',
      '### `tapsmith ios`',
      '#### `tapsmith ios network`',
      '#### `tapsmith ios network verify <udid>`',
      '#### `tapsmith ios network configure <udid> --refresh`',
      '#### `tapsmith ios build-agent`',
      '### `tapsmith telemetry [status|enable|disable]`',
    ].join('\n');
    expect(undocumented(syntheticTree(), doc(body), 'x.md')).toEqual([
      'tapsmith ios network verify: flag --timeout <s> is not documented under line 14',
      'tapsmith ios build-agent: flag --team-id <id> is not documented under line 16',
      'tapsmith ios build-agent: flag -h, --host <name> is not documented under line 16',
    ]);
  });

  it('fails loudly when the CLI section is missing', () => {
    expect(() => cliSectionBlocks('# API\n\n## Commands\n')).toThrow('no "## CLI" section');
  });
});
