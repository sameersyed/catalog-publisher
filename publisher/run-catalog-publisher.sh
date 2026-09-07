#!/bin/sh
set -eu

ROOT=${CATALOG_ROOT:-"$HOME/catalog-publisher"}
PUBLISHER="$ROOT/publisher"
STATE_HOME=${XDG_STATE_HOME:-"$HOME/.local/state"}
LOCK="$STATE_HOME/stock-evidence-catalog/run.lock"

: "${SEC_USER_AGENT:?Set SEC_USER_AGENT to an application name and monitored contact email}"
mkdir -p "$STATE_HOME/stock-evidence-catalog"
if ! mkdir "$LOCK" 2>/dev/null; then
  printf '%s\n' 'Catalog publisher is already running.' >&2
  exit 1
fi
trap 'rmdir "$LOCK"' EXIT HUP INT TERM

if [ -n "$(git -C "$ROOT" status --porcelain -- catalog)" ]; then
  printf '%s\n' 'Catalog has uncommitted changes; refusing to publish over them.' >&2
  exit 1
fi

node "$PUBLISHER/process-queue.js"
