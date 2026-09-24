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
# <target> is an iOS simulator UDID or an Android serial (emulator-5554).
# <owner> names who holds it, e.g. "PILOT-123" or "qa:feat/pilot-123-x".
#
# Every transition on a target (acquire, renew, expire, release) runs under
# that target's kernel file lock (lockf on macOS, flock on Linux), so no two
# can interleave; the lock is released automatically if the process dies.
# The lease itself is one file, written to a temp file and renamed into
# place, so a reader never sees half of one. A lease expires after
# TAPSMITH_LEASE_TTL_HOURS (default 6) so a crashed worker cannot hold a
# device forever; re-acquiring a lease you already hold renews it.
#
# Exit codes: 0 ok, 1 not held / not free, 2 usage, 3 lock unavailable,
# 4 timed out waiting.

set -u
DIR="${TAPSMITH_LEASE_DIR:-$HOME/.tapsmith/device-leases}"
TTL_HOURS="${TAPSMITH_LEASE_TTL_HOURS:-6}"
mkdir -p "$DIR"

usage() { sed -n '4,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }
lease_file() { printf '%s/%s.lease' "$DIR" "$(safe "$1")"; }
field() { sed -n "s/^$1=//p" "$2" 2>/dev/null; }   # field <name> <lease file>

# Run "$0 __locked <args>" while holding <target>'s lock.
with_lock() {  # with_lock <target> <op> <args…>
  local lk="$DIR/.$(safe "$1").lock"; shift
  if command -v lockf >/dev/null; then
    lockf -k -t 30 "$lk" "$0" __locked "$@"
  elif command -v flock >/dev/null; then
    flock -w 30 "$lk" "$0" __locked "$@"
  else
    echo "device-lease: needs lockf (macOS) or flock (Linux)" >&2; return 3
  fi
  local rc=$?
  # lockf/flock report their own timeout as 75 / 1; surface it as "lock unavailable".
  [ $rc -eq 75 ] && return 3
  return $rc
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
    echo "BUSY $1 is leased by $(field owner "$f")" >&2; return 1
  fi
  local tmp="$f.tmp.$$"
  printf 'owner=%s\ntarget=%s\nsince=%s\n' "$2" "$1" "$(date +%s)" > "$tmp" && mv -f "$tmp" "$f" || {
    rm -f "$tmp"; echo "device-lease: could not write $f" >&2; return 1; }
  echo "LEASED $1 to $2"
}
locked_release() {  # target owner
  local f; f=$(lease_file "$1")
  if ! live "$f"; then rm -f "$f"; echo "not leased: $1"; return 0; fi
  if [ "$(field owner "$f")" != "$2" ]; then
    echo "refusing: $1 is leased by $(field owner "$f"), not $2" >&2; return 1
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
    [ "${3:-}" = "--wait" ] && wait_min="${4:-0}"
    deadline=$(( $(date +%s) + wait_min * 60 ))
    while :; do
      with_lock "$target" acquire "$target" "$owner" 2>/dev/null && exit 0
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep 30
    done
    with_lock "$target" acquire "$target" "$owner" && exit 0   # final try, with the message
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
        echo "$t $(field owner "$f") since $(date -r "$(field since "$f")" '+%H:%M')"
    done
    exit 0
    ;;
  *) usage ;;
esac
