// The Network tab: the captured request list, its filters, and the per-request
// detail pane. Shared with UI mode.

import { test, expect } from "../fixtures.js"
import { actionEvent, networkEntry, type TraceSpec } from "../trace-builder.js"
import type { ViewerHarness } from "../fixtures.js"

const RESPONSE_BODY = JSON.stringify(
  { items: [{ id: 1, title: "Buy milk" }], total: 1 },
  null,
  2,
)

// ─── gRPC body builders ───
// Built here rather than captured: real Firestore bodies carry account data,
// and a hand-built message states exactly which wire-format shape is under test.

function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  do {
    const byte = v & 0x7f
    v >>>= 7
    out.push(v > 0 ? byte | 0x80 : byte)
  } while (v > 0)
  return out
}

/** A length-delimited (wire type 2) string field. */
function protoString(fieldNumber: number, text: string): number[] {
  const payload = Array.from(new TextEncoder().encode(text))
  return [(fieldNumber << 3) | 2, ...varint(payload.length), ...payload]
}

/** A length-delimited field wrapping a nested message. */
function protoNested(fieldNumber: number, inner: number[]): number[] {
  return [(fieldNumber << 3) | 2, ...varint(inner.length), ...inner]
}

/** A varint (wire type 0) field. */
function protoVarint(fieldNumber: number, value: number): number[] {
  return [(fieldNumber << 3) | 0, ...varint(value)]
}

/** Wrap a message in gRPC framing: `[flag][4-byte big-endian length][message]`. */
function grpcFrame(message: number[]): number[] {
  const len = message.length
  return [0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...message]
}

/**
 * A Firestore ListenRequest with the shape real traffic has: `database`, then
 * `add_target` → `documents` → the document path. Built to match the schema so
 * the test exercises the naming layer, not just the wire decode.
 */
const LISTEN_REQUEST = new Uint8Array(
  grpcFrame([
    ...protoString(1, "projects/demo/databases/(default)"),
    ...protoNested(2, [
      ...protoNested(
        3,
        protoString(2, "projects/demo/databases/(default)/documents/users/u1"),
      ),
      ...protoVarint(5, 2),
    ]),
  ]),
)

const ENTRIES = [
  networkEntry({ index: 0, url: "https://api.acme.dev/v1/items", status: 200 }),
  networkEntry({
    index: 1,
    method: "POST",
    url: "https://api.acme.dev/v1/items",
    status: 201,
    duration: 120,
  }),
  networkEntry({
    index: 2,
    url: "https://api.acme.dev/v1/missing",
    status: 404,
    contentType: "text/plain",
  }),
  networkEntry({
    index: 3,
    url: "https://cdn.acme.dev/logo.png",
    status: 200,
    contentType: "image/png",
    responseSize: 20_480,
  }),
]

async function openWithNetwork(viewer: ViewerHarness, extra: TraceSpec = {}) {
  await viewer.open({
    events: [actionEvent({ actionIndex: 0, action: "tap" })],
    network: ENTRIES,
    ...extra,
  })
}

test.describe("Network tab", () => {
  test("counts captured requests on the tab", async ({ viewer, detailTabs }) => {
    await openWithNetwork(viewer)
    await expect(detailTabs.tab("Network")).toHaveAccessibleName("Network 4")
  })

  test("lists every captured request", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")

    await expect(network.rows).toHaveCount(4)
    await expect(network.row("logo.png")).toBeVisible()
  })

  test("shows method, status and duration per row", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")

    const row = network.row("items").nth(1)
    await expect(row).toContainText("POST")
    await expect(row).toContainText("201")
    // The fixture sets 120ms on this entry; asserting it is the difference
    // between checking the column exists and checking it carries the value.
    await expect(row).toContainText("120 ms")
  })

  test("lists requests chronologically by default", async ({ viewer, detailTabs, network }) => {
    // Durations chosen so a duration sort (the old default) would order these
    // second, fourth, third, first; the archive order is scrambled too, so only
    // the start time can explain a first-to-fourth listing.
    const first = networkEntry({ index: 0, url: "https://api.acme.dev/first", duration: 300 })
    const second = networkEntry({ index: 1, url: "https://api.acme.dev/second", duration: 10 })
    const third = networkEntry({ index: 2, url: "https://api.acme.dev/third", duration: 200 })
    const fourth = networkEntry({ index: 3, url: "https://api.acme.dev/fourth", duration: 50 })
    await viewer.open({
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
      network: [third, first, fourth, second],
    })
    await detailTabs.select("Network")

    // The Name cell renders the path segment followed by the domain.
    const names = await network.rows.evaluateAll((rows) =>
      rows.map((r) => r.querySelector("td")?.textContent ?? ""),
    )
    expect(names.map((n) => n.replace("api.acme.dev", ""))).toEqual(["first", "second", "third", "fourth"])
  })

  test("sorts when a column header is clicked", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")
    await expect(network.columnHeaders.first()).toHaveText(/Name/)

    // Capture order, sort by status, and check it actually changed — the header
    // rendering alone says nothing about whether clicking it does anything.
    const before = await network.rows.evaluateAll((rows) =>
      rows.map((r) => r.textContent ?? ""),
    )
    await network.columnHeaders.filter({ hasText: "Status" }).click()
    const after = await network.rows.evaluateAll((rows) =>
      rows.map((r) => r.textContent ?? ""),
    )

    expect(after).not.toEqual(before)
    expect([...after].sort()).toEqual([...before].sort())
  })

  test.describe("filtering", () => {
    test("narrows by URL", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("logo")
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("logo.png")
    })

    test("narrows by method", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("POST")
      await expect(network.rows).toHaveCount(1)
    })

    test("restores every row when cleared", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("logo")
      await expect(network.rows).toHaveCount(1)
      await network.filter("")
      await expect(network.rows).toHaveCount(4)
    })

    test("reports which type filter is active", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      // "All" starts on; picking Img narrows to the one PNG.
      await expect(network.pill("All")).toHaveAttribute("aria-pressed", "true")
      await network.pill("Img").click()
      await expect(network.pill("Img")).toHaveAttribute("aria-pressed", "true")
      await expect(network.pill("All")).toHaveAttribute("aria-pressed", "false")
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("logo.png")
    })

    test("filters to failed requests", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.pill("4xx").click()
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("missing")
    })
  })

  test.describe("request detail", () => {
    test("opens on a row click and closes again", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.selectRow("logo.png")
      await expect(network.detailBody).toBeVisible()

      await network.detailClose.click()
      await expect(network.detailBody).toHaveCount(0)
    })

    test("shows request and response headers", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")
      await network.selectRow("missing")

      await network.openDetailTab("Headers")
      await expect(network.detailBody).toContainText("content-type")
    })

    test("shows the captured response body", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            responseBodyPath: "network/res-0.bin",
          }),
        ],
        networkBodies: { "network/res-0.bin": RESPONSE_BODY },
      })
      await detailTabs.select("Network")
      await network.selectRow("items")
      await network.openDetailTab("Response")

      await expect(network.detailBody).toContainText("Buy milk")
    })

    test("shows the captured request payload", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            method: "POST",
            url: "https://api.acme.dev/v1/items",
            requestBodyPath: "network/req-0.bin",
          }),
        ],
        networkBodies: { "network/req-0.bin": '{"title":"Buy milk"}' },
      })
      await detailTabs.select("Network")
      await network.selectRow("items")
      await network.openDetailTab("Payload")

      await expect(network.detailBody).toContainText("Buy milk")
    })

    test("shows timing for the request", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")
      await network.selectRow("logo.png")
      await network.openDetailTab("Timing")

      // The fixture's own duration, not a bare /ms/ — which nearly any content
      // in this pane would satisfy.
      await expect(network.detailBody).toContainText("35 ms")
    })
  })

  test.describe("route actions", () => {
    test("badges a mocked response", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            routeAction: "mocked",
          }),
        ],
      })
      await detailTabs.select("Network")
      // A mocked response looks like a real 200 without this cue.
      await expect(network.row("items")).toContainText(/mock/i)
    })

    test("shows an aborted request as ABORTED rather than a status", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            status: 0,
            routeAction: "aborted",
          }),
        ],
      })
      await detailTabs.select("Network")
      await expect(network.row("items")).toContainText("ABORTED")
    })
  })

  test("says so when no requests were captured", async ({ viewer, detailTabs }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.select("Network")
    await expect(detailTabs.noContent).toBeVisible()
  })

  // ─── gRPC / protobuf bodies (PILOT-279 follow-on) ───
  // These bodies are binary, so they exercise the one path a string-valued body
  // map could not: the viewer keeps raw bytes and decodes at render time.
  test.describe("gRPC and protobuf bodies", () => {
    const grpcEntry = () =>
      networkEntry({
        index: 0,
        method: "POST",
        url: "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen",
        status: 200,
        contentType: "application/grpc",
        requestBodyPath: "network/req-0.bin",
      })

    test("decodes a gRPC body into readable protobuf fields", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [grpcEntry()],
        networkBodies: { "network/req-0.bin": LISTEN_REQUEST },
      })
      await detailTabs.select("Network")
      await network.selectRow("Listen")
      await network.openDetailTab("Payload")

      // The decoder's verdict, including the message type it recognised.
      await expect(network.bodyInfo).toContainText("gRPC")
      await expect(network.bodyInfo).toContainText("ListenRequest")
      // Strings inside the protobuf are readable...
      await expect(network.detailBody).toContainText(
        "projects/demo/databases/(default)/documents/users/u1",
      )
      // ...and fields carry their schema names rather than numbers.
      await expect(network.detailBody).toContainText("database:")
      await expect(network.detailBody).toContainText("target_id: 2")
    })

    test("marks an open stream and decodes messages before a partial frame", async ({ viewer, detailTabs, network }) => {
      const response = new Uint8Array([
        ...grpcFrame(protoNested(2, protoVarint(1, 1))),
        0, 0, 0, 0, 4, 0x12,
      ])
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [{ ...grpcEntry(), inFlight: true, duration: 120, responseBodyPath: "network/res-0.bin" }],
        networkBodies: { "network/req-0.bin": LISTEN_REQUEST, "network/res-0.bin": response },
      })
      await detailTabs.select("Network")
      await expect(network.rows).toHaveCount(1)
      await expect(network.row("Listen")).toContainText("Streaming")
      await expect(network.row("Listen")).toContainText("120 ms so far")
      await expect(network.row("Listen").getByText("Listen", { exact: true })).toBeInViewport()
      await expect(network.row("Listen").getByText("Streaming", { exact: true })).toBeInViewport()
      await network.selectRow("Listen")
      await network.openDetailTab("Response")
      await expect(network.detailBody).toContainText("still open at capture time")
      await expect(network.bodyInfo).toContainText("ListenResponse")
      await expect(network.detailBody).toContainText("target_change_type: ADD")
      await expect(network.detailBody).toContainText("truncated:")
      await expect(network.detailBody).toContainText("declares 4 bytes, 1 present")
      await network.openDetailTab("Timing")
      await expect(network.detailBody).toContainText("Snapshot taken")
      await expect(network.detailBody).not.toContainText("Finished")
      await network.openDetailTab("Payload")
      await expect(network.detailBody).toContainText("database:")
    })

    test("explains a streaming response with no DATA yet", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [{ ...grpcEntry(), inFlight: true }],
      })
      await detailTabs.select("Network")
      await network.selectRow("Listen")
      await network.openDetailTab("Response")
      await expect(network.detailBody).toContainText("No response body captured yet")
    })

    test("can switch between the decoded view and the raw bytes", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [grpcEntry()],
        networkBodies: { "network/req-0.bin": LISTEN_REQUEST },
      })
      await detailTabs.select("Network")
      await network.selectRow("Listen")
      await network.openDetailTab("Payload")

      await expect(network.decodeToggle).toBeVisible()
      await network.decodeToggle.click()

      // Raw view drops the decoded field names but keeps the readable text
      // that happens to be embedded in the bytes.
      await expect(network.bodyInfo).toContainText("grpc")
      await expect(network.detailBody).not.toContainText("database:")
      await expect(network.detailBody).toContainText("projects/demo")
    })

    test("does not offer a decoded view for a JSON body", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      // Guards the heuristic: JSON must keep its Pretty/Raw behaviour and never
      // be reported as protobuf.
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            responseBodyPath: "network/res-0.bin",
          }),
        ],
        networkBodies: { "network/res-0.bin": RESPONSE_BODY },
      })
      await detailTabs.select("Network")
      await network.selectRow("items")
      await network.openDetailTab("Response")

      await expect(network.bodyInfo).toContainText("json")
      await expect(network.detailBody).toContainText("Buy milk")
      // No decoder toggle at all — and the toggle that *is* here is the
      // pretty-printer, which confusingly also reads "Raw" once it is on.
      await expect(network.decodeToggle).toHaveCount(0)
      await expect(network.prettyToggle).toBeVisible()
    })
  })

  // PILOT-319: a trace captured through the host-wide system proxy holds other
  // apps' traffic and misses localhost — the tab must say so, not just list it.
  test.describe("capture route", () => {
    const iosSim = (networkCaptureRoute?: "ios-system-proxy" | "ios-network-extension") => ({
      device: {
        serial: "8C2F-SIM",
        platform: "ios" as const,
        isEmulator: true,
        ...(networkCaptureRoute ? { networkCaptureRoute } : {}),
      },
    })

    test("warns when capture went through the macOS system proxy", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer, { metadata: iosSim("ios-system-proxy") })
      await detailTabs.select("Network")

      await expect(network.hostWideNotice).toContainText("other apps on the Mac")
      await expect(network.hostWideNotice).toContainText("localhost")
      await expect(network.rows).toHaveCount(4)
    })

    test("warns on an empty system-proxy capture too", async ({ viewer, detailTabs, network }) => {
      await viewer.open({ network: [], metadata: iosSim("ios-system-proxy") })
      await detailTabs.select("Network")

      await expect(detailTabs.noContent).toContainText("No network requests captured")
      await expect(network.hostWideNotice).toBeVisible()
    })

    for (const route of ["ios-network-extension", undefined] as const) {
      test(`shows no warning for an isolated or unrecorded route (${route ?? "none"})`, async ({ viewer, detailTabs, network }) => {
        await openWithNetwork(viewer, { metadata: iosSim(route) })
        await detailTabs.select("Network")

        await expect(network.rows).toHaveCount(4)
        await expect(network.hostWideNotice).toHaveCount(0)
      })
    }
  })
})

for (const enabled of [true, false]) {
  test(`empty trace network hint reflects capture config (${enabled})`, async ({ viewer, detailTabs, page }) => {
    await viewer.open({
      network: [],
      metadata: { traceConfig: { screenshots: false, snapshots: false, sources: false, network: enabled, deviceLogs: false, daemonLogs: false } },
    })
    await detailTabs.select("Network")
    await expect(detailTabs.noContent).toContainText("No network requests captured")
    await expect(page.getByText("Enable network capture in your trace config to record HTTP requests.")).toHaveCount(enabled ? 0 : 1)
  })
}

for (const inFlight of [true, false]) {
  test(`distinguishes an inherited request's lifetime from this test (${inFlight ? 'open' : 'completed'})`, async ({ viewer, detailTabs, network, page }) => {
    const start = 1_700_000_000_000
    const observedStartTime = start + 42 * 60_000
    const inherited = {
      ...networkEntry({ index: 0, url: 'http://test/Listen', contentType: 'text/plain' }),
      startTime: start, observedStartTime, endTime: observedStartTime + 10_000,
      duration: 42 * 60_000 + 10_000, inFlight,
    }
    const fresh = {
      ...networkEntry({ index: 1, url: 'http://test/fresh', duration: 20_000 }),
      startTime: observedStartTime + 2000, endTime: observedStartTime + 22_000,
    }
    await viewer.open({ network: [inherited, fresh] })
    await detailTabs.select('Network')
    await expect(network.row('Listen')).toContainText('Started before this test')
    await expect(network.row('Listen')).toContainText('10.00 s')
    await expect(network.row('Listen').getByText('Started before this test', { exact: true })).toBeInViewport()
    await expect(network.row('fresh')).not.toContainText('Started before this test')
    await network.columnHeaders.filter({ hasText: /^Time/ }).click()
    await expect(network.rows.first()).toContainText('fresh')
    const inheritedBar = await network.row('Listen').locator('.net-waterfall-bar').boundingBox()
    const freshBar = await network.row('fresh').locator('.net-waterfall-bar').boundingBox()
    expect(inheritedBar!.width).toBeLessThan(freshBar!.width)
    await network.selectRow('Listen')
    await network.openDetailTab('Timing')
    await expect(network.detailBody).toContainText('Observed during this test')
    await expect(network.detailBody).toContainText(inFlight ? 'Stream age' : 'Total request duration')
    await expect(network.detailBody).toContainText('42 min 10 s')
    await expect(network.detailBody).toContainText(new Date(start).toISOString())
    await expect(network.detailBody).toContainText('bodies and byte counts are cumulative')
    await expect(page.getByText('Started before this test', { exact: true })).toBeInViewport()
  })
}
