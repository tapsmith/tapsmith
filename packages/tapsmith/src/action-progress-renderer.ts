/**
 * Renderers for the action-progress channel.
 *
 * `createActionProgressMessenger` holds the shared timing policy: a start
 * message only fires if the action is still running after `startDelayMs`
 * (so fast launches stay silent), heartbeats fire every `heartbeatMs` while
 * it keeps running, and an end message fires when it finishes — provided the
 * action was announced or turned out slow.
 *
 * `installActionProgressPrinter` adapts the messenger to a console:
 *   ⏳ Saving app state (com.example → state.tar.gz)…
 *   ⏳ Still saving app state (com.example → state.tar.gz)… (16s)
 *   ✓ Saved app state (com.example → state.tar.gz) (18.2s)
 * Lines go through `process.stdout.write`, which the list reporter's
 * interceptor wraps to keep its TTY live region intact.
 */

import type { ActionProgressEvent } from './action-progress.js';
import { ACTION_PROGRESS_LABELS, onActionProgress } from './action-progress.js';
import { dim, green, red, formatDuration } from './reporters/base.js';

// ─── Messenger (shared timing policy) ───

export type ActionProgressPhase = 'start' | 'heartbeat' | 'end';

export interface ActionProgressMessengerOptions {
  /** Suppress actions that finish faster than this. Default 3000ms. */
  startDelayMs?: number
  /** Interval between "still running" messages. 0 disables. Default 15000ms. */
  heartbeatMs?: number
  emit: (text: string, phase: ActionProgressPhase, ev: ActionProgressEvent) => void
}

interface PendingAction {
  ev: ActionProgressEvent
  startedAt: number
  announced: boolean
  startTimer?: NodeJS.Timeout
  heartbeatTimer?: NodeJS.Timeout
}

function withTarget(label: string, target: string | undefined): string {
  return target ? `${label} (${target})` : label;
}

/** Lowercase the leading word so labels compose into "Still saving app state…". */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Subscribe a threshold/heartbeat messenger to the action-progress channel.
 * Returns a dispose function that clears all timers and unsubscribes.
 */
export function createActionProgressMessenger(options: ActionProgressMessengerOptions): () => void {
  const startDelayMs = options.startDelayMs ?? 3_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pending = new Map<number, PendingAction>();

  const unsubscribe = onActionProgress((ev) => {
    const labels = ACTION_PROGRESS_LABELS[ev.action];

    if (ev.kind === 'start') {
      const entry: PendingAction = { ev, startedAt: Date.now(), announced: false };
      entry.startTimer = setTimeout(() => {
        entry.announced = true;
        options.emit(`⏳ ${withTarget(labels.active, ev.target)}…`, 'start', ev);
        if (heartbeatMs > 0) {
          entry.heartbeatTimer = setInterval(() => {
            const elapsed = Math.round((Date.now() - entry.startedAt) / 1000);
            options.emit(`⏳ Still ${withTarget(lowerFirst(labels.active), ev.target)}… (${elapsed}s)`, 'heartbeat', ev);
          }, heartbeatMs);
          entry.heartbeatTimer.unref?.();
        }
      }, startDelayMs);
      entry.startTimer.unref?.();
      pending.set(ev.id, entry);
      return;
    }

    const entry = pending.get(ev.id);
    if (entry) {
      clearTimeout(entry.startTimer);
      clearInterval(entry.heartbeatTimer);
      pending.delete(ev.id);
    }

    // Stay silent for fast actions that were never announced. The duration
    // check covers the race where the action was genuinely slow but the
    // start timer never fired (e.g. event-loop starvation during the RPC).
    const announced = entry?.announced ?? false;
    if (!announced && (ev.durationMs ?? 0) < startDelayMs) return;

    const duration = `(${formatDuration(ev.durationMs ?? 0)})`;
    // Sub-step attribution, when the action body supplied it (PILOT-350).
    const detail = ev.detail ? ` — ${ev.detail}` : '';
    if (ev.aborted) {
      options.emit(`– Stopped ${withTarget(lowerFirst(labels.active), ev.target)} ${duration}${detail}`, 'end', ev);
    } else if (ev.success) {
      options.emit(`✓ ${withTarget(labels.done, ev.target)} ${duration}${detail}`, 'end', ev);
    } else {
      const errorSuffix = ev.error ? `: ${ev.error}` : '';
      options.emit(`✗ ${withTarget(labels.failed, ev.target)} ${duration}${detail}${errorSuffix}`, 'end', ev);
    }
  });

  return () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.startTimer);
      clearInterval(entry.heartbeatTimer);
    }
    pending.clear();
    unsubscribe();
  };
}

// ─── Console printer ───

/**
 * Print progress lines for slow device actions to stdout. Returns a dispose
 * function. Writes intentionally go through `process.stdout.write` (not a
 * saved original) so the list reporter's live-region interceptor sees them.
 */
export function installActionProgressPrinter(): () => void {
  return createActionProgressMessenger({
    emit: (text, phase, ev) => {
      let line: string;
      if (phase === 'end' && ev.success && !ev.aborted) {
        // '✓ Saved app state …' — color just the icon, like test result rows.
        line = `  ${green('✓')}${text.slice(1)}`;
      } else if (phase === 'end' && !ev.success && !ev.aborted) {
        line = `  ${red('✗')}${text.slice(1)}`;
      } else {
        line = dim(`  ${text}`);
      }
      process.stdout.write(`${line}\n`);
    },
  });
}
