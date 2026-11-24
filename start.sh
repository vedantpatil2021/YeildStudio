#!/usr/bin/env bash
# Starts Yield Studio in the background.
#   ./start.sh                 start everything (backend on port 8000, website on port 5173)
#   ./start.sh backend         start one service (backend or frontend)
#   ./stop.sh [service]        stop everything, or one service
# Missing dependencies are installed the first time. Logs go to logs/ (see scripts/lib.sh for what is in each file).
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"

pick_services "$@"

# ---- checks ------------------------------------------------------------------------------------------------
for svc in "${TARGETS[@]}"; do
  running "$svc" && fail "$svc is already running (pid $(pid_of "$svc")). Run ./stop.sh $svc first."
  port=$(port_of "$svc")
  port_busy "$port" && fail "Port $port ($svc) is in use by another program: $(port_user "$port"). Stop it or run ./stop.sh."
done

# ---- services ----------------------------------------------------------------------------------------------
start_backend() {
  [ -f "$APP/backend/.env" ] || fail "backend/.env is missing: copy backend/.env.example to backend/.env and fill it in."
  if [ ! -x "$APP/backend/.venv/bin/uvicorn" ]; then
    command -v uv >/dev/null || fail "uv is not installed (https://docs.astral.sh/uv/); it creates the backend's Python environment."
    say "Installing backend dependencies…"
    (cd "$APP/backend" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt)
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
    (cd "$APP/frontend" && npm ci)
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

for svc in "${TARGETS[@]}"; do
  say "Starting $svc on port $(port_of "$svc")"
  "start_$svc"
done
for svc in "${TARGETS[@]}"; do wait_for "$svc"; done

# ---- summary -----------------------------------------------------------------------------------------------
echo
say "Yield Studio is running"
for svc in "${TARGETS[@]}"; do
  case "$svc" in
    backend)  echo "  API:      http://localhost:$API_PORT   (docs: http://localhost:$API_PORT/docs)"
              echo "  Health:   $(curl -fsS "http://localhost:$API_PORT/health")" ;;
    frontend) echo "  Website:  http://localhost:$WEB_PORT" ;;
  esac
done
echo "  Logs:     logs/   (tail -f logs/backend.log)"
echo "  Stop:     ./stop.sh"
