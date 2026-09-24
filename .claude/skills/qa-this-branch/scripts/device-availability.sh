#!/bin/bash
# Is a simulator/emulator actively in use by someone else's Tapsmith session?
#
# Exit 0 = FREE   (no active-use signal; claim a target without asking)
# Exit 3 = BUSY   (a live session holds a device; ask the user before claiming it)
#
# The whole point is separating live sessions from leftovers. This machine
# normally carries dozens of orphaned processes and booted devices that are NOT
# in use; treating those as "busy" makes the check useless.

ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
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
if [ -n "$daemon_pids" ]; then
  for p in $daemon_pids; do
    est=$(lsof -nP -a -p "$p" -iTCP -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | grep -c .)
    age=$(ps -o etime= -p "$p" | tr -d ' ')
    if [ "$est" -gt 0 ]; then
      BUSY_REASONS+=("daemon pid $p (age $age) has $est live gRPC client connection(s)")
    else
      NOISE+=("daemon pid $p (age $age) running with no client attached — likely orphaned")
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
ui_procs=$(match_parented 'tapsmith[^ ]*(dist/)?cli\.js test.*--ui|tapsmith test.*--ui')
[ -n "$(printf '%s' "$ui_procs")" ] && BUSY_REASONS+=("$(count "$ui_procs") live UI-mode process(es)")

# 3. A run in flight: the CLI, a parallel worker, a watch child, a UI worker.
# Anchored to Tapsmith's own paths: a bare 'cli.js test' also matches
# Playwright's '@playwright/test/cli.js test-server', and the web-tests suites
# are device-free — flagging one as a device claim is a false positive.
runs=$(match_parented 'tapsmith/dist/cli\.js (test|mcp-server)|tapsmith[^ ]*/(dist/)?(worker-runner|watch-run|ui-worker|ui-mode/ui-worker)|npx tapsmith test|exec tapsmith test')
[ -n "$(printf '%s' "$runs")" ] && BUSY_REASONS+=("$(count "$runs") live run/worker process(es)")

# 4. Fresh result writes — a run mid-flight touches these within seconds.
fresh=$(find "$PWD" -maxdepth 3 -type d \( -name 'tapsmith-results' -o -name 'pilot-results' \) \
          -newermt '-2 minutes' 2>/dev/null)
[ -n "$fresh" ] && BUSY_REASONS+=("results dir written in the last 2 minutes: $fresh")

# ── Tier B: agent-side processes, which only count next to a live driver ─────
# iOS XCUITest runners get orphaned to PPID 1 and outlive their daemons by
# days; a lingering Android instrumentation is the same story. They mean
# "in use" only when something above is also live.
ios_agents=$(match 'xcodebuild.*test-without-building')
ios_parented=$(printf '%s\n' "$ios_agents" | awk 'NF && $2 != 1')
if [ -n "$(printf '%s' "$ios_parented")" ] && [ ${#BUSY_REASONS[@]} -gt 0 ]; then
  BUSY_REASONS+=("$(count "$ios_parented") parented xcodebuild agent runner(s)")
elif [ -n "$(printf '%s' "$ios_agents")" ]; then
  NOISE+=("$(count "$ios_agents") xcodebuild agent runner(s), no live driver — leftovers")
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
echo "── Targets ──"
xcrun simctl list devices booted 2>/dev/null | grep -E '\(Booted\)' | sed 's/^ *//' | while read -r line; do
  udid=$(printf '%s' "$line" | grep -oE '[0-9A-F]{8}-[0-9A-F-]+')
  if [ -n "$udid" ] && printf '%s\n' "$held_udids" | grep -qF "$udid"; then
    echo "  iOS sim   $line  [agent runner attached]"
  else
    echo "  iOS sim   $line  [no agent attached]"
  fi
done
[ -x "$ADB" ] && "$ADB" devices 2>/dev/null | tail -n +2 | grep -E 'device$|emulator' |
  while read -r serial state; do echo "  Android   $serial ($state)"; done

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
  echo "         If an unheld target is listed above, use that one instead."
  echo "         Otherwise tell the user what is running and ask before claiming it."
  exit 3
fi

echo "VERDICT: FREE — no live session. Claim a target and get on with it."
exit 0
