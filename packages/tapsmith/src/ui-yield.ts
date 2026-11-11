/**
 * Hand-over of devices from a coding agent's headless MCP session to a
 * UI-mode session starting in the same project (PILOT-1164).
 *
 * `tapsmith mcp-server --prefer-ui` works in the project's UI session when
 * one is running and headless when none is. A headless spell that has used a
 * device holds its claim, so `tapsmith test --ui` started afterwards would
 * find that device taken by the very agent that is about to work in the new
 * session. Such a session marks its claims (`SessionIdentity.yieldsToUi`),
 * and a UI session asks it to let go before picking its own devices: a signal
 * to the session's root process, then a wait for the claims to go. A session
 * in the middle of a test run keeps its device, and the wait times out.
 */

import { currentSession, yieldingClaimsElsewhere, type DeviceClaim, type SessionIdentity } from './device-claims.js';
import { uiSessionMatchesProject, type UiSessionProject } from './mcp/ui-session.js';

/** What a UI session sends a yielding session's root process. */
export const YIELD_SIGNAL = 'SIGUSR2';

const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 150;

interface YieldOptions {
  log?: (line: string) => void
  /** How long to wait for the devices to be given up. */
  timeoutMs?: number
  /** Test seams. */
  platform?: NodeJS.Platform
  kill?: (pid: number, signal: NodeJS.Signals) => void
  claims?: () => DeviceClaim[]
  session?: SessionIdentity
}

/**
 * The claims a UI session starting for `project` asks to be given up: those of
 * yielding sessions started in the same project.
 *
 * @internal — exported for unit testing.
 */
export function claimsToYield(claims: readonly DeviceClaim[], project: UiSessionProject): DeviceClaim[] {
  return claims.filter((claim) => uiSessionMatchesProject(project, { cwd: claim.session.project }));
}

/**
 * Ask this project's yielding sessions to give their devices up, and wait
 * until they have (or `timeoutMs` passes). Returns the devices still held.
 */
export async function requestHeadlessYield(project: UiSessionProject, opts: YieldOptions = {}): Promise<string[]> {
  // No such signal on Windows: the device stays held, as it would without this.
  if ((opts.platform ?? process.platform) === 'win32') return [];
  const session = opts.session ?? currentSession();
  const read = opts.claims ?? (() => yieldingClaimsElsewhere(session));
  const wanted = claimsToYield(read(), project);
  if (wanted.length === 0) return [];

  const roots = new Map(wanted.map((claim) => [claim.session.id, claim.session]));
  const devices = (claims: readonly DeviceClaim[]): string[] => claims.map((c) => c.device).sort();
  opts.log?.(
    `A coding agent's headless Tapsmith session in this project holds ${devices(wanted).join(', ')}: `
    + 'asking it to hand over to this UI session.',
  );
  const kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
  for (const root of roots.values()) {
    try {
      kill(root.pid, YIELD_SIGNAL);
    } catch {
      // Gone since it was listed: its claims go with it.
    }
  }

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const left = claimsToYield(read(), project).filter((claim) => roots.has(claim.session.id));
    if (left.length === 0) return [];
    if (Date.now() >= deadline) {
      opts.log?.(`It kept ${devices(left).join(', ')} (a test run in progress there keeps its device until it ends).`);
      return devices(left);
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, POLL_MS); });
  }
}
