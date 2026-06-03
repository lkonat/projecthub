#!/usr/bin/env bash
#
# Start the ProjectHub server, optionally on a custom port.
#
#   ./start.sh                 # default port 3005
#   ./start.sh --port 5000     # http://localhost:5000
#   ./start.sh -p 5000         # same
#   ./start.sh --port=5000     # same
#
# The server reads PORT from the environment (see server/src/config/index.js),
# so this script just sets it and hands off to `npm start`.

set -euo pipefail

# Resolve this script's own directory so it works from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=3005

while [ $# -gt 0 ]; do
  case "$1" in
    --port=*) PORT="${1#*=}"; shift ;;
    --port|-p) PORT="${2:-}"; shift 2 ;;
    -h|--help)
      echo "Usage: ${0##*/} [--port PORT]"
      echo "  Start ProjectHub (default port 3005)."
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2
       echo "Usage: ${0##*/} [--port PORT]" >&2
       exit 1 ;;
  esac
done

# Port must be a positive integer in the valid range.
if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "Invalid port: '$PORT' (expected 1-65535)" >&2
  exit 1
fi

echo "Starting ProjectHub on http://localhost:$PORT"
cd "$SCRIPT_DIR/server"
# exec so Ctrl-C / signals go straight to the node process.
PORT="$PORT" exec npm start
