#!/usr/bin/env bash
# Yield Studio: start, stop and watch the local services from one place.
#
#   ./run.sh start   [service]   start everything, or one service (installs missing dependencies the first time)
#   ./run.sh stop    [service]   stop everything, or one service
#   ./run.sh restart [service]   stop, then start
#   ./run.sh status              what is running, on which port
#   ./run.sh logs    [file]      follow a log live (default: backend); e.g. ./run.sh logs frontend
#
# Services: backend (FastAPI, port 8000) and frontend (Vite, port 5173). Override ports with API_PORT / WEB_PORT.
#
# Logs, one file per service, all in logs/ (ignored by git), every line timestamped:
#   backend.log          API messages, warnings, errors with tracebacks, uvicorn start/stop
#   backend-access.log   one line per HTTP request: client, method, path, status, duration, signed-in user
#   earth-engine.log     Earth Engine script runs, export status, cancels
#   frontend.log         Vite dev server output
# Each start rotates a service's logs: name.log -> name.log.1 -> ... -> name.log.5 (older ones are deleted).
# Process ids are kept in .run/ (also ignored by git).
set -uo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN="$APP/.run"
LOGS="$APP/logs"
KEEP_LOGS=5
SERVICES=(backend frontend)
API_PORT="${API_PORT:-8000}"
WEB_PORT="${WEB_PORT:-5173}"
mkdir -p "$RUN" "$LOGS"

port_of() { case "$1" in backend) echo "$API_PORT" ;; frontend) echo "$WEB_PORT" ;; esac; }
logs_of() { case "$1" in backend) echo "backend backend-access earth-engine" ;; frontend) echo "frontend" ;; esac; }
url_of()  { case "$1" in backend) echo "http://localhost:$API_PORT/health" ;; frontend) echo "http://localhost:$WEB_PORT/" ;; esac; }

# ---- helpers -----------------------------------------------------------------------------------------------
say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Prefix every line with a timestamp (for programs that do not write their own).
timestamp() { perl -MPOSIX -ne '$|=1; print strftime("%Y-%m-%d %H:%M:%S ", localtime), $_'; }

pick_services() {   # sets TARGETS: no argument or "all" -> every service
  TARGETS=()
  if [ $# -eq 0 ] || [ "$1" = "all" ]; then TARGETS=("${SERVICES[@]}"); return; fi
  local s
  for s in "$@"; do
    [[ " ${SERVICES[*]} " == *" $s "* ]] || fail "Unknown service '$s'. Choose from: ${SERVICES[*]} (or all)."
    TARGETS+=("$s")
  done
}

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

# ---- services ----------------------------------------------------------------------------------------------
start_backend() {
  [ -f "$APP/backend/.env" ] || fail "backend/.env is missing: copy backend/.env.example to backend/.env and fill it in."
  if [ ! -x "$APP/backend/.venv/bin/uvicorn" ]; then
    command -v uv >/dev/null || fail "uv is not installed (https://docs.astral.sh/uv/); it creates the backend's Python environment."
    say "Installing backend dependencies…"
    (cd "$APP/backend" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt) \
      || fail "Installing backend dependencies failed."
  fi
  rotate_logs backend
  mark backend "backend starting on port $API_PORT"
  # The API writes its own timestamped logs (backend/logging_setup.py). Anything else it prints (e.g. a crash
  # before logging is set up) is appended to backend.log too.
  (cd "$APP/backend" && LOG_DIR="$LOGS" PYTHONDONTWRITEBYTECODE=1 \
    exec nohup .venv/bin/uvicorn main:app --port "$API_PORT" --no-access-log) < /dev/null >> "$LOGS/backend.log" 2>&1 &
  echo $! > "$RUN/backend.pid"
}

start_frontend() {
  command -v npm >/dev/null || fail "npm is not installed (Node.js 22 or newer)."
  [ -f "$APP/frontend/.env.local" ] || warn "Note: frontend/.env.local is missing, so only tester@osu.edu can sign in (no Supabase keys)."
  if [ ! -d "$APP/frontend/node_modules" ]; then
    say "Installing frontend dependencies…"
    (cd "$APP/frontend" && npm ci) || fail "Installing frontend dependencies failed."
  fi
  rotate_logs frontend
  mark frontend "frontend starting on port $WEB_PORT"
  # Vite does not timestamp its output, so each line is prefixed with the time.
  export -f timestamp
  export WEB_PORT
  (cd "$APP/frontend" &&
    exec nohup bash -c 'npx vite --port "$WEB_PORT" --strictPort --clearScreen false 2>&1 | timestamp') \
    < /dev/null >> "$LOGS/frontend.log" 2>&1 &
  echo $! > "$RUN/frontend.pid"
}

wait_for() {   # service
  local url; url=$(url_of "$1")
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    running "$1" || { tail -n 20 "$LOGS/$1.log" >&2; fail "$1 stopped while starting (log above, full log in logs/$1.log)."; }
    sleep 0.5
  done
  tail -n 20 "$LOGS/$1.log" >&2
  fail "$1 did not answer within 30 s (log above, full log in logs/$1.log)."
}

# ---- commands ----------------------------------------------------------------------------------------------
cmd_start() {
  pick_services "$@"
  local svc port
  for svc in "${TARGETS[@]}"; do
    running "$svc" && fail "$svc is already running (pid $(pid_of "$svc")). Run ./run.sh stop $svc first."
    port=$(port_of "$svc")
    port_busy "$port" && fail "Port $port ($svc) is in use by another program: $(port_user "$port"). Stop it or run ./run.sh stop."
  done
  for svc in "${TARGETS[@]}"; do
    say "Starting $svc on port $(port_of "$svc")"
    "start_$svc"
  done
  for svc in "${TARGETS[@]}"; do wait_for "$svc"; done

  echo
  say "Yield Studio is running"
  for svc in "${TARGETS[@]}"; do
    case "$svc" in
      backend)  echo "  API:      http://localhost:$API_PORT   (docs: http://localhost:$API_PORT/docs)"
                echo "  Health:   $(curl -fsS "http://localhost:$API_PORT/health")" ;;
      frontend) echo "  Website:  http://localhost:$WEB_PORT" ;;
    esac
  done
  echo "  Logs:     logs/   (./run.sh logs backend)"
  echo "  Stop:     ./run.sh stop"
}

cmd_stop() {
  # Stops the processes recorded in .run/*.pid (and their children), then anything still listening on the
  # service's port that was started from this app folder. Other programs are left alone.
  pick_services "$@"
  local svc pid port cwd stopped=0
  for svc in "${TARGETS[@]}"; do
    if pid=$(pid_of "$svc"); then
      if kill -0 "$pid" 2>/dev/null; then
        stop_tree "$pid"; mark "$svc" "$svc stopped"; say "Stopped $svc (pid $pid)"; stopped=1
      fi
      rm -f "$RUN/$svc.pid"
    fi
    port=$(port_of "$svc")
    for pid in $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      if [[ "$cwd" == "$APP"* ]]; then
        stop_tree "$pid"; mark "$svc" "$svc stopped (leftover on port $port)"; say "Stopped $svc leftover on port $port (pid $pid)"; stopped=1
      else
        warn "Port $port is used by another program (pid $pid, $cwd); left running."
      fi
    done
  done
  if [ $stopped -eq 1 ]; then say "Stopped: ${TARGETS[*]}."; else echo "Not running: ${TARGETS[*]}."; fi
}

cmd_status() {
  local svc port
  for svc in "${SERVICES[@]}"; do
    port=$(port_of "$svc")
    if running "$svc"; then
      if curl -fsS -o /dev/null "$(url_of "$svc")" 2>/dev/null; then state="running"; else state="started, not answering"; fi
      printf '  %-9s %-24s pid %-7s port %s\n' "$svc" "$state" "$(pid_of "$svc")" "$port"
    elif port_busy "$port"; then
      printf '  %-9s %-24s port %s used by %s\n' "$svc" "stopped" "$port" "$(port_user "$port")"
    else
      printf '  %-9s %s\n' "$svc" "stopped"
    fi
  done
}

cmd_logs() {
  local name="${1:-backend}"
  name="${name%.log}"
  [ -f "$LOGS/$name.log" ] || fail "No log logs/$name.log. Available: $(cd "$LOGS" && ls *.log 2>/dev/null | tr '\n' ' ')"
  exec tail -n 50 -F "$LOGS/$name.log"
}

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

cmd="${1:-}"; shift || true
case "$cmd" in
  start)   cmd_start "$@" ;;
  stop)    cmd_stop "$@" ;;
  restart) cmd_stop "$@"; cmd_start "$@" ;;
  status)  cmd_status ;;
  logs)    cmd_logs "$@" ;;
  -h|--help|help|"") usage ;;
  *) usage; fail "Unknown command '$cmd'." ;;
esac
