/**
 * Runtime checks for the options objects locator actions take (PILOT-840).
 *
 * Tests usually run under tsx, which strips types without checking them, so
 * an option TypeScript would reject (`tap({ timout: 5000 })`, `tap(5000)`)
 * reaches the method anyway. Ignoring it is the worst outcome: the call waits
 * the device's default timeout and the test fails far from the mistake. These
 * checks make such a call throw at once, naming the method and what it accepts.
 */

// ─── Types ───

/** The per-call timeout every locator action and waiting reader accepts. */
export interface TimeoutOptions {
  /**
   * Maximum time in milliseconds for the whole call: the auto-wait for the
   * element and the action itself. Must be a positive number. Defaults to the
   * device timeout (the config's `timeout`, 30 s by default).
   */
  timeout?: number;
}

// ─── Checks ───

/**
 * Playwright action options with no Tapsmith equivalent. A key from this list
 * gets a message saying so, rather than reading as a typo.
 */
const PLAYWRIGHT_ONLY_OPTIONS = new Set([
  'animations', 'button', 'caret', 'clickCount', 'force', 'mask', 'maskColor', 'modifiers',
  'noWaitAfter', 'omitBackground', 'path', 'position', 'quality', 'sourcePosition', 'steps',
  'strict', 'style', 'targetPosition', 'trial',
]);

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `${JSON.stringify(value)} (a string)`;
  if (typeof value === 'number' || typeof value === 'boolean') return `${String(value)} (a ${typeof value})`;
  return `a ${typeof value}`;
}

/**
 * Check that `options` is undefined or a plain options object whose keys are
 * all in `allowed`, and return it. Keys set to `undefined` are ignored, so an
 * object built with a spread of optional fields passes.
 *
 * @param method - the call as the user wrote it, e.g. `tap()`, for the message.
 * @throws TypeError naming the bad argument and the options `method` accepts.
 */
export function checkOptions<T extends object>(
  method: string,
  options: T | undefined,
  allowed: readonly (keyof T & string)[],
): T | undefined {
  if (options === undefined) return undefined;
  const accepts = allowed.length > 0 ? `${method} accepts: ${allowed.join(', ')}.` : `${method} takes no options.`;
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    const example = (allowed as readonly string[]).includes('timeout') ? ' such as { timeout: 5000 }' : '';
    throw new TypeError(`${method}: expected an options object${example}, but got ${describeValue(options)}. ${accepts}`);
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || (allowed as readonly string[]).includes(key)) continue;
    throw new TypeError(
      PLAYWRIGHT_ONLY_OPTIONS.has(key)
        ? `${method}: option "${key}" is a Playwright option Tapsmith does not support. ${accepts}`
        : `${method}: unknown option "${key}". ${accepts}`,
    );
  }
  return options;
}

/**
 * The per-call `timeout` from an action's options, checked: undefined when
 * not given, else a positive, finite number of milliseconds.
 *
 * 0 is refused rather than given a meaning: in Playwright it means "no limit",
 * and a Tapsmith action cannot wait without one.
 *
 * @throws TypeError for any other value.
 */
export function checkTimeout(method: string, timeout: unknown): number | undefined {
  if (timeout === undefined) return undefined;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    const hint = timeout === 0
      ? ' In Playwright 0 means no limit; Tapsmith needs one, so pass a long timeout instead (e.g. { timeout: 120_000 }).'
      : '';
    throw new TypeError(
      `${method}: timeout must be a positive number of milliseconds, but got ${describeValue(timeout)}.${hint}`,
    );
  }
  return timeout;
}
