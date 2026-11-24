"""Logging for the API: everything goes to stdout, one record per line. In Docker, Grafana Alloy ships the
container's stdout to Loki, which keeps and indexes it (see ../observability/).

Each record carries the logger name, which Loki turns into a label, so the three streams stay separate:

    yieldstudio.api      application messages, warnings, errors with tracebacks (and uvicorn start/stop)
    yieldstudio.access   one line per HTTP request: client, method, path, route, status, duration, user
    yieldstudio.ee       Earth Engine work: script runs, export status, cancels

Settings:
    LOG_FORMAT   json (one JSON object per line; used in Docker) or text (readable; default)
    LOG_LEVEL    DEBUG, INFO, WARNING, ERROR (default INFO)
"""
import json
import logging
import logging.config
import os
from datetime import datetime, timezone

# Attributes every LogRecord has; anything else was passed with extra={...} and is kept as a field.
_STANDARD = set(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {"message", "asctime", "taskName", "color_message"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        out.update({k: v for k, v in vars(record).items() if k not in _STANDARD})
        if record.exc_info:
            out["exception"] = self.formatException(record.exc_info)
        return json.dumps(out, default=str)


def setup() -> None:
    level = os.environ.get("LOG_LEVEL", "INFO").upper()
    fmt = "json" if os.environ.get("LOG_FORMAT", "text").lower() == "json" else "text"
    logging.config.dictConfig({
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "json": {"()": JsonFormatter},
            "text": {"format": "%(asctime)s %(levelname)-7s %(name)s: %(message)s"},
        },
        "handlers": {"stdout": {"class": "logging.StreamHandler", "stream": "ext://sys.stdout", "formatter": fmt}},
        "root": {"level": level, "handlers": ["stdout"]},
        "loggers": {
            # uvicorn's messages flow to the root handler; its access log is replaced by yieldstudio.access
            "uvicorn": {"level": level, "handlers": [], "propagate": True},
            "uvicorn.error": {"level": level, "handlers": [], "propagate": True},
            "uvicorn.access": {"level": "WARNING", "handlers": [], "propagate": False},
            "yieldstudio.access": {"level": "INFO"},
            # chatty libraries
            "urllib3": {"level": "WARNING"},
            "google": {"level": "WARNING"},
            "googleapiclient": {"level": "WARNING"},
            "rasterio": {"level": "WARNING"},
        },
    })
