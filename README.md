# Yield Studio

Web platform for the AgSensing Lab's crop yield work at The Ohio State University: 30 m corn and soybean yield maps
estimated from satellite greenness and August weather (method of KC & Khanal, 2023), with a no-code Explore page and
a Python Earth Engine Studio.

## Repository layout

```
.
├── frontend/          React + Vite website; Dockerfile builds it and serves it with nginx (see frontend/README.md)
├── backend/           FastAPI API, Earth Engine runner, Supabase schema, file pipeline; Dockerfile (see backend/README.md)
├── supabase/          Self-hosted Supabase, full stack (official compose files + Yield Studio overrides)
├── observability/     Loki, Grafana Alloy, Prometheus and Grafana configuration (dashboards, datasources)
├── docker-compose.yml The whole stack: app + Supabase + observability
├── email-templates/   Supabase Auth email templates (invite, sign-in code)
├── data/              Source data for the app (large boundary file is not in git)
├── .github/workflows/ GitHub Pages deploy for the frontend (manual only)
└── PLAN.md            Plan for the full application
```

## Quick start (Docker)

Requires Docker Desktop (or Docker Engine with Compose v2).

```bash
git config core.hooksPath .githooks             # once per clone: blocks commits containing secrets
cp .env.example .env                            # set GRAFANA_ADMIN_PASSWORD
cp backend/.env.example backend/.env            # fill in
cp frontend/.env.example frontend/.env.local    # fill in (baked into the website at build time)
cp supabase/.env.example supabase/.env          # then generate its secrets (written to supabase/.env only):
(cd supabase && sh utils/generate-keys.sh --update-env && sh utils/add-new-auth-keys.sh --update-env)
earthengine authenticate                        # once, unless EE_SERVICE_ACCOUNT_FILE is used

docker compose up -d --build                    # build and start everything
docker compose ps                               # status and health
docker compose up -d --build backend            # rebuild / restart one service after a change
docker compose logs -f backend                  # follow one service in the terminal
docker compose down                             # stop (volumes kept; add -v to delete logs/metrics/Grafana data)
```

| What | URL (127.0.0.1 only) |
|---|---|
| Website | http://localhost:5173 |
| API (docs at /docs, metrics at /metrics) | http://localhost:8000 |
| Grafana (user `admin`, password from `.env`) | http://localhost:3000 |
| Prometheus | http://localhost:9090 |
| Supabase Studio + API gateway (Studio login: `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` in `supabase/.env`) | http://localhost:54321 |
| Supabase Postgres via Supavisor (session / transaction) | localhost:5432 / localhost:6543 |

## Supabase (self-hosted)

`docker-compose.yml` includes the official self-hosted Supabase compose files from
[supabase/supabase `docker/`](https://github.com/supabase/supabase/tree/master/docker) (versions in
`supabase/versions.md`), so the full stack starts with everything else: Postgres, Auth, PostgREST, Realtime, Storage,
imgproxy, postgres-meta, Edge Functions, Supavisor, the Envoy API gateway, Studio, Logflare analytics and Vector.

Yield Studio changes to the upstream files:
- `supabase/.env.example`: placeholder secrets (no demo keys); gateway on port 54321, because 8000 is the Yield Studio API; `SITE_URL` is the website.
- `supabase/docker-compose.yml`: published ports bound to 127.0.0.1.
- `supabase/docker-compose.yieldstudio.yml`: Postgres and Storage data in Docker named volumes (a bind-mounted
  Postgres data folder fails on macOS with "wrong ownership").

The Yield Studio backend and website still use the Supabase project set in `backend/.env` and
`frontend/.env.local`. To use the local stack instead, point them at it: `SUPABASE_URL` / `VITE_SUPABASE_URL` =
`http://localhost:54321` (backend in Docker: `http://api-gw:8000`), the keys from `supabase/.env`, and
`DATABASE_URL` = `postgresql://postgres.<POOLER_TENANT_ID>:<POSTGRES_PASSWORD>@supavisor:5432/postgres`; then load
`backend/supabase/schema.sql` in Studio's SQL editor.

## Images

Both images are multi-stage builds: the build stage has the compilers, package managers and sources; the runtime
stage gets only what runs.

| Image | Build stage | Runtime stage |
|---|---|---|
| `yieldstudio-backend` | python:3.12-slim + uv, installs requirements into `/opt/venv`, strips tests, bytecode and unused Google API descriptions | python:3.12-slim + the virtualenv + `*.py`, non-root user `app` |
| `yieldstudio-frontend` | node:22-alpine, `npm ci` and `vite build` | unprivileged nginx:alpine + `dist/` only (~80 MB) |

The 30 m map layers (`frontend/public/cog/`, ~1.2 GB) and the yield-map GeoTIFFs are mounted into the containers
rather than copied into the images. Secrets never enter an image: `.dockerignore` excludes `.env` files and keys,
`backend/.env` is passed at run time, and `frontend/.env.local` is a BuildKit secret during the build.

## Logs and metrics

Every container writes to stdout. **Grafana Alloy** reads it through the Docker API and pushes it to **Loki** (kept
7 days). **Prometheus** scrapes the API's `/metrics` and the stack's own endpoints (kept 15 days). **Grafana** has
both as datasources and opens on the provisioned **Yield Studio** dashboard: request rate, errors, latency by route,
Earth Engine runs and durations, backend memory/CPU, and log panels.

Log streams in Loki (Grafana → Explore → Loki):

| Query | What |
|---|---|
| `{service="backend", logger="yieldstudio.api"}` | API messages, warnings, errors with tracebacks |
| `{service="backend", logger="yieldstudio.access"}` | one line per request: method, path, route, status, duration, user |
| `{service="backend", logger="yieldstudio.ee"}` | Earth Engine script runs, exports, cancels |
| `{service="frontend"}` | nginx access log |
| `{service="backend", level="error"}` | all backend errors |

Set `LOG_LEVEL=DEBUG` in `backend/.env` for more detail. Outside Docker (`uvicorn main:app --reload`) the API logs
readable text to the terminal instead of JSON.

Requirements: Node.js 22+, [uv](https://docs.astral.sh/uv/) (creates the backend's Python 3.12 environment).

Notes:
- `backend/.env` → `DATA_ROOT` must point at the folder that holds `outputs/v2.0/yield_maps`; the default assumes
  the parent research repository.
- The 30 m map layers in `frontend/public/cog/` (~1.2 GB) are not in git; rebuild them with
  `frontend/scripts/build_demo_data.py`.
- Until Supabase is configured the sign-in is a demo: any @osu.edu or @buckeyemail.osu.edu address, code `0000`.

## Deploy

`.github/workflows/deploy.yml` builds `frontend/` and publishes it to GitHub Pages. It runs only when started by hand
(Actions tab → "Deploy frontend to GitHub Pages" → Run workflow); pushes do not deploy.
One-time: repo Settings → Pages → Source: "GitHub Actions".
