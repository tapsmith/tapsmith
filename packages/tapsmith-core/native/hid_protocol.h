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
 * whether it had one before (`contactDown`) and whether the send succeeded
 * (`sent`). A d or m (sent as a down) leaves one; u, c, t1 and t2 end with
 * none; an invalid line sends nothing. A u or c that failed keeps the contact
 * it was lifting: the daemon streams those without waiting, so it sends no
 * recovery lift, and the next t1/t2 must lift the finger first. */
int hid_contact_after(HidCmd cmd, int contactDown, int sent);

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

/* The simulator's screen types (SimScreenProperties.screenType). */
#define HID_SCREEN_TYPE_INTEGRATED 0
#define HID_SCREEN_TYPE_TV_OUT 1
#define HID_SCREEN_TYPE_CARPLAY 2
#define HID_SCREEN_TYPE_RESIZABLE 4

/* The IndigoHID target that addresses "the" touch screen. On a device with
 * one integrated screen it reaches that screen. */
#define HID_LEGACY_TOUCH_TARGET 0x32u
/* A screen's own IndigoHID target is this OR'd with its screen id, the way
 * SimulatorKit's display view addresses the screen it shows. */
#define HID_SCREEN_TARGET_BASE 0x40000000u

/* One screen the simulator lists: its id, type and size in pixels. */
typedef struct {
  unsigned screenId;
  int screenType;
  double widthPx;
  double heightPx;
} HidScreen;

/* The screen a touch goes to, the IndigoHID target that reaches it, and the
 * pixel size its coordinates are normalised against. */
typedef struct {
  int found;
  unsigned screenId;
  unsigned target;
  double widthPx;
  double heightPx;
} HidTouchScreen;

/* Pick the screen touches go to from the `count` screens the simulator
 * lists, given the device type's main screen size in pixels (PILOT-1259).
 * A device with one integrated screen keeps HID_LEGACY_TOUCH_TARGET. A device
 * with several (the iPhone Duo) is addressed by the screen's own target: the
 * legacy one does not reach the screen the app is on there, and the touch is
 * still reported as delivered. The screen is the integrated one the main
 * size describes, else the lowest-numbered integrated one. found == 0 when no
 * integrated screen is listed. */
HidTouchScreen hid_touch_screen(const HidScreen *screens, size_t count,
                                double mainWidthPx, double mainHeightPx);

#endif /* TAPSMITH_HID_PROTOCOL_H */
