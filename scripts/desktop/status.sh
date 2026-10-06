#!/bin/sh
# Succeeds while the app server answers, for use from a terminal. (The Ash Log app does the
# same check itself every 10 seconds, on GET /api/health.) One retry, so a busy moment does
# not count.

. "$(/usr/bin/dirname -- "$0")/lib.sh"

is_healthy 3 && exit 0
/bin/sleep 1
is_healthy 3 && exit 0
echo "The server is not running anymore." >&2
exit 1
