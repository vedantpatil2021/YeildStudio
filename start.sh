#!/usr/bin/env bash
# Starts Yield Studio: the FastAPI backend (port 8000) and the website (port 5173), in the background.
#   ./start.sh        start both (installs missing dependencies the first time)
#   ./stop.sh         stop both
# Logs: .run/backend.log and .run/frontend.log
set -euo pipefail

APP="$(cd "$(dirname "$0")" && pwd)"
RUN="$APP/.run"
API_PORT=8000
WEB_PORT=5173
mkdir -p "$RUN"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

running() { [ -f "$RUN/$1.pid" ] && kill -0 "$(cat "$RUN/$1.pid")" 2>/dev/null; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# ---- checks ------------------------------------------------------------------------------------------------
[ -f "$APP/backend/.env" ] || fail "backend/.env is missing: copy backend/.env.example to backend/.env and fill it in."
[ -f "$APP/frontend/.env.local" ] || say "Note: frontend/.env.local is missing, so only tester@osu.edu can sign in (no Supabase keys)."
command -v npm >/dev/null || fail "npm is not installed (Node.js 22 or newer)."

for svc in backend frontend; do
  if running "$svc"; then fail "$svc is already running (pid $(cat "$RUN/$svc.pid")). Run ./stop.sh first."; fi
done
port_busy $API_PORT && fail "Port $API_PORT is in use by another program: $(lsof -nP -iTCP:$API_PORT -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'). Stop it or run ./stop.sh."
port_busy $WEB_PORT && fail "Port $WEB_PORT is in use by another program: $(lsof -nP -iTCP:$WEB_PORT -sTCP:LISTEN | awk 'NR==2{print $1" pid "$2}'). Stop it or run ./stop.sh."

# ---- dependencies (first run only) ---------------------------------------------------------------------------
if [ ! -x "$APP/backend/.venv/bin/uvicorn" ]; then
  command -v uv >/dev/null || fail "uv is not installed (https://docs.astral.sh/uv/); it creates the backend's Python environment."
  say "Installing backend dependencies…"
  (cd "$APP/backend" && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt)
fi
if [ ! -d "$APP/frontend/node_modules" ]; then
  say "Installing frontend dependencies…"
  (cd "$APP/frontend" && npm ci)
fi

# ---- start ---------------------------------------------------------------------------------------------------
say "Starting backend on http://localhost:$API_PORT"
(cd "$APP/backend" && PYTHONDONTWRITEBYTECODE=1 nohup .venv/bin/uvicorn main:app --port $API_PORT < /dev/null > "$RUN/backend.log" 2>&1 & echo $! > "$RUN/backend.pid")

say "Starting website on http://localhost:$WEB_PORT"
(cd "$APP/frontend" && nohup npx vite --port $WEB_PORT --strictPort < /dev/null > "$RUN/frontend.log" 2>&1 & echo $! > "$RUN/frontend.pid")

# ---- wait until both answer --------------------------------------------------------------------------------
wait_for() {   # name url
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$2" 2>/dev/null && return 0
    running "$1" || { tail -n 20 "$RUN/$1.log" >&2; fail "$1 stopped while starting (log above, full log in .run/$1.log)."; }
    sleep 0.5
  done
  tail -n 20 "$RUN/$1.log" >&2
  fail "$1 did not answer within 30 s (log above)."
}
wait_for backend "http://localhost:$API_PORT/health"
wait_for frontend "http://localhost:$WEB_PORT/"

health="$(curl -fsS "http://localhost:$API_PORT/health")"
echo
say "Yield Studio is running"
echo "  Website:  http://localhost:$WEB_PORT"
echo "  API:      http://localhost:$API_PORT   (docs: http://localhost:$API_PORT/docs)"
echo "  Health:   $health"
echo "  Logs:     .run/backend.log, .run/frontend.log"
echo "  Stop:     ./stop.sh"
