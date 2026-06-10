#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-19876}"
PID_FILE="$HOME/.config/opencode/feishu.pid"
LOG_FILE="$HOME/.config/opencode/feishu.log"

log() { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG_FILE"; }

log "restart-feishu.sh started (port=$PORT, notify=$FEISHU_NOTIFY_CHAT_ID)"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    log "Stopping feishu daemon (PID=$PID)"
    kill "$PID" 2>/dev/null || true
    for i in $(seq 1 10); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      log "Force killing feishu daemon"
      kill -9 "$PID" 2>/dev/null || true
    fi
  fi
  rm -f "$PID_FILE"
fi

sleep 1

log "Starting feishu daemon"
if command -v opencode-feishu &>/dev/null; then
  nohup opencode-feishu start --daemon >> "$LOG_FILE" 2>&1 &
  log "Feishu daemon restarted"
else
  log "ERROR: opencode-feishu command not found"
  exit 1
fi
