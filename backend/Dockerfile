# syntax=docker/dockerfile:1
# Yield Studio API. Two stages: the builder installs the dependencies into a virtualenv with uv; the runtime image
# copies only that virtualenv and the source onto python:slim (no compilers, no uv, no pip cache).

# ---- build ---------------------------------------------------------------------------------------------------
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
# No precompiled .pyc (they would double the size of the virtualenv); Python compiles in memory at start-up.
ENV UV_COMPILE_BYTECODE=0 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv venv /opt/venv --python /usr/local/bin/python3.12 && \
    uv pip install --python /opt/venv/bin/python -r requirements.txt
# Trim what the API never loads:
#   - googleapiclient's offline API descriptions (~100 MB); Earth Engine fetches its own discovery document
#   - test suites bundled inside packages, and any bytecode caches
RUN cd /opt/venv/lib/python3.12/site-packages && \
    rm -rf googleapiclient/discovery_cache/documents/*.json && \
    find /opt/venv -depth -type d \( -name tests -o -name test -o -name __pycache__ \) -prune -exec rm -rf {} + && \
    find /opt/venv -name "*.pyc" -delete

# ---- runtime -------------------------------------------------------------------------------------------------
FROM python:3.12-slim AS runtime
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LOG_FORMAT=json \
    HOME=/home/app
# libexpat1: needed by rasterio's bundled GDAL, not part of python:slim
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 10001 app && \
    useradd --system --uid 10001 --gid app --home-dir /home/app --create-home app && \
    mkdir -p /home/app/.config/earthengine && chown -R app:app /home/app
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY --chown=app:app *.py ./
COPY --chown=app:app pipeline ./pipeline
COPY --chown=app:app supabase ./supabase
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)" || exit 1
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--no-access-log", "--proxy-headers"]
