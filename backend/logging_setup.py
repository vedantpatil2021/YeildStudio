"""Logging for the API. One file per service area, in LOG_DIR (default: <app>/logs):

    backend.log          application messages, warnings, errors and tracebacks (also uvicorn start/stop)
    backend-access.log   one line per HTTP request: method, path, status, duration, user
    earth-engine.log     Earth Engine work: script runs, export status, cancels, tile requests

Files are appended to; ../run.sh rotates them on each start (keeps the last 5 runs). When the API runs in a terminal
(e.g. `uvicorn main:app --reload`), messages are also printed there.

Settings: LOG_DIR, LOG_LEVEL (DEBUG, INFO, WARNING, ERROR; default INFO).
"""
import logging
import logging.config
import os
import sys
from pathlib import Path

FORMAT = "%(asctime)s %(levelname)-7s %(name)s: %(message)s"
ACCESS_FORMAT = "%(asctime)s %(message)s"


def setup() -> Path:
    log_dir = Path(os.environ.get("LOG_DIR") or Path(__file__).resolve().parents[1] / "logs")
    log_dir.mkdir(parents=True, exist_ok=True)
    level = os.environ.get("LOG_LEVEL", "INFO").upper()

    def file(name: str, fmt: str = "default") -> dict:
        return {"class": "logging.FileHandler", "filename": str(log_dir / name), "encoding": "utf-8", "formatter": fmt}

    handlers = {"app": file("backend.log"), "access": file("backend-access.log", "access"), "ee": file("earth-engine.log")}
    to_terminal = sys.stderr.isatty()
    if to_terminal:
        handlers["console"] = {"class": "logging.StreamHandler", "stream": "ext://sys.stderr", "formatter": "default"}
    extra = ["console"] if to_terminal else []

    logging.config.dictConfig({
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"default": {"format": FORMAT}, "access": {"format": ACCESS_FORMAT}},
        "handlers": handlers,
        "root": {"level": level, "handlers": ["app", *extra]},
        "loggers": {
            # uvicorn's own messages go to backend.log; its access log is replaced by yieldstudio.access
            "uvicorn": {"level": level, "handlers": [], "propagate": True},
            "uvicorn.error": {"level": level, "handlers": [], "propagate": True},
            "uvicorn.access": {"level": "WARNING", "handlers": [], "propagate": False},
            "yieldstudio.access": {"level": "INFO", "handlers": ["access", *extra], "propagate": False},
            "yieldstudio.ee": {"level": level, "handlers": ["ee", *extra], "propagate": False},
            # chatty libraries
            "urllib3": {"level": "WARNING"},
            "google": {"level": "WARNING"},
            "googleapiclient": {"level": "WARNING"},
            "rasterio": {"level": "WARNING"},
        },
    })
    return log_dir
