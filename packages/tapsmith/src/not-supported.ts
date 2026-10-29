/**
 * Runtime stand-ins for Playwright APIs Tapsmith does not implement (yet).
 *
 * Playwright users call these by reflex. Without a stand-in the call fails as
 * "import_tapsmith.test.step is not a function" — a bundler-mangled TypeError
 * that names neither the API nor what to do instead. The stand-ins
 * are deliberately left off the TypeScript types, so the type checker still
 * reports the property as missing; they only make the runtime failure clear.
 * Each is replaced by the real API when it lands.
 */

/** Where the docs list these APIs; the anchor is the api-reference heading. */
const NOT_SUPPORTED_DOCS_URL = 'https://tapsmith.dev/reference/api/test-runner/#playwright-apis-not-supported-yet';

/** A function that throws "`api`() isn't supported in Tapsmith yet", plus `hint`. */
export function notSupportedYet(api: string, hint?: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `${api}() isn't supported in Tapsmith yet.${hint ? ` ${hint}` : ''} See ${NOT_SUPPORTED_DOCS_URL}`,
    );
  };
}

/**
 * Define non-enumerable stand-ins on `target`, so they never show up when
 * an object is spread, logged or iterated.
 */
export function defineStandIns(target: object, standIns: Record<string, (...args: unknown[]) => never>): void {
  for (const [name, value] of Object.entries(standIns)) {
    Object.defineProperty(target, name, { value, enumerable: false, configurable: true, writable: true });
  }
}

/** Playwright locator methods that exist in Tapsmith under another name. */
export function defineRenamedMethods(prototype: object, renames: Record<string, string>): void {
  const standIns: Record<string, (...args: unknown[]) => never> = {};
  for (const [method, replacement] of Object.entries(renames)) {
    standIns[method] = () => {
      throw new Error(`.${method}() isn't an ElementHandle method in Tapsmith: use .${replacement}() instead.`);
    };
  }
  defineStandIns(prototype, standIns);
}
