#!/bin/sh
set -eu

ROOT=${CATALOG_ROOT:-"$HOME/catalog-publisher"}
PUBLISHER="$ROOT/publisher"
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}
STATE_DIR="$STATE_HOME/stock-evidence-catalog"
LOCK="$STATE_DIR/run.lock"
LOG="$STATE_DIR/publisher.log"

: "${SEC_USER_AGENT:?Set SEC_USER_AGENT to an application name and monitored contact email}"
mkdir -p "$STATE_DIR"
touch "$LOG"
chmod 600 "$LOG"
exec >>"$LOG" 2>&1
printf '\n%s\n' "=== Stock Evidence publisher started $(date -Is) ==="
if ! mkdir "$LOCK" 2>/dev/null; then
  printf '%s\n' 'Catalog publisher is already running.' >&2
  exit 1
fi
cleanup() {
  status=$?
  rmdir "$LOCK"
  printf '%s\n' "=== Stock Evidence publisher finished $(date -Is), status $status ==="
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$(git -C "$ROOT" status --porcelain -- catalog)" ]; then
  printf '%s\n' 'Catalog has uncommitted changes; refusing to publish over them.' >&2
  exit 1
fi

node "$PUBLISHER/process-queue.js"
