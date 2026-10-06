#!/bin/sh
# Starts the app server in the background unless it already answers, then waits until it
# is healthy. The Ash Log app runs this on launch (when no app server answers) and when you
# choose Opnieuw starten after the server stopped; running it from a terminal works too.
#
#   exit 0  the server answers on http://127.0.0.1:$PORT
#   exit 1  it does not; a Dutch reason for the dialog is on stderr, details in .local/server.log
#
# Builds the app first (vite build) when dist/ is missing or older than the sources.
# Extra overrides: ASHENFALL_VITE (vite CLI script), ASHENFALL_START_TIMEOUT (seconds, default 30).

. "$(/usr/bin/dirname -- "$0")/lib.sh"

START_TIMEOUT=${ASHENFALL_START_TIMEOUT:-30}
VITE=${ASHENFALL_VITE:-"$PROJECT_DIR/node_modules/vite/bin/vite.js"}
MAX_LOG_BYTES=1048576

is_healthy && exit 0

# Keeps one previous log instead of letting it grow forever.
rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  size=$(/usr/bin/wc -c <"$LOG_FILE" | /usr/bin/tr -d ' ')
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then /bin/mv -f "$LOG_FILE" "$LOG_FILE.1"; fi
  return 0
}

log_size() {
  if [ -f "$LOG_FILE" ]; then /usr/bin/wc -c <"$LOG_FILE" | /usr/bin/tr -d ' '; else echo 0; fi
}

# "name (pid n)" of whatever listens on $PORT; fails when nothing does.
port_owner() {
  owner=$(/usr/sbin/lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | /usr/bin/head -n 1)
  [ -n "$owner" ] || return 1
  name=$(/bin/ps -p "$owner" -o comm= 2>/dev/null)
  printf '%s (pid %s)\n' "$(/usr/bin/basename -- "${name:-onbekend}")" "$owner"
}

# Succeeds when dist/index.html is missing or older than any source file.
needs_build() {
  [ -f "$PROJECT_DIR/dist/index.html" ] || return 0
  newer=$(cd "$PROJECT_DIR" && /usr/bin/find src index.html vite.config.ts tailwind.config.ts package.json \
    -type f -newer dist/index.html ! -name '*.test.ts' ! -name '.DS_Store' 2>/dev/null | /usr/bin/head -n 1)
  [ -n "$newer" ]
}

# The last line the server wrote since byte $1 of the log that reads like a message
# (no stack frames, no blank lines, no "Node.js v..." footer), for the dialog.
last_server_message() {
  /usr/bin/tail -c "+$(($1 + 1))" "$LOG_FILE" 2>/dev/null |
    /usr/bin/grep -v -E '^[[:space:]]|^$|^Node\.js v|^\[[0-9-]+ [0-9:]+\] ' |
    /usr/bin/tail -n 1 | /usr/bin/cut -c 1-240
}

/bin/mkdir -p "$LOCAL_DIR" || fail "Kan de map .local niet maken in $PROJECT_DIR."
rotate_log

if owner=$(port_owner); then
  pid=$(server_pid) ||
    fail "Poort $PORT is al bezet door $owner. Sluit dat programma, of kies een andere APP_PORT in .env."
  # Our own server that does not answer yet (still starting, or stuck): give it the usual time.
  log "Server (pid $pid) draait al maar antwoordt nog niet, even wachten"
  offset=$(log_size)
else
  resolve_node
  [ -f "$PROJECT_DIR/$SERVER_ENTRY" ] || fail "Server niet gevonden: $PROJECT_DIR/$SERVER_ENTRY"

  if needs_build; then
    [ -f "$VITE" ] || fail "Vite niet gevonden. Draai eerst npm install in $PROJECT_DIR."
    log "dist/ is ouder dan de bronbestanden, app bouwen"
    if ! (cd "$PROJECT_DIR" && "$NODE" "$VITE" build) >>"$LOG_FILE" 2>&1 </dev/null; then
      fail "Bouwen van de app is mislukt. Kijk in .local/server.log wat er misging."
    fi
  fi

  case $SERVER_ENTRY in
    *.ts | *.mts | *.cts) set -- --import tsx "$SERVER_ENTRY" ;;
    *) set -- "$SERVER_ENTRY" ;;
  esac
  log "Server starten op poort $PORT met $NODE"
  offset=$(log_size)
  cd "$PROJECT_DIR" || fail "Projectmap niet gevonden: $PROJECT_DIR"
  # Detached: own stdin/stdout, immune to hangups, so it outlives this script. The app reads
  # this script's output until the pipe closes, so the server must not hold on to it.
  APP_PORT=$PORT /usr/bin/nohup "$NODE" "$@" >>"$LOG_FILE" 2>&1 </dev/null &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
fi

tries=$((START_TIMEOUT * 5))
until is_healthy 1; do
  if ! /bin/kill -0 "$pid" 2>/dev/null; then
    /bin/rm -f "$PID_FILE"
    reason=$(last_server_message "$offset")
    fail "De server is meteen gestopt${reason:+: $reason}. Kijk in .local/server.log wat er misging."
  fi
  tries=$((tries - 1))
  if [ "$tries" -le 0 ]; then
    /bin/kill -TERM "$pid" 2>/dev/null
    /bin/rm -f "$PID_FILE"
    fail "De server reageert niet binnen $START_TIMEOUT seconden. Kijk in .local/server.log wat er misging."
  fi
  /bin/sleep 0.2
done

log "Server draait op poort $PORT (pid $pid)"
exit 0
