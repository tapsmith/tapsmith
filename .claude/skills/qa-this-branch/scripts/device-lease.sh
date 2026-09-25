#!/bin/bash
# Machine-wide leases on simulators/emulators, so parallel Claude workers
# (implement-tickets) and QA runs never drive the same device.
#
#   device-lease.sh acquire <target> <owner> [--wait <minutes>]
#   device-lease.sh release <target> <owner>
#   device-lease.sh holder  <target>          # prints the owner, exit 1 if free
#   device-lease.sh list
#   device-lease.sh reap                      # drop expired leases
#
# <target> is an iOS simulator UDID or an Android serial (emulator-5554), or a
# whole platform — "platform:ios" / "platform:android" — for a run that picks
# or boots its own devices (--workers N, device groups). A platform lease is
# refused while anyone else holds a device of that platform, and a device
# lease is refused while someone else holds its platform.
# <owner> names who holds it, e.g. "PILOT-123" or "qa:feat/pilot-123-x".
#
# Every transition (acquire, renew, expire, release) runs under the target's
# *platform's* kernel file lock — one lock per platform, so a device lease and
# a platform lease can never race each other (lockf on macOS, flock on Linux), so no two
# can interleave; the lock is released automatically if the process dies.
# The lease itself is one file, written to a temp file and renamed into
# place, so a reader never sees half of one. A lease expires after
# TAPSMITH_LEASE_TTL_HOURS (default 6) so a crashed worker cannot hold a
# device forever; re-acquiring a lease you already hold renews it.
#
# Exit codes: 0 ok, 1 not held / not free, 2 usage, 3 lock unavailable (a
# stuck lock or an exec failure — not a busy device), 4 timed out waiting.

set -u
# lockf/flock exec this script again by path; a bare "$0" (run as
# `bash device-lease.sh`) would be looked up on PATH and fail.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
DIR="${TAPSMITH_LEASE_DIR:-$HOME/.tapsmith/device-leases}"
TTL_HOURS="${TAPSMITH_LEASE_TTL_HOURS:-6}"
[[ "$TTL_HOURS" =~ ^[0-9]+$ ]] || { echo "device-lease: TAPSMITH_LEASE_TTL_HOURS must be whole hours" >&2; exit 2; }
mkdir -p "$DIR"

usage() { sed -n '4,9p' "$0" | sed 's/^# \{0,1\}//' | grep . >&2; exit 2; }
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
lease_file() { printf '%s/%s.lease' "$DIR" "$(safe "$1")"; }
IOS_UDID_RE='^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$'
platform_of() {  # ios for "platform:ios" and any iOS UDID form, android otherwise
  # Simulator UUIDs (8-4-4-4-12), physical devices since the A12 (8-16), and
  # older physical devices (40 hex). Android serials are none of these.
  case "$1" in
    platform:ios) echo ios ;; platform:android) echo android ;;
    *) [[ "$1" =~ $IOS_UDID_RE ]] && echo ios || echo android ;;
  esac
}
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null; }   # field <name> <lease file>
hhmm() { date -r "$1" '+%H:%M' 2>/dev/null || date -d "@$1" '+%H:%M'; }   # BSD, then GNU

# Run "$0 __locked <args>" while holding <target>'s lock.
with_lock() {  # with_lock <target> <op> <args…>
  local lk="$DIR/.platform-$(platform_of "$1").lock"; shift
  if command -v lockf >/dev/null; then
    lockf -k -t 30 "$lk" "${BASH:-bash}" "$SELF" __locked "$@"
  elif command -v flock >/dev/null; then
    flock -E 75 -w 30 "$lk" "${BASH:-bash}" "$SELF" __locked "$@"
  else
    echo "device-lease: needs lockf (macOS) or flock (Linux)" >&2; return 3
  fi
  local rc=$?
  # The locked operation answers "not free / not held" with 10 and success
  # with 0. Anything else — lockf/flock timing out (75), failing to open the
  # lock file or exec this script, or the operation failing to write — is an
  # environment fault, not contention: report it as 3 so no caller mistakes it
  # for a busy device.
  case $rc in 0) return 0 ;; 10) return 1 ;; *) return 3 ;; esac
}

live() {  # live <lease file>: exists and not expired
  local since
  [ -f "$1" ] || return 1
  since=$(field since "$1"); since=${since:-0}
  [ $(( $(date +%s) - since )) -le $((TTL_HOURS * 3600)) ]
}

# ── Operations, only ever called with the target's lock held ────────────────
locked_acquire() {  # target owner
  local f; f=$(lease_file "$1")
  if live "$f" && [ "$(field owner "$f")" != "$2" ]; then
    echo "BUSY $1 is leased by $(field owner "$f")" >&2; return 10
  fi
  local plat; plat=$(platform_of "$1")
  if [ "$1" = "platform:$plat" ]; then
    # Whole platform: refuse while anyone else holds one of its devices.
    local g
    for g in "$DIR"/*.lease; do
      [ -f "$g" ] && [ "$g" != "$f" ] && live "$g" || continue
      local t; t=$(field target "$g")
      [ "$(platform_of "$t")" = "$plat" ] && [ "$(field owner "$g")" != "$2" ] && {
        echo "BUSY platform:$plat — $t is leased by $(field owner "$g")" >&2; return 10; }
    done
  else
    # One device: refuse while someone else holds its whole platform.
    local pf; pf=$(lease_file "platform:$plat")
    if live "$pf" && [ "$(field owner "$pf")" != "$2" ]; then
      echo "BUSY $1 — the whole $plat platform is leased by $(field owner "$pf")" >&2; return 10
    fi
  fi
  local tmp="$f.tmp.$$"
  printf 'owner=%s\ntarget=%s\nsince=%s\n' "$2" "$1" "$(date +%s)" > "$tmp" && mv -f "$tmp" "$f" || {
    rm -f "$tmp"; echo "device-lease: could not write $f" >&2; return 3; }
  echo "LEASED $1 to $2"
}
locked_release() {  # target owner
  local f; f=$(lease_file "$1")
  if ! live "$f"; then rm -f "$f"; echo "not leased: $1"; return 0; fi
  if [ "$(field owner "$f")" != "$2" ]; then
    echo "refusing: $1 is leased by $(field owner "$f"), not $2" >&2; return 10
  fi
  rm -f "$f"; echo "RELEASED $1"
}
locked_reap() {  # target
  local f; f=$(lease_file "$1")
  if [ -f "$f" ] && ! live "$f"; then
    echo "reaped expired lease on $1 (was $(field owner "$f"))" >&2; rm -f "$f"
  fi
}

cmd="${1:-}"; shift || true
case "$cmd" in
  __locked)
    op="$1"; shift
    case "$op" in
      acquire) locked_acquire "$@" ;;
      release) locked_release "$@" ;;
      reap)    locked_reap "$@" ;;
      *) exit 2 ;;
    esac
    ;;
  acquire)
    [ $# -ge 2 ] || usage
    target="$1"; owner="$2"; wait_min=0
    if [ $# -gt 2 ]; then
      [ "${3:-}" = "--wait" ] && [[ "${4:-}" =~ ^[0-9]+$ ]] || {
        echo "device-lease: expected --wait <whole minutes>, got: ${*:3}" >&2; exit 2; }
      wait_min="$4"
    fi
    deadline=$(( $(date +%s) + wait_min * 60 ))
    while :; do
      with_lock "$target" acquire "$target" "$owner" 2>/dev/null; rc=$?
      [ $rc -eq 0 ] && exit 0
      [ $rc -eq 3 ] && { echo "device-lease: lock for $target unavailable" >&2; exit 3; }
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep 30
    done
    with_lock "$target" acquire "$target" "$owner"; rc=$?   # final try, with the message
    [ $rc -eq 0 ] && exit 0
    [ $rc -eq 3 ] && exit 3
    [ "$wait_min" -gt 0 ] && exit 4 || exit 1
    ;;
  release)
    [ $# -ge 2 ] || usage
    with_lock "$1" release "$1" "$2"
    ;;
  holder)
    [ $# -ge 1 ] || usage
    f=$(lease_file "$1")
    live "$f" && { field owner "$f"; exit 0; }
    exit 1
    ;;
  list|reap)
    for f in "$DIR"/*.lease; do
      [ -f "$f" ] || continue
      t=$(field target "$f")
      with_lock "$t" reap "$t"
      [ "$cmd" = list ] && live "$f" &&
        echo "$t $(field owner "$f") since $(hhmm "$(field since "$f")")"
    done
    exit 0
    ;;
  *) usage ;;
esac
