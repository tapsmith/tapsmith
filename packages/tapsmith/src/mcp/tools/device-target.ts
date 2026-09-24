import { resolveDeviceTarget, type RequestedProject } from '../connection.js';
import type { TapsmithGrpcClient } from '../../grpc-client.js';
import type { TestDispatcher } from '../test-dispatcher.js';

/**
 * How a device tool says which device it means.
 *
 * `project` is the one a caller can actually know: it is what `run_tests`
 * takes, it is stable across sessions, and it names a platform, which names a
 * device. `device` stays for the cases a project cannot express — two Android
 * emulators, or a device the session is not running tests on.
 */
export interface DeviceRequest {
  device?: string
  project?: string
}

export const DEVICE_ARG_DESCRIPTION =
  'Serial of a device this session drives (see tapsmith_session_info), or the group name '
  + '(e.g. "alice") of a device in a `use.devices` project. Never required: '
  + 'a session on one platform acts on its primary device (worker 0 in UI mode), and a '
  + 'session spanning platforms takes `project`. Pass this only to single out one worker '
  + 'of a parallel run. A device the session merely *sees* cannot be acted on: its daemon '
  + 'is pointed elsewhere, and moving it would leave the agent attached to the previous device.';

export const PROJECT_ARG_DESCRIPTION =
  'Project whose device this should act on (same names as tapsmith_run_tests). '
  + 'Required only when the session drives devices on more than one platform, unless '
  + '`device` is given; it selects that project\'s primary device.';

/** The client for a tool's requested device, with the daemon pointed at it. */
export async function deviceClientFor(
  request: DeviceRequest,
  dispatcher?: TestDispatcher,
): Promise<TapsmithGrpcClient> {
  // Before anything asks what this session drives, not just on the `project`
  // branch. A multi-platform session spawns its per-platform daemons during
  // initialization; a device tool arriving first would otherwise see only the
  // one daemon discovery started, count a single target, and answer from
  // whichever device happened to be Active — silently, because the ambiguity
  // guard never fires on a session that does not yet know it has two devices.
  //
  // Devices only: waiting for the test tree as well would make the first device
  // tool of a session pay for a discovery child per test file.
  if (dispatcher?.ensureDevicesReady) await dispatcher.ensureDevicesReady({ retryFailedTargets: true, project: request.project });
  else await dispatcher?.ensureInitialized?.();
  // A config that failed to load gives the session no projects and no
  // targets. Unless the caller named a device outright, say that, rather than
  // an "unknown project" or a daemon nothing prepared (no device, no agent).
  const configError = sessionConfigErrorOf(dispatcher);
  if (configError && !request.device) {
    throw new Error(
      `The Tapsmith config could not be loaded, so this session has no device to use: ${configError} `
      + 'Fix the config, or pass `device` to use one directly.',
    );
  }
  // Nothing named and no target resolved: say why, rather than hand the call
  // to a pool daemon no target prepared (no device selected, no agent).
  if (!request.device && !request.project) {
    const targets = sessionTargetsOf(dispatcher);
    if (targets.length > 0 && targets.every((t) => t.error && !t.device)) {
      throw new Error(`No device is available to this session: ${targets.map((t) => (t.platform ? `${t.platform}: ${t.error}` : t.error)).join('; ')}`);
    }
  }
  const project = request.project
    ? await resolveProject(request.project, dispatcher)
    : undefined;
  // `resolveDeviceTarget` points the daemon and records that it did — both
  // matter, and doing the pointing here left the pool's own account of itself
  // stale for every call that followed.
  // A group name (`alice`) names a device the way its tests do; resolve it to
  // the serial the connection pool knows — within the requested project's
  // group when one is named, since `device` wins over `project` below.
  const device = request.device
    ? dispatcher?.resolveDeviceName(request.device, request.project) ?? request.device
    : undefined;

  try {
    const { client } = await resolveDeviceTarget({ device, project });
    return client;
  } catch (err) {
    throw withGroupNames(err, request.device, dispatcher);
  }
}

/**
 * The one serial a group name resolves to, from every (project, serial) pair
 * that answered to it. Several pairs may name the same serial (a UI worker
 * and the CLI's primary, say) — that is one device. Two different serials
 * are an ambiguity the caller has to settle with `project`.
 *
 * @internal — shared by both MCP dispatchers; exported for unit testing.
 */
export function pickResolvedDeviceName(
  name: string,
  matches: Array<{ project: string | undefined; serial: string }>,
): string | undefined {
  const serials = [...new Set(matches.map((m) => m.serial))];
  if (serials.length <= 1) return serials[0];
  const projects = [...new Set(matches.map((m) => m.project).filter((p): p is string => p !== undefined))];
  throw new Error(
    `Device name "${name}" belongs to more than one project's group`
    + `${projects.length > 0 ? ` (${projects.join(', ')})` : ''}. Pass \`project\` to say which one you mean.`,
  );
}

/**
 * An unknown `device` is answered with the group names the session accepts,
 * not just its serials. The pool lists what it can see — serials — but a
 * caller who wrote `alice` and got `Available devices: emulator-5554, …`
 * could not tell that `alice` was a typo rather than the wrong kind of name.
 *
 * @internal — exported for unit testing.
 */
export function withGroupNames(err: unknown, requested: string | undefined, dispatcher?: TestDispatcher): unknown {
  if (!(err instanceof Error) || requested === undefined || !/\bnot found\b/.test(err.message)) return err;
  const names = groupNamesOf(dispatcher);
  if (names.length === 0) return err;
  return new Error(`${err.message}. Group names: ${names.join(', ')}`);
}

/** The session's config load error, when a config file exists but failed to load. */
function sessionConfigErrorOf(dispatcher?: TestDispatcher): string | undefined {
  if (!dispatcher) return undefined;
  try {
    return dispatcher.getSessionInfo().configError;
  } catch {
    return undefined;
  }
}

/** The session's device targets as its dispatcher reports them (none without one). */
function sessionTargetsOf(dispatcher?: TestDispatcher): Array<{ platform?: string; device?: string; error?: string }> {
  if (!dispatcher) return [];
  try {
    return dispatcher.getSessionInfo().deviceTargets ?? [];
  } catch {
    return [];
  }
}

/** Group member names the session's device tools accept, in target order. */
function groupNamesOf(dispatcher?: TestDispatcher): string[] {
  if (!dispatcher) return [];
  let targets: Array<{ name?: string }> = [];
  try {
    targets = dispatcher.getSessionInfo().deviceTargets ?? [];
  } catch {
    return [];
  }
  return [...new Set(targets.map((t) => t.name).filter((n): n is string => Boolean(n)))];
}

async function resolveProject(
  name: string,
  dispatcher?: TestDispatcher,
): Promise<RequestedProject> {
  if (!dispatcher) {
    throw new Error('This session cannot resolve a project name. Pass `device` instead.');
  }
  const projects = dispatcher.getSessionInfo().projects;
  const match = projects.find((p) => p.name === name);
  if (!match) {
    const known = projects.map((p) => p.name).join(', ');
    throw new Error(
      `Unknown project "${name}". ${known ? `This config declares: ${known}.` : 'This config declares none.'}`,
    );
  }
  // The platform may legitimately be undefined — a project inherits it from a
  // root config that declares none — and that is a real answer, not a miss.
  return { name, platform: match.platform };
}
