#!/bin/bash
# Is a simulator/emulator actively in use by someone else's Tapsmith session?
#
# Exit 0 = FREE   (no active-use signal; claim a target without asking)
# Exit 3 = BUSY   (a live session holds a device; ask the user before claiming it)
#
# Leases (device-lease.sh) are shown per target. FREE means no live session;
# a target marked [LEASED] still belongs to its holder — lease one first.
#
# Usage: device-availability.sh                      full report
#        device-availability.sh --pick <ios|android> [--owner <lease owner>]
#            print one target that is not in use, not attached and not leased
#            by anyone but <owner>. Exit 0 with its id; 1 if every booted target
#            is taken (or a live session on that platform drives an unidentified
#            device); 4 if no target of that platform is booted at all — boot
#            one, that is not "busy". Poll this to wait for a device:
#            `device-lease.sh acquire --wait` only waits on leases and knows
#            nothing about unleased live sessions.
#        device-availability.sh --check <id> [--owner <lease owner>]
#            exit 0 if that one target is free for <owner> (use after leasing
#            it, before launching), 1 if it is taken, 4 if it is not booted.
#
# The whole point is separating live sessions from leftovers. This machine
# normally carries dozens of orphaned processes and booted devices that are NOT
# in use; treating those as "busy" makes the check useless.

PICK=""; CHECK=""; PICK_OWNER=""
usage_exit() { echo "usage: $0 [--pick ios|android | --check <id>] [--owner <owner>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  # Every option takes a value; a missing one is a usage error, not a loop.
  [ $# -ge 2 ] && [ -n "$2" ] || usage_exit
  case "$1" in
    --pick) PICK="$2" ;;
    --check) CHECK="$2" ;;
    --owner) PICK_OWNER="$2" ;;
    *) usage_exit ;;
  esac
  shift 2
done
case "$PICK" in ""|ios|android) ;; *) echo "--pick takes ios or android" >&2; exit 2 ;; esac
[ -n "$PICK" ] && [ -n "$CHECK" ] && usage_exit

ADB=""
for c in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Library/Android/sdk"; do
  [ -n "$c" ] && [ -x "$c/platform-tools/adb" ] && { ADB="$c/platform-tools/adb"; break; }
done
[ -n "$ADB" ] || ADB=$(command -v adb 2>/dev/null)
BUSY_REASONS=()
NOISE=()

ps_all=$(ps -eo pid,ppid,etime,command)

# Processes matching a pattern, one "pid ppid etime cmd" line each.
match() { printf '%s\n' "$ps_all" | grep -E "$1" | grep -v -e ' grep ' -e 'device-availability' -e 'npm exec '; }
# Same, but only children whose parent is still alive (PPID != 1) — a PPID of 1
# means the launcher died and this is an orphan.
match_parented() { match "$1" | awk '$2 != 1'; }
count() { printf '%s\n' "$1" | grep -c . ; }

# ── Tier A: signals that mean a device is really being driven ────────────────

# 1. A live Rust daemon. Nothing reaches a device without one, so this is the
#    single strongest signal — and its absence clears almost every other one.
# Anchor on the executable (first word of the command): a bare 'tapsmith-core'
# substring also matches cargo/rustc builds inside packages/tapsmith-core and
# any shell whose -c string mentions it — including the caller's own.
daemons=$(match '^ *[0-9]+ +[0-9]+ +[^ ]+ +([^ ]*/)?tapsmith-core( |$)')
daemon_pids=$(printf '%s\n' "$daemons" | awk 'NF {print $1}')
held_serials=""
orphan_daemons=" "
fwd_list=$([ -x "$ADB" ] && "$ADB" forward --list 2>/dev/null)
unidentified_live=""   # platforms ("ios"/"android") with a live daemon whose device is unknown
live_ios_daemon=""
live_daemon=""
adopted_udids=""
if [ -n "$daemon_pids" ]; then
  for p in $daemon_pids; do
    # Count only connections *to the daemon's gRPC port*: the daemon's own
    # outbound sockets (its persistent agent stream, proxy upstreams) survive
    # after its client has gone, and would make every orphan look live.
    cmdline=$(ps -o command= -p "$p")
    gport=$(printf '%s' "$cmdline" | sed -nE 's/.*--port[ =]([0-9]+).*/\1/p'); gport=${gport:-50051}
    est=$(lsof -nP -a -p "$p" -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null |
          sed -n 's/^n//p' | awk -F'->' -v gp="$gport" '{ n=split($1, a, ":"); if (a[n]==gp) c++ } END { print c+0 }')
    age=$(ps -o etime= -p "$p" | tr -d ' ')
    if [ "$est" -gt 0 ]; then
      BUSY_REASONS+=("daemon pid $p (age $age) has $est live gRPC client connection(s) on port $gport")
      live_daemon=1
      # Which device is it driving? Android: its long-lived `adb -s <serial> …`
      # children (logcat, forwards). iOS: its xcodebuild agent runner's
      # `-destination id=<udid>`.
      kids=$(printf '%s\n' "$ps_all" | awk -v d="$p" '$2==d')
      # Android, reliably: the daemon talks to its agent through an
      # `adb forward tcp:<host port>`, so map its outbound 127.0.0.1 connections
      # through `adb forward --list` (serial tcp:<host> tcp:<device>).
      rports=$(lsof -nP -a -p "$p" -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null | sed -n 's/^n//p' |
               awk -F'->' 'NF==2 { n=split($2, a, ":"); print a[n] }' | sort -u)
      s_fwd=$(for rp in $rports; do printf '%s\n' "$fwd_list" | awk -v rp="tcp:$rp" '$2==rp {print $1}'; done | sort -u)
      s_for=$( { printf '%s\n' "$kids" | grep -oE 'adb -s [^ ]+' | awk '{print $3}'; printf '%s\n' "$s_fwd"; } | grep . | sort -u)
      u_for=$(printf '%s\n' "$kids" | grep -oE 'id=[0-9A-Fa-f-]{25,40}' | cut -d= -f2 | sort -u)
      # sort -u output is newline-separated; inuse() matches space-delimited words.
      held_serials="$held_serials $(printf '%s ' $s_for $u_for)"
      dplat=$(printf '%s' "$cmdline" | sed -nE 's/.*--platform[ =](ios|android).*/\1/p')
      [ -z "$dplat" ] && [ -n "$s_for" ] && dplat=android
      [ -z "$dplat" ] && [ -n "$u_for" ] && dplat=ios
      [ "$dplat" != android ] && live_ios_daemon=1   # only an iOS (or unknown) daemon can adopt a runner
      if [ -z "$s_for$u_for" ]; then
        case "$dplat" in
          ios|android) unidentified_live="$unidentified_live $dplat" ;;
          *) unidentified_live="$unidentified_live ios android" ;;
        esac
      fi
    else
      NOISE+=("daemon pid $p (age $age) running with no client attached — likely orphaned")
      orphan_daemons="$orphan_daemons$p "
    fi
  done
fi

# 2. A UI server: a published port with something actually listening on it.
#    A stale port file with no listener is a leftover, not a session.
for f in "$HOME"/.tapsmith/daemons/ui-port-*; do
  [ -e "$f" ] || continue
  port=$(tr -dc '0-9' < "$f")
  [ -n "$port" ] || continue
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    BUSY_REASONS+=("UI server listening on port $port (from $(basename "$f"))")
  else
    NOISE+=("stale ui-port file $(basename "$f") — port $port has no listener")
  fi
done
ui_procs=$(match 'tapsmith[^ ]*(dist/)?cli\.js test.*--ui|(^|[ /.])dist/cli\.js test.*--ui|tapsmith test.*--ui')
[ -n "$(printf '%s' "$ui_procs")" ] && BUSY_REASONS+=("$(count "$ui_procs") live UI-mode process(es)")

# 3. A run in flight: the CLI, a parallel worker, a watch child, a UI worker.
# Anchored to Tapsmith's own paths: a bare 'cli.js test' also matches
# Playwright's '@playwright/test/cli.js test-server', and the web-tests suites
# are device-free — flagging one as a device claim is a false positive.
# Top-level CLI runs count whatever their parent: a run whose launcher shell
# exited (nohup, a detached background job) is reparented to PID 1 but is
# still driving a device. Only worker *children* orphaned by a dead parent are
# leftovers, so those stay parented-only.
runs=$( { match '(^|[ /.])dist/cli\.js test( |$)|node_modules/\.bin/tapsmith test|npx tapsmith test|exec tapsmith test'
          match_parented 'tapsmith[^ ]*/(dist/)?(worker-runner|watch-run|ui-worker|ui-mode/ui-worker)'; } | grep . )
[ -n "$(printf '%s' "$runs")" ] && BUSY_REASONS+=("$(count "$runs") live run/worker process(es)")

# (A "results dir written recently" signal used to live here. It flagged the
# caller's own just-finished probe as BUSY and missed worktrees; in-flight runs
# are already caught by their processes and their daemon's client connection.)

# ── Tier B: agent-side processes, which only count next to a live driver ─────
# iOS XCUITest runners get orphaned to PPID 1 and outlive their daemons by
# days; a lingering Android instrumentation is the same story. They mean
# "in use" only when something above is also live.
ios_agents=$(match 'xcodebuild.*test-without-building')
# A runner is orphaned if its parent is gone (PPID 1) or is itself an orphaned,
# clientless daemon — a crashed or Ctrl-C'd run leaves exactly that behind.
ios_parented=$(printf '%s\n' "$ios_agents" | awk -v od="$orphan_daemons" 'NF && $2 != 1 && index(od, " " $2 " ") == 0')
ios_orphans=$(printf '%s\n' "$ios_agents" | awk -v od="$orphan_daemons" 'NF && ($2 == 1 || index(od, " " $2 " ") > 0)')
if [ -n "$(printf '%s' "$ios_parented")" ] && [ ${#BUSY_REASONS[@]} -gt 0 ]; then
  BUSY_REASONS+=("$(count "$ios_parented") parented xcodebuild agent runner(s)")
fi
if [ -n "$(printf '%s' "$ios_orphans")" ]; then
  if [ -n "$live_ios_daemon" ]; then
    # A live iOS daemon reuses any runner that answers ping, orphaned or not, so
    # while one exists these may be in use: not leftovers, never cleanup.
    adopted_udids=$(printf '%s\n' "$ios_orphans" | grep -oE 'id=[0-9A-Fa-f-]{25,40}' | cut -d= -f2 | sort -u)
    BUSY_REASONS+=("$(count "$ios_orphans") orphaned xcodebuild runner(s) a live daemon may have adopted — do not kill")
  else
    NOISE+=("$(count "$ios_orphans") xcodebuild agent runner(s), no live driver — leftovers")
  fi
fi

# ── Tier B noise worth reporting so it is not mistaken for use ───────────────
idle_mcp=$(match 'tapsmith mcp-server')
[ -n "$(printf '%s' "$idle_mcp")" ] && [ -z "$daemon_pids" ] &&
  NOISE+=("$(count "$idle_mcp") registered MCP server(s) with no daemon — idle, not driving a device")
orphan_logcat=$(match 'adb .*logcat' | awk '$2 == 1')
[ -n "$(printf '%s' "$orphan_logcat")" ] &&
  NOISE+=("$(count "$orphan_logcat") orphaned adb logcat process(es)")
orphan_workers=$(match 'ui-worker' | awk '$2 == 1')
[ -n "$(printf '%s' "$orphan_workers")" ] &&
  NOISE+=("$(count "$orphan_workers") orphaned ui-worker process(es) from a dead UI server")

# ── Which targets exist, and which are held ─────────────────────────────────
held_udids=$(printf '%s\n' "$ios_parented" | grep -oE 'id=[0-9A-Fa-f-]+' | cut -d= -f2)
LEASE="$(dirname "$0")/device-lease.sh"
inuse() {
  case " $held_serials " in *" $1 "*) printf '  [IN USE by a live session]'; return;; esac
  case " $(printf '%s ' $adopted_udids) " in *" $1 "*) printf '  [IN USE: runner may be adopted by a live daemon]';; esac
}
# leased <target> <platform: ios|android>. A platform lease (target
# "platform:ios" / "platform:android") covers every target of that platform:
# it is how a run that picks or boots its own devices (--workers N, device
# groups) claims them, since those devices cannot be named in advance.
leased() {
  local h rc
  # holder exits 0 = held, 1 = free; anything else is a lease-tool fault, and
  # an unknown lease state must never read as free (fail closed).
  h=$("$LEASE" holder "$1" 2>/dev/null); rc=$?
  if [ $rc -eq 0 ]; then printf '  [LEASED by %s — not yours unless you are %s]' "$h" "$h"; return; fi
  [ $rc -ne 1 ] && { printf '  [LEASE STATE UNKNOWN: device-lease.sh failed (%s)]' "$rc"; return; }
  h=$("$LEASE" holder "platform:$2" 2>/dev/null); rc=$?
  if [ $rc -eq 0 ]; then printf '  [LEASED: whole %s platform, by %s — not yours unless you are %s]' "$2" "$h" "$h"
  elif [ $rc -ne 1 ]; then printf '  [LEASE STATE UNKNOWN: device-lease.sh failed (%s)]' "$rc"; fi
}
# One line per target: platform, id, flags (empty flags = free for anyone).
list_targets() {
  xcrun simctl list devices booted 2>/dev/null | grep -E '\(Booted\)' | sed 's/^ *//' | while read -r line; do
    udid=$(printf '%s' "$line" | grep -oE '[0-9A-F]{8}-[0-9A-F-]+')
    [ -n "$udid" ] || continue
    att=""; printf '%s\n' "$held_udids" | grep -qF "$udid" && att="  [agent runner attached]"
    printf 'ios\t%s\t%s\t%s\n' "$udid" "$att$(inuse "$udid")$(leased "$udid" ios)" "iOS sim   $line"
  done
  [ -x "$ADB" ] && "$ADB" devices 2>/dev/null | tail -n +2 | grep -E 'device$' |
    while read -r serial state; do
      printf 'android\t%s\t%s\t%s\n' "$serial" "$(inuse "$serial")$(leased "$serial" android)" "Android   $serial ($state)"
    done
}
targets=$(list_targets)

if [ -n "$PICK$CHECK" ]; then
  # Owner strings are compared literally (index()), never as a regex: branch
  # names in owners can carry + ( [ * and similar.
  printf '%s\n' "$targets" | PICK_ME="$PICK_OWNER" PICK_ID="$CHECK" awk -F'\t' -v pl="$PICK" -v unid="$unidentified_live" '
    BEGIN { me = ENVIRON["PICK_ME"]; id = ENVIRON["PICK_ID"] }   # via ENVIRON: no escape processing
    function strip(f, s,   k) { while ((k = index(f, s)) > 0) f = substr(f, 1, k - 1) substr(f, k + length(s)); return f }
    { if (id != "") { if ($2 != id) next } else if ($1 != pl) next }
    { seen = 1; f = $3
      if (me != "") {
        f = strip(f, "[LEASED by " me " — not yours unless you are " me "]")
        f = strip(f, "[LEASED: whole " $1 " platform, by " me " — not yours unless you are " me "]")
      }
      if (index(" " unid " ", " " $1 " ") > 0) f = f "[unidentified live session on this platform]"
      if (f ~ /^ *$/) { print $2; found = 1; exit } }
    END { exit found ? 0 : (seen ? 1 : 4) }'
  exit $?
fi

echo "── Targets ── (a [LEASED] target belongs to its holder: use it only if you are that holder)"
printf '%s\n' "$targets" | awk -F'\t' 'NF { print "  " $4 ($3 == "" ? "  [free]" : $3) }'
[ -n "$unidentified_live" ] &&
  echo "  ! a live daemon's device could not be identified — treat every unmarked$(printf ' %s' $(printf '%s\n' $unidentified_live | sort -u)) target as possibly in use"

echo
if [ ${#NOISE[@]} -gt 0 ]; then
  echo "── Leftovers (NOT active use; safe to ignore, and candidates for cleanup) ──"
  for n in "${NOISE[@]}"; do echo "  · $n"; done
  echo
fi

if [ ${#BUSY_REASONS[@]} -gt 0 ]; then
  echo "── Active-use signals ──"
  for r in "${BUSY_REASONS[@]}"; do echo "  ! $r"; done
  echo
  echo "VERDICT: BUSY — a live session is driving a device."
  echo "         Use a target marked neither IN USE, [agent runner attached] nor [LEASED] —"
  echo "         unless the line above says a live session's device is unidentified: then ask."
  echo "         Otherwise tell the user what is running and ask before claiming it."
  exit 3
fi

echo "VERDICT: FREE — no live session. Claim a target and get on with it."
exit 0
