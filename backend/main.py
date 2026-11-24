"""Yield Studio API (FastAPI). Every route except /health needs a Supabase access token from an OSU address, and every
query is limited to the signed-in user's own rows.

    /me, /me/settings                       who is signed in; their UI settings (panel widths, last crop/year)
    /projects (+ /{id})                     list, create (with starter scripts), rename, save map state, delete
    /projects/{id}/scripts, /scripts/{id}   list, add, update (content or name), delete
    /projects/{id}/runs                     run a script on Earth Engine (layers, console, exports); run history
    /projects/{id}/predict                  yield-map summary from the 30 m GeoTIFF of a crop and year
    /projects/{id}/tasks, /tasks/{id}       exports: list (status refreshed from Earth Engine), start, cancel/delete
    /projects/{id}/assets, /assets/{id}     finished exports: list, map tiles, delete
    /files, /files/upload, /jobs            Cloud Storage → OSC file pipeline (Phase 4, not used by Studio yet)

Settings come from the environment (see .env.example). Run from v2.0/app/backend:

    uvicorn main:app --reload --port 8000
"""
import json
import os
import re
import uuid
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

import jwt
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

for line in (Path(__file__).parent / ".env").read_text().splitlines() if (Path(__file__).parent / ".env").exists() else []:
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())

import ee_runner  # noqa: E402  (reads EE_* settings from the environment loaded above)

ALLOWED_DOMAINS = {"osu.edu", "buckeyemail.osu.edu"}
TESTER = "tester@osu.edu"        # UI-only demo account: handled in the browser, never accepted here
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")     # server only: sends invitations (Auth admin API)
ADMIN_EMAILS = {e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()}
JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET")          # legacy HS256 projects; newer ones use the JWKS below
DATABASE_URL = os.environ.get("DATABASE_URL")
BUCKET = os.environ.get("GCS_BUCKET")
FRONTEND = [o.strip() for o in os.environ.get("FRONTEND_ORIGIN", "http://localhost:5173").split(",") if o.strip()]
DATA_ROOT = Path(os.environ.get("DATA_ROOT") or Path(__file__).resolve().parents[3])   # repository root (outputs/v2.0)
SCRIPT_NAME = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_. -]{0,78}\.py$")

app = FastAPI(title="Yield Studio API")
app.add_middleware(CORSMiddleware, allow_origins=FRONTEND, allow_methods=["*"], allow_headers=["*"])
bearer = HTTPBearer(auto_error=False)
jwks = jwt.PyJWKClient(f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json", cache_keys=True) if SUPABASE_URL else None


# ---- sign-in and database ------------------------------------------------------------------------------------

def osu_email(email: str) -> bool:
    return email.lower().rsplit("@", 1)[-1] in ALLOWED_DOMAINS and email.count("@") == 1


class User(BaseModel):
    id: str
    email: str


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> User:
    """The signed-in user, from the Supabase access token the website sends."""
    if creds is None:
        raise HTTPException(401, "Sign in first")
    token = creds.credentials
    try:
        alg = jwt.get_unverified_header(token).get("alg")
        if alg == "HS256" and JWT_SECRET:            # legacy shared-secret projects
            claims = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], audience="authenticated")
        elif alg in ("ES256", "RS256") and jwks:     # current projects: asymmetric signing keys, checked with the public JWKS
            key = jwks.get_signing_key_from_jwt(token)
            claims = jwt.decode(token, key, algorithms=[alg], audience="authenticated")
        else:
            raise HTTPException(401, "Unsupported sign-in token; set SUPABASE_URL (and SUPABASE_JWT_SECRET for legacy projects)")
    except jwt.PyJWTError:
        raise HTTPException(401, "Session expired, sign in again")
    email = (claims.get("email") or "").lower()
    if not osu_email(email):
        raise HTTPException(403, "Only @osu.edu and @buckeyemail.osu.edu addresses can use Yield Studio")
    if email == TESTER:
        raise HTTPException(403, "tester@osu.edu is the offline demo account and does not use the server")
    return User(id=claims["sub"], email=email)


def db():
    if not DATABASE_URL:
        raise HTTPException(503, "Set DATABASE_URL to the Supabase Postgres connection string")
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(DATABASE_URL, row_factory=dict_row, autocommit=True)


def q(conn, sql: str, args=()) -> list[dict]:
    """Run one statement; unique-name clashes become a 409 with a plain message."""
    import psycopg
    try:
        cur = conn.execute(sql, args)
        return cur.fetchall() if cur.description else []
    except psycopg.errors.UniqueViolation:
        raise HTTPException(409, "That name is already used. Pick another one.")
    except psycopg.errors.CheckViolation:
        raise HTTPException(422, "Name or content not allowed (names: letters, digits, _ - . and spaces; scripts end in .py).")


def one(rows: list[dict], what: str) -> dict:
    if not rows:
        raise HTTPException(404, f"{what} not found")
    return rows[0]


def project_of(conn, project_id: str, user: User) -> dict:
    return one(q(conn, "select * from projects where id = %s and owner = %s", (project_id, user.id)), "Project")


def jsonb(v) -> str:
    return json.dumps(v)


# ---- health and profile --------------------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"ok": True, "auth": bool(JWT_SECRET or jwks), "database": bool(DATABASE_URL), "storage": bool(BUCKET),
            "earth_engine": ee_runner.configured(), "maps": (DATA_ROOT / "outputs/v2.0/yield_maps").is_dir()}


@app.get("/me")
def me(user: User = Depends(current_user)):
    with db() as conn:
        row = q(conn, "insert into profiles (id, email) values (%s, %s) on conflict (id) do update set email = excluded.email "
                      "returning settings, role", (user.id, user.email))
    return {**user.model_dump(), "settings": row[0]["settings"], "role": role_of(row[0]["role"], user)}


class Settings(BaseModel):
    settings: dict


@app.put("/me/settings")
def save_settings(body: Settings, user: User = Depends(current_user)):
    if len(jsonb(body.settings)) > 20000:
        raise HTTPException(413, "Settings too large")
    with db() as conn:
        return one(q(conn, "update profiles set settings = settings || %s::jsonb where id = %s returning settings",
                     (jsonb(body.settings), user.id)), "Profile")


# ---- invitations (admins) -----------------------------------------------------------------------------------

def role_of(db_role: str, user: User) -> str:
    """profiles.role, or admin when the address is in ADMIN_EMAILS (to bootstrap the first admin)."""
    return "admin" if db_role == "admin" or user.email in ADMIN_EMAILS else "member"


def admin_user(user: User = Depends(current_user)) -> User:
    with db() as conn:
        row = q(conn, "select role from profiles where id = %s", (user.id,))
    if role_of(row[0]["role"] if row else "member", user) != "admin":
        raise HTTPException(403, "Only Yield Studio admins can invite people")
    return user


def auth_admin(method: str, path: str, body: dict | None = None) -> dict:
    """Supabase Auth admin API with the service key (never sent to browsers)."""
    import urllib.error
    import urllib.request
    if not SERVICE_KEY:
        raise HTTPException(503, "Set SUPABASE_SERVICE_ROLE_KEY in backend/.env to send invitations")
    headers = {"apikey": SERVICE_KEY, "Content-Type": "application/json"}
    if not SERVICE_KEY.startswith("sb_secret_"):           # legacy service_role JWT also goes in Authorization
        headers["Authorization"] = f"Bearer {SERVICE_KEY}"
    req = urllib.request.Request(f"{SUPABASE_URL}/auth/v1{path}", method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = json.loads(e.read() or b"{}")
        msg = detail.get("msg") or detail.get("message") or detail.get("error_description") or str(e)
        if "already been registered" in msg:
            raise HTTPException(409, "This address already has an account. They can sign in with an email code.")
        if "rate limit" in msg.lower():
            raise HTTPException(429, "Supabase's email limit was reached. Wait a while, or add your own SMTP sender.")
        if "database error" in msg.lower():
            raise HTTPException(422, "Only @osu.edu and @buckeyemail.osu.edu addresses can be invited.")
        raise HTTPException(502, f"Supabase Auth: {msg}")


INVITE_COLS = ("select id, email, invited_at, last_sign_in_at, raw_user_meta_data->>'invited_by' as invited_by, "
               "case when last_sign_in_at is not null then 'accepted' else 'pending' end as status from auth.users")


class InviteIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)


@app.get("/admin/invites")
def list_invites(user: User = Depends(admin_user)):
    with db() as conn:
        return q(conn, INVITE_COLS + " where invited_at is not null order by invited_at desc limit 200")


@app.post("/admin/invites", status_code=201)
def invite(body: InviteIn, user: User = Depends(admin_user)):
    """Supabase creates the account and emails the "Invite user" template (email-templates/invite.html, pasted in the dashboard)."""
    email = body.email.strip().lower()
    if not osu_email(email) or not re.match(r"^[^@\s]+@[^@\s]+$", email):
        raise HTTPException(422, "Only @osu.edu and @buckeyemail.osu.edu addresses can be invited.")
    if email == TESTER:
        raise HTTPException(422, "tester@osu.edu is the offline demo account and cannot be invited.")
    made = auth_admin("POST", "/invite", {"email": email, "data": {"invited_by": user.email}})
    with db() as conn:
        return one(q(conn, INVITE_COLS + " where id = %s", (made.get("id"),)), "Invitation")


@app.delete("/admin/invites/{user_id}", status_code=204)
def revoke_invite(user_id: uuid.UUID, user: User = Depends(admin_user)):
    """Withdraws an invitation that was never accepted (deletes the unused account)."""
    with db() as conn:
        row = one(q(conn, "select last_sign_in_at from auth.users where id = %s and invited_at is not null", (str(user_id),)), "Invitation")
    if row["last_sign_in_at"] is not None:
        raise HTTPException(409, "Already accepted: this person has signed in.")
    auth_admin("DELETE", f"/admin/users/{user_id}")


# ---- projects ------------------------------------------------------------------------------------------------

PROJECT_COLS = "id, name, description, state, created_at, updated_at"


class ScriptIn(BaseModel):
    name: str
    content: str = ""


class ProjectIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field("", max_length=500)
    scripts: list[ScriptIn] = []


class ProjectPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = Field(None, max_length=500)
    state: dict | None = None


def check_script(s: ScriptIn | None = None, name: str | None = None, content: str | None = None):
    name = s.name if s else name
    content = s.content if s else content
    if name is not None and not SCRIPT_NAME.match(name):
        raise HTTPException(422, "Script names use letters, digits, _ - . or spaces and end in .py (at most 80 characters).")
    if content is not None and len(content.encode()) > 200_000:
        raise HTTPException(413, "Scripts are limited to 200 KB.")


@app.get("/projects")
def list_projects(user: User = Depends(current_user)):
    with db() as conn:
        return q(conn, f"select {PROJECT_COLS}, (select count(*) from scripts s where s.project_id = p.id) as scripts "
                       f"from projects p where owner = %s order by updated_at desc", (user.id,))


@app.post("/projects", status_code=201)
def create_project(body: ProjectIn, user: User = Depends(current_user)):
    for s in body.scripts:
        check_script(s)
    with db() as conn, conn.transaction():
        p = q(conn, f"insert into projects (owner, name, description) values (%s, %s, %s) returning {PROJECT_COLS}",
              (user.id, body.name.strip(), body.description.strip()))[0]
        for s in body.scripts:
            q(conn, "insert into scripts (project_id, owner, name, content) values (%s, %s, %s, %s)", (p["id"], user.id, s.name, s.content))
    return p


@app.patch("/projects/{project_id}")
def update_project(project_id: uuid.UUID, body: ProjectPatch, user: User = Depends(current_user)):
    if body.state is not None and len(jsonb(body.state)) > 100_000:
        raise HTTPException(413, "Map state too large")
    with db() as conn:
        project_of(conn, str(project_id), user)
        return one(q(conn, f"update projects set name = coalesce(%s, name), description = coalesce(%s, description), "
                           f"state = coalesce(%s::jsonb, state) where id = %s and owner = %s returning {PROJECT_COLS}",
                     (body.name and body.name.strip(), body.description, None if body.state is None else jsonb(body.state),
                      str(project_id), user.id)), "Project")


@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        one(q(conn, "delete from projects where id = %s and owner = %s returning id", (str(project_id), user.id)), "Project")


# ---- scripts -------------------------------------------------------------------------------------------------

SCRIPT_COLS = "id, project_id, name, content, created_at, updated_at"


class ScriptPatch(BaseModel):
    name: str | None = None
    content: str | None = None


@app.get("/projects/{project_id}/scripts")
def list_scripts(project_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        project_of(conn, str(project_id), user)
        return q(conn, f"select {SCRIPT_COLS} from scripts where project_id = %s and owner = %s order by name", (str(project_id), user.id))


@app.post("/projects/{project_id}/scripts", status_code=201)
def create_script(project_id: uuid.UUID, body: ScriptIn, user: User = Depends(current_user)):
    check_script(body)
    with db() as conn:
        project_of(conn, str(project_id), user)
        s = q(conn, f"insert into scripts (project_id, owner, name, content) values (%s, %s, %s, %s) returning {SCRIPT_COLS}",
              (str(project_id), user.id, body.name, body.content))[0]
        q(conn, "update projects set updated_at = now() where id = %s", (str(project_id),))
        return s


@app.patch("/scripts/{script_id}")
def update_script(script_id: uuid.UUID, body: ScriptPatch, user: User = Depends(current_user)):
    check_script(name=body.name, content=body.content)
    with db() as conn:
        s = one(q(conn, f"update scripts set name = coalesce(%s, name), content = coalesce(%s, content) "
                        f"where id = %s and owner = %s returning {SCRIPT_COLS}", (body.name, body.content, str(script_id), user.id)), "Script")
        q(conn, "update projects set updated_at = now() where id = %s", (s["project_id"],))
        return s


@app.delete("/scripts/{script_id}", status_code=204)
def delete_script(script_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        one(q(conn, "delete from scripts where id = %s and owner = %s returning id", (str(script_id), user.id)), "Script")


# ---- runs (Earth Engine) -------------------------------------------------------------------------------------

TASK_COLS = "id, project_id, run_id, description, export_type, params, state, ee_task_id, progress, error, created_at, updated_at"


class RunIn(BaseModel):
    script_id: uuid.UUID | None = None
    script_name: str = Field(min_length=1, max_length=80)
    code: str = Field(max_length=200_000)


@app.post("/projects/{project_id}/runs")
def run(project_id: uuid.UUID, body: RunIn, user: User = Depends(current_user)):
    """Runs the code on Earth Engine and records the run. Exports become READY tasks (started from the Tasks tab)."""
    with db() as conn:
        project_of(conn, str(project_id), user)
        r = q(conn, "insert into runs (owner, project_id, script_id, script_name, code) values (%s, %s, %s, %s, %s) returning id",
              (user.id, str(project_id), body.script_id and str(body.script_id), body.script_name, body.code))[0]
    try:
        out = ee_runner.run_script(body.code)
    except ee_runner.EEError as e:
        out = {"logs": [], "layers": [], "center": None, "exports": [], "error": str(e)}
    with db() as conn:
        q(conn, "update runs set status = %s, output = %s, error = %s, finished_at = now() where id = %s",
          ("failed" if out.get("error") else "done", jsonb({k: out.get(k) for k in ("logs", "layers", "center")}), out.get("error"), r["id"]))
        tasks = [q(conn, f"insert into tasks (owner, project_id, run_id, description, export_type, params, code) "
                         f"values (%s, %s, %s, %s, %s, %s, %s) returning {TASK_COLS}",
                   (user.id, str(project_id), r["id"], e["description"], e["export_type"], jsonb(e["params"]), body.code))[0]
                 for e in out.get("exports", [])] if not out.get("error") else []
    return {"run_id": r["id"], "logs": out.get("logs", []), "layers": out.get("layers", []), "center": out.get("center"),
            "error": out.get("error"), "tasks": tasks}


@app.get("/projects/{project_id}/runs")
def list_runs(project_id: uuid.UUID, limit: int = 20, user: User = Depends(current_user)):
    with db() as conn:
        project_of(conn, str(project_id), user)
        return q(conn, "select id, script_name, kind, status, error, started_at, finished_at from runs "
                       "where project_id = %s and owner = %s order by started_at desc limit %s", (str(project_id), user.id, min(limit, 100)))


# ---- predict (precomputed 30 m maps) -------------------------------------------------------------------------

class PredictIn(BaseModel):
    crop: str = Field(pattern="^(corn|soybean)$")
    year: int = Field(ge=2009, le=2100)


@lru_cache(maxsize=64)
def map_stats(crop: str, year: int) -> dict:
    """Mean/min/max and pixel count of a 30 m yield map, read from the GeoTIFF itself."""
    import numpy as np
    import rasterio
    path = DATA_ROOT / "outputs/v2.0/yield_maps" / f"{year}_{crop}_yield.tif"
    if not path.exists():
        raise HTTPException(404, f"No {crop} yield map for {year}")
    with rasterio.open(path) as src:
        a = src.read(1, masked=True).filled(np.nan)
    v = a[np.isfinite(a)]
    return {"mean_t_ha": round(float(v.mean()), 3), "min_t_ha": round(float(v.min()), 3), "max_t_ha": round(float(v.max()), 3),
            "pixels_30m": int(v.size), "source": "HLS" if year >= 2020 else "HISTARFM"}


@app.post("/projects/{project_id}/predict")
def predict(project_id: uuid.UUID, body: PredictIn, user: User = Depends(current_user)):
    stats = map_stats(body.crop, body.year)
    with db() as conn:
        project_of(conn, str(project_id), user)
        q(conn, "insert into runs (owner, project_id, script_name, code, kind, status, output, finished_at) "
                "values (%s, %s, %s, %s, 'predict', 'done', %s, now())",
          (user.id, str(project_id), f"predict {body.crop} {body.year}", f"predict --crop {body.crop} --year {body.year} --model MLR", jsonb(stats)))
    return stats


# ---- tasks (exports) and assets ------------------------------------------------------------------------------

def refresh(conn, task: dict) -> dict:
    """Pull the latest state of a running export from Earth Engine; a finished asset export becomes an asset."""
    if task["state"] != "RUNNING" or not task["ee_task_id"]:
        return task
    try:
        s = ee_runner.task_status(task["ee_task_id"])
    except Exception as e:
        return {**task, "error": f"Could not read status: {e}"}
    task = q(conn, f"update tasks set state = %s, progress = %s, error = %s where id = %s returning {TASK_COLS}",
             (s["state"], s["progress"], s["error"], task["id"]))[0]
    asset_id = task["params"].get("assetId")
    if task["state"] == "COMPLETED" and asset_id and not q(conn, "select 1 from assets where task_id = %s", (task["id"],)):
        q(conn, "insert into assets (owner, project_id, task_id, name, ee_asset_id) select owner, project_id, id, description, %s "
                "from tasks where id = %s", (asset_id, task["id"]))
    return task


@app.get("/projects/{project_id}/tasks")
def list_tasks(project_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        project_of(conn, str(project_id), user)
        return [refresh(conn, t) for t in q(conn, f"select {TASK_COLS} from tasks where project_id = %s and owner = %s "
                                                  f"order by created_at desc", (str(project_id), user.id))]


@app.post("/tasks/{task_id}/start")
def start_task(task_id: uuid.UUID, user: User = Depends(current_user)):
    """Re-runs the task's script snapshot and starts only the export with this description."""
    with db() as conn:
        t = one(q(conn, f"select {TASK_COLS}, code from tasks where id = %s and owner = %s", (str(task_id), user.id)), "Task")
    if t["state"] not in ("READY", "FAILED", "CANCELLED"):
        raise HTTPException(409, f"Task is already {t['state'].lower()}")
    try:
        out = ee_runner.run_script(t["code"], start=t["description"])
    except ee_runner.EEError as e:
        out = {"error": str(e)}
    ok = bool(out.get("started"))
    with db() as conn:
        return q(conn, f"update tasks set state = %s, ee_task_id = %s, progress = 0, error = %s where id = %s returning {TASK_COLS}",
                 ("RUNNING" if ok else "FAILED", out.get("started"), None if ok else (out.get("error") or "The export was not found when re-running the script"),
                  str(task_id)))[0]


@app.delete("/tasks/{task_id}", status_code=204)
def delete_task(task_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        t = one(q(conn, "select state, ee_task_id from tasks where id = %s and owner = %s", (str(task_id), user.id)), "Task")
        if t["state"] == "RUNNING" and t["ee_task_id"]:
            try:
                ee_runner.cancel_task(t["ee_task_id"])
            except Exception as e:
                raise HTTPException(502, f"Could not cancel the Earth Engine task: {e}")
        q(conn, "delete from tasks where id = %s", (str(task_id),))


@app.get("/projects/{project_id}/assets")
def list_assets(project_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        project_of(conn, str(project_id), user)
        return q(conn, "select id, project_id, task_id, name, ee_asset_id, vis, created_at from assets "
                       "where project_id = %s and owner = %s order by created_at desc", (str(project_id), user.id))


@app.post("/assets/{asset_id}/tiles")
def asset_tiles(asset_id: uuid.UUID, user: User = Depends(current_user)):
    with db() as conn:
        a = one(q(conn, "select name, ee_asset_id, vis from assets where id = %s and owner = %s", (str(asset_id), user.id)), "Asset")
    if not a["ee_asset_id"]:
        raise HTTPException(422, "This asset has no Earth Engine ID")
    try:
        return {"name": a["name"], "url": ee_runner.asset_tiles(a["ee_asset_id"], a["vis"] or {"min": 6, "max": 12.5,
                "palette": ["d73027", "fc8d59", "fee08b", "91cf60", "1a9850"]})}
    except Exception as e:
        raise HTTPException(502, f"Earth Engine: {e}")


@app.delete("/assets/{asset_id}", status_code=204)
def delete_asset(asset_id: uuid.UUID, user: User = Depends(current_user)):
    """Removes the record only; the Earth Engine asset itself is kept."""
    with db() as conn:
        one(q(conn, "delete from assets where id = %s and owner = %s returning id", (str(asset_id), user.id)), "Asset")


# ---- file pipeline (Phase 4) ---------------------------------------------------------------------------------

@app.get("/files")
def files(user: User = Depends(current_user)):
    with db() as conn:
        return q(conn, "select id, name, kind, bytes, status, osc_path, error, created_at, updated_at from files "
                       "where owner = %s order by created_at desc", (user.id,))


class Upload(BaseModel):
    name: str
    bytes: int
    content_type: str = "application/octet-stream"


@app.post("/files/upload")
def upload(body: Upload, user: User = Depends(current_user)):
    """A 15-minute signed PUT link into the staging folder. The bucket event takes it to OSC from there."""
    if not BUCKET:
        raise HTTPException(503, "Set GCS_BUCKET")
    from google.cloud import storage
    file_id = str(uuid.uuid4())
    name = re.sub(r"[^\w.\-]+", "_", body.name)[:120] or "file"
    path = f"staging/{user.id}/{file_id}/{name}"
    url = storage.Client().bucket(BUCKET).blob(path).generate_signed_url(
        version="v4", expiration=timedelta(minutes=15), method="PUT", content_type=body.content_type)
    with db() as conn:
        q(conn, "insert into files (id, owner, name, kind, bytes, gcs_path) values (%s, %s, %s, 'upload', %s, %s)",
          (file_id, user.id, body.name, body.bytes, path))
    return {"id": file_id, "url": url, "content_type": body.content_type}


@app.get("/jobs")
def jobs(user: User = Depends(current_user)):
    with db() as conn:
        return q(conn, "select id, kind, status, progress, result, error, created_at, updated_at from jobs "
                       "where owner = %s order by created_at desc", (user.id,))
