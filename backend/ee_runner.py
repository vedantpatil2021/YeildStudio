"""Earth Engine work for the API: run a script in a separate, limited process; read export status; asset tiles.

Credentials: EE_SERVICE_ACCOUNT_FILE (a service-account JSON key) if set, otherwise the persistent credentials of
`earthengine authenticate` on this machine. Everything runs under EE_PROJECT, never the user's own account.

Scripts are user code. They run in a child process with a time limit, a memory limit, an empty working directory
and only the environment variables Earth Engine needs. That stops runaway scripts, but it is not a security sandbox:
before the API is opened beyond trusted lab users, run ee_child.py in a container with no access to the host.
"""
import json
import logging
import os
import resource
import subprocess
import sys
import tempfile
import time
from pathlib import Path

log = logging.getLogger("yieldstudio.ee")   # -> logs/earth-engine.log

EE_PROJECT = os.environ.get("EE_PROJECT", "")
KEY_FILE = os.environ.get("EE_SERVICE_ACCOUNT_FILE", "")
TIMEOUT_S = int(os.environ.get("EE_RUN_TIMEOUT") or 120)
MEMORY_BYTES = 2 * 1024 ** 3
CHILD = Path(__file__).with_name("ee_child.py")
MARKER = "__YIELD_STUDIO_RESULT__"


class EEError(Exception):
    pass


def configured() -> bool:
    return bool(EE_PROJECT)


def _limits():
    resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_S, TIMEOUT_S + 5))
    try:
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    except (ValueError, OSError):        # macOS does not support an address-space limit
        pass


def run_script(code: str, start: str | None = None) -> dict:
    """{logs, layers, center, exports, started, error?} for one script run."""
    if not configured():
        log.warning("Script run refused: EE_PROJECT is not set")
        raise EEError("Earth Engine is not configured on the server (set EE_PROJECT).")
    what = f"export {start!r}" if start else "script"
    log.info("Running %s (%d characters of code, limit %d s)", what, len(code), TIMEOUT_S)
    t0 = time.perf_counter()
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "PYTHONDONTWRITEBYTECODE": "1"}
    if KEY_FILE:
        env["EE_SERVICE_ACCOUNT_FILE"] = KEY_FILE
    with tempfile.TemporaryDirectory() as cwd:
        try:
            proc = subprocess.run([sys.executable, "-I", str(CHILD)], input=json.dumps({"code": code, "project": EE_PROJECT, "start": start}),
                                  capture_output=True, text=True, timeout=TIMEOUT_S + 10, cwd=cwd, env=env, preexec_fn=_limits)
        except subprocess.TimeoutExpired:
            log.warning("%s stopped after %d s (time limit)", what.capitalize(), TIMEOUT_S)
            return {"logs": [], "layers": [], "center": None, "exports": [], "started": None,
                    "error": f"Stopped after {TIMEOUT_S} s. Use an Export for long computations."}
    line = next((ln for ln in reversed(proc.stdout.splitlines()) if ln.startswith(MARKER)), None)
    if line is None:
        detail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [f"exit code {proc.returncode}"]
        log.error("%s process failed after %.1f s (exit code %s): %s\n%s", what.capitalize(), time.perf_counter() - t0,
                  proc.returncode, detail[0], (proc.stderr or "").strip()[-4000:])
        return {"logs": [], "layers": [], "center": None, "exports": [], "started": None, "error": f"The script process failed: {detail[0]}"}
    out = json.loads(line[len(MARKER):])
    secs = time.perf_counter() - t0
    if out.get("error"):
        log.info("%s finished with a script error after %.1f s: %s", what.capitalize(), secs, str(out["error"])[:500])
    else:
        log.info("%s finished in %.1f s: %d layers, %d exports%s", what.capitalize(), secs, len(out.get("layers") or []),
                 len(out.get("exports") or []), f", started task {out['started']}" if out.get("started") else "")
    return out


_ready = False


def _ee():
    """Earth Engine in the API process itself, for short calls (task status, asset tiles)."""
    global _ready
    import ee
    if not _ready:
        if not configured():
            raise EEError("Earth Engine is not configured on the server (set EE_PROJECT).")
        if KEY_FILE:
            email = json.loads(Path(KEY_FILE).read_text())["client_email"]
            ee.Initialize(ee.ServiceAccountCredentials(email, KEY_FILE), project=EE_PROJECT)
        else:
            ee.Initialize(project=EE_PROJECT)
        _ready = True
        log.info("Earth Engine initialised for project %s (%s)", EE_PROJECT, "service account" if KEY_FILE else "local credentials")
    return ee


def task_status(ee_task_id: str) -> dict:
    """{state, progress (0-100), error}. Earth Engine states are mapped onto READY/RUNNING/COMPLETED/FAILED/CANCELLED."""
    ee = _ee()
    s = ee.data.getTaskStatus(ee_task_id)[0]
    state = {"UNSUBMITTED": "READY", "READY": "RUNNING", "RUNNING": "RUNNING", "COMPLETED": "COMPLETED", "FAILED": "FAILED",
             "CANCEL_REQUESTED": "CANCELLED", "CANCELLED": "CANCELLED"}.get(s.get("state"), "RUNNING")
    progress = 100.0 if state == "COMPLETED" else float(s.get("progress", 0) or 0) * 100
    log.debug("Task %s: %s %.0f%%", ee_task_id, state, progress)
    if state == "FAILED":
        log.warning("Export task %s failed: %s", ee_task_id, s.get("error_message"))
    return {"state": state, "progress": progress, "error": s.get("error_message")}


def cancel_task(ee_task_id: str):
    _ee().data.cancelTask(ee_task_id)
    log.info("Cancelled export task %s", ee_task_id)


def asset_tiles(asset_id: str, vis: dict) -> str:
    ee = _ee()
    vis = {k: (",".join(map(str, v)) if isinstance(v, list) else v) for k, v in vis.items()}
    return ee.Image(asset_id).getMapId(vis)["tile_fetcher"].url_format
