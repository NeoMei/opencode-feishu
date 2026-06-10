#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-19876}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[$(date '+%H:%M:%S')] restart-all.sh started" >> "$HOME/.config/opencode/feishu.log"

bash "$SCRIPT_DIR/restart-serve.sh" "$PORT"
sleep 2
bash "$SCRIPT_DIR/restart-feishu.sh" "$PORT"

echo "[$(date '+%H:%M:%S')] restart-all.sh completed" >> "$HOME/.config/opencode/feishu.log"
