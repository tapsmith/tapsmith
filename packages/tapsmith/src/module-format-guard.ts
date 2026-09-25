/**
 * Fail fast, with the real cause, when the SDK is loaded as CommonJS without
 * `import.meta` (PILOT-382).
 *
 * Tapsmith ships ESM. A CommonJS test or config file — any `.ts` file in a
 * package without `"type": "module"` — makes its TypeScript loader compile
 * the SDK to CommonJS as well. tsx 4.23+ (the version Tapsmith depends on)
 * fills in all of `import.meta` when it does that; older releases fill in
 * only `import.meta.url` (tsx 4.21 does), and ts-node or a hand-rolled
 * require hook may leave it empty. Either way the first module that resolves
 * a path from `import.meta.dirname` at load time dies with an
 * unrelated-looking `The "paths[0]" argument must be of type string`.
 *
 * `index.ts` imports this module first, so it runs before any of those.
 */

export function moduleFormatError(dirname: unknown): string | undefined {
  if (typeof dirname === 'string') return undefined;
  return [
    'Tapsmith was loaded as CommonJS without `import.meta.dirname`, so it cannot locate its own files.',
    'A TypeScript loader compiled Tapsmith\'s ESM build to CommonJS — typically a tsx older than 4.23, ts-node,',
    'or a custom require hook running a test or config file in a package without "type": "module".',
    'Fix: run tests with the Tapsmith CLI (`npx tapsmith test`), which uses the tsx it ships with;',
    'upgrade tsx to 4.23 or newer if you register it yourself; or add "type": "module" to your package.json.',
  ].join('\n');
}

const error = moduleFormatError(import.meta.dirname);
if (error) throw new Error(error);
