import { useEffect, useRef, useState } from "react"
import { StyleSheet, Text, TextInput, View } from "react-native"
import { useTapsmithResetEpoch } from "@tapsmith/react-native"

// Typing that checks what arrived (PILOT-1012). With a typing delay, iOS
// type() sends the first key alone, the rest as one burst of key events, and
// reads the field back, typing it again a key at a time when keys came out
// short or out of order. Each field here is one way that can go wrong:
//
// - "Slow input" is a controlled TextInput whose change handler keeps the
//   JavaScript thread busy, so a burst of keys outruns it — the React Native
//   case that loses or reorders keys ("sneaker" came out "sakerne"). What it
//   holds is echoed in "slow=<value>".
// - "Secure input" reads back only as bullets; its length is echoed in
//   "secure=<length>".
// - The code boxes take one digit each and move the focus on to the next box
//   by themselves, as a one-time-code field does, and give up the focus once
//   the last one is filled. What they hold is echoed in "code=<digits>".
// - The slow code boxes do the same half a second after each digit, as a
//   busy app does: keys typed before the focus moves go to the box being
//   left. What they hold is echoed in "slowcode=<digits>".
// - "Lossy input" drops the second key of the first text typed into it, as an
//   iPad field just focused did while its keyboard came up (PILOT-1281:
//   "test@example.com" came out "tst@example.com"). Only once per visit, so
//   typing it again gets every key. What it holds is echoed in "lossy=<value>".
// - "Select-on-focus input" starts out holding "old" and selects its text as
//   it takes the focus, so the first key typed replaces it, as it would for a
//   user. What it holds is echoed in "select=<value>".
// - "Formatted input" keeps digits only and puts a dash after the third, as
//   an input mask does, so it never shows exactly what was typed. What it
//   holds is echoed in "fmt=<value>".
// - "Vanishing input" is removed once it holds four characters, as a code
//   field that submits itself is. "vanish=<value>" echoes what it held.
const BUSY_MS = 40
const CODE_LENGTH = 4
const SLOW_FOCUS_MS = 500
const SELECT_START = "old"
const VANISH_LENGTH = 4

function formatDigits(text: string) {
  const digits = text.replace(/\D/g, "").slice(0, 6)
  return digits.length > 3 ? `${digits.slice(0, 3)}-${digits.slice(3)}` : digits
}

function busyWait(ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    // Hold the JavaScript thread, as a heavy re-render would.
  }
}

export default function TypingScreen() {
  const [slow, setSlow] = useState("")
  const [secure, setSecure] = useState("")
  const [code, setCode] = useState<string[]>(Array(CODE_LENGTH).fill(""))
  const boxes = useRef<(TextInput | null)[]>([])
  const [slowCode, setSlowCode] = useState<string[]>(Array(CODE_LENGTH).fill(""))
  const slowBoxes = useRef<(TextInput | null)[]>([])
  const [lossy, setLossy] = useState("")
  const lossyDropped = useRef(false)
  // Bumped to re-render when a key is dropped: the value stays the same, and
  // the re-render is what puts it back into the native field.
  const [lossyDrops, setLossyDrops] = useState(0)
  const [select, setSelect] = useState(SELECT_START)
  const [formatted, setFormatted] = useState("")
  const [vanish, setVanish] = useState("")

  // A warm reset navigates here rather than remounting.
  const resetEpoch = useTapsmithResetEpoch()
  useEffect(() => {
    if (resetEpoch === 0) return
    setSlow("")
    setSecure("")
    setCode(Array(CODE_LENGTH).fill(""))
    setSlowCode(Array(CODE_LENGTH).fill(""))
    setLossy("")
    lossyDropped.current = false
    setLossyDrops(0)
    setSelect(SELECT_START)
    setFormatted("")
    setVanish("")
  }, [resetEpoch])

  const setDigit = (index: number, text: string) => {
    const digit = text.slice(-1)
    setCode((current) => current.map((d, i) => (i === index ? digit : d)))
    if (digit && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus()
    // Done: let go of the keyboard, as many code fields do.
    if (digit && index === CODE_LENGTH - 1) boxes.current[index]?.blur()
  }

  const setSlowDigit = (index: number, text: string) => {
    const digit = text.slice(-1)
    setSlowCode((current) => current.map((d, i) => (i === index ? digit : d)))
    if (digit && index < CODE_LENGTH - 1) {
      setTimeout(() => slowBoxes.current[index + 1]?.focus(), SLOW_FOCUS_MS)
    }
  }

  return (
    <View style={styles.container}>
      <TextInput
        style={styles.input}
        value={slow}
        onChangeText={(text) => {
          busyWait(BUSY_MS)
          setSlow(text)
        }}
        placeholder="Slow input"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel="Slow input"
        testID="typing-slow-input"
      />
      <Text testID="typing-slow-value">{`slow=${slow}`}</Text>

      <TextInput
        style={styles.input}
        value={lossy}
        onChangeText={(text) => {
          if (!lossyDropped.current && lossy.length === 1 && text.length >= 2) {
            lossyDropped.current = true
            setLossyDrops((n) => n + 1)
            setLossy(text[0] + text.slice(2))
            return
          }
          setLossy(text)
        }}
        placeholder="Lossy input"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel="Lossy input"
        testID="typing-lossy-input"
      />
      <Text testID="typing-lossy-value">{`lossy=${lossy}`}</Text>
      <Text testID="typing-lossy-drops">{`drops=${lossyDrops}`}</Text>

      <TextInput
        style={styles.input}
        value={secure}
        onChangeText={setSecure}
        secureTextEntry
        placeholder="Secure input"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Secure input"
        testID="typing-secure-input"
      />
      <Text testID="typing-secure-length">{`secure=${secure.length}`}</Text>

      <View style={styles.row}>
        {code.map((digit, index) => (
          <TextInput
            key={index}
            ref={(box) => {
              boxes.current[index] = box
            }}
            style={[styles.input, styles.box]}
            value={digit}
            onChangeText={(text) => setDigit(index, text)}
            keyboardType="number-pad"
            maxLength={1}
            accessibilityLabel={`Code digit ${index + 1}`}
            testID={`typing-code-${index + 1}`}
          />
        ))}
      </View>
      <Text testID="typing-code-value">{`code=${code.join("")}`}</Text>

      <View style={styles.row}>
        {slowCode.map((digit, index) => (
          <TextInput
            key={index}
            ref={(box) => {
              slowBoxes.current[index] = box
            }}
            style={[styles.input, styles.box]}
            value={digit}
            onChangeText={(text) => setSlowDigit(index, text)}
            keyboardType="number-pad"
            maxLength={1}
            accessibilityLabel={`Slow code digit ${index + 1}`}
            testID={`typing-slow-code-${index + 1}`}
          />
        ))}
      </View>
      <Text testID="typing-slow-code-value">{`slowcode=${slowCode.join("")}`}</Text>

      <TextInput
        style={styles.input}
        value={select}
        onChangeText={setSelect}
        selectTextOnFocus
        placeholder="Select-on-focus input"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel="Select-on-focus input"
        testID="typing-select-input"
      />
      <Text testID="typing-select-value">{`select=${select}`}</Text>

      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.half]}
          value={formatted}
          onChangeText={(text) => setFormatted(formatDigits(text))}
          placeholder="Formatted input"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          accessibilityLabel="Formatted input"
          testID="typing-formatted-input"
        />
        {vanish.length < VANISH_LENGTH ? (
          <TextInput
            style={[styles.input, styles.half]}
            value={vanish}
            onChangeText={setVanish}
            placeholder="Vanishing input"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel="Vanishing input"
            testID="typing-vanishing-input"
          />
        ) : null}
      </View>
      <View style={styles.row}>
        <Text testID="typing-formatted-value">{`fmt=${formatted}`}</Text>
        <Text testID="typing-vanishing-value">{`vanish=${vanish}`}</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    gap: 12,
    backgroundColor: "#f5f5f5",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  half: {
    flex: 1,
  },
  box: {
    width: 48,
    textAlign: "center",
  },
})
