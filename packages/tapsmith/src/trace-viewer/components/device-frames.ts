/**
 * Multi-device trace helpers.
 *
 * A trace recorded by a `use.devices` test holds one interleaved action list
 * for several devices. Screenshots and hierarchies are still keyed by the
 * shared action index, so "which frame shows device X at step N" is a lookup
 * over the events tagged with X's `deviceId`. Everything the viewer needs for
 * that lives here, shared by the standalone viewer and UI mode's live view.
 */

import type { ActionTraceEvent, AssertionTraceEvent, TraceDeviceInfo } from '../../trace/types.js';

/** The group a multi-device trace was recorded on, as the viewer sees it. */
export interface DeviceGroupView {
  /** `metadata.devices`, primary first, each with `name`, `platform`, `devicePixelRatio`. */
  devices: TraceDeviceInfo[]
  /** Every visible row, in display order. */
  actionEvents: (ActionTraceEvent | AssertionTraceEvent)[]
  /**
   * `metadata.actionCount` — the runner records one terminal screenshot per
   * device from this index on, in group order, so a device that never
   * captured after step N still has a final frame.
   */
  actionCount: number
  hierarchies: Map<string, string>
  /** Which pane is armed for picking / bound to the Locator tab; defaults to the selected event's device. */
  activeDevice?: string
  onActiveDeviceChange?: (deviceName: string) => void
}

export type FrameVariant = 'before' | 'after';

/** Zero-padded archive index, as screenshot and hierarchy paths spell it. */
export function padIndex(actionIndex: number): string {
  return String(actionIndex).padStart(3, '0');
}

/** Position of a device in the group (0 = primary), or -1 when unknown. */
export function deviceOrdinal(group: Pick<DeviceGroupView, 'devices'>, deviceName: string): number {
  return group.devices.findIndex((d) => d.name === deviceName);
}

/**
 * The device an event ran on. Events recorded without a `deviceId` (a
 * host-side row, an older trace) belong to the primary.
 */
export function actingDevice(
  group: Pick<DeviceGroupView, 'devices'>,
  event: { deviceId?: string } | undefined,
): string {
  const name = event?.deviceId;
  if (name && group.devices.some((d) => d.name === name)) return name;
  return group.devices[0]?.name ?? '';
}

/**
 * OKLCH hues that tell one device's tags from another's, by group position.
 * The primary keeps the accent hue; the rest are spaced so neighbours never
 * share a family. Every tag for a device — its filmstrip lane, its pill in the
 * actions list, its screenshot pane, the console and hierarchy filters — uses
 * the same hue, so the eye matches them without reading the name.
 */
const DEVICE_HUES = [57, 250, 150, 320, 200, 95];

/** The hue every tag for `deviceName` is tinted with; stable across runs. */
export function deviceHue(group: Pick<DeviceGroupView, 'devices'>, deviceName: string): number {
  return deviceHueAt(deviceOrdinal(group, deviceName));
}

/** The hue for a group position, for callers that hold device names in group order (see `deviceNamesFor`). */
export function deviceHueAt(ordinal: number): number {
  return DEVICE_HUES[Math.max(0, ordinal) % DEVICE_HUES.length];
}

/** Inline style for a device tag: `--device-h` feeds the tag's oklch colours in the stylesheet. */
export function deviceTagStyle(group: Pick<DeviceGroupView, 'devices'>, deviceName: string): Record<string, string> {
  return { '--device-h': String(deviceHue(group, deviceName)) };
}

/**
 * The shortest filmstrip that keeps every lane's thumbnails legible: the
 * stylesheet's fixed budget (summary line 18px + time axis 14px + 10px kept
 * for the horizontal scrollbar) plus, per lane, a 48px thumbnail and 4px of
 * padding. Mirrors the `.film-lanes` calc in both stylesheets.
 */
export function laneStripMinHeight(laneCount: number): number {
  return 42 + laneCount * 52;
}

/** Whether a trace was recorded on more than one device. */
export function isMultiDevice(metadata: { devices?: TraceDeviceInfo[] } | undefined): boolean {
  return !!metadata?.devices && metadata.devices.length > 1;
}

/**
 * The action index of a device's terminal screenshot — the frame the runner
 * captured after the last action, one per device in group order.
 */
export function terminalFrameIndex(group: Pick<DeviceGroupView, 'devices' | 'actionCount'>, deviceName: string): number {
  return group.actionCount + Math.max(0, deviceOrdinal(group, deviceName));
}

/** Events of one device, in display order. Untagged events count as the primary's. */
function eventsOf(group: DeviceGroupView, deviceName: string): (ActionTraceEvent | AssertionTraceEvent)[] {
  return group.actionEvents.filter((e) => actingDevice(group, e) === deviceName);
}

/**
 * The frame index whose *before* screenshot shows `deviceName`'s state right
 * after the selected event: the device's next capture past `selectedIndex`,
 * or its terminal screenshot when nothing followed.
 */
export function nextFrameIndexForDevice(group: DeviceGroupView, deviceName: string, selectedIndex: number): number {
  const next = eventsOf(group, deviceName).find((e) => e.actionIndex > selectedIndex);
  return next ? next.actionIndex : terminalFrameIndex(group, deviceName);
}

/**
 * The frame a device's pane shows for the selected event.
 *
 * - The acting device: `before` is its own before-screenshot at
 *   `selectedIndex`; `after` is its next capture (see `nextFrameIndexForDevice`).
 * - Any other device: `before` is its latest capture at or before the
 *   selected event; `after` is its next capture past it. A device that never
 *   captured before that point falls through to its next capture, then to its
 *   terminal screenshot, so a pane is only ever empty when the archive holds
 *   no frame for that device at all.
 */
export function frameIndexForDevice(
  group: DeviceGroupView,
  deviceName: string,
  selectedIndex: number,
  variant: FrameVariant,
): number {
  const selected = group.actionEvents.find((e) => e.actionIndex === selectedIndex);
  const isActing = selected ? actingDevice(group, selected) === deviceName : false;
  if (variant === 'after') return nextFrameIndexForDevice(group, deviceName, selectedIndex);
  if (isActing) return selectedIndex;
  const own = eventsOf(group, deviceName);
  let latest: number | undefined;
  for (const e of own) {
    if (e.actionIndex <= selectedIndex) latest = e.actionIndex;
    else break;
  }
  return latest ?? nextFrameIndexForDevice(group, deviceName, selectedIndex);
}

/**
 * The screenshot URL for a frame index, preferring the before-capture (the
 * runner records only those; `after` files exist in legacy traces).
 */
export function screenshotForFrame(screenshots: Map<string, string>, frameIndex: number): string | undefined {
  const pad = padIndex(frameIndex);
  return screenshots.get(`screenshots/action-${pad}-before.png`)
    ?? screenshots.get(`screenshots/action-${pad}-after.png`);
}

/**
 * The view hierarchy captured with a device's frame — the tree a pick on that
 * pane must hit-test, since it depicts the same moment as the displayed
 * screenshot.
 */
export function hierarchyForDeviceFrame(
  group: Pick<DeviceGroupView, 'hierarchies'>,
  frameIndex: number,
): string | undefined {
  const pad = padIndex(frameIndex);
  return group.hierarchies.get(`hierarchy/action-${pad}-before.xml`)
    ?? group.hierarchies.get(`hierarchy/action-${pad}-after.xml`);
}

/** Device names present in a trace's network entries, in group order first. */
export function deviceNamesFor(
  metadata: { devices?: TraceDeviceInfo[] } | undefined,
  entries: ReadonlyArray<{ deviceId?: string }>,
): string[] {
  const names: string[] = [];
  for (const d of metadata?.devices ?? []) if (d.name && !names.includes(d.name)) names.push(d.name);
  for (const e of entries) if (e.deviceId && !names.includes(e.deviceId)) names.push(e.deviceId);
  return names;
}
