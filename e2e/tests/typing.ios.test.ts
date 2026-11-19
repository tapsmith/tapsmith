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

  test("typing into a field that selects its text on focus replaces the text, as for a user", async ({ typingScreen }) => {
    await expect(typingScreen.selectValue).toHaveText("select=old")
    await typingScreen.selectInput.type("new", { delay })
    await expect(typingScreen.selectValue).toHaveText("select=new")
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

  test("a code field whose app moves the focus on later than the first key shows keeps one digit per box with a long delay", async ({ typingScreen }) => {
    await typingScreen.firstSlowCodeBox.type("1234", { delay: 1500 })
    await expect(typingScreen.slowCodeValue).toHaveText("slowcode=1234")
  })

  for (const held of ["ab", "a"]) {
    test(`typing into a secure field holding ${held.length} character(s) that iOS empties as it takes focus again fails instead of reporting success`, async ({ typingScreen }) => {
      await typingScreen.secureInput.type(held, { delay })
      await expect(typingScreen.secureLength).toHaveText(`secure=${held.length}`)
      await typingScreen.slowInput.tap()
      let error: unknown
      try {
        await typingScreen.secureInput.type("xyz", { delay, timeout: 5000 })
      } catch (e) {
        error = e
      }
      expect(String(error)).toContain("use clearAndType() to replace its text")
    })
  }
})

// PILOT-1281: with no typing delay (the default), type() used to send the text
// unchecked, and an iPad field just focused lost the second key while its
// keyboard came up ("test@example.com" came out "tst@example.com") with the
// action reporting success. The field is now read back once, and a few lost
// keys make it empty the field and send the text again; anything else the field
// shows (a mask, a filter, a replaced selection, a field the app removed) is
// left as it is, as before. Each call passes `delay: 0`, so this runs whatever
// the config's typingDelay is.
describe("type() with no typing delay types lost keys again (iOS)", () => {
  test.use({ appResetScope: "test" })

  test.beforeEach(async ({ device, typingScreen }) => {
    await openScreen(device, "/typing")
    await expect(typingScreen.lossyValue).toHaveText("lossy=")
  })

  test("a field that drops the second key still ends up with the text", async ({ typingScreen }) => {
    await typingScreen.lossyInput.type("test@example.com", { delay: 0 })
    await expect(typingScreen.lossyValue).toHaveText("lossy=test@example.com")
    // The field did drop a key: the text is there because it was typed again.
    await expect(typingScreen.lossyDrops).toHaveText("drops=1")
    await expect(typingScreen.lossyInput).toHaveValue("test@example.com")
  })

  test("clearAndType() into a field that drops the second key still ends up with the text", async ({ typingScreen }) => {
    await typingScreen.lossyInput.clearAndType("smoke@test.com", { delay: 0 })
    await expect(typingScreen.lossyValue).toHaveText("lossy=smoke@test.com")
    await expect(typingScreen.lossyDrops).toHaveText("drops=1")
  })

  test("a secure field gets every character", async ({ typingScreen }) => {
    await typingScreen.secureInput.type("password123", { delay: 0 })
    await expect(typingScreen.secureLength).toHaveText("secure=11")
  })

  test("typing into a field that selects its text on focus replaces the text, as for a user", async ({ typingScreen }) => {
    await expect(typingScreen.selectValue).toHaveText("select=old")
    await typingScreen.selectInput.type("new", { delay: 0 })
    await expect(typingScreen.selectValue).toHaveText("select=new")
  })

  test("a field that formats what is typed keeps its formatting, as before", async ({ typingScreen }) => {
    await typingScreen.formattedInput.type("123456", { delay: 0 })
    await expect(typingScreen.formattedValue).toHaveText("fmt=123-456")
  })

  test("a field that drops what it does not take keeps what it took, as before", async ({ typingScreen }) => {
    // The field keeps six digits: the seventh is left out.
    await typingScreen.formattedInput.type("1234567", { delay: 0 })
    await expect(typingScreen.formattedValue).toHaveText("fmt=123-456")
  })

  test("a field that filters out a typed character keeps what it took", async ({ typingScreen }) => {
    // The "a" is filtered out: the field reads one key short, is emptied and
    // typed again, and is then left with what it takes.
    await typingScreen.formattedInput.type("12a3", { delay: 0 })
    await expect(typingScreen.formattedValue).toHaveText("fmt=123")
  })

  test("a field the app removes once it is full still counts as typed", async ({ typingScreen }) => {
    await typingScreen.vanishingInput.type("abcd", { delay: 0 })
    await expect(typingScreen.vanishingValue).toHaveText("vanish=abcd")
    await expect(typingScreen.vanishingInput).toBeHidden()
  })
})
