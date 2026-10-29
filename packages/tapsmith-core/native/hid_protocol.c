#include "hid_protocol.h"
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static double clamp01(double v) {
  if (v < 0.0) return 0.0;
  if (v > 1.0) return 1.0;
  return v;
}

double hid_normalize(double point, double extentPt) {
  if (extentPt <= 0.0) return 0.0;
  return clamp01(point / extentPt);
}

HidEvent hid_parse_line(const char *line) {
  HidEvent e = { .cmd = HID_INVALID, .x = 0.0, .y = 0.0 };
  if (!line) return e;

  while (*line && isspace((unsigned char)*line)) line++;
  char c = *line;

  if (c == 'c') { e.cmd = HID_CANCEL; return e; }

  int isDoubleTap = (c == 't' && line[1] == '2' &&
                     (line[2] == '\0' || isspace((unsigned char)line[2])));
  if (!isDoubleTap && c != 'd' && c != 'm' && c != 'u') return e;

  const char *rest = line + (isDoubleTap ? 2 : 1);
  char *end = NULL;
  double x = strtod(rest, &end);
  if (end == rest) return e;          /* no x parsed */
  const char *rest2 = end;
  double y = strtod(rest2, &end);
  if (end == rest2) return e;         /* no y parsed */

  e.x = x;
  e.y = y;
  e.cmd = isDoubleTap ? HID_DOUBLE_TAP
        : (c == 'd')  ? HID_DOWN
        : (c == 'm')  ? HID_MOVE
                      : HID_UP;
  return e;
}

int hid_simulatorkit_path(const char *devDir, int index, char *buf, size_t len) {
  if (!devDir || !buf || len == 0 || index < 0 || index > 1) return 0;
  size_t n = strlen(devDir);
  while (n > 1 && devDir[n - 1] == '/') n--;  /* drop trailing slashes */
  if (n == 0 || (n == 1 && devDir[0] == '/')) return 0;

  /* An app bundle stands for its Contents/Developer. */
  int isApp = n >= 4 && strncmp(devDir + n - 4, ".app", 4) == 0;
  const char *kit = "SimulatorKit.framework/SimulatorKit";
  int w;
  if (index == 0) {
    w = snprintf(buf, len, "%.*s%s/Library/PrivateFrameworks/%s", (int)n, devDir,
                 isApp ? "/Contents/Developer" : "", kit);
  } else if (isApp) {
    w = snprintf(buf, len, "%.*s/Contents/SharedFrameworks/%s", (int)n, devDir, kit);
  } else {
    /* The developer dir's parent: Contents, in an app bundle. */
    size_t parent = 0;
    for (size_t i = 0; i < n; i++) if (devDir[i] == '/') parent = i;
    w = snprintf(buf, len, "%.*s/SharedFrameworks/%s", (int)parent, devDir, kit);
  }
  return w >= 0 && (size_t)w < len;
}
