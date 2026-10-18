// The package ships Flow types only. RN's StyleSheet runs every colour
// through this function, so the tests use it to see a colour as RN does.
declare module '@react-native/normalize-colors' {
  /** `0xRRGGBBAA` as an unsigned int, or null when the input is not a colour. */
  export default function normalizeColor(color: unknown): number | null;
}
