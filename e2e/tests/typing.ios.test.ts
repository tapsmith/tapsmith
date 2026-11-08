import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// PILOT-1012: with a typing delay, iOS type() sends the first key alone, the
// rest as one burst of key events, and reads the field back — typing it again
// a key at a time when keys came out short or out of order. Each call passes
// the delay itself, so the checked path runs whatever the config sets.
const delay = 10

describe("type() with a typing delay checks what arrived (iOS)", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, typingScreen }) => {
    await openScreen(device, "/typing")
    await expect(typingScreen.slowValue).toHaveText("slow=")
  })

  test("a controlled field that falls behind the keys still ends up with the text", async ({ typingScreen }) => {
    await typingScreen.slowInput.type("sneaker", { delay })
    await expect(typingScreen.slowValue).toHaveText("slow=sneaker")
    await expect(typingScreen.slowInput).toHaveValue("sneaker")
  })

  test("a longer text with repeated letters and spaces", async ({ typingScreen }) => {
    const text = "the quick brown fox jumps over the lazy dog"
    await typingScreen.slowInput.type(text, { delay })
    await expect(typingScreen.slowValue).toHaveText(`slow=${text}`)
  })

  test("typing again appends to what the field holds", async ({ typingScreen }) => {
    await typingScreen.slowInput.type("abc", { delay })
    await typingScreen.slowInput.type("def", { delay })
    await expect(typingScreen.slowValue).toHaveText("slow=abcdef")
  })

  test("clearAndType() replaces the text", async ({ typingScreen }) => {
    await typingScreen.slowInput.type("seed text", { delay })
    await typingScreen.slowInput.clearAndType("new text", { delay })
    await expect(typingScreen.slowValue).toHaveText("slow=new text")
  })

  test("characters off the plain keyboard arrive", async ({ typingScreen }) => {
    await typingScreen.slowInput.type("café 😀", { delay })
    await expect(typingScreen.slowValue).toHaveText("slow=café 😀")
  })

  test("a secure field gets every character", async ({ typingScreen }) => {
    await typingScreen.secureInput.type("password123", { delay })
    await expect(typingScreen.secureLength).toHaveText("secure=11")
  })

  test("a code field that moves the focus on gets one digit per box", async ({ typingScreen }) => {
    await typingScreen.firstCodeBox.type("1234", { delay })
    await expect(typingScreen.codeValue).toHaveText("code=1234")
  })

  test("a code field whose app moves the focus on late still gets one digit per box", async ({ typingScreen }) => {
    await typingScreen.firstSlowCodeBox.type("1234", { delay })
    await expect(typingScreen.slowCodeValue).toHaveText("slowcode=1234")
  })

  test("a delay over a second keeps every key that far apart", async ({ typingScreen }) => {
    const started = Date.now()
    await typingScreen.slowInput.type("abc", { delay: 1500 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
    await expect(typingScreen.slowValue).toHaveText("slow=abc")
  })

  test("a code field that moves the focus on keeps the delay between digits", async ({ typingScreen }) => {
    const started = Date.now()
    await typingScreen.firstCodeBox.type("1234", { delay: 1500 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500)
    await expect(typingScreen.codeValue).toHaveText("code=1234")
  })

  test("typing into a secure field that iOS empties as it takes focus again fails instead of reporting success", async ({ typingScreen }) => {
    await typingScreen.secureInput.type("ab", { delay })
    await expect(typingScreen.secureLength).toHaveText("secure=2")
    await typingScreen.slowInput.tap()
    let error: unknown
    try {
      await typingScreen.secureInput.type("xyz", { delay, timeout: 5000 })
    } catch (e) {
      error = e
    }
    expect(String(error)).toContain("the secure field dropped the 2 character(s) it held")
  })
})
