// The Network tab: the captured request list, its filters, and the per-request
// detail pane. Shared with UI mode.

import * as zlib from "node:zlib"
import { test, expect } from "../fixtures.js"
import { actionEvent, networkEntry, type TraceSpec } from "../trace-builder.js"
import type { ViewerHarness } from "../fixtures.js"
import type { DetailTabsPane } from "../../panes/detail-tabs.pane.js"
import type { NetworkPane } from "../../panes/network.pane.js"
import type { NetworkEntry } from "../../trace-types.js"
import { solidPng } from "../../png.js"

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

  // ─── Image bodies ───

  test.describe("image bodies", () => {
    const IMAGE = solidPng(20, 10, [0, 128, 255])

    /** A GET for an image, with its body at `network/res-0.bin`. */
    const imageEntry = (o: {
      contentType?: string
      responseHeaders?: Record<string, string>
      responseSize?: number
      inFlight?: boolean
    } = {}) => {
      const contentType = o.contentType ?? "image/png"
      const entry = networkEntry({
        index: 0,
        url: "https://cdn.acme.dev/avatar.png",
        contentType,
        responseBodyPath: "network/res-0.bin",
        responseSize: o.responseSize ?? IMAGE.length,
      })
      return {
        ...entry,
        inFlight: o.inFlight,
        responseHeaders: { "content-type": contentType, ...o.responseHeaders },
      }
    }

    async function openResponse(
      { viewer, detailTabs, network }: { viewer: ViewerHarness; detailTabs: DetailTabsPane; network: NetworkPane },
      entry: NetworkEntry,
      body: Uint8Array,
    ) {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [entry],
        networkBodies: { "network/res-0.bin": body },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar.png")
      await network.openDetailTab("Response")
    }

    /** The decoded pixel size — proves the browser decoded the bytes, which
     * `toBeVisible` alone does not (a broken image still has a box). */
    async function naturalSize(network: NetworkPane) {
      return network.imagePreview.evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])
    }

    test("renders an image response as a picture, with its dimensions", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry(), IMAGE)

      await expect(network.imagePreview).toBeVisible()
      expect(await naturalSize(network)).toEqual([20, 10])
      await expect(network.bodyInfo).toContainText("png")
      await expect(network.bodyInfo).toContainText("20 × 10")
      await expect(network.decodeToggle).toHaveCount(0)
    })

    test("can switch between the picture and the raw bytes", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry(), IMAGE)
      await expect(network.imagePreview).toBeVisible()

      await network.imageToggle.click()
      await expect(network.imagePreview).toHaveCount(0)
      // PNG's signature carries the ASCII "PNG" and the "IHDR" chunk name.
      await expect(network.detailBody).toContainText("IHDR")

      await network.imageToggle.click()
      await expect(network.imagePreview).toBeVisible()
    })

    test("previews a raster image served as SVG", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry({ contentType: "image/svg+xml" }), IMAGE)

      await expect(network.imagePreview).toBeVisible()
      expect(await naturalSize(network)).toEqual([20, 10])
      await expect(network.bodyInfo).toContainText("png")
    })

    test("recognises an image served with a generic content type", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry({ contentType: "application/octet-stream" }), IMAGE)

      await expect(network.imagePreview).toBeVisible()
      expect(await naturalSize(network)).toEqual([20, 10])
    })

    // The runner stores bodies already dechunked and decompressed, with the
    // wire headers and wire sizes left as they were — so these archives hold
    // the plain image next to headers that say otherwise, as real ones do.
    for (const encoding of ["gzip", "br"]) {
      test(`shows a ${encoding}-encoded image the runner has decompressed`, async ({ viewer, detailTabs, network }) => {
        const wire = encoding === "gzip" ? zlib.gzipSync(IMAGE) : zlib.brotliCompressSync(IMAGE)
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ responseHeaders: { "Content-Encoding": encoding }, responseSize: wire.length }),
          IMAGE,
        )

        await expect(network.imagePreview).toBeVisible()
        expect(await naturalSize(network)).toEqual([20, 10])
      })
    }

    test("shows a chunked image, whose wire size includes the chunk framing", async ({ viewer, detailTabs, network }) => {
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ responseHeaders: { "Transfer-Encoding": "chunked" }, responseSize: IMAGE.length + 12 }),
        IMAGE,
      )

      await expect(network.imagePreview).toBeVisible()
    })

    test("says why when a gzip body could not be decompressed", async ({ viewer, detailTabs, network }) => {
      // The runner keeps the original bytes when decompression fails.
      const wire = zlib.gzipSync(IMAGE)
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ responseHeaders: { "content-encoding": "gzip" }, responseSize: wire.length }),
        wire,
      )

      await expect(network.imageNote).toContainText("couldn't be decompressed")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("does not draw an image the capture cut short", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry({ responseSize: 3 * 1024 * 1024 }), IMAGE)

      await expect(network.imageNote).toContainText(`only ${IMAGE.length} B of this 3.0 MB image`)
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("does not draw a chunked image whose stream stopped on a chunk boundary", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      // Dechunked cleanly, wire size far under the capture cap — only the PNG
      // itself (no IEND chunk) says the tail is missing.
      const cut = IMAGE.subarray(0, IMAGE.length - 12)
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ responseHeaders: { "Transfer-Encoding": "chunked" }, responseSize: cut.length + 10 }),
        cut,
      )

      await expect(network.imageNote).toContainText("stops before its end")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("clips a large raw fallback until asked to show it all", async ({ viewer, detailTabs, network }) => {
      // A capture-capped image falls back to raw bytes; a megabyte of wrapped
      // text would freeze the pane, so only the start is rendered at first.
      const big = Buffer.alloc(300 * 1024, 0x41)
      IMAGE.copy(big)
      big.write("TAIL-MARKER", big.length - 11)
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ responseSize: 2 * 1024 * 1024 }),
        big,
      )

      await expect(network.imageNote).toContainText("only")
      await expect(network.bodyClipped).toContainText("Showing the first 64K of 300K characters")
      await expect(network.detailBody).not.toContainText("TAIL-MARKER")

      await network.showAllBody.click()
      await expect(network.detailBody).toContainText("TAIL-MARKER")
      await expect(network.bodyClipped).toHaveCount(0)
    })

    test("does not draw an image shorter than its Content-Length", async ({ viewer, detailTabs, network }) => {
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ responseHeaders: { "Content-Length": String(IMAGE.length * 4) } }),
        IMAGE,
      )

      await expect(network.imageNote).toContainText(`only ${IMAGE.length} B of this ${IMAGE.length * 4} B image`)
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("does not draw an image that was still downloading", async ({ viewer, detailTabs, network }) => {
      await openResponse({ viewer, detailTabs, network }, imageEntry({ inFlight: true }), IMAGE)

      await expect(network.imageNote).toContainText("still downloading")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("falls back to the raw bytes when the body is not really an image", async ({ viewer, detailTabs, network }) => {
      const notAnImage = new TextEncoder().encode("<html>Not found</html>")
      await openResponse({ viewer, detailTabs, network }, imageEntry({ responseSize: notAnImage.length }), notAnImage)

      await expect(network.imageNote).toContainText("couldn't display this body as png")
      await expect(network.detailBody).toContainText("Not found")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test.describe("SVG", () => {
      const svgEntry = () => imageEntry({ contentType: "image/svg+xml" })
      // The script would stamp the viewer's window if it ever ran.
      const SCRIPTED_SVG = new TextEncoder().encode(
        `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" onload="window.__svgRan = true">` +
          `<rect width="40" height="20" fill="#08f"/></svg>`,
      )

      test("draws an SVG as a PNG, so no SVG URL is left to open as a page", async ({
        page,
        viewer,
        detailTabs,
        network,
      }) => {
        await openResponse({ viewer, detailTabs, network }, svgEntry(), SCRIPTED_SVG)

        await expect(network.imagePreview).toBeVisible()
        await expect(network.bodyInfo).toContainText("40 × 20")
        // What "Open image in new tab" would open: a blob of PNG, not SVG.
        const shownType = await network.imagePreview.evaluate(async (img: HTMLImageElement) =>
          (await (await fetch(img.src)).blob()).type,
        )
        expect(shownType).toBe("image/png")
        expect(await page.evaluate(() => (window as { __svgRan?: boolean }).__svgRan)).toBeUndefined()
      })

      test("says so when an SVG can't be drawn, rather than showing nothing", async ({
        viewer,
        detailTabs,
        network,
      }) => {
        const broken = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect`)
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ contentType: "image/svg+xml", responseSize: broken.length }),
          broken,
        )

        await expect(network.imageNote).toContainText("couldn't display this body as svg")
        await expect(network.imagePreview).toHaveCount(0)
      })

      test("draws a sizeless SVG in a legacy encoding exactly as its UTF-8 twin", async ({
        viewer,
        detailTabs,
        network,
      }) => {
        // The sizeless path decodes and re-serialises the SVG; its text must
        // survive the declared encoding. (This catches a wrong decode. The
        // write-back declaration only matters to engines that honour it —
        // Chromium, which runs here, does not.)
        const svg = (encoding: string) =>
          `<?xml version="1.0" encoding="${encoding}"?>` +
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40">` +
          `<text x="4" y="28" font-size="24" font-family="sans-serif">café ñ</text></svg>`
        const latin1 = Buffer.from(svg("ISO-8859-1"), "latin1")
        const utf8 = Buffer.from(svg("UTF-8"), "utf8")
        const entry = (index: number, name: string, size: number) => ({
          ...networkEntry({
            index,
            url: `https://cdn.acme.dev/${name}`,
            contentType: "image/svg+xml",
            responseBodyPath: `network/res-${index}.bin`,
            responseSize: size,
          }),
          responseHeaders: { "content-type": "image/svg+xml" },
        })
        await viewer.open({
          events: [actionEvent({ actionIndex: 0, action: "tap" })],
          network: [entry(0, "latin1.svg", latin1.length), entry(1, "utf8.svg", utf8.length)],
          networkBodies: { "network/res-0.bin": latin1, "network/res-1.bin": utf8 },
        })
        await detailTabs.select("Network")
        const rasterOf = async (name: string) => {
          await network.selectRow(name)
          await network.openDetailTab("Response")
          await expect(network.imagePreview).toBeVisible()
          return network.imagePreview.evaluate(async (img: HTMLImageElement) => {
            // Compare pixels, not PNG bytes: the encoder may differ run to run.
            const bitmap = await createImageBitmap(await (await fetch(img.src)).blob())
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            const ctx = canvas.getContext("2d")!
            ctx.drawImage(bitmap, 0, 0)
            return Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data).join(",")
          })
        }

        expect(await rasterOf("latin1.svg")).toBe(await rasterOf("utf8.svg"))

        // The Raw view reads it in the same encoding.
        await network.selectRow("latin1.svg")
        await network.openDetailTab("Response")
        await network.imageToggle.click()
        await expect(network.detailBody).toContainText("café ñ")
      })

      test("reads an SVG it can't preview in its declared encoding", async ({ viewer, detailTabs, network }) => {
        const latin1 = Buffer.from(
          `<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>café</text></svg>`,
          "latin1",
        )
        // Cut short, so it falls back to text.
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ contentType: "image/svg+xml", responseSize: latin1.length * 2 }),
          latin1,
        )

        await expect(network.imageNote).toBeVisible()
        await expect(network.detailBody).toContainText("café")
      })

      test("reads an SVG in the charset its Content-Type names", async ({ viewer, detailTabs, network }) => {
        // No XML declaration: only the HTTP charset says this is Latin-1.
        const latin1 = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>café</text></svg>`,
          "latin1",
        )
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ contentType: "image/svg+xml; charset=windows-1252", responseSize: latin1.length }),
          latin1,
        )
        await expect(network.imagePreview).toBeVisible()
        await network.imageToggle.click()
        await expect(network.detailBody).toContainText("café")
      })

      test("keeps a sizeless SVG's prolog, such as an xml-stylesheet", async ({ viewer, detailTabs, network }) => {
        // The stylesheet is what paints the rect; without the processing
        // instruction the rect falls back to black.
        const styled = new TextEncoder().encode(
          `<?xml version="1.0"?><?xml-stylesheet href="#s" type="text/css"?>` +
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
            `<style id="s">rect { fill: rgb(0, 200, 0) }</style><rect width="10" height="10"/></svg>`,
        )
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ contentType: "image/svg+xml", responseSize: styled.length }),
          styled,
        )
        await expect(network.imagePreview).toBeVisible()
        const centre = await network.imagePreview.evaluate(async (img: HTMLImageElement) => {
          const bitmap = await createImageBitmap(await (await fetch(img.src)).blob())
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
          const ctx = canvas.getContext("2d")!
          ctx.drawImage(bitmap, 0, 0)
          return Array.from(ctx.getImageData(bitmap.width >> 1, bitmap.height >> 1, 1, 1).data)
        })
        expect(centre.slice(0, 3)).toEqual([0, 200, 0])
      })

      test("keeps the size an SVG declares in absolute units other than px", async ({ viewer, detailTabs, network }) => {
        // Inkscape's default: millimetres.
        const inkscape = new TextEncoder().encode(
          `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="25mm" viewBox="0 0 50 25"><rect width="50" height="25" fill="#08f"/></svg>`,
        )
        await openResponse(
          { viewer, detailTabs, network },
          imageEntry({ contentType: "image/svg+xml", responseSize: inkscape.length }),
          inkscape,
        )

        await expect(network.imagePreview).toBeVisible()
        await expect(network.bodyInfo).toContainText("189 × 94")
      })

      test("draws an SVG with only a viewBox without claiming a size for it", async ({
        viewer,
        detailTabs,
        network,
      }) => {
        const iconSvg = new TextEncoder().encode(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>`,
        )
        await openResponse({ viewer, detailTabs, network }, svgEntry(), iconSvg)

        await expect(network.imagePreview).toBeVisible()
        await expect(network.bodyInfo).not.toContainText("×")
        // Shown at the proportions it was drawn at, not stretched.
        const [shown, drawn] = await network.imagePreview.evaluate((img: HTMLImageElement) => [
          img.clientWidth / img.clientHeight,
          img.naturalWidth / img.naturalHeight,
        ])
        expect(shown).toBeCloseTo(drawn, 1)
      })
    })

    test("explains that an image format browsers can't display is shown raw", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      const tiff = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])
      await openResponse(
        { viewer, detailTabs, network },
        imageEntry({ contentType: "image/tiff", responseSize: tiff.length }),
        tiff,
      )

      await expect(network.imageNote).toContainText("can't display image/tiff images")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("does not draw one range of an image from a 206 response", async ({ viewer, detailTabs, network }) => {
      const entry = { ...imageEntry({ responseHeaders: { "Content-Range": `bytes 0-${IMAGE.length - 1}/400000` } }), status: 206 }
      await openResponse({ viewer, detailTabs, network }, entry, IMAGE)

      await expect(network.imageNote).toContainText("206 Partial Content")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("previews an uploaded image in the request payload", async ({ viewer, detailTabs, network }) => {
      const upload = {
        ...networkEntry({
          index: 0,
          method: "PUT",
          url: "https://api.acme.dev/v1/me/avatar",
          // The response is JSON; the payload's own type comes from its headers.
          contentType: "application/json",
          requestBodyPath: "network/req-0.bin",
        }),
        requestSize: IMAGE.length,
        requestHeaders: { "Content-Type": "image/png" },
      }
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [upload],
        networkBodies: { "network/req-0.bin": IMAGE },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar")
      await network.openDetailTab("Payload")

      await expect(network.imagePreview).toBeVisible()
      expect(await naturalSize(network)).toEqual([20, 10])
    })

    test("previews an upload whose response is still streaming", async ({ viewer, detailTabs, network }) => {
      // The response has started, so the request body was sent in full.
      const upload = {
        ...networkEntry({
          index: 0,
          method: "PUT",
          url: "https://api.acme.dev/v1/me/avatar",
          status: 200,
          contentType: "application/json",
          requestBodyPath: "network/req-0.bin",
        }),
        inFlight: true,
        requestSize: IMAGE.length,
        requestHeaders: { "Content-Type": "image/png" },
      }
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [upload],
        networkBodies: { "network/req-0.bin": IMAGE },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar")
      await network.openDetailTab("Payload")

      await expect(network.imagePreview).toBeVisible()
    })

    test("does not draw an upload that has no response yet", async ({ viewer, detailTabs, network }) => {
      const upload = {
        ...networkEntry({
          index: 0,
          method: "PUT",
          url: "https://api.acme.dev/v1/me/avatar",
          status: 0,
          contentType: "",
          requestBodyPath: "network/req-0.bin",
        }),
        inFlight: true,
        requestSize: IMAGE.length,
        requestHeaders: { "Content-Type": "image/png" },
      }
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [upload],
        networkBodies: { "network/req-0.bin": IMAGE },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar")
      await network.openDetailTab("Payload")

      await expect(network.imageNote).toContainText("may still have been uploading")
      await expect(network.imagePreview).toHaveCount(0)
    })

    test("types a payload by the response's Content-Type when the request declares none", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      // What the payload view always did; an empty header declares nothing too.
      const headerVariants: Record<string, string>[] = [{}, { "Content-Type": "" }]
      for (const requestHeaders of headerVariants) {
        await viewer.open({
          events: [actionEvent({ actionIndex: 0, action: "tap" })],
          network: [{
            ...networkEntry({
              index: 0,
              method: "POST",
              url: "https://api.acme.dev/v1/items",
              contentType: "application/json",
              requestBodyPath: "network/req-0.bin",
            }),
            requestHeaders,
          }],
          networkBodies: { "network/req-0.bin": '{"title":"Buy milk"}' },
        })
        await detailTabs.select("Network")
        await network.selectRow("items")
        await network.openDetailTab("Payload")

        await expect(network.bodyInfo).toContainText("json")
        await expect(network.prettyToggle).toBeVisible()
      }
    })

    test("types a non-image payload by its own Content-Type, not the response's", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      const form = {
        ...networkEntry({
          index: 0,
          method: "POST",
          url: "https://api.acme.dev/v1/login",
          contentType: "application/json",
          requestBodyPath: "network/req-0.bin",
        }),
        requestHeaders: { "Content-Type": "application/x-www-form-urlencoded" },
      }
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [form],
        networkBodies: { "network/req-0.bin": "user=sam&remember=1" },
      })
      await detailTabs.select("Network")
      await network.selectRow("login")
      await network.openDetailTab("Payload")

      await expect(network.detailBody).toContainText("user=sam")
      await expect(network.bodyInfo).not.toContainText("json")
      await expect(network.prettyToggle).toHaveCount(0)
    })

    test("labels an upload it cannot preview by the upload's own type", async ({ viewer, detailTabs, network }) => {
      const upload = {
        ...networkEntry({
          index: 0,
          method: "PUT",
          url: "https://api.acme.dev/v1/me/avatar",
          contentType: "application/json",
          requestBodyPath: "network/req-0.bin",
        }),
        requestSize: 3 * 1024 * 1024,
        requestHeaders: { "Content-Type": "image/png" },
      }
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [upload],
        networkBodies: { "network/req-0.bin": IMAGE },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar")
      await network.openDetailTab("Payload")

      await expect(network.imageNote).toContainText("only")
      await expect(network.bodyInfo).toContainText("png")
      await expect(network.prettyToggle).toHaveCount(0)
    })

    test("opens each image as a picture, even after the previous one was switched to raw", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      const second = solidPng(6, 4)
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          imageEntry(),
          {
            ...networkEntry({
              index: 1,
              url: "https://cdn.acme.dev/banner.png",
              contentType: "image/png",
              responseBodyPath: "network/res-1.bin",
              responseSize: second.length,
            }),
            responseHeaders: { "content-type": "image/png" },
          },
        ],
        networkBodies: { "network/res-0.bin": IMAGE, "network/res-1.bin": second },
      })
      await detailTabs.select("Network")
      await network.selectRow("avatar.png")
      await network.openDetailTab("Response")
      await network.imageToggle.click()
      await expect(network.imagePreview).toHaveCount(0)

      await network.selectRow("banner.png")
      await expect(network.imagePreview).toBeVisible()
      expect(await naturalSize(network)).toEqual([6, 4])
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

    // PILOT-1183: a device that did not trust Tapsmith's CA had its HTTPS
    // tunneled uncaptured; the tab must say why HTTPS rows have no content.
    const untrusted = (networkHttpsPassthrough?: boolean) => ({
      device: {
        ...iosSim("ios-network-extension").device,
        ...(networkHttpsPassthrough !== undefined ? { networkHttpsPassthrough } : {}),
      },
    })

    test("says HTTPS was passed through when the device did not trust the CA", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer, { metadata: untrusted(true) })
      await detailTabs.select("Network")

      await expect(network.httpsPassthroughNotice).toContainText("did not trust Tapsmith's CA")
      await expect(network.httpsPassthroughNotice).toContainText("Plain HTTP")
      await expect(network.rows).toHaveCount(4)
    })

    test("says HTTPS was passed through on an empty capture too", async ({ viewer, detailTabs, network }) => {
      await viewer.open({ network: [], metadata: untrusted(true) })
      await detailTabs.select("Network")

      await expect(detailTabs.noContent).toContainText("No network requests captured")
      await expect(network.httpsPassthroughNotice).toBeVisible()
    })

    for (const flag of [false, undefined] as const) {
      test(`shows no passthrough notice when the CA was trusted (${flag ?? "unrecorded"})`, async ({ viewer, detailTabs, network }) => {
        await openWithNetwork(viewer, { metadata: untrusted(flag) })
        await detailTabs.select("Network")

        await expect(network.rows).toHaveCount(4)
        await expect(network.httpsPassthroughNotice).toHaveCount(0)
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
