# Shared settings and helpers for the desktop launcher scripts (start.sh, stop.sh, status.sh).
# Sourced, never run on its own.
#
# The macOS app runs these with the bare PATH of a Dock app (/usr/bin:/bin:/usr/sbin:/sbin),
# so everything here uses absolute tool paths. The app passes the node binary and the port it
# baked in at build time as ASHENFALL_NODE and ASHENFALL_PORT (see AshLog.swift).
#
# Overrides (the app sets the first two, the tests all of them):
#   ASHENFALL_NODE            node binary
#   ASHENFALL_PORT            port (default: APP_PORT from .env, else 5199)
#   ASHENFALL_PROJECT_DIR     project root (default: two folders up from this one)
#   ASHENFALL_SERVER_ENTRY    server entry, relative to the project (default: server/app.ts)

DESKTOP_DIR=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)
PROJECT_DIR=${ASHENFALL_PROJECT_DIR:-$(CDPATH='' cd -- "$DESKTOP_DIR/../.." && pwd -P)}
LOCAL_DIR="$PROJECT_DIR/.local"
PID_FILE="$LOCAL_DIR/server.pid"
LOG_FILE="$LOCAL_DIR/server.log"
SERVER_ENTRY=${ASHENFALL_SERVER_ENTRY:-server/app.ts}
DEFAULT_PORT=5199

# Appends a timestamped line to .local/server.log.
log() {
  /bin/mkdir -p "$LOCAL_DIR" 2>/dev/null &&
    printf '[%s] %s\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

# Prints a message for the dialog on stderr, logs it and exits 1.
fail() {
  log "ERROR: $*"
  printf '%s\n' "$*" >&2
  exit 1
}

# APP_PORT from .env (last assignment wins), empty when not set.
env_port() {
  [ -f "$PROJECT_DIR/.env" ] || return 0
  /usr/bin/sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?APP_PORT[[:space:]]*=[[:space:]]*[\"']?([^\"'#[:space:]]*)[\"']?[[:space:]]*(#.*)?\$/\\2/p" \
    "$PROJECT_DIR/.env" | /usr/bin/tail -n 1
}

PORT=${ASHENFALL_PORT:-$(env_port)}
PORT=${PORT:-$DEFAULT_PORT}
case $PORT in
  '' | *[!0-9]*) fail "APP_PORT in .env isn't a port number: $PORT" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  fail "APP_PORT in .env isn't a port number: $PORT"
fi
BASE_URL="http://127.0.0.1:$PORT"

# Succeeds when the app server answers GET /api/health within $1 seconds (default 2). Only
# the app server counts: the dev server (npm run dev) answers there too, with mode "dev".
is_healthy() {
  health=$(/usr/bin/curl -fsS --noproxy '*' --max-time "${1:-2}" "$BASE_URL/api/health" 2>/dev/null) || return 1
  case $health in
    *'"mode":"app"'*) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets NODE to a working node binary and puts its folder first on PATH, so tools that
# start with `#!/usr/bin/env node` (tsx, the sync) work under the app's bare PATH.
resolve_node() {
  NODE=''
  for candidate in "${ASHENFALL_NODE:-}" "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      NODE=$candidate
      break
    fi
  done
  if [ -z "$NODE" ]; then
    fail "Node not found${ASHENFALL_NODE:+ (expected at $ASHENFALL_NODE)}. Reinstall the app with: npm run app:install"
  fi
  PATH="$(/usr/bin/dirname -- "$NODE"):$PATH"
  export PATH
}

# The pid from .local/server.pid when that process still runs our server entry.
server_pid() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(/usr/bin/tr -cd '0-9' <"$PID_FILE")
  [ -n "$pid" ] || return 1
  cmdline=$(/bin/ps -ww -p "$pid" -o command= 2>/dev/null) || return 1
  case $cmdline in
    *"$SERVER_ENTRY"*) printf '%s\n' "$pid" ;;
    *) return 1 ;;
  esac
}

# Waits until `$1` (a command) fails, polling every 0.2 s for at most $2 seconds.
wait_while() {
  tries=$(($2 * 5))
  while eval "$1"; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || return 1
    /bin/sleep 0.2
  done
  return 0
}
