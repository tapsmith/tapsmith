/**
 * Fail fast, with the real cause, when the SDK is loaded without
 * `import.meta.dirname` — in practice, compiled to CommonJS (PILOT-382).
 *
 * Tapsmith ships ESM. A CommonJS test or config file — any `.ts` file in a
 * package without `"type": "module"` — makes its TypeScript loader compile
 * the SDK to CommonJS as well. tsx 4.21.1 and later (Tapsmith depends on
 * ^4.23) fill in all of `import.meta` when they do that; 4.21.0 and earlier
 * fill in only `import.meta.url`, and other esbuild-style transforms
 * may stub `import.meta` out entirely. Either way the first module that resolves
 * a path from `import.meta.dirname` at load time dies with an
 * unrelated-looking `The "paths[0]" argument must be of type string`.
 *
 * Some ESM hosts (a test runner's VM modules, a bundler) can also leave
 * `dirname` out, so the message leads with what is missing, not with a cause.
 *
 * `index.ts` imports this module first, so it runs before any of those.
 */

export function moduleFormatError(dirname: unknown): string | undefined {
  if (typeof dirname === 'string') return undefined;
  return [
    'Tapsmith was loaded without `import.meta.dirname`, so it cannot locate its own files.',
    'Usually a TypeScript loader compiled Tapsmith\'s ESM build to CommonJS — tsx 4.21.0 or older, or another',
    'transform that stubs out import.meta — for a test or config file in a package without "type": "module".',
    'Fix: run tests with the Tapsmith CLI (`npx tapsmith test`), which uses the tsx it ships with;',
    'upgrade tsx if you register it yourself (Tapsmith ships 4.23); or add "type": "module" to your package.json.',
  ].join('\n');
}

// `?.`: a transform may replace `import.meta` itself with `undefined`.
const error = moduleFormatError(import.meta?.dirname);
if (error) throw new Error(error);
