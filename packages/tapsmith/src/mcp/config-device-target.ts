import { resolveDeviceStrategy, type TapsmithConfig } from '../config.js';

/**
 * The devices a config targets without pinning one, as `tapsmith test`
 * reads it: `simulator` on iOS, and on Android the AVD under
 * `deviceStrategy: 'avd-only'` (the default when `avd` is set).
 *
 * A headless MCP session with no `device` pin took whichever free device
 * its daemon listed first, so a config naming `simulator: 'iPhone 17'` drove
 * a booted iPhone 17 Pro — often another session's (PILOT-915).
 */
export interface ConfigDeviceTarget {
  /** How the config names the target, for messages: `simulator "iPhone 17"`. */
  readonly description: string
  /** What to do when none of the target's devices is running. */
  readonly startHint: string
  /** Whether the device with this serial is one the config targets. */
  accepts(serial: string): boolean
}

export interface ConfigDeviceTargetDeps {
  /** Booted simulators (`simctl list`); [] when simctl is unavailable. */
  listBootedSimulators(): Array<{ udid: string; name: string }>
  /** The AVD an emulator serial runs (`adb emu avd name`), if it can be read. */
  getRunningAvdName(serial: string): string | undefined
  /** Whether `name` is one Tapsmith gives its clones of `source`. */
  isTapsmithCloneOf(name: string, source: string): boolean
}

/**
 * Loaded on first use: `emulator.ts` and `ios-simulator.ts` run code at
 * import, which the MCP server must not pay (or mock) before a config asks.
 */
async function defaultDeps(): Promise<ConfigDeviceTargetDeps> {
  const [{ listBootedSimulators, isTapsmithCloneOf }, { getRunningAvdName }] = await Promise.all([
    import('../ios-simulator.js'),
    import('../emulator.js'),
  ]);
  return { listBootedSimulators, getRunningAvdName, isTapsmithCloneOf };
}

/**
 * The device target `config` names, or undefined when it leaves the choice
 * free (no `simulator`; Android under `prefer-connected`) — any device of the
 * platform will then do, as it does for the runner.
 *
 * A `device` pin is not considered here: callers honour a pin before asking.
 */
export async function configDeviceTarget(
  config: Pick<TapsmithConfig, 'platform' | 'simulator' | 'avd' | 'deviceStrategy'>,
  injected?: ConfigDeviceTargetDeps,
): Promise<ConfigDeviceTarget | undefined> {
  if (config.platform === 'ios') {
    const simulator = config.simulator;
    if (!simulator) return undefined;
    const deps = injected ?? await defaultDeps();
    // By name or UDID, as the runner adopts a booted one — and Tapsmith's
    // own clones of it, the simulators a parallel run of this config boots.
    const matching = new Set(
      deps.listBootedSimulators()
        .filter((s) => s.udid === simulator || s.name === simulator || deps.isTapsmithCloneOf(s.name, simulator))
        .map((s) => s.udid),
    );
    return {
      description: `simulator "${simulator}"`,
      startHint: `Boot it (\`xcrun simctl boot "${simulator}"\`, or run \`tapsmith test\` once, which boots it)`,
      accepts: (serial) => matching.has(serial),
    };
  }
  // A config that names no platform runs on Android.
  if (config.platform !== undefined && config.platform !== 'android') return undefined;
  if (resolveDeviceStrategy(config) !== 'avd-only' || !config.avd) return undefined;
  const avd = config.avd;
  const deps = injected ?? await defaultDeps();
  const avdOf = new Map<string, string | undefined>();
  return {
    description: `AVD "${avd}"${config.deviceStrategy === 'avd-only' ? ' (deviceStrategy "avd-only")' : ''}`,
    startHint: `Start it (\`emulator -avd ${avd}\`), set \`deviceStrategy: 'prefer-connected'\` to use any device`,
    accepts: (serial) => {
      if (!serial.startsWith('emulator-')) return false;
      if (!avdOf.has(serial)) avdOf.set(serial, deps.getRunningAvdName(serial));
      return avdOf.get(serial) === avd;
    },
  };
}

/**
 * Why no device was picked for a config target while others were visible:
 * the target, what is running instead, and the ways out.
 */
export function configTargetMissMessage(
  target: Pick<ConfigDeviceTarget, 'description' | 'startHint'>,
  platform: string | undefined,
  visible: readonly string[],
): string {
  const kind = platform ? `${platform} device` : 'device';
  return `No running ${kind} matches ${target.description} from your config. `
    + `Visible ${kind}s: ${visible.join(', ')}. `
    + `${target.startHint}, change it in your config, or pass one of those as \`device\`.`;
}
