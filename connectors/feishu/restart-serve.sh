#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-19876}"
LOG_FILE="$HOME/.config/opencode/feishu.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE"; }

log "restart-serve.sh started (port=$PORT)"

SERVE_PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$SERVE_PID" ]; then
  log "Stopping opencode serve (PID=$SERVE_PID, port=$PORT)"
  kill "$SERVE_PID" 2>/dev/null || true
  for i in $(seq 1 10); do
    kill -0 "$SERVE_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$SERVE_PID" 2>/dev/null; then
    log "Force killing opencode serve"
    kill -9 "$SERVE_PID" 2>/dev/null || true
  fi
else
  log "No process found on port $PORT"
fi

sleep 1

log "Starting opencode serve on port $PORT"
if command -v opencode &>/dev/null; then
  nohup opencode serve --port "$PORT" >> "$LOG_FILE" 2>&1 &
  log "opencode serve restarted (PID=$!)"
else
  log "ERROR: opencode command not found"
  exit 1
fi

sleep 3
log "restart-serve.sh completed"
