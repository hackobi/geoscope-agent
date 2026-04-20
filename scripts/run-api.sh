#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.api.pid"
LOG_DIR="$PROJECT_DIR/logs"
DAEMON_LOG="$LOG_DIR/api-daemon.log"
COOLDOWN=10
MAX_COOLDOWN=300

mkdir -p "$LOG_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$DAEMON_LOG"
}

cleanup() {
  log "Received shutdown signal — stopping API"
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
log "API daemon started (wrapper PID $$)"

# Prevent Mac sleep
caffeinate -i -w $$ &
CAFFEINATE_PID=$!

cd "$PROJECT_DIR"

CONSECUTIVE_FAILURES=0

while true; do
  log "Starting Geoscope API..."
  START_TIME=$(date +%s)
  npx tsx --env-file=.env src/api.mjs >> "$LOG_DIR/api-production.log" 2>&1 &
  CHILD_PID=$!
  log "API running (PID $CHILD_PID)"

  wait "$CHILD_PID" || true
  EXIT_CODE=$?
  END_TIME=$(date +%s)
  RUNTIME=$((END_TIME - START_TIME))
  log "API exited with code $EXIT_CODE after ${RUNTIME}s"

  # If it ran for more than 2 minutes, reset failure counter
  if [[ "$RUNTIME" -gt 120 ]]; then
    CONSECUTIVE_FAILURES=0
  else
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
  fi

  # Exponential backoff: 10s, 20s, 40s, 80s... capped at 5min
  DELAY=$((COOLDOWN * (2 ** (CONSECUTIVE_FAILURES > 5 ? 5 : CONSECUTIVE_FAILURES - 1))))
  if [[ "$DELAY" -gt "$MAX_COOLDOWN" ]]; then
    DELAY=$MAX_COOLDOWN
  fi
  if [[ "$DELAY" -lt "$COOLDOWN" ]]; then
    DELAY=$COOLDOWN
  fi

  log "Restarting in ${DELAY}s... (consecutive fast failures: $CONSECUTIVE_FAILURES)"
  sleep "$DELAY"
done

rm -f "$PID_FILE"
log "Daemon loop ended"
