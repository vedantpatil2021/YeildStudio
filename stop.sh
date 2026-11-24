#!/usr/bin/env bash
# Stops what ./start.sh started: the backend (port 8000) and the website (port 5173).
#   ./stop.sh
# It stops the processes recorded in .run/*.pid (and their children), then anything still listening on the two
# ports that was started from this app folder. Other programs are left alone.
set -uo pipefail

APP="$(cd "$(dirname "$0")" && pwd)"
RUN="$APP/.run"
PORTS=(8000 5173)

say() { printf '\033[1m%s\033[0m\n' "$*"; }

stop_tree() {   # pid: stop the process and its children, politely first
  local pid=$1 kids
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do stop_tree "$k"; done
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
}

stopped=0
for svc in backend frontend; do
  f="$RUN/$svc.pid"
  if [ -f "$f" ]; then
    pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then stop_tree "$pid"; say "Stopped $svc (pid $pid)"; stopped=1; fi
    rm -f "$f"
  fi
done

# Leftovers on the app's ports, only if they belong to this app folder (e.g. started by hand with uvicorn/vite)
for port in "${PORTS[@]}"; do
  for pid in $(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    if [[ "$cwd" == "$APP"* ]]; then stop_tree "$pid"; say "Stopped process on port $port (pid $pid)"; stopped=1
    else echo "Port $port is used by another program (pid $pid, $cwd); left running."; fi
  done
done

[ $stopped -eq 1 ] && say "Yield Studio stopped." || echo "Yield Studio was not running."
