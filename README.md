# Yield Studio

Web platform for the AgSensing Lab's crop yield work at The Ohio State University: 30 m corn and soybean yield maps
estimated from satellite greenness and August weather (method of KC & Khanal, 2023), with a no-code Explore page and
a Python Earth Engine Studio.

## Repository layout

```
.
├── frontend/          React + Vite website (see frontend/README.md)
├── backend/           FastAPI API, Earth Engine runner, Supabase schema, file pipeline (see backend/README.md)
├── email-templates/   Supabase Auth email templates (invite, sign-in code)
├── data/              Source data for the app (large boundary file is not in git)
├── .github/workflows/ GitHub Pages deploy for the frontend
├── run.sh             Start / stop / restart / status / logs for all services or one (backend 8000, frontend 5173)
├── logs/              One log file per service (created on start, not in git)
└── PLAN.md            Plan for the full application
```

## Quick start

```bash
git config core.hooksPath .githooks             # once per clone: blocks commits containing secrets
cp backend/.env.example backend/.env            # fill in
cp frontend/.env.example frontend/.env.local    # fill in (optional: without it only the demo sign-in works)
./run.sh start                                  # all services; installs dependencies on first run
./run.sh start backend                          # or just one: backend | frontend
./run.sh status                                 # what is running
./run.sh restart frontend                       # stop + start
./run.sh logs earth-engine                      # follow a log live
./run.sh stop                                   # all services, or ./run.sh stop frontend
```

## Logs

Every service writes to its own file in `logs/` (ignored by git), each line timestamped:

| File | What is in it |
|---|---|
| `logs/backend.log` | API messages, warnings, errors with tracebacks, uvicorn start/stop |
| `logs/backend-access.log` | one line per HTTP request: client, method, path, status, duration, signed-in user |
| `logs/earth-engine.log` | Earth Engine script runs (duration, layers, exports, errors), export status, cancels |
| `logs/frontend.log` | Vite dev server output |

Each start rotates the service's logs (`backend.log` → `backend.log.1` … `.5`). Follow one live with
`./run.sh logs backend` (or `backend-access`, `earth-engine`, `frontend`). Set `LOG_LEVEL=DEBUG` in `backend/.env` for more detail.

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
