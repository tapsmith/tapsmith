// Builds trace archives for the viewer to open.
//
// The archive layout is the viewer's real input contract, read off
// `parseTraceZip` in `src/trace-viewer/main.tsx`:
//
//   metadata.json    TraceMetadata — required; without it the viewer errors
//   trace.json       NDJSON of trace events
//   screenshots/*.png
//   hierarchy/*.xml
//   sources.json     { [rootDir-relative path]: fileContents }  (absolute in format v1)
//   network.json     NDJSON of NetworkEntry
//   network/*        request/response bodies, referenced by path from an entry
//
// Zipped with the same library the product uses, and the payload types come from
// the SDK's own `trace/types.ts`, so a shape that drifts fails typecheck here.

import { zipSync, strToU8 } from "fflate"
import type {
  AnyTraceEvent,
  ActionTraceEvent,
  AssertionTraceEvent,
  ConsoleTraceEvent,
  NetworkEntry,
  SourceLocation,
  TraceMetadata,
} from "../trace-types.js"

export interface TraceSpec {
  metadata?: Partial<TraceMetadata>
  events?: AnyTraceEvent[]
  /** Keyed by archive path, e.g. `screenshots/action-000-before.png`. */
  screenshots?: Record<string, Uint8Array>
  /** Keyed by archive path, e.g. `hierarchy/action-000-before.xml`. */
  hierarchies?: Record<string, string>
  /** Keyed by the same path the events' stack frames carry (rootDir-relative since format v2). */
  sources?: Record<string, string>
  network?: NetworkEntry[]
  /** Keyed by archive path, e.g. `network/res-0.bin`. Accepts bytes so binary
   * payloads (gRPC/protobuf) can be exercised, which a string cannot express —
   * the viewer keeps bodies as bytes precisely because a UTF-8 round-trip
   * destroys them. */
  networkBodies?: Record<string, string | Uint8Array>
  /** Omit metadata.json entirely, to exercise the viewer's error path. */
  omitMetadata?: boolean
}

const BASE_TIME = 1_700_000_000_000

export function defaultMetadata(): TraceMetadata {
  return {
    version: 2,
    tapsmithVersion: "0.5.0",
    testFile: "e2e/tests/gestures.test.ts",
    testName: "Gestures screen > double tap registers double tap gesture",
    testStatus: "passed",
    testDuration: 1200,
    startTime: BASE_TIME,
    endTime: BASE_TIME + 1200,
    device: {
      serial: "emulator-5554",
      model: "sdk_gphone64_arm64",
      osVersion: "16",
      screenResolution: { width: 1080, height: 2400 },
      isEmulator: true,
      packageName: "dev.tapsmith.testapp",
    },
    traceConfig: {
      screenshots: true,
      snapshots: true,
      sources: true,
      network: true,
      deviceLogs: true,
      daemonLogs: false,
    },
    actionCount: 0,
    screenshotCount: 0,
  }
}

/** Build a trace archive as bytes, ready to fulfil the viewer's fetch. */
export function buildTrace(spec: TraceSpec = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {}

  const events = spec.events ?? []
  if (!spec.omitMetadata) {
    const metadata: TraceMetadata = {
      ...defaultMetadata(),
      actionCount: events.filter((e) => e.type === "action").length,
      screenshotCount: Object.keys(spec.screenshots ?? {}).length,
      ...spec.metadata,
    }
    files["metadata.json"] = strToU8(JSON.stringify(metadata))
  }

  // Written even when empty, so a spec can tell "an archive with no events"
  // apart from "an archive missing trace.json".
  if (spec.events) {
    files["trace.json"] = strToU8(events.map((e) => JSON.stringify(e)).join("\n"))
  }

  for (const [name, bytes] of Object.entries(spec.screenshots ?? {})) {
    files[name] = bytes
  }
  for (const [name, xml] of Object.entries(spec.hierarchies ?? {})) {
    files[name] = strToU8(xml)
  }
  if (spec.sources) {
    files["sources.json"] = strToU8(JSON.stringify(spec.sources))
  }
  if (spec.network?.length) {
    files["network.json"] = strToU8(spec.network.map((e) => JSON.stringify(e)).join("\n") + "\n")
  }
  for (const [name, body] of Object.entries(spec.networkBodies ?? {})) {
    files[name] = typeof body === "string" ? strToU8(body) : body
  }

  return zipSync(files)
}

// ─── Event builders ───

interface ActionOptions {
  actionIndex: number
  action: string
  category?: ActionTraceEvent["category"]
  selector?: string
  duration?: number
  success?: boolean
  error?: string
  screenshots?: { before?: boolean; after?: boolean }
  hierarchies?: { before?: boolean; after?: boolean }
  /**
   * Where in the test this came from. The Source tab resolves which file to show
   * from the event's stack, so without this it has nothing to display even when
   * `sources.json` is present.
   */
  sourceLocation?: SourceLocation
  /** Full call stack, innermost frame first. `sourceLocation` is `stack[0]`. */
  stack?: SourceLocation[]
  /** Group name of the device that acted (multi-device traces). */
  deviceId?: string
}

export function actionEvent(o: ActionOptions): ActionTraceEvent {
  return {
    type: "action",
    deviceId: o.deviceId,
    category: o.category ?? "tap",
    action: o.action,
    selector: o.selector,
    actionIndex: o.actionIndex,
    timestamp: BASE_TIME + o.actionIndex * 100,
    duration: o.duration ?? 40,
    success: o.success ?? true,
    error: o.error,
    hasScreenshotBefore: !!o.screenshots?.before,
    hasScreenshotAfter: !!o.screenshots?.after,
    hasHierarchyBefore: !!o.hierarchies?.before,
    hasHierarchyAfter: !!o.hierarchies?.after,
    sourceLocation: o.sourceLocation ?? o.stack?.[0],
    stack: o.stack,
  }
}

export function assertionEvent(o: {
  actionIndex: number
  assertion: string
  selector?: string
  passed?: boolean
  error?: string
  expected?: string
  actual?: string
  soft?: boolean
  negated?: boolean
  sourceLocation?: SourceLocation
  stack?: SourceLocation[]
  /** Group name of the device that was asserted on (multi-device traces). */
  deviceId?: string
  /** Assertions capture a before-hierarchy (and screenshot) like actions do. */
  screenshots?: { before?: boolean; after?: boolean }
  hierarchies?: { before?: boolean; after?: boolean }
}): AssertionTraceEvent {
  return {
    type: "assertion",
    deviceId: o.deviceId,
    assertion: o.assertion,
    selector: o.selector,
    actionIndex: o.actionIndex,
    timestamp: BASE_TIME + o.actionIndex * 100,
    duration: 20,
    attempts: 1,
    passed: o.passed ?? true,
    soft: o.soft ?? false,
    negated: o.negated ?? false,
    error: o.error,
    expected: o.expected,
    actual: o.actual,
    sourceLocation: o.sourceLocation ?? o.stack?.[0],
    stack: o.stack,
    hasScreenshotBefore: !!o.screenshots?.before,
    hasScreenshotAfter: !!o.screenshots?.after,
    hasHierarchyBefore: !!o.hierarchies?.before,
    hasHierarchyAfter: !!o.hierarchies?.after,
  }
}

export function consoleEvent(o: {
  actionIndex: number
  level: ConsoleTraceEvent["level"]
  message: string
  source?: ConsoleTraceEvent["source"]
  /** Offset from the trace's start time in ms. Defaults to 100ms per action index. */
  offsetMs?: number
  /** Group name of the device that logged the line (multi-device traces). */
  deviceId?: string
}): ConsoleTraceEvent {
  return {
    type: "console",
    deviceId: o.deviceId,
    level: o.level,
    message: o.message,
    source: o.source ?? "device",
    actionIndex: o.actionIndex,
    timestamp: BASE_TIME + (o.offsetMs ?? o.actionIndex * 100),
  }
}

export function networkEntry(o: {
  index: number
  actionIndex?: number
  method?: string
  url: string
  status?: number
  contentType?: string
  duration?: number
  responseBodyPath?: string
  requestBodyPath?: string
  routeAction?: NetworkEntry["routeAction"]
  responseSize?: number
  /** Group name of the device whose proxy captured the request (multi-device traces). */
  deviceId?: string
}): NetworkEntry {
  const start = BASE_TIME + o.index * 50
  const duration = o.duration ?? 35
  return {
    index: o.index,
    deviceId: o.deviceId,
    actionIndex: o.actionIndex ?? 0,
    startTime: start,
    endTime: start + duration,
    method: o.method ?? "GET",
    url: o.url,
    status: o.status ?? 200,
    contentType: o.contentType ?? "application/json",
    requestSize: 0,
    responseSize: o.responseSize ?? 128,
    duration,
    requestBodyPath: o.requestBodyPath,
    responseBodyPath: o.responseBodyPath,
    requestHeaders: { accept: "application/json" },
    responseHeaders: { "content-type": o.contentType ?? "application/json" },
    routeAction: o.routeAction,
  }
}

/** Escape a value for an XML double-quoted attribute. */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** A minimal UIAutomator-style hierarchy, which `parseHierarchyXml` accepts. */
export function hierarchyXml(
  nodes: Array<{ class: string; text?: string; desc?: string; id?: string; bounds: string }>,
): string {
  // Attribute values are escaped: an unescaped quote in fixture text (`Say "hi"`)
  // silently produces malformed XML, and the spec would then exercise a tree
  // other than the one it describes.
  const children = nodes
    .map(
      (n) =>
        `<node index="0" text="${xmlAttr(n.text ?? "")}" resource-id="${xmlAttr(n.id ?? "")}" ` +
        `class="${xmlAttr(n.class)}" package="dev.tapsmith.testapp" ` +
        `content-desc="${xmlAttr(n.desc ?? "")}" checkable="false" checked="false" ` +
        `clickable="true" enabled="true" focusable="true" focused="false" ` +
        `scrollable="false" long-clickable="false" password="false" ` +
        `selected="false" bounds="${n.bounds}" />`,
    )
    .join("")
  return (
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>` +
    `<hierarchy rotation="0">` +
    `<node index="0" text="" resource-id="" class="android.widget.FrameLayout" ` +
    `package="dev.tapsmith.testapp" content-desc="" checkable="false" checked="false" ` +
    `clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" ` +
    `long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">` +
    children +
    `</node></hierarchy>`
  )
}
