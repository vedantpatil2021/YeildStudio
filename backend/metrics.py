"""Prometheus metrics for the API, served at /metrics and scraped by Prometheus (see ../observability/prometheus/).

    yieldstudio_http_requests_total{method, route, status}       requests, by route template (not raw path)
    yieldstudio_http_request_duration_seconds{method, route}     request latency histogram
    yieldstudio_ee_runs_total{kind, result}                      Earth Engine runs; kind = script | export,
                                                                 result = ok | script_error | failed | timeout | not_configured
    yieldstudio_ee_run_duration_seconds{kind}                    Earth Engine run time histogram

Python process metrics (memory, CPU, open files, GC) come with the client library.
"""
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

CONTENT_TYPE = CONTENT_TYPE_LATEST

HTTP_REQUESTS = Counter("yieldstudio_http_requests_total", "HTTP requests handled by the API", ["method", "route", "status"])
HTTP_LATENCY = Histogram("yieldstudio_http_request_duration_seconds", "HTTP request latency", ["method", "route"],
                         buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120))

EE_RUNS = Counter("yieldstudio_ee_runs_total", "Earth Engine script and export runs", ["kind", "result"])
EE_DURATION = Histogram("yieldstudio_ee_run_duration_seconds", "Earth Engine run duration", ["kind"],
                        buckets=(1, 2, 5, 10, 20, 30, 60, 90, 120, 180))


def latest() -> bytes:
    return generate_latest()
