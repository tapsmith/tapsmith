/**
 * The Mac running Tapsmith, as the device a `platform: 'macos'` config
 * (experimental) tests on.
 */

/** The daemon lists this Mac under this serial (`--platform macos`). */
export const MACOS_HOST_SERIAL = 'macos-host';

/**
 * The serial a macOS run targets: always this Mac. A `device` pin naming
 * anything else is refused, not ignored.
 */
export function macosTargetSerial(pinned: string | undefined): string {
  if (pinned !== undefined && pinned !== MACOS_HOST_SERIAL) {
    throw new Error(
      `platform: 'macos' runs on this Mac (${MACOS_HOST_SERIAL}), but \`device\` names ${pinned}. Remove \`device\`.`,
    );
  }
  return MACOS_HOST_SERIAL;
}
