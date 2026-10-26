import type { Device } from "tapsmith"

/**
 * The `@tapsmith/react-native` hooks marker, read from the hierarchy dump the
 * way Tapsmith itself reads it. No locator matches the marker (PILOT-830), so
 * a test that checks the marker's own behaviour has to look at the dump.
 */
export interface HooksMarkerNode {
  /** The marker text: `tapsmith-hooks:1;epoch=…;nav=…;boot=…;url=…`. */
  text: string
  /** Its bounds in screen pixels (Android) or points (iOS). */
  bounds: { x: number; y: number; width: number; height: number }
}

function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

/** The hierarchy dump (internal gRPC client: the dump itself is what is read). */
export async function hierarchyXml(device: Device): Promise<string> {
  const client = (device as unknown as { _client: { getUiHierarchy(): Promise<{ hierarchyXml: string }> } })._client
  return (await client.getUiHierarchy()).hierarchyXml
}

/** The marker node in `xml` — the one carrying `testID="tapsmith-hooks"` — or undefined. */
export function findHooksMarker(xml: string): HooksMarkerNode | undefined {
  for (const [tag] of xml.matchAll(/<[^>]*"tapsmith-hooks:[^"]*"[^>]*>/g)) {
    if (!/(resource-id|identifier)="tapsmith-hooks"/.test(tag)) continue
    const text = /"(tapsmith-hooks:[^"]*)"/.exec(tag)![1]
    const b = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(tag)
    if (!b) continue
    const [left, top, right, bottom] = b.slice(1).map(Number)
    return { text: decode(text), bounds: { x: left, y: top, width: right - left, height: bottom - top } }
  }
  return undefined
}

/** The marker on screen now, or undefined if the app renders none. */
export async function readHooksMarker(device: Device): Promise<HooksMarkerNode | undefined> {
  return findHooksMarker(await hierarchyXml(device))
}

/**
 * The XML of each window in an Android dump: every top-level `<node>` (one
 * per window) with its whole subtree, in dump order.
 */
export function androidWindows(xml: string): string[] {
  const windows: string[] = []
  let depth = 0
  let start = -1
  for (const m of xml.matchAll(/<(\/?)node\b[^>]*?(\/?)>/g)) {
    if (m[1] === "/") {
      depth--
      if (depth === 0) windows.push(xml.slice(start, m.index! + m[0].length))
      continue
    }
    if (depth === 0) start = m.index!
    if (m[2] === "/") {
      if (depth === 0) windows.push(m[0])
    } else depth++
  }
  return windows
}
