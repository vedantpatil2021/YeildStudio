#!/usr/bin/env bash
# Shared by ../start.sh and ../stop.sh. Defines the services, their ports and their log files.
#
# Logs (all in logs/, ignored by git):
#   backend.log          API messages, warnings, errors, tracebacks, uvicorn start/stop
#   backend-access.log   one line per HTTP request (method, path, status, duration, user)
#   earth-engine.log     Earth Engine script runs, exports, cancels
#   frontend.log         Vite dev server output, timestamped
# Each start rotates a service's logs: name.log -> name.log.1 -> ... -> name.log.5 (older ones are deleted).
# Process ids are kept in .run/ (also ignored by git).

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$APP/.run"
LOGS="$APP/logs"
KEEP_LOGS=5

SERVICES=(backend frontend)
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"

port_of() { case "$1" in backend) echo "$API_PORT" ;; frontend) echo "$WEB_PORT" ;; esac; }
logs_of() { case "$1" in backend) echo "backend backend-access earth-engine" ;; frontend) echo "frontend" ;; esac; }
url_of()  { case "$1" in backend) echo "http://localhost:$API_PORT/health" ;; frontend) echo "http://localhost:$WEB_PORT/" ;; esac; }

mkdir -p "$RUN" "$LOGS"

# ---- output ------------------------------------------------------------------------------------------------
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Prefix every line with a timestamp (for programs that do not write their own).
timestamp() { perl -MPOSIX -ne '$|=1; print strftime("%Y-%m-%d %H:%M:%S ", localtime), $_'; }

# ---- arguments ---------------------------------------------------------------------------------------------
# pick_services "$@": sets TARGETS. No argument or "all" -> every service; otherwise each name must be a known service.
pick_services() {
  TARGETS=()
  if [ $# -eq 0 ] || [ "$1" = "all" ]; then TARGETS=("${SERVICES[@]}"); return; fi
  local s
  for s in "$@"; do
    [[ " ${SERVICES[*]} " == *" $s "* ]] || fail "Unknown service '$s'. Choose from: ${SERVICES[*]} (or all)."
    TARGETS+=("$s")
  done
}

# ---- processes ---------------------------------------------------------------------------------------------
pid_of()    { [ -f "$RUN/$1.pid" ] && cat "$RUN/$1.pid"; }
running()   { local p; p=$(pid_of "$1") && kill -0 "$p" 2>/dev/null; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_user() { lsof -nP -iTCP:"$1" -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'; }

stop_tree() {   # pid: stop the process and its children, politely first
  local pid=$1 kids k
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do stop_tree "$k"; done
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
}

# ---- logs --------------------------------------------------------------------------------------------------
rotate_logs() {   # service
  local name i
  for name in $(logs_of "$1"); do
    [ -s "$LOGS/$name.log" ] || continue
    rm -f "$LOGS/$name.log.$KEEP_LOGS"
    for ((i = KEEP_LOGS - 1; i >= 1; i--)); do
      [ -f "$LOGS/$name.log.$i" ] && mv "$LOGS/$name.log.$i" "$LOGS/$name.log.$((i + 1))"
    done
    mv "$LOGS/$name.log" "$LOGS/$name.log.1"
  done
}

mark() {   # service message: a separator line in the service's main log
  printf '%s ===== %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$2" >> "$LOGS/$1.log"
}
