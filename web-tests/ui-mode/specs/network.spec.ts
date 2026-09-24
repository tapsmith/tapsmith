import type { NetworkMessage } from '../../protocol.js'
import { test, expect } from "../fixtures.js"
import { GESTURES_FILE } from "../messages/scenarios.js"
import { NetworkPane } from "../../panes/network.pane.js"
import { actionEvent, networkEntry } from "../../trace-viewer/trace-builder.js"

const FULL_NAME = "Gestures screen > double tap registers double tap gesture"
const HINT = "Enable network capture in your trace config to record HTTP requests."

test("network requests and selected bodies update while the test is running", async ({ app, detailTabs, page, explorer }) => {
  app.send({ type: "run-start", fileCount: 1 })
  app.send({ type: "test-start", fullName: FULL_NAME, filePath: GESTURES_FILE })
  app.send({ type: "network", testFullName: FULL_NAME, entries: [], networkCaptureEnabled: true })
  await explorer.expandAll()
  await explorer.clickNode("double tap registers double tap gesture")
  await detailTabs.select("Network")
  await expect(detailTabs.noContent).toContainText("No network requests captured")
  await expect(page.getByText(HINT)).toHaveCount(0)

  const network = new NetworkPane(page)
  const entry = {
    ...networkEntry({ index: 7, url: "https://example.com/Listen", contentType: "text/plain" }),
    inFlight: true, responseBodyPath: "network/res-7.bin",
  }
  const snapshot = (body: string, inFlight: boolean) => app.send({
    type: "network", testFullName: FULL_NAME, networkCaptureEnabled: true,
    bodyMode: "patch", entries: [{ ...entry, inFlight }], bodies: { "network/res-7.bin": Buffer.from(body).toString("base64") },
  })
  snapshot("partial", true)
  await expect(network.rows).toHaveCount(1)
  await expect(network.rows.first()).toContainText("Streaming")
  await network.selectRow("Listen")
  await network.openDetailTab("Response")
  await expect(network.detailBody).toContainText("partial")
  app.send({ type: "network", testFullName: FULL_NAME, bodyMode: "patch", entries: [{ ...entry, duration: 9000 }], bodies: {} })
  await expect(network.detailBody).toContainText("partial")
  snapshot("partial grown", true)
  await expect(network.detailBody).toContainText("partial grown")
  snapshot("complete", false)
  await expect(network.detailBody).toContainText("complete")
  await expect(network.rows).toHaveCount(1)
  await expect(network.rows.first()).not.toContainText("Streaming")
  app.send({ type: "network", testFullName: FULL_NAME, bodyMode: "patch", entries: [], bodies: {} })
  await expect(network.rows).toHaveCount(0)
  app.send({ type: "network", testFullName: FULL_NAME, bodyMode: "patch", entries: [entry], bodies: { "network/res-7.bin": Buffer.from("new attempt").toString("base64") } })
  await network.selectRow("Listen")
  await network.openDetailTab("Response")
  await expect(network.detailBody).toContainText("new attempt")
  await expect(network.detailBody).not.toContainText("complete")
  // No test-status or run-end message: all updates occurred during execution.
})

for (const networkCaptureRoute of ["ios-system-proxy", "ios-network-extension", undefined] as const) {
  const hostWide = networkCaptureRoute === "ios-system-proxy"
  test(`warns about a host-wide system-proxy capture while the test runs (${networkCaptureRoute ?? "no route"})`, async ({ app, detailTabs, page, explorer }) => {
    app.send({ type: "run-start", fileCount: 1 })
    app.send({ type: "test-start", fullName: FULL_NAME, filePath: GESTURES_FILE })
    app.send({
      type: "network", testFullName: FULL_NAME, networkCaptureEnabled: true, networkCaptureRoute,
      entries: [networkEntry({ index: 0, url: "https://chat.google.com/preconnect" })],
    })
    await explorer.expandAll()
    await explorer.clickNode("double tap registers double tap gesture")
    await detailTabs.select("Network")
    const network = new NetworkPane(page)
    await expect(network.rows).toHaveCount(1)
    await expect(network.hostWideNotice).toHaveCount(hostWide ? 1 : 0)
  })
}

test("a retry whose capture has no route clears the previous attempt's host-wide warning", async ({ app, detailTabs, page, explorer }) => {
  app.send({ type: "run-start", fileCount: 1 })
  app.send({ type: "test-start", fullName: FULL_NAME, filePath: GESTURES_FILE })
  const entries = [networkEntry({ index: 0, url: "https://api.acme.dev/items" })]
  app.send({ type: "network", testFullName: FULL_NAME, networkCaptureEnabled: true, networkCaptureRoute: "ios-system-proxy", entries })
  await explorer.expandAll()
  await explorer.clickNode("double tap registers double tap gesture")
  await detailTabs.select("Network")
  const network = new NetworkPane(page)
  await expect(network.hostWideNotice).toHaveCount(1)
  // Attempt 2 (same test, same trace key) captured with no route.
  app.send({ type: "network", testFullName: FULL_NAME, networkCaptureEnabled: true, networkCaptureRoute: null, entries })
  await expect(network.hostWideNotice).toHaveCount(0)
})

for (const enabled of [true, false, undefined]) {
  test(`empty network hint requires explicit disabled capture (${enabled})`, async ({ app, detailTabs, page, explorer }) => {
    app.send({ type: "run-start", fileCount: 1 })
    app.send({ type: "test-start", fullName: FULL_NAME, filePath: GESTURES_FILE })
    app.send({ type: "network", testFullName: FULL_NAME, entries: [], networkCaptureEnabled: enabled })
    await explorer.expandAll()
    await explorer.clickNode("double tap registers double tap gesture")
    await detailTabs.select("Network")
    await expect(detailTabs.noContent).toContainText("No network requests captured")
    await expect(page.getByText(HINT)).toHaveCount(enabled === false ? 1 : 0)
  })
}

test('keeps inherited request timing across live updates, completion and reruns', async ({ app, detailTabs, page, explorer }) => {
  const start = 1_700_000_000_000
  const testStart = start + 42 * 60_000
  app.send({ type: 'run-start', fileCount: 1 })
  app.send({ type: 'test-start', fullName: FULL_NAME, filePath: GESTURES_FILE })
  await explorer.expandAll()
  await explorer.clickNode('double tap registers double tap gesture')
  await detailTabs.select('Network')
  const network = new NetworkPane(page)
  const snapshot = (observedStartTime: number, endTime: number, inFlight: boolean) => app.send({
    type: 'network', testFullName: FULL_NAME, bodyMode: 'patch', entries: [{
      ...networkEntry({ index: 0, url: 'http://test/Listen' }),
      startTime: start, observedStartTime, endTime, duration: endTime - start, inFlight,
    }], bodies: {},
  })
  snapshot(testStart, testStart + 1000, true)
  await expect(network.row('Listen')).toContainText('Started before this test')
  await expect(network.row('Listen')).toContainText('1.00 s')
  await network.selectRow('Listen')
  await network.openDetailTab('Timing')
  snapshot(testStart, testStart + 5000, true)
  await expect(network.row('Listen')).toContainText('5.00 s')
  await expect(network.detailBody).toContainText('42 min 5 s')
  snapshot(testStart, testStart + 6000, false)
  await expect(network.detailBody).toContainText('Total request duration')
  await expect(network.row('Listen')).toContainText('Started before this test')
  app.send({ type: 'network', testFullName: FULL_NAME, bodyMode: 'patch', entries: [], bodies: {} })
  snapshot(testStart + 30_000, testStart + 31_000, true)
  await expect(network.row('Listen')).toContainText('1.00 s')
  await expect(network.row('Listen')).not.toContainText('6.00 s')
})

test('isolates same-named tests across files during interleaved updates, replay and reruns', async ({ ui, explorer, detailTabs, actions, page }) => {
  const { fileNode, projectNode } = await import('../messages/tree.js')
  const { idleSeed } = await import('../messages/scenarios.js')
  const { NetworkReplayBuffer } = await import('../../../packages/tapsmith/dist/ui-mode/network-replay.js')
  const files = ['/repo/a.test.ts', '/repo/b.test.ts']
  const tree = [projectNode('android', files.map((file) => fileNode(file, [{ name: 'smoke' }])))]
  ui.seed(idleSeed(tree))
  await ui.open()
  await explorer.expandAll()
  const buffer = new NetworkReplayBuffer(10)
  const traces = files.map((filePath, i) => ({
    type: 'trace-event' as const, filePath, projectName: 'android', testFullName: 'smoke', workerId: i,
    event: actionEvent({ actionIndex: 0, action: i === 0 ? 'tapXY' : 'inputText' }),
  }))
  const statuses = files.map((filePath, i) => ({
    type: 'test-status' as const, filePath, projectName: 'android', fullName: 'smoke', workerId: i, status: 'passed' as const,
  }))
  const sendNetwork = (i: number, body?: string) => {
    const message: NetworkMessage = {
      type: 'network' as const, filePath: files[i], projectName: 'android', testFullName: 'smoke', bodyMode: 'patch' as const,
      entries: [{ ...networkEntry({ index: 0, url: `http://test/file-${i}`, contentType: 'text/plain' }), responseBodyPath: 'network/res-0.bin' }],
      bodies: body === undefined ? {} : { 'network/res-0.bin': Buffer.from(body).toString('base64') },
    }
    buffer.add(message)
    ui.send(message)
  }
  ui.send({ type: 'run-start', fileCount: 2 })
  for (let i = 0; i < 2; i++) {
    ui.send({ type: 'test-start', filePath: files[i], projectName: 'android', fullName: 'smoke', workerId: i })
    ui.send(traces[i])
    sendNetwork(i, `body from file ${i}`)
  }
  sendNetwork(0)
  const network = new NetworkPane(page)
  const inspect = async (i: number) => {
    await explorer.node('smoke').nth(i).click()
    await detailTabs.select('Network')
    await expect(network.rows).toHaveCount(1)
    await network.selectRow(`file-${i}`)
    await network.openDetailTab('Response')
    await expect(network.detailBody).toContainText(`body from file ${i}`)
    await expect(network.detailBody).not.toContainText(`body from file ${1 - i}`)
    await expect(actions.items).toHaveCount(1)
    await expect(actions.items.first()).toContainText(i === 0 ? 'tapXY' : 'inputText')
  }
  await inspect(0)
  await inspect(1)
  ui.seed([...idleSeed(tree), ...statuses, ...traces, ...buffer.values()])
  await page.reload()
  await explorer.expandAll()
  await inspect(0)
  await inspect(1)
  ui.send({ type: 'run-start', fileCount: 1, filePath: files[0], testFilter: 'smoke', projectName: 'android' })
  ui.send({ type: 'test-start', filePath: files[0], fullName: 'smoke', projectName: 'android', workerId: 0 })
  ui.send({ type: 'network', filePath: files[0], testFullName: 'smoke', projectName: 'android', bodyMode: 'patch', entries: [], bodies: {} })
  await inspect(1)
  await explorer.node('smoke').nth(0).click()
  await detailTabs.select('Network')
  await expect(network.rows).toHaveCount(0)
})
