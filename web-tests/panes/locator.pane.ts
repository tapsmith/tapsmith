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

  /** Why the locator would throw when a test builds it, e.g. an unknown role (PILOT-556). */
  get error() {
    return this.page.getByTestId("locator-error")
  }

  /** Shown when an ambiguous locator has no positional chain (PILOT-226). */
  get strictWarning() {
    return this.page.getByTestId("locator-strict-warning")
  }

  /** Who answered: the device (Live) or the recorded hierarchy (approximate). */
  get sourceNote() {
    return this.page.getByTestId("locator-source-note")
  }

  /** Shown while the device checks a live pick's locators. */
  get suggestionsPending() {
    return this.page.getByTestId("locator-suggestions-pending")
  }

  /** Why a live pick's list is short or empty. */
  get suggestionsNote() {
    return this.page.getByTestId("locator-suggestions-note")
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
