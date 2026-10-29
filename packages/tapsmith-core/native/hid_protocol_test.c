#include "hid_protocol.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static int approx(double a, double b) { return fabs(a - b) < 1e-9; }

int main(void) {
  HidEvent e;

  e = hid_parse_line("d 100 200");
  assert(e.cmd == HID_DOWN && approx(e.x, 100) && approx(e.y, 200));

  e = hid_parse_line("m 12.5 34.75");
  assert(e.cmd == HID_MOVE && approx(e.x, 12.5) && approx(e.y, 34.75));

  e = hid_parse_line("u 0 0");
  assert(e.cmd == HID_UP);

  e = hid_parse_line("c");
  assert(e.cmd == HID_CANCEL);

  e = hid_parse_line("t2 150 300");
  assert(e.cmd == HID_DOUBLE_TAP && approx(e.x, 150) && approx(e.y, 300));

  e = hid_parse_line("t2");            /* missing coords -> invalid */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("t20 1 2");       /* no delimiter after t2 -> invalid */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("t2\t150 300");   /* tab delimiter accepted */
  assert(e.cmd == HID_DOUBLE_TAP && approx(e.x, 150) && approx(e.y, 300));

  e = hid_parse_line("t 100 200");     /* bare 't' is not a command */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("   m 5 6");   /* leading whitespace tolerated */
  assert(e.cmd == HID_MOVE && approx(e.x, 5) && approx(e.y, 6));

  e = hid_parse_line("x 1 2");      /* unknown command */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("d 1");        /* missing y */
  assert(e.cmd == HID_INVALID);

  e = hid_parse_line("");           /* empty */
  assert(e.cmd == HID_INVALID);

  /* normalize + clamp to [0,1] */
  assert(approx(hid_normalize(100, 200), 0.5));
  assert(approx(hid_normalize(-10, 200), 0.0));   /* clamp low */
  assert(approx(hid_normalize(300, 200), 1.0));   /* clamp high */
  assert(approx(hid_normalize(5, 0), 0.0));       /* guard divide-by-zero */

  /* SimulatorKit candidates: Xcode <=26 layout first, then Xcode 27's. */
  char p[1024];
  const char *pf = "/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit";
  const char *sf = "/Applications/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit";
  assert(hid_simulatorkit_path("/Applications/Xcode.app/Contents/Developer", 0, p, sizeof p) && !strcmp(p, pf));
  assert(hid_simulatorkit_path("/Applications/Xcode.app/Contents/Developer", 1, p, sizeof p) && !strcmp(p, sf));
  assert(!hid_simulatorkit_path("/Applications/Xcode.app/Contents/Developer", 2, p, sizeof p));
  /* trailing slashes */
  assert(hid_simulatorkit_path("/Applications/Xcode.app/Contents/Developer//", 1, p, sizeof p) && !strcmp(p, sf));
  /* DEVELOPER_DIR may name the app bundle itself (xcrun accepts that) */
  assert(hid_simulatorkit_path("/Applications/Xcode.app", 0, p, sizeof p) && !strcmp(p, pf));
  assert(hid_simulatorkit_path("/Applications/Xcode.app/", 1, p, sizeof p) && !strcmp(p, sf));
  /* a developer dir outside an app bundle: its parent's SharedFrameworks */
  assert(hid_simulatorkit_path("/opt/dev", 1, p, sizeof p) &&
         !strcmp(p, "/opt/SharedFrameworks/SimulatorKit.framework/SimulatorKit"));
  /* refuses what does not fit, and bad input */
  assert(!hid_simulatorkit_path("/Applications/Xcode.app/Contents/Developer", 0, p, 10));
  assert(!hid_simulatorkit_path(NULL, 0, p, sizeof p));
  assert(!hid_simulatorkit_path("", 0, p, sizeof p));
  assert(!hid_simulatorkit_path("/x", -1, p, sizeof p));

  printf("all hid_protocol tests passed\n");
  return 0;
}
