// tapsmith-ios-hid.m — long-running iOS Simulator HID touch injector.
//
// Usage: tapsmith-ios-hid <udid>
//
// On startup: dlopen CoreSimulator + SimulatorKit, resolve the SimDevice for
// <udid>, open ONE persistent SimulatorKit.SimDeviceLegacyHIDClient, query the
// screen touches go to (hid_touch_screen) and its size+scale, then print
// "ready <wPx> <hPx> <scale> screen <id> target <hex>" to stdout.
//
// Then loop on stdin, one event per line (coords in LOGICAL POINTS):
//   d <x> <y>   touch down       m <x> <y>   touch move (contact held)
//   u <x> <y>   touch up          c           cancel (lift at last point)
// Prints "ok" or "err <msg>" per line: "err send rejected" when the simulator
// refused a send, "err send failed" when one was not confirmed in time. Exits 0 on stdin EOF.
// A down or move is not waited on (its reply is "ok" once it is sent): the
// lift that ends the gesture waits, and reports a failure of any of them.
// Startup failure: prints "fatal <msg>" to stderr and exits 1. While running,
// stderr says when the simulator was slow to confirm touches, or did not
// confirm one in time, so the daemon's log shows why a reply came late.
//
// HID mechanism is verbatim from the proven spike docs/superpowers/spikes/
// ios-hid/hidpoke.m (SimDeviceLegacyHIDClient + Indigo 320-byte message).
//
// Build (see build.rs): clang -fobjc-arc -framework Foundation \
//   -framework CoreGraphics -o tapsmith-ios-hid tapsmith-ios-hid.m hid_protocol.c
// (CoreSimulator/SimulatorKit are dlopen'd at runtime; not linked.)

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <dlfcn.h>
#import <mach/mach_time.h>
#include <locale.h>
#include <stdatomic.h>
#include "hid_protocol.h"

#pragma pack(push, 4)
typedef struct {
  unsigned int msgh_bits, msgh_size, msgh_remote_port, msgh_local_port,
      msgh_voucher_port;
  int msgh_id;
} MachMessageHeader;

typedef struct {
  unsigned int field1, field2, field3;
  double xRatio, yRatio, field6, field7, field8;
  unsigned int field9, field10, field11, field12, field13;
  double field14, field15, field16, field17, field18;
} IndigoTouch;

typedef struct {
  unsigned int field1;
  unsigned long long timestamp;
  unsigned int field3;
  IndigoTouch touch;
} IndigoPayload;

typedef struct {
  MachMessageHeader header;
  unsigned int innerSize;
  unsigned char eventType;
  IndigoPayload payload;
} IndigoMessage;
#pragma pack(pop)

enum { DirDown = 1, DirUp = 2 };

typedef IndigoMessage *(*MouseNSEventFn)(CGPoint *, CGPoint *, int, int, BOOL);
static MouseNSEventFn gMouseFn = NULL;

/* Delivery failures reported by fire-and-forget sends (a t1/t2's down and
 * inner events), counted from the completion queue. Reset at the start of
 * each t1/t2 and read after its waited final lift: the client delivers in
 * order, so the earlier events' completions have run by then. */
static atomic_int gNoWaitFailures;

/* Set when a send's completion reported an error, as opposed to a send whose
 * delivery was not confirmed in time. Reset at the start of each line. A
 * helper whose simulator rebooted under it gets every send rejected at once,
 * and says so (`err send rejected`), so the daemon can tell it from one that
 * is only slow (`err send failed`, PILOT-1072). */
static atomic_int gRejected;

/* The IndigoHID target every touch addresses (hid_touch_screen). */
static unsigned gTouchTarget = HID_LEGACY_TOUCH_TARGET;

/* Confirmations slower than kSlowConfirmMs since the last report, and the
 * slowest of them: reported on stderr after the next waited line. */
static atomic_int gSlowConfirms;
static atomic_llong gSlowestConfirmMs;
static const long long kSlowConfirmMs = 500;

static long long nowMs(void) {
  return (long long)(clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000000);
}

/* Count a confirmation that took `ms`, if it was slow. Called on the
 * completion queue, and on the main thread for a wait that timed out. */
static void noteConfirm(long long ms) {
  if (ms < kSlowConfirmMs) return;
  atomic_fetch_add(&gSlowConfirms, 1);
  long long prev = atomic_load(&gSlowestConfirmMs);
  while (ms > prev && !atomic_compare_exchange_weak(&gSlowestConfirmMs, &prev, ms)) {
  }
}

/* Say on stderr how many confirmations were slow since the last report. */
static void reportSlowConfirms(void) {
  int n = atomic_exchange(&gSlowConfirms, 0);
  long long slowest = atomic_exchange(&gSlowestConfirmMs, 0);
  if (n > 0) {
    fprintf(stderr, "slow: the simulator took up to %lld ms to confirm %d touch event%s\n",
            slowest, n, n == 1 ? "" : "s");
  }
}

// Build the canonical 320-byte touch Indigo message (verbatim from the spike).
static IndigoMessage *makeTouchMessage(double xRatio, double yRatio, int direction) {
  CGPoint p = CGPointMake(xRatio, yRatio);
  IndigoMessage *base = gMouseFn(&p, NULL, gTouchTarget, direction, 0x0);
  if (!base) return NULL;  // private API returned nothing — don't deref/crash
  base->payload.touch.xRatio = xRatio;
  base->payload.touch.yRatio = yRatio;

  IndigoTouch *payload = &base->payload.touch;
  size_t messageSize = sizeof(IndigoMessage) + sizeof(IndigoPayload);
  size_t stride = sizeof(IndigoPayload);

  IndigoMessage *message = calloc(1, messageSize);
  message->innerSize = sizeof(IndigoPayload);
  message->eventType = 0x02;
  message->payload.field1 = 0x0000000b;
  message->payload.timestamp = mach_absolute_time();
  memcpy(&message->payload.touch, payload, sizeof(IndigoTouch));
  free(base);

  unsigned char *bp = (unsigned char *)&message->payload;
  IndigoPayload *second = (IndigoPayload *)(bp + stride);
  memcpy(second, bp, stride);
  second->touch.field1 = 0x00000001;
  second->touch.field2 = 0x00000002;
  return message;
}

// `xcode-select -p`, or nil when it fails or prints nothing.
static NSString *selectedDeveloperDir(void) {
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xcode-select"];
  task.arguments = @[ @"-p" ];
  NSPipe *out = [NSPipe pipe];
  task.standardOutput = out;
  task.standardError = [NSFileHandle fileHandleWithNullDevice];
  if (![task launchAndReturnError:nil]) return nil;
  NSData *data = [out.fileHandleForReading readDataToEndOfFile];
  [task waitUntilExit];
  if (task.terminationStatus != 0) return nil;
  NSString *path = [[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
      stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  return path.length ? path : nil;
}

static id msgSend_id(id self, SEL op) {
  return ((id(*)(id, SEL))objc_msgSend)(self, op);
}

/* The screens `device` lists (its IO ports that are screens), up to `max`,
 * into `out`. Returns how many, or -1 when they could not be read. */
static int listScreens(id device, HidScreen *out, int max) {
  @try {
    id io = msgSend_id(device, NSSelectorFromString(@"io"));
    NSArray *ports = io ? msgSend_id(io, NSSelectorFromString(@"ioPorts")) : nil;
    if (![ports isKindOfClass:[NSArray class]]) return -1;
    SEL propsSel = NSSelectorFromString(@"screenProperties");
    SEL idSel = NSSelectorFromString(@"screenID");
    SEL typeSel = NSSelectorFromString(@"screenType");
    SEL sizeSel = NSSelectorFromString(@"pixelSize");
    int n = 0;
    for (id port in ports) {
      id desc = msgSend_id(port, NSSelectorFromString(@"descriptor"));
      if (![desc respondsToSelector:propsSel]) continue;
      id props = msgSend_id(desc, propsSel);
      if (!props || ![props respondsToSelector:idSel] || ![props respondsToSelector:typeSel]) continue;
      if (n == max) break;
      out[n].screenId = ((unsigned (*)(id, SEL))objc_msgSend)(props, idSel);
      out[n].screenType = (int)((NSInteger (*)(id, SEL))objc_msgSend)(props, typeSel);
      CGSize px = [props respondsToSelector:sizeSel]
          ? ((CGSize (*)(id, SEL))objc_msgSend)(props, sizeSel) : CGSizeZero;
      out[n].widthPx = px.width;
      out[n].heightPx = px.height;
      n++;
    }
    return n;
  } @catch (id e) {
    return -1;
  }
}

int main(int argc, char **argv) {
  // Parse coordinates with '.' as the decimal separator regardless of the host
  // locale: strtod() (in hid_parse_line) is LC_NUMERIC-dependent and would
  // mis-parse "12.5" on comma-decimal locales (e.g. fr_FR).
  setlocale(LC_NUMERIC, "C");
  @autoreleasepool {
    if (argc < 2) { fprintf(stderr, "fatal usage: %s <udid>\n", argv[0]); return 1; }
    NSString *udid = [NSString stringWithUTF8String:argv[1]];

    // The Xcode to drive: DEVELOPER_DIR, else the one `xcode-select` picked
    // (not necessarily /Applications/Xcode.app), else the default install.
    NSString *devDirStr = nil;
    const char *envDev = getenv("DEVELOPER_DIR");
    if (envDev && *envDev) devDirStr = [NSString stringWithUTF8String:envDev];
    if (!devDirStr) devDirStr = selectedDeveloperDir();
    if (!devDirStr) devDirStr = @"/Applications/Xcode.app/Contents/Developer";
    const char *devDir = devDirStr.UTF8String;

    void *cs = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW);
    if (!cs) { fprintf(stderr, "fatal dlopen CoreSimulator: %s\n", dlerror()); return 1; }
    Class SimServiceContext = NSClassFromString(@"SimServiceContext");
    if (!SimServiceContext) { fprintf(stderr, "fatal no SimServiceContext\n"); return 1; }

    // SimulatorKit moved between Xcode releases (hid_simulatorkit_path):
    // try each place in turn and report every miss if none loads.
    void *sk = NULL;
    NSMutableString *skErrors = [NSMutableString string];
    char skPath[PATH_MAX];
    for (int i = 0; !sk && hid_simulatorkit_path(devDir, i, skPath, sizeof skPath); i++) {
      sk = dlopen(skPath, RTLD_NOW);
      if (!sk) {
        const char *why = dlerror();
        [skErrors appendFormat:@"%@%s", skErrors.length ? @"; " : @"", why ? why : skPath];
      }
    }
    if (!sk) { fprintf(stderr, "fatal dlopen SimulatorKit (developer dir %s): %s\n", devDir, skErrors.UTF8String); return 1; }
    gMouseFn = (MouseNSEventFn)dlsym(sk, "IndigoHIDMessageForMouseNSEvent");
    if (!gMouseFn) { fprintf(stderr, "fatal no IndigoHIDMessageForMouseNSEvent\n"); return 1; }

    NSError *err = nil;
    SEL sctxSel = NSSelectorFromString(@"sharedServiceContextForDeveloperDir:error:");
    id sctx = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
        SimServiceContext, sctxSel, [NSString stringWithUTF8String:devDir], &err);
    if (!sctx) { fprintf(stderr, "fatal sharedServiceContext: %s\n", err.description.UTF8String); return 1; }

    id deviceSet = ((id(*)(id, SEL, NSError **))objc_msgSend)(
        sctx, NSSelectorFromString(@"defaultDeviceSetWithError:"), &err);
    if (!deviceSet) { fprintf(stderr, "fatal defaultDeviceSet: %s\n", err.description.UTF8String); return 1; }

    NSArray *devices = msgSend_id(deviceSet, NSSelectorFromString(@"devices"));
    id device = nil;
    for (id d in devices) {
      id u = msgSend_id(d, NSSelectorFromString(@"UDID"));
      NSString *us = msgSend_id(u, NSSelectorFromString(@"UUIDString"));
      if ([us caseInsensitiveCompare:udid] == NSOrderedSame) { device = d; break; }
    }
    if (!device) { fprintf(stderr, "fatal device %s not found\n", udid.UTF8String); return 1; }

    id deviceType = msgSend_id(device, NSSelectorFromString(@"deviceType"));
    CGSize screenPx = ((CGSize(*)(id, SEL))objc_msgSend)(deviceType, NSSelectorFromString(@"mainScreenSize"));
    float scale = ((float(*)(id, SEL))objc_msgSend)(deviceType, NSSelectorFromString(@"mainScreenScale"));
    if (scale <= 0) scale = 1;

    // The screen touches go to (PILOT-1259). A device with two integrated
    // screens (the iPhone Duo) is not reached by the legacy touch target:
    // the simulator accepts the touch and the app never sees it. Without the
    // screen list there is no telling, so refuse: the daemon then uses the
    // agent's touch, which always reaches the app.
    HidScreen screens[16];
    int screenCount = listScreens(device, screens, 16);
    if (screenCount < 0) { fprintf(stderr, "fatal could not read the simulator's screens\n"); return 1; }
    HidTouchScreen touchScreen = hid_touch_screen(screens, (size_t)screenCount, screenPx.width, screenPx.height);
    if (!touchScreen.found) { fprintf(stderr, "fatal the simulator lists no touch screen (%d screens)\n", screenCount); return 1; }
    gTouchTarget = touchScreen.target;
    double widthPt = touchScreen.widthPx / scale;
    double heightPt = touchScreen.heightPx / scale;

    NSBundle *skBundle = [NSBundle bundleWithIdentifier:@"com.apple.SimulatorKit"];
    [skBundle loadAndReturnError:nil];
    Class hidClientClass = objc_lookUpClass("SimulatorKit.SimDeviceLegacyHIDClient");
    if (!hidClientClass) { fprintf(stderr, "fatal no SimDeviceLegacyHIDClient\n"); return 1; }
    id hidClient = [hidClientClass alloc];
    hidClient = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(
        hidClient, NSSelectorFromString(@"initWithDevice:error:"), device, &err);
    if (!hidClient) { fprintf(stderr, "fatal initWithDevice: %s\n", err.description.UTF8String); return 1; }

    SEL sendSel = NSSelectorFromString(@"sendWithMessage:freeWhenDone:completionQueue:completion:");
    dispatch_queue_t cq = dispatch_queue_create("tapsmith.hid.cq", DISPATCH_QUEUE_SERIAL);

    // Send one touch event and wait up to `waitSeconds` for its delivery.
    BOOL (^sendTouchWithin)(double, double, int, int64_t) = ^BOOL(double rx, double ry, int dir, int64_t waitSeconds) {
      IndigoMessage *m = makeTouchMessage(rx, ry, dir);
      if (!m) return NO;  // couldn't build the touch message — report failure
      __block NSError *serr = nil;
      dispatch_semaphore_t sem = dispatch_semaphore_create(0);
      long long sentAt = nowMs();
      void (^completion)(NSError *) = ^(NSError *e) {
        serr = e;
        if (e) atomic_store(&gRejected, 1);
        noteConfirm(nowMs() - sentAt);
        dispatch_semaphore_signal(sem);
      };
      ((void(*)(id, SEL, IndigoMessage *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
          hidClient, sendSel, m, YES, cq, completion);
      // A timeout must NOT be reported as success: on timeout serr is still nil
      // (the completion never fired) but the event was not delivered, so check
      // the wait's return code too. If the block fires late it safely writes to
      // the ARC-retained __block serr box and signals an unwaited semaphore — a
      // harmless no-op nobody reads.
      long rc = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, waitSeconds * NSEC_PER_SEC));
      if (rc != 0) {
        fprintf(stderr, "unconfirmed: the simulator did not confirm a touch %s within %lld ms\n",
                dir == DirUp ? "lift" : "press", nowMs() - sentAt);
      }
      return rc == 0 && serr == nil;
    };
    BOOL (^sendTouch)(double, double, int) = ^BOOL(double rx, double ry, int dir) {
      return sendTouchWithin(rx, ry, dir, 2);
    };
    // A whole tap's lift gets longer to be confirmed: the daemon waits for
    // this answer, and on a loaded host the confirmation of a delivered lift
    // has come after 2 s, which would report a tap the app got as failed.
    const int64_t kTapLiftWaitSeconds = 4;

    // Fire-and-forget send for the intermediate events of a composite
    // gesture (double-tap): the client delivers in order, and recognizers
    // key on the message timestamps stamped at CREATION time — so pacing
    // the creations paces the gesture, while waiting on each completion
    // (up to 2s under CI load) stretched the app-visible inter-tap gap
    // past double-tap recognizer windows.
    // NO when the event could not be built; a delivery failure is counted
    // in gNoWaitFailures when its completion reports it.
    BOOL (^sendTouchNoWait)(double, double, int) = ^BOOL(double rx, double ry, int dir) {
      IndigoMessage *m = makeTouchMessage(rx, ry, dir);
      if (!m) return NO;
      long long sentAt = nowMs();
      ((void(*)(id, SEL, IndigoMessage *, BOOL, dispatch_queue_t, void(^)(NSError *)))objc_msgSend)(
          hidClient, sendSel, m, YES, cq, ^(NSError *e) {
            noteConfirm(nowMs() - sentAt);
            if (e) {
              atomic_fetch_add(&gNoWaitFailures, 1);
              atomic_store(&gRejected, 1);
            }
          });
      return YES;
    };

    // Announce readiness; the daemon reads this line to confirm the helper is up.
    printf("ready %.0f %.0f %.1f screen %u target 0x%x\n", touchScreen.widthPx, touchScreen.heightPx,
           scale, touchScreen.screenId, touchScreen.target);
    fflush(stdout);

    // Process stdin events. Track the last point so a bare `c` can lift there.
    double lastX = 0, lastY = 0;
    // Whether a d/m left a finger down that no u/c has lifted yet.
    int contactDown = 0;
    // Pace injections to at least ~a frame apart. iOS never engages the pan
    // recognizer for a gesture whose entire path lands within a single frame:
    // a synthetic stream written back-to-back (e.g. a test replaying a drag
    // with no sleeps) injects in ~2ms and scrolls NOTHING while every send
    // reports success; the same path at ≥1-frame spacing scrolls normally
    // (measured on iOS 26.1). Human-paced mirror input arrives slower than
    // this floor and is unaffected.
    const uint64_t kMinEventSpacingUs = 12000;
    // A double tap's press when its line gives no hold (an older daemon).
    const useconds_t kDefaultDoubleTapHoldUs = 40000;
    // A single tap's press when its line gives no hold: long enough for a
    // control that reads a touch on a display frame (a UISwitch).
    const useconds_t kDefaultTapHoldUs = 20000;
    uint64_t lastInjectUs = 0;
    char buf[1024];
    while (fgets(buf, sizeof(buf), stdin)) {
      HidEvent ev = hid_parse_line(buf);
      atomic_store(&gRejected, 0);
      if (ev.cmd != HID_INVALID) {
        uint64_t nowUs = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000;
        if (lastInjectUs != 0 && nowUs - lastInjectUs < kMinEventSpacingUs) {
          usleep((useconds_t)(kMinEventSpacingUs - (nowUs - lastInjectUs)));
        }
      }
      BOOL ok = NO;
      // A whole tap after a gesture whose lift never came (a UI-mode mirror
      // flick cut short): lift that finger first, or the tap's down would only
      // move it and the app would see no tap.
      if (hid_lifts_held_contact(ev.cmd, contactDown)) {
        // If that lift failed, the finger may still be down: fail a `t1`
        // rather than move the finger and report a tap the app never saw (the
        // contact stays held, so the next tap tries the lift again). A `t2`
        // goes ahead: the daemon does not read its reply, so skipping it
        // would report a double tap that never happened.
        BOOL lifted = sendTouch(hid_normalize(lastX, widthPt), hid_normalize(lastY, heightPt), DirUp);
        if (!lifted && ev.cmd == HID_TAP) {
          printf(atomic_load(&gRejected) ? "err send rejected\n" : "err send failed\n");
          fflush(stdout);
          continue;
        }
        contactDown = 0;
      }
      switch (ev.cmd) {
        // A down and its moves are not waited on, as a tap's down is not: the
        // client delivers in order, so the lift's confirmation covers them.
        // Waiting on each made a scroll drag (~40 lines) as slow as 40 of the
        // simulator's confirmations, which a busy simulator can stretch to
        // seconds each: the lift's reply then missed the daemon's deadline,
        // and every new helper hung on the same drag (PILOT-1293).
        case HID_DOWN:
          atomic_store(&gNoWaitFailures, 0);
          // fall through
        case HID_MOVE:  // moves keep contact: same DirDown direction as the spike
          lastX = ev.x; lastY = ev.y;
          ok = sendTouchNoWait(hid_normalize(ev.x, widthPt), hid_normalize(ev.y, heightPt), DirDown);
          break;
        case HID_UP:
          // Waited like a tap's lift; `ok` also needs the gesture's unwaited
          // down and moves to have been delivered.
          lastX = ev.x; lastY = ev.y;
          ok = sendTouchWithin(hid_normalize(ev.x, widthPt), hid_normalize(ev.y, heightPt), DirUp,
                               kTapLiftWaitSeconds)
              && atomic_load(&gNoWaitFailures) == 0;
          atomic_store(&gNoWaitFailures, 0);
          break;
        case HID_CANCEL:
          ok = sendTouch(hid_normalize(lastX, widthPt), hid_normalize(lastY, heightPt), DirUp);
          break;
        case HID_TAP: {
          // Down, hold, up timed in-process: the down is fire-and-forget so
          // the hold between the two events' creation timestamps (what the
          // app's touch handling sees) is the usleep, not the down's delivery
          // round trip. The up waits, so `ok` means the touch was lifted, and
          // that the down's delivery reported no failure.
          lastX = ev.x; lastY = ev.y;
          double nx = hid_normalize(ev.x, widthPt);
          double ny = hid_normalize(ev.y, heightPt);
          useconds_t holdUs = ev.holdMs == HID_DEFAULT_HOLD
              ? kDefaultTapHoldUs
              : (useconds_t)ev.holdMs * 1000;
          // `ok` also needs the down: a lift alone presses nothing.
          atomic_store(&gNoWaitFailures, 0);
          if (!sendTouchNoWait(nx, ny, DirDown)) break;
          usleep(holdUs);
          ok = sendTouchWithin(nx, ny, DirUp, kTapLiftWaitSeconds)
              && atomic_load(&gNoWaitFailures) == 0;
          break;
        }
        case HID_DOUBLE_TAP: {
          // Full double-tap with in-process timing: each press held as the
          // line asks (kDefaultDoubleTapHoldUs without a hold), ~120ms
          // inter-tap gap — inside every double-tap recognizer window. The
          // first three events are fire-and-forget so the gap between the
          // CREATION timestamps (what recognizers key on) is exactly the
          // usleep pacing; only the final lift waits for its completion so
          // `ok` still reflects delivery.
          lastX = ev.x; lastY = ev.y;
          double nx = hid_normalize(ev.x, widthPt);
          double ny = hid_normalize(ev.y, heightPt);
          useconds_t holdUs = ev.holdMs == HID_DEFAULT_HOLD
              ? kDefaultDoubleTapHoldUs
              : (useconds_t)ev.holdMs * 1000;
          atomic_store(&gNoWaitFailures, 0);
          if (!sendTouchNoWait(nx, ny, DirDown)) break;
          usleep(holdUs);
          BOOL sent = sendTouchNoWait(nx, ny, DirUp);
          usleep(120000);
          sent = sent && sendTouchNoWait(nx, ny, DirDown);
          usleep(holdUs);
          ok = sendTouch(nx, ny, DirUp) && sent && atomic_load(&gNoWaitFailures) == 0;
          break;
        }
        case HID_INVALID:
          printf("err invalid line\n"); fflush(stdout);
          continue;
      }
      lastInjectUs = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000;
      contactDown = hid_contact_after(ev.cmd, contactDown, ok);
      if (ev.cmd != HID_DOWN && ev.cmd != HID_MOVE) reportSlowConfirms();
      printf(ok ? "ok\n" : atomic_load(&gRejected) ? "err send rejected\n" : "err send failed\n");
      fflush(stdout);
    }
    return 0;
  }
}
