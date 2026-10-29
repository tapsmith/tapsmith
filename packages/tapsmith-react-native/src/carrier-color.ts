/**
 * Text colour of the screen-sized hooks marker carrier (the `<Text>` that
 * carries `testID="tapsmith-hooks"`): black at alpha 1/255, which no one can
 * see but which is not zero.
 *
 * It cannot be `'transparent'`. React Native's new architecture (Fabric) on
 * Android passes colours as ints and uses `0` to mean "no colour set", and
 * `'transparent'` is `0x00000000`. The text colour is then never applied and
 * the TextView draws the whole marker string in the default colour, black,
 * across the top of the app. The same goes for any colour whose
 * alpha rounds to 0, such as `rgba(0,0,0,0.001)`.
 *
 * Nor can the carrier use `opacity: 0`: iOS can drop a view that is close to
 * fully transparent from the accessibility tree, and with it the marker.
 */
export const CARRIER_TEXT_COLOR = 'rgba(0,0,0,0.004)';
