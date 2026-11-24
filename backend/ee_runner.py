"""Earth Engine work for the API: run a script in a separate, limited process; read export status; asset tiles.

Credentials: EE_SERVICE_ACCOUNT_FILE (a service-account JSON key) if set, otherwise the persistent credentials of
`earthengine authenticate` on this machine. Everything runs under EE_PROJECT, never the user's own account.

Scripts are user code. They run in a child process with a time limit, a memory limit, an empty working directory
and only the environment variables Earth Engine needs. That stops runaway scripts, but it is not a security sandbox:
before the API is opened beyond trusted lab users, run ee_child.py in a container with no access to the host.
"""
import json
import os
import resource
import subprocess
import sys
import tempfile
from pathlib import Path

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
        raise EEError("Earth Engine is not configured on the server (set EE_PROJECT).")
    env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", ""), "PYTHONDONTWRITEBYTECODE": "1"}
    if KEY_FILE:
        env["EE_SERVICE_ACCOUNT_FILE"] = KEY_FILE
    with tempfile.TemporaryDirectory() as cwd:
        try:
            proc = subprocess.run([sys.executable, "-I", str(CHILD)], input=json.dumps({"code": code, "project": EE_PROJECT, "start": start}),
                                  capture_output=True, text=True, timeout=TIMEOUT_S + 10, cwd=cwd, env=env, preexec_fn=_limits)
        except subprocess.TimeoutExpired:
            return {"logs": [], "layers": [], "center": None, "exports": [], "started": None,
                    "error": f"Stopped after {TIMEOUT_S} s. Use an Export for long computations."}
    line = next((ln for ln in reversed(proc.stdout.splitlines()) if ln.startswith(MARKER)), None)
    if line is None:
        detail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [f"exit code {proc.returncode}"]
        return {"logs": [], "layers": [], "center": None, "exports": [], "started": None, "error": f"The script process failed: {detail[0]}"}
    return json.loads(line[len(MARKER):])


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
    return ee


def task_status(ee_task_id: str) -> dict:
    """{state, progress (0-100), error}. Earth Engine states are mapped onto READY/RUNNING/COMPLETED/FAILED/CANCELLED."""
    ee = _ee()
    s = ee.data.getTaskStatus(ee_task_id)[0]
    state = {"UNSUBMITTED": "READY", "READY": "RUNNING", "RUNNING": "RUNNING", "COMPLETED": "COMPLETED", "FAILED": "FAILED",
             "CANCEL_REQUESTED": "CANCELLED", "CANCELLED": "CANCELLED"}.get(s.get("state"), "RUNNING")
    progress = 100.0 if state == "COMPLETED" else float(s.get("progress", 0) or 0) * 100
    return {"state": state, "progress": progress, "error": s.get("error_message")}


def cancel_task(ee_task_id: str):
    _ee().data.cancelTask(ee_task_id)


def asset_tiles(asset_id: str, vis: dict) -> str:
    ee = _ee()
    vis = {k: (",".join(map(str, v)) if isinstance(v, list) else v) for k, v in vis.items()}
    return ee.Image(asset_id).getMapId(vis)["tile_fetcher"].url_format
