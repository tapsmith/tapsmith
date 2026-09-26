/**
 * Video recording configuration (PILOT-114).
 *
 * Mirrors Playwright's `video` config option. Users supply either a mode
 * string shorthand (`'on'`, `'retain-on-failure'`, …) or an object with a
 * `mode` plus optional `size`. A trailing `resolveVideoConfig()` step
 * normalises both forms to the same internal `VideoConfig` shape.
 *
 * The mode set deliberately mirrors `TraceMode` so the same `shouldRecord` /
 * `shouldRetain` decision helpers from `../trace/trace-mode.ts` apply. The
 * trade-off — a small coupling between the trace and video modules — is
 * worth it because the rules are intentionally identical and any future
 * change ("on-second-retry"?) should land in one place.
 */

import { shouldRecord, shouldRetain } from '../trace/trace-mode.js';

/**
 * Recording mode. Seven modes total — the four listed in PILOT-114 plus three
 * extras (`on-all-retries`, `retain-on-first-failure`,
 * `retain-on-failure-and-retries`) that mirror the trace config for parity.
 * See `shouldRecord` / `shouldRetain` for exact semantics.
 */
export const VIDEO_MODES = [
  'off',
  'on',
  'on-first-retry',
  'on-all-retries',
  'retain-on-failure',
  'retain-on-first-failure',
  'retain-on-failure-and-retries',
] as const;

export type VideoMode = (typeof VIDEO_MODES)[number]

/** Output resolution. Honoured on Android only; iOS records at native res. */
export interface VideoSize {
  width: number
  height: number
}

export interface VideoConfig {
  mode: VideoMode
  /** Output resolution; Android-only in v1. iOS warns and ignores. */
  size?: VideoSize
}

/** Default config — recording off. */
const DEFAULT_VIDEO_CONFIG: VideoConfig = {
  mode: 'off',
};

/**
 * Normalise a user-supplied `video` field — mode shorthand, partial object,
 * or undefined — into a fully-populated `VideoConfig`.
 */
export function resolveVideoConfig(
  input: VideoMode | Partial<VideoConfig> | undefined | null,
): VideoConfig {
  // == null also catches explicit `video: null` from untyped .mjs configs.
  if (input == null) return { ...DEFAULT_VIDEO_CONFIG };
  // `|| 'off'`: an untyped config's '' or `{ mode: false }` means off (see resolveTraceConfig).
  if (typeof input === 'string') {
    return { ...DEFAULT_VIDEO_CONFIG, mode: input || 'off' };
  }
  return { ...DEFAULT_VIDEO_CONFIG, ...input, mode: input.mode || 'off' };
}

// Re-export the shared decision helpers under video-flavoured names so
// runner code can read naturally — `shouldRecordVideo(...)` reads better
// than `shouldRecord(...)` when sat next to the trace recording call.
export { shouldRecord as shouldRecordVideo, shouldRetain as shouldRetainVideo };
