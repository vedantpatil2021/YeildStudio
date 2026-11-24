# Yield Studio backend

| Path | What it is |
|---|---|
| `main.py` | FastAPI: checks the Supabase login on every call (OSU addresses only) and serves every Studio action (below). |
| `ee_runner.py`, `ee_child.py` | Runs a Studio script on Earth Engine in a separate, time- and memory-limited process. `Map.addLayer` returns map tiles, `print` returns console output, and `Export` becomes a task. |
| `supabase/schema.sql` | Database: OSU-only guard on sign-up, `profiles` (with UI `settings`), `projects`, `scripts`, `runs`, `tasks`, `assets`, `files`, `jobs`, row level security. |

## Two kinds of account

- **`tester@osu.edu`**: UI mode only. Code `0000`, no email is sent, and the server is never called.
  Projects and scripts are kept in that browser's storage, and Run shows the precomputed results.
- **Any other `@osu.edu` / `@buckeyemail.osu.edu` address**: live mode. Supabase emails a one-time code.
  Everything goes through this API into Supabase, and Run executes the script on Earth Engine.
  The API refuses `tester@osu.edu` tokens.

## What each Studio button calls

| In the app | Route |
|---|---|
| Open Studio (first visit creates "My first project" with the starter scripts) | `GET /me`, `GET /projects`, `POST /projects` |
| Project menu: switch / new / rename / delete | `GET /projects/{id}/scripts` + tasks + assets, `POST /projects`, `PATCH /projects/{id}`, `DELETE /projects/{id}` |
| Map layers, basemap, county lines and open script (saved per project) | `PATCH /projects/{id}` (`state`) |
| Scripts: new / rename / delete / edit (autosave after 1.2 s, or ⌘/Ctrl + S) | `POST /projects/{id}/scripts`, `PATCH /scripts/{id}`, `DELETE /scripts/{id}` |
| Run (⌘/Ctrl + Enter) | `POST /projects/{id}/runs`: Earth Engine; console lines, tile layers, map position, new tasks; the run is recorded |
| Models → Predict | `POST /projects/{id}/predict`: summary of the 30 m GeoTIFF; recorded as a run |
| Tasks: Run / Retry / cancel-remove (status refreshes every 5 s while running) | `POST /tasks/{id}/start`, `GET /projects/{id}/tasks`, `DELETE /tasks/{id}` |
| Assets: add to map / remove | `POST /assets/{id}/tiles`, `DELETE /assets/{id}` |
| Panel sizes (drag the bars), Explore's last crop and year | `PUT /me/settings` |
| Console chart PNG / CSV | in the browser, no server call |

Script runs execute user code. The child process has time and memory limits, an empty working folder and a minimal environment.
That is not a full sandbox: run `ee_child.py` in a container before the API serves anyone beyond trusted lab users.
| `pipeline/main.py` | Cloud Run functions: bucket event → Globus transfer to OSC → delete from the bucket once Globus reports success. |

## Run locally

```bash
cd v2.0/app/backend
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
cp .env.example .env            # fill it in
PYTHONDONTWRITEBYTECODE=1 .venv/bin/uvicorn main:app --reload --port 8000
```

`GET /health` shows which parts are configured. Every other route needs `Authorization: Bearer <Supabase access token>`;
the website sends it for you (`api()` in `frontend/src/lib/auth.tsx`).

## Supabase setup (once)

1. Create a project at supabase.com (free plan is enough).
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. **Authentication → Sign In / Providers → Email**: on. Set *Email OTP length* to 6 (it must match `VITE_OTP_LENGTH`)
   and *Email OTP expiration* to 600 seconds. Turn every other provider off.
4. **Authentication → Emails → Templates**: in both **Magic Link** and **Confirm signup**, replace the link with the code,
   for example `<h2>Your Yield Studio code</h2><p>{{ .Token }}</p><p>It expires in 10 minutes.</p>`.
   Without `{{ .Token }}` Supabase emails a link instead of a code.
5. **Authentication → Emails → SMTP Settings**: add a real SMTP sender (OSU's, or a free plan such as Resend or Brevo).
   Supabase's built-in sender only mails the project's own team members and a few messages an hour.
6. **Authentication → URL Configuration**: Site URL = where the website runs (`http://localhost:5173` for now).
7. **Project Settings → API**: copy the URL and the anon (publishable) key into `frontend/.env.local`, and the URL into
   `backend/.env`. **Project Settings → Database → Connection string** goes into `DATABASE_URL`.
8. In `backend/.env` set `EE_PROJECT` (the lab's Earth Engine Cloud project) and, on a server, `EE_SERVICE_ACCOUNT_FILE`.
   `FRONTEND_ORIGIN` takes a comma-separated list, e.g. `http://localhost:5173,http://localhost:5179`.

Sessions: the browser keeps the session and refreshes it (Supabase default: 1-hour access token, long-lived refresh
token). To force people to sign in again after a while, set **Authentication → Sessions** (time-box or inactivity
timeout; these need a paid plan) or shorten the JWT expiry.

## Who can sign in

Only `name@osu.edu` and `name@buckeyemail.osu.edu`, checked in three places:
the sign-in form, the database trigger in `schema.sql` (so the Supabase API itself refuses other addresses),
and `current_user()` in `main.py` (so the API refuses any token without one).

## File pipeline (Phase 4)

See the docstring in `pipeline/main.py` for deploy commands and `pipeline/env.example.yaml` for its settings.
It needs a staging bucket in a free-tier region, a Globus collection over that bucket (Google Cloud Storage connector,
which needs a Globus subscription), OSC's Globus collection and a Globus service app with access to both.
Not tested yet: it needs those accounts.
