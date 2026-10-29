/**
 * Fixture system for Tapsmith tests.
 *
 * Provides `test.extend()` for defining custom fixtures with test or worker
 * scope. Follows the Playwright fixture pattern where setup/teardown is
 * managed via the `use()` callback.
 */

import type { Device } from './device.js';
import type { APIRequestContext } from './api-request.js';

// ─── Types ───

/** How long a fixture's value lives: one test (`'test'`) or the whole worker (`'worker'`). */
export type FixtureScope = 'test' | 'worker'

/** The `use` callback provided to fixture functions. */
export type UseFn<T> = (value: T) => Promise<void>

/**
 * A fixture definition function. Receives all other fixtures as the first
 * argument and a `use` callback as the second. The fixture sets up its
 * value, passes it to `use()`, and cleans up after `use()` resolves.
 */
export type FixtureFn<T, F extends Record<string, unknown>> = (
  fixtures: F,
  use: UseFn<T>,
) => Promise<void>

/** A fixture definition: either a bare function (test scope) or a tuple with options. */
export type FixtureDefinition<T, F extends Record<string, unknown>> =
  | FixtureFn<T, F>
  | [FixtureFn<T, F>, { scope: FixtureScope }]

/** Map of fixture names to their definitions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- F is a merged fixture context that may include interfaces without index signatures
export type FixtureDefinitions<T extends Record<string, unknown>, F = any> = {
  [K in keyof T]: FixtureDefinition<T[K], F & T & Record<string, unknown>>
}

/** Internal resolved fixture entry. */
export interface ResolvedFixture<T = unknown> {
  fn: FixtureFn<T, Record<string, unknown>>
  scope: FixtureScope
  /** Parsed dependency names, or null if the function takes params but doesn't
   *  destructure them (meaning deps are unknown). */
  deps: string[] | null
}

// ─── Built-in fixtures ───

/** The fixtures Tapsmith provides to every test. */
export interface BuiltinFixtures {
  /** The device under test. */
  device: Device
  /** An HTTP client for calling APIs from a test (Playwright's `request`). */
  request: APIRequestContext
}

// ─── Fixture registry ───

/**
 * A registry of fixture definitions. Created by `test.extend()` and used
 * by the runner to resolve fixtures at the appropriate scope.
 */
export class FixtureRegistry {
  private _fixtures: Map<string, ResolvedFixture> = new Map();

  /** Register fixture definitions from a `test.extend()` call. */
  register<T extends Record<string, unknown>>(
    definitions: FixtureDefinitions<T, BuiltinFixtures & T>,
  ): void {
    for (const [name, def] of Object.entries(definitions)) {
      if (Array.isArray(def)) {
        const [fn, opts] = def as [FixtureFn<unknown, Record<string, unknown>>, { scope: FixtureScope }];
        this._fixtures.set(name, { fn, scope: opts.scope, deps: fixtureDepsFromFn(fn) });
      } else {
        const fn = def as FixtureFn<unknown, Record<string, unknown>>;
        this._fixtures.set(name, { fn, scope: 'test', deps: fixtureDepsFromFn(fn) });
      }
    }
  }

  /** Get a fixture definition by name. */
  get(name: string): ResolvedFixture | undefined {
    return this._fixtures.get(name);
  }

  /** Check if a fixture is registered by name. */
  has(name: string): boolean {
    return this._fixtures.has(name);
  }

  /** Get all fixture names. */
  names(): string[] {
    return [...this._fixtures.keys()];
  }

  /** Get all fixtures with the given scope. */
  byScope(scope: FixtureScope): Map<string, ResolvedFixture> {
    const result = new Map<string, ResolvedFixture>();
    for (const [name, fixture] of this._fixtures) {
      if (fixture.scope === scope) {
        result.set(name, fixture);
      }
    }
    return result;
  }

  /**
   * Collect transitive dependencies for the given fixture names, filtered to a
   * scope. Returns names in dependency-first (setup) order, or null if any
   * fixture in the chain has unknown deps (lazy resolution must fall back).
   */
  collectDeps(names: string[], scope: FixtureScope): string[] | null {
    const ordered: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string): boolean => {
      const fixture = this._fixtures.get(name);
      if (!fixture || fixture.scope !== scope) return true;
      if (visiting.has(name)) {
        throw new Error(`Circular fixture dependency detected: ${[...visiting, name].join(' -> ')}`);
      }
      if (visited.has(name)) return true;
      if (fixture.deps === null) return false;
      visiting.add(name);
      for (const dep of fixture.deps) {
        if (!visit(dep)) return false;
      }
      visiting.delete(name);
      visited.add(name);
      ordered.push(name);
      return true;
    };

    for (const name of names) {
      if (!visit(name)) return null;
    }
    return ordered;
  }

  /** Whether any fixtures are registered. */
  get isEmpty(): boolean {
    return this._fixtures.size === 0;
  }

  /** Create a copy of this registry with additional fixtures merged in. */
  merge(other: FixtureRegistry): FixtureRegistry {
    const merged = new FixtureRegistry();
    for (const [name, fixture] of this._fixtures) {
      merged._fixtures.set(name, fixture);
    }
    for (const [name, fixture] of other._fixtures) {
      merged._fixtures.set(name, fixture);
    }
    return merged;
  }
}

// ─── Fixture resolution ───

/**
 * Resolve and run fixtures for a given scope. Returns the fixture values
 * and a teardown function that runs all fixture teardown in reverse order.
 *
 * The `use()` pattern works by creating a promise per fixture:
 * - The fixture function calls `use(value)`, which resolves a "provided" promise
 * - The runner consumes the value
 * - When teardown is triggered, the "teardown" promise resolves, allowing the
 *   fixture function to continue past `use()` and run cleanup
 */
export async function resolveFixtures(
  registry: FixtureRegistry,
  scope: FixtureScope,
  baseFixtures: Record<string, unknown>,
  requestedNames?: string[],
): Promise<{ fixtures: Record<string, unknown>; teardown: () => Promise<void> }> {
  const fixtures: Record<string, unknown> = { ...baseFixtures };
  const teardowns: (() => Promise<void>)[] = [];

  const depOrder = requestedNames ? registry.collectDeps(requestedNames, scope) : null;
  const fixturesToResolve: [string, ResolvedFixture][] = depOrder
    ? depOrder.map(name => [name, registry.get(name)!] as [string, ResolvedFixture])
    : [...registry.byScope(scope)];

  try {
    for (const [name, def] of fixturesToResolve) {
      // Create the use/teardown promise pair
      let resolveUse: (value: unknown) => void;
      let resolveTeardown: () => void;
      let fixtureError: unknown;

      const usePromise = new Promise<unknown>((resolve) => {
        resolveUse = resolve;
      });
      const teardownPromise = new Promise<void>((resolve) => {
        resolveTeardown = resolve;
      });

      let hasUsed = false;
      // Run the fixture function in the background
      const fixturePromise = def.fn(fixtures, async (value: unknown) => {
        hasUsed = true;
        resolveUse!(value);
        // Wait for teardown signal
        await teardownPromise;
      }).catch((err) => {
        if (!hasUsed) {
          fixtureError = err;
          // Resolve use in case the fixture errored before calling use()
          resolveUse!(undefined);
        } else {
          // Error after use() — rethrow so teardown handler sees it
          throw err;
        }
      });

      // Mark as handled to prevent unhandledRejection warnings/crashes —
      // the rejection is caught later via `await fixturePromise` in teardown.
      fixturePromise.catch(() => {});

      // Wait for the fixture to provide its value
      const value = await usePromise;

      if (fixtureError) {
        throw fixtureError;
      }

      fixtures[name] = value;

      // Queue teardown (run in reverse order)
      teardowns.unshift(async () => {
        resolveTeardown!();
        await fixturePromise;
      });
    }
  } catch (err) {
    // Tear down already-resolved fixtures to prevent resource leaks
    for (const fn of teardowns) {
      try {
        await fn();
      } catch (teardownErr) {
        const msg = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        process.stderr.write(`[tapsmith] fixture teardown error during cleanup: ${msg}\n`);
      }
    }
    throw err;
  }

  return {
    fixtures,
    teardown: async () => {
      for (const fn of teardowns) {
        try {
          await fn();
        } catch (err) {
          // Teardown errors should not mask test errors, but log for diagnosability
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[tapsmith] fixture teardown error: ${msg}\n`);
        }
      }
    },
  };
}

// ─── Fixture parameter name parsing ───
//
// Known limitation: nested template literals (e.g., `a ${`nested`} b`) are not
// handled — the inner backtick toggles the string state incorrectly. This is
// acceptable because fixture function signatures never contain nested templates.

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- WeakMap key must be Function
const signatureCache = new WeakMap<Function, string[]>();

// Count consecutive backslashes before index to determine if a quote is escaped.
// An odd count means the quote is escaped; even (including zero) means it's real.
function isEscaped(s: string, index: number): boolean {
  let count = 0;
  let j = index - 1;
  while (j >= 0 && s[j] === '\\') {
    count++;
    j--;
  }
  return count % 2 === 1;
}

function filterOutComments(s: string): string {
  const result: string[] = [];
  let commentState: 'none' | 'singleline' | 'multiline' = 'none';
  let stringState: 'none' | 'single' | 'double' | 'template' = 'none';

  for (let i = 0; i < s.length; ++i) {
    if (commentState === 'none') {
      if (stringState === 'none') {
        if (s[i] === "'" && !isEscaped(s, i)) {
          stringState = 'single';
        } else if (s[i] === '"' && !isEscaped(s, i)) {
          stringState = 'double';
        } else if (s[i] === '`' && !isEscaped(s, i)) {
          stringState = 'template';
        } else if (s[i] === '/' && s[i + 1] === '/') {
          commentState = 'singleline';
          continue;
        } else if (s[i] === '/' && s[i + 1] === '*') {
          commentState = 'multiline';
          i++;
          continue;
        }
      } else {
        if (stringState === 'single' && s[i] === "'" && !isEscaped(s, i)) {
          stringState = 'none';
        } else if (stringState === 'double' && s[i] === '"' && !isEscaped(s, i)) {
          stringState = 'none';
        } else if (stringState === 'template' && s[i] === '`' && !isEscaped(s, i)) {
          stringState = 'none';
        }
      }
    }

    if (commentState === 'singleline') {
      if (s[i] === '\n') {
        commentState = 'none';
        result.push('\n');
      }
    } else if (commentState === 'multiline') {
      if (s[i - 1] === '*' && s[i] === '/')
        commentState = 'none';
    } else {
      result.push(s[i]);
    }
  }
  return result.join('');
}

function splitByComma(s: string): string[] {
  const result: string[] = [];
  const stack: string[] = [];
  let start = 0;
  let stringState: 'none' | 'single' | 'double' | 'template' = 'none';
  for (let i = 0; i < s.length; i++) {
    if (stringState === 'none') {
      if (s[i] === "'" && !isEscaped(s, i)) {
        stringState = 'single';
      } else if (s[i] === '"' && !isEscaped(s, i)) {
        stringState = 'double';
      } else if (s[i] === '`' && !isEscaped(s, i)) {
        stringState = 'template';
      } else if (s[i] === '{' || s[i] === '[' || s[i] === '(') {
        stack.push(s[i] === '{' ? '}' : s[i] === '[' ? ']' : ')');
      } else if (s[i] === stack[stack.length - 1]) {
        stack.pop();
      } else if (!stack.length && s[i] === ',') {
        const token = s.substring(start, i).trim();
        if (token)
          result.push(token);
        start = i + 1;
      }
    } else {
      if (stringState === 'single' && s[i] === "'" && !isEscaped(s, i)) {
        stringState = 'none';
      } else if (stringState === 'double' && s[i] === '"' && !isEscaped(s, i)) {
        stringState = 'none';
      } else if (stringState === 'template' && s[i] === '`' && !isEscaped(s, i)) {
        stringState = 'none';
      }
    }
  }
  const lastToken = s.substring(start).trim();
  if (lastToken)
    result.push(lastToken);
  return result;
}

/** Find the matching closing paren for the opening `(` at `start`, respecting
 *  nested parens and string literals. Returns the index of `)` or -1. */
function findMatchingParen(text: string, start: number): number {
  let depth = 1;
  let stringState: 'none' | 'single' | 'double' | 'template' = 'none';
  for (let i = start + 1; i < text.length; i++) {
    if (stringState === 'none') {
      if (text[i] === "'" && !isEscaped(text, i)) {
        stringState = 'single';
      } else if (text[i] === '"' && !isEscaped(text, i)) {
        stringState = 'double';
      } else if (text[i] === '`' && !isEscaped(text, i)) {
        stringState = 'template';
      } else if (text[i] === '(') {
        depth++;
      } else if (text[i] === ')') {
        depth--;
        if (depth === 0) return i;
      }
    } else {
      if (stringState === 'single' && text[i] === "'" && !isEscaped(text, i)) {
        stringState = 'none';
      } else if (stringState === 'double' && text[i] === '"' && !isEscaped(text, i)) {
        stringState = 'none';
      } else if (stringState === 'template' && text[i] === '`' && !isEscaped(text, i)) {
        stringState = 'none';
      }
    }
  }
  return -1;
}

/** Find the matching closing brace for the opening `{` at the start of `s`,
 *  respecting nested braces and string literals. Returns the index or -1. */
function findMatchingBrace(s: string): number {
  let braceCount = 0;
  let stringState: 'none' | 'single' | 'double' | 'template' = 'none';
  for (let i = 0; i < s.length; i++) {
    if (stringState === 'none') {
      if (s[i] === "'" && !isEscaped(s, i)) {
        stringState = 'single';
      } else if (s[i] === '"' && !isEscaped(s, i)) {
        stringState = 'double';
      } else if (s[i] === '`' && !isEscaped(s, i)) {
        stringState = 'template';
      } else if (s[i] === '{') {
        braceCount++;
      } else if (s[i] === '}') {
        braceCount--;
        if (braceCount === 0) return i;
      }
    } else {
      if (stringState === 'single' && s[i] === "'" && !isEscaped(s, i)) {
        stringState = 'none';
      } else if (stringState === 'double' && s[i] === '"' && !isEscaped(s, i)) {
        stringState = 'none';
      } else if (stringState === 'template' && s[i] === '`' && !isEscaped(s, i)) {
        stringState = 'none';
      }
    }
  }
  return -1;
}

/** Extract the full parameter list string from a function's toString(). */
function extractParamList(text: string): string | null {
  const openParen = text.indexOf('(');
  if (openParen === -1) return null;
  const closeParen = findMatchingParen(text, openParen);
  if (closeParen === -1) return null;
  const params = text.substring(openParen + 1, closeParen).trim();
  return params.length > 0 ? params : null;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
function innerFixtureParameterNames(fn: Function): string[] {
  const text = filterOutComments(fn.toString());
  const trimmedParams = extractParamList(text);
  if (!trimmedParams || trimmedParams[0] !== '{')
    return [];
  const closingBraceIndex = findMatchingBrace(trimmedParams);
  if (closingBraceIndex === -1)
    return [];
  const props = splitByComma(trimmedParams.substring(1, closingBraceIndex)).map(prop => {
    const eq = prop.indexOf('=');
    const colon = prop.indexOf(':');
    if (colon !== -1 && (eq === -1 || colon < eq))
      return prop.substring(0, colon).trim();
    if (eq !== -1)
      return prop.substring(0, eq).trim();
    return prop.trim();
  });
  const restProperty = props.find(prop => prop.startsWith('...'));
  if (restProperty)
    return [];
  return props;
}

/**
 * Parse the destructured parameter names from a function signature.
 * Used for lazy fixture resolution — only fixtures that are actually
 * destructured by the test/hook function are resolved.
 *
 * Ported from Playwright's fixture parameter parsing.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
export function fixtureParameterNames(fn: Function): string[] {
  const cached = signatureCache.get(fn);
  if (cached)
    return cached;
  const names = innerFixtureParameterNames(fn);
  signatureCache.set(fn, names);
  return names;
}

/**
 * Determine fixture dependencies from a fixture function's signature.
 * - Destructured first param `({ foo, bar }, use)` → `['foo', 'bar']`
 * - Unused `_`-prefixed first param `(_fixtures, use)` → `[]`
 * - Plain first param `(fixtures, use)` → `null` (unknown deps)
 * - No params `() => ...` → `[]`
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
function fixtureDepsFromFn(fn: Function): string[] | null {
  const names = fixtureParameterNames(fn);
  if (names.length > 0) return names;
  const text = filterOutComments(fn.toString());
  const paramList = extractParamList(text);
  if (!paramList) return [];
  const firstParam = splitByComma(paramList)[0].trim();
  if (firstParam.startsWith('{')) return [];
  // Strip type annotations and defaults: `fixtures: any = {}` → `fixtures`
  const ident = firstParam.replace(/[:=].*/, '').trim();
  if (ident.startsWith('_') && !functionBodyReferencesIdentifier(text, ident)) return [];
  return null;
}

function functionBodyReferencesIdentifier(text: string, ident: string): boolean {
  const openParen = text.indexOf('(');
  const closeParen = openParen === -1 ? -1 : findMatchingParen(text, openParen);
  const body = closeParen === -1 ? text : text.slice(closeParen + 1);
  const escaped = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(body);
}

/**
 * Check whether a function has any parameters, including those with default
 * values (which make `fn.length === 0`). Used by lazy resolution to detect
 * `(fixtures = {}) => ...` patterns that fn.length misses.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
export function functionHasParameters(fn: Function): boolean {
  if (fn.length > 0) return true;
  const text = filterOutComments(fn.toString());
  return extractParamList(text) !== null;
}

/** @internal Exported for testing only. */
export const _testUtils = { filterOutComments, splitByComma };
