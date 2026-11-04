#ifndef TAPSMITH_HID_PROTOCOL_H
#define TAPSMITH_HID_PROTOCOL_H

#include <stddef.h>

/* One parsed stdin command for the iOS HID helper.
 * Wire protocol (whitespace-delimited, coords in LOGICAL POINTS):
 *   d <x> <y>   touch down
 *   m <x> <y>   touch move (contact maintained)
 *   u <x> <y>   touch up
 *   c           cancel (lift at last point; x/y unused)
 *   t2 <x> <y> [<hold>]
 *               double-tap primitive: the helper injects both down/up pairs
 *               with in-process timing, so the inter-tap gap stays inside
 *               every double-tap recognizer window regardless of how loaded
 *               the daemon-side event loop is (four host round-trips were
 *               observed stretching the gap past the app's window on CI).
 *               <hold>: how long each tap holds its touch, in whole
 *               milliseconds (0..HID_MAX_HOLD_MS); without it, the helper's
 *               default.
 *   t1 <x> <y> [<hold>]
 *               single-tap primitive: down, a hold of <hold> milliseconds
 *               (0..HID_MAX_HOLD_MS; without it, the helper's default), up,
 *               timed in-process. Lines are paced at least a frame apart and
 *               each `d` waits for its delivery, so a `d`/`u` pair cannot hold
 *               a touch for less than a frame, and its hold grows with load.
 *               Only the up waits for delivery: the reply to the line comes
 *               once the touch has been lifted.
 */
typedef enum {
  HID_DOWN,
  HID_MOVE,
  HID_UP,
  HID_CANCEL,
  HID_DOUBLE_TAP,
  HID_TAP,
  HID_INVALID
} HidCmd;

/* holdMs when a line gives none. */
#define HID_DEFAULT_HOLD (-1)
/* The longest hold a tap's or double tap's line may ask for: a hold past
 * this would make the pair two separate taps, or a long press. */
#define HID_MAX_HOLD_MS 500

typedef struct {
  HidCmd cmd;
  double x;
  double y;
  /* A tap's or double tap's hold in milliseconds, or HID_DEFAULT_HOLD. */
  int holdMs;
} HidEvent;

/* Parse one protocol line. Returns cmd==HID_INVALID on malformed input
 * (unknown command, missing coordinate, or NULL). */
HidEvent hid_parse_line(const char *line);

/* Whether the simulator has a contact down after `cmd` was sent, given
 * whether it had one before (`contactDown`). A d or m (sent as a down)
 * leaves one; u, c, t1 and t2 end with none; an invalid line sends nothing. */
int hid_contact_after(HidCmd cmd, int contactDown);

/* Whether `cmd` must first lift a contact left down (a mirror gesture whose
 * u never came): a t1 or t2 down would otherwise only move that finger, and
 * the app would see no tap. */
int hid_lifts_held_contact(HidCmd cmd, int contactDown);

/* Convert a logical-point coordinate to a normalized 0..1 ratio, clamped to
 * [0,1]. Returns 0.0 when extentPt <= 0 (divide-by-zero guard). */
double hid_normalize(double point, double extentPt);

/* Write the index-th place to look for SimulatorKit's binary, for the
 * developer dir `devDir`, into `buf`. Xcode 26 and earlier ship it in the
 * developer dir's Library/PrivateFrameworks (index 0); Xcode 27 moved it to
 * the app's Contents/SharedFrameworks (index 1). `devDir` may also name the
 * app bundle itself ("/Applications/Xcode.app"), as DEVELOPER_DIR can.
 * Returns 1 when a path was written, 0 for no such index, a missing devDir,
 * or a path that does not fit in `len` bytes. */
int hid_simulatorkit_path(const char *devDir, int index, char *buf, size_t len);

#endif /* TAPSMITH_HID_PROTOCOL_H */
