#!/usr/bin/env bash
# Stops what ./start.sh started.
#   ./stop.sh                  stop everything
#   ./stop.sh frontend         stop one service (backend or frontend)
# It stops the processes recorded in .run/*.pid (and their children), then anything still listening on the service's
# port that was started from this app folder. Other programs are left alone.
set -uo pipefail
source "$(dirname "$0")/scripts/lib.sh"

pick_services "$@"

stopped=0
for svc in "${TARGETS[@]}"; do
  if pid=$(pid_of "$svc"); then
    if kill -0 "$pid" 2>/dev/null; then
      stop_tree "$pid"; mark "$svc" "$svc stopped"; say "Stopped $svc (pid $pid)"; stopped=1
    fi
    rm -f "$RUN/$svc.pid"
  fi

  # Leftovers on the port, only if they belong to this app folder (e.g. started by hand with uvicorn/vite)
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
