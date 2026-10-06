#!/bin/sh
# Stops the app server. Asks it first (POST /api/server/stop), so it can finish pending
# writes and shut down cleanly; falls back to the pid in .local/server.pid (SIGTERM, then
# SIGKILL). The Ash Log app runs this when it quits.
#
#   exit 0  nothing answers on the port any more
#   exit 1  the server keeps running; the reason is on stderr
#
# Extra override: ASHENFALL_STOP_TIMEOUT (seconds to wait for a clean exit, default 10).

. "$(/usr/bin/dirname -- "$0")/lib.sh"

STOP_TIMEOUT=${ASHENFALL_STOP_TIMEOUT:-10}

pid=$(server_pid) || pid=''

requested=no
if is_healthy 1; then
  if /usr/bin/curl -fsS -o /dev/null --noproxy '*' --max-time 3 -X POST \
    -H 'Content-Type: application/json' --data '{}' "$BASE_URL/api/server/stop" 2>/dev/null; then
    requested=yes
    log "Asked the server to stop"
  else
    log "Stop request failed"
  fi
fi

if [ -n "$pid" ]; then
  # Asked nicely: give it time to exit on its own. Otherwise signal it right away.
  if [ "$requested" = no ] || ! wait_while "/bin/kill -0 $pid 2>/dev/null" "$STOP_TIMEOUT"; then
    log "Stopping the server (pid $pid) with SIGTERM"
    /bin/kill -TERM "$pid" 2>/dev/null
    if ! wait_while "/bin/kill -0 $pid 2>/dev/null" 5; then
      log "Server (pid $pid) does not stop, SIGKILL"
      /bin/kill -KILL "$pid" 2>/dev/null
      wait_while "/bin/kill -0 $pid 2>/dev/null" 2
    fi
  fi
elif [ "$requested" = yes ]; then
  # Started some other way (npm run app): wait until it no longer answers.
  wait_while "is_healthy 1" "$STOP_TIMEOUT"
fi

/bin/rm -f "$PID_FILE"
if is_healthy 1; then
  fail "The server on port $PORT won't stop. Stop it yourself, for example in Activity Monitor (process node)."
fi
log "Server stopped"
exit 0
