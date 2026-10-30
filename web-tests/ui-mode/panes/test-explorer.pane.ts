// Test Explorer pane — the tree, its toolbar, and its filters.
//
// Follows the screen-object guidelines in docs/writing-tests.md: getters (never
// constructor assignments) so each access yields a fresh lazy locator,
// multi-step flows as methods, and no assertions — specs decide what to assert.
//
// Locators are role- and text-based. Where a surface had no accessible name, the
// fix was to give it the ARIA it should already have had rather than to reach for
// a CSS class from `styles/ui-mode.css.ts` — those are styling hooks and only
// incidentally stable. `getByTestId` is the deliberate fallback for the few bits
// carrying no semantics at all.

import type { Locator, Page } from "@playwright/test"

type NodeStatus = "idle" | "running" | "passed" | "failed" | "skipped"
type NodeType = "project" | "file" | "suite" | "test"
type StatusFilter = "All" | "Pass" | "Fail" | "Skip"

export class TestExplorerPane {
  constructor(private page: Page) {}

  // ─── Search and status filters ───

  get searchInput() {
    return this.page.getByRole("textbox", { name: "Filter tests" })
  }

  /**
   * The filters are a toggle group, not a tab strip: they narrow the same tree
   * in place rather than switching panels, and report state with `aria-pressed`
   * — the same model as the network filter pills.
   */
  get statusFilters() {
    return this.page.getByRole("group", { name: "Filter by status" })
  }

  /**
   * One of the All / Pass / Fail / Skip filters. Matched on the leading label
   * because the accessible name also carries the count.
   */
  statusFilter(label: StatusFilter) {
    return this.statusFilters.getByRole("button", { name: new RegExp(`^${label}\\b`) })
  }

  /** The count badge on a filter — a bare number, so read its value. */
  statusFilterCount(label: StatusFilter) {
    return this.statusFilter(label).getByTestId("filter-count")
  }

  // ─── Toolbar ───

  get runAllButton() {
    return this.page.getByRole("button", { name: "Run all tests" })
  }

  /** Run all's label while a name or status filter narrows the tree. */
  get runVisibleButton() {
    return this.page.getByRole("button", { name: "Run visible tests" })
  }

  get stopButton() {
    return this.page.getByRole("button", { name: "Stop current run" })
  }

  get watchAllButton() {
    return this.page.getByRole("button", { name: "Watch all files for changes" })
  }

  /** The watch toggle once something is being watched — its label flips. */
  get disableWatchButton() {
    return this.page.getByRole("button", { name: "Disable watch mode" })
  }

  get expandAllButton() {
    return this.page.getByRole("button", { name: "Expand all" })
  }

  get collapseAllButton() {
    return this.page.getByRole("button", { name: "Collapse all" })
  }

  // ─── Tree ───

  get emptyState() {
    return this.page.getByTestId("tests-empty")
  }

  get tree() {
    return this.page.getByRole("tree", { name: "Tests" })
  }

  /**
   * Every rendered tree row, in document order. Scoped to the Tests tree: the
   * Hierarchy tab is also a tree of treeitems, so a page-wide query would count
   * its rows too.
   */
  get nodes() {
    return this.tree.getByRole("treeitem")
  }

  /**
   * A tree row by its visible name — its last path segment, or `[name]` for a
   * project. Exact, so "smoke" doesn't also match "smoke test".
   */
  node(name: string): Locator {
    return this.tree.getByRole("treeitem", { name, exact: true })
  }

  // `data-type` and `data-status` have no ARIA equivalent — there is no role or
  // state for "this test failed" — and they are pre-existing product
  // attributes rather than styling hooks. Refining the role keeps the accessible
  // locator primary.

  nodesOfType(type: NodeType) {
    return this.nodes.and(this.page.locator(`[data-type="${type}"]`))
  }

  /** Rows of one kind showing a given status — e.g. only the leaf tests. */
  nodesOfTypeWithStatus(type: NodeType, status: NodeStatus) {
    return this.nodes.and(this.page.locator(`[data-type="${type}"][data-status="${status}"]`))
  }

  /**
   * Rows waiting for a run the server has not reported started yet: the
   * pending pulse, exposed as `aria-busy`.
   */
  get pendingNodes() {
    return this.nodes.and(this.page.locator('[aria-busy="true"]'))
  }

  // Each row holds exactly one run and one watch button, so a name prefix is
  // unambiguous once scoped to the row — and it keeps these from restating how
  // the label is derived.

  runButtonFor(name: string) {
    return this.node(name).getByRole("button", { name: /^Run / })
  }

  watchButtonFor(name: string) {
    return this.node(name).getByRole("button", { name: /^Watch / })
  }

  /** A formatted duration is a bare number with no role of its own. */
  durationFor(name: string) {
    return this.node(name).getByTestId("node-duration")
  }

  /** The "depends on" badge on a project row, named by its tooltip. */
  dependenciesFor(name: string) {
    return this.node(name).getByTitle(/^Depends on:/)
  }

  /** The declared-isolation badge on a row (only when the row itself declares one). */
  isolationFor(name: string) {
    return this.node(name).getByTestId("node-isolation")
  }

  /** The device-group badge on a project row (`use.devices`), named by member. */
  devicesFor(name: string) {
    return this.node(name).getByTestId("node-devices")
  }

  // ─── Flows ───

  /** Click a row, which both selects it and toggles it if it has children. */
  async clickNode(name: string) {
    await this.node(name).click()
  }

  /** Hover the row (its actions only appear on hover) and hit its play button. */
  async runNode(name: string) {
    await this.node(name).hover()
    await this.runButtonFor(name).click()
  }

  async toggleWatchOn(name: string) {
    await this.node(name).hover()
    await this.watchButtonFor(name).click()
  }

  async filterByName(text: string) {
    await this.searchInput.fill(text)
  }

  async clearNameFilter() {
    await this.searchInput.fill("")
  }

  async filterByStatus(label: StatusFilter) {
    await this.statusFilter(label).click()
  }

  async expandAll() {
    await this.expandAllButton.click()
  }

  async collapseAll() {
    await this.collapseAllButton.click()
  }
}
