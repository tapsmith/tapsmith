// Locator tab — the locator playground: type a locator, see how many elements
// it matches, or pick one from the suggestions generated for a hierarchy node.

import type { Page } from "@playwright/test"

export class LocatorPane {
  constructor(private page: Page) {}

  get input() {
    return this.page.getByRole("textbox", { name: "Locator" })
  }

  /**
   * Addressed by test id rather than a listbox role: the panel interleaves a
   * section label and the WebView setup hint with the suggestions, and a listbox
   * may not contain those.
   */
  get suggestions() {
    return this.page.getByTestId("locator-suggestions")
  }

  get options() {
    return this.page.getByTestId("locator-option")
  }

  get selectedOption() {
    return this.options.and(this.page.locator('[data-selected="true"]'))
  }

  option(code: string) {
    return this.options.filter({ hasText: code })
  }

  /** The locator expression a suggestion offers, without its label or Copy button. */
  get optionCodes() {
    return this.page.getByTestId("locator-code")
  }

  /** "1 match" / "3 matches" / empty when nothing has been typed. */
  get matchCount() {
    return this.page.getByTestId("locator-match-count")
  }

  /** Shown when an ambiguous locator has no positional chain (PILOT-226). */
  get strictWarning() {
    return this.page.getByTestId("locator-strict-warning")
  }

  /** Trace vs Live hierarchy source, in UI mode only. */
  get sourceToggle() {
    return this.page.getByRole("group", { name: "Locator hierarchy source" })
  }

  // ─── Flows ───

  async type(selector: string) {
    await this.input.fill(selector)
  }

  async chooseSuggestion(code: string) {
    await this.option(code).first().click()
  }
}
