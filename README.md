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
├── start.sh / stop.sh Start / stop backend (port 8000) and frontend (port 5173) locally
└── PLAN.md            Plan for the full application
```

## Quick start

```bash
git config core.hooksPath .githooks             # once per clone: blocks commits containing secrets
cp backend/.env.example backend/.env            # fill in
cp frontend/.env.example frontend/.env.local    # fill in (optional: without it only the demo sign-in works)
./start.sh                                      # installs dependencies on first run
./stop.sh
```

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
