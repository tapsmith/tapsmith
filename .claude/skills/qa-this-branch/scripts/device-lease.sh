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
# A lease is a directory, created with mkdir, which is atomic: two workers
# racing for one device cannot both win. A lease expires after
# TAPSMITH_LEASE_TTL_HOURS (default 6) so a crashed worker cannot hold a
# device forever; re-acquiring a lease you already hold renews it.
#
# Exit codes: 0 ok, 1 not held / not free, 2 usage, 4 timed out waiting.

set -u
DIR="${TAPSMITH_LEASE_DIR:-$HOME/.tapsmith/device-leases}"
TTL_HOURS="${TAPSMITH_LEASE_TTL_HOURS:-6}"
mkdir -p "$DIR"

usage() { sed -n '4,10p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
safe() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'; }

expired() {  # $1 = lease dir
  local since now
  since=$(cat "$1/since" 2>/dev/null || echo 0)
  now=$(date +%s)
  [ $((now - since)) -gt $((TTL_HOURS * 3600)) ]
}

reap() {
  for l in "$DIR"/*/; do
    [ -d "$l" ] || continue
    if expired "$l" && mv "$l" "${l%/}.reaped.$$" 2>/dev/null; then
      rm -rf "${l%/}.reaped.$$"
      echo "reaped expired lease $(basename "$l")" >&2
    fi
  done
}

try_acquire() {  # $1 target, $2 owner
  local l="$DIR/$(safe "$1")"
  if mkdir "$l" 2>/dev/null; then
    printf '%s\n' "$2" > "$l/owner"; printf '%s\n' "$1" > "$l/target"; date +%s > "$l/since"
    return 0
  fi
  if [ "$(cat "$l/owner" 2>/dev/null)" = "$2" ]; then date +%s > "$l/since"; return 0; fi
  # Expired: move it aside first. mv is atomic, so of several workers reaping
  # the same stale lease only one wins, and nobody deletes a fresh one.
  if expired "$l" && mv "$l" "$l.reaped.$$" 2>/dev/null; then
    rm -rf "$l.reaped.$$"; try_acquire "$1" "$2"; return $?
  fi
  return 1
}

cmd="${1:-}"; shift || true
case "$cmd" in
  acquire)
    [ $# -ge 2 ] || usage
    target="$1"; owner="$2"; wait_min=0
    [ "${3:-}" = "--wait" ] && wait_min="${4:-0}"
    deadline=$(( $(date +%s) + wait_min * 60 ))
    while :; do
      if try_acquire "$target" "$owner"; then echo "LEASED $target to $owner"; exit 0; fi
      [ "$(date +%s)" -ge "$deadline" ] && break
      sleep 30
    done
    holder=$(cat "$DIR/$(safe "$target")/owner" 2>/dev/null)
    echo "BUSY $target is leased by $holder" >&2
    [ "$wait_min" -gt 0 ] && exit 4 || exit 1
    ;;
  release)
    [ $# -ge 2 ] || usage
    l="$DIR/$(safe "$1")"
    if [ ! -d "$l" ]; then echo "not leased: $1"; exit 0; fi
    if [ "$(cat "$l/owner" 2>/dev/null)" != "$2" ]; then
      echo "refusing: $1 is leased by $(cat "$l/owner"), not $2" >&2; exit 1
    fi
    rm -rf "$l"; echo "RELEASED $1"
    ;;
  holder)
    [ $# -ge 1 ] || usage
    l="$DIR/$(safe "$1")"
    if [ -d "$l" ] && ! expired "$l"; then cat "$l/owner"; exit 0; fi
    exit 1
    ;;
  list)
    reap 2>/dev/null
    for l in "$DIR"/*/; do
      [ -d "$l" ] || continue
      echo "$(cat "$l/target") $(cat "$l/owner") since $(date -r "$(cat "$l/since")" '+%H:%M')"
    done
    ;;
  reap) reap ;;
  *) usage ;;
esac
