#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.geoscope.pid"
LOG_DIR="$PROJECT_DIR/logs"
DAEMON_LOG="$LOG_DIR/geoscope-daemon.log"
COOLDOWN=5

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$DAEMON_LOG"
}

cleanup() {
  log "Received shutdown signal — stopping geoscope"
  if [[ -n "${CHILD_PID:-}" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  if [[ -n "${CAFFEINATE_PID:-}" ]] && kill -0 "$CAFFEINATE_PID" 2>/dev/null; then
    kill "$CAFFEINATE_PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
  log "Clean shutdown complete"
  exit 0
}

trap cleanup SIGINT SIGTERM

# Write wrapper PID
echo $$ > "$PID_FILE"
log "Geoscope daemon started (wrapper PID $$)"

# Prevent Mac sleep
caffeinate -i -w $$ &
CAFFEINATE_PID=$!

cd "$PROJECT_DIR"

while true; do
  log "Starting geoscope agent..."
  npx tsx --env-file=.env src/geoscope.mjs >> "$LOG_DIR/geoscope-production.log" 2>&1 &
  CHILD_PID=$!
  log "Agent running (PID $CHILD_PID)"

  wait "$CHILD_PID" || true
  EXIT_CODE=$?
  log "Agent exited with code $EXIT_CODE"

  # If exit code 0, it was intentional — don't restart
  if [[ "$EXIT_CODE" -eq 0 ]]; then
    log "Clean exit — not restarting"
    break
  fi

  log "Restarting in ${COOLDOWN}s..."
  sleep "$COOLDOWN"
done

rm -f "$PID_FILE"
log "Daemon loop ended"
