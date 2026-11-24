-- Yield Studio database. Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Supabase holds logins and records only; files live in Cloud Storage (staging) and then OSC.

-- Only OSU addresses can ever become users: the check runs inside the database, so it holds even if
-- someone calls the Supabase API directly instead of using the website.
create or replace function public.is_osu_email(email text) returns boolean
language sql immutable as $$
  select lower(substring(coalesce(email, '') from '@([^@]+)$')) in ('osu.edu', 'buckeyemail.osu.edu')
$$;

create or replace function public.guard_osu_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_osu_email(new.email) then
    raise exception 'Only @osu.edu and @buckeyemail.osu.edu addresses can sign in';
  end if;
  return new;
end $$;

drop trigger if exists guard_osu_email on auth.users;
create trigger guard_osu_email before insert or update of email on auth.users
  for each row execute function public.guard_osu_email();

-- One profile per user, created on first sign-in.
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text not null,
  created_at timestamptz not null default now()
);

create or replace function public.create_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, lower(new.email)) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists create_profile on auth.users;
create trigger create_profile after insert on auth.users
  for each row execute function public.create_profile();

-- Every file the platform makes or receives. The file itself is never stored here:
-- uploading → in gs://<bucket>/staging/, transferring → Globus is copying it to OSC,
-- at_osc → copied and deleted from the bucket, failed → still in the bucket, needs a look.
create table if not exists public.files (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users on delete set null,      -- null for files the lab's own jobs export
  name text not null,
  kind text not null default 'upload' check (kind in ('upload', 'export', 'model')),
  bytes bigint,
  gcs_path text unique,
  osc_path text,
  status text not null default 'uploading' check (status in ('uploading', 'transferring', 'at_osc', 'failed')),
  globus_task text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists files_status on public.files (status);

-- Long work (exports, training, full-season maps), shown in the Jobs module.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  owner uuid references auth.users on delete set null,
  kind text not null,
  params jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  progress real not null default 0,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The website reads through the FastAPI backend, which connects as the database owner.
-- Row level security still limits any direct API access to a user's own rows.
alter table public.profiles enable row level security;
alter table public.files enable row level security;
alter table public.jobs enable row level security;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "own files" on public.files;
create policy "own files" on public.files for select to authenticated using (owner = (select auth.uid()));
drop policy if exists "own jobs" on public.jobs;
create policy "own jobs" on public.jobs for select to authenticated using (owner = (select auth.uid()));

-- ============================================================================================================
-- Studio workspace: every user has their own projects, scripts, runs, tasks and assets. Safe to run again.
-- ============================================================================================================

-- UI settings per user (panel widths, last crop and year, ...)
alter table public.profiles add column if not exists settings jsonb not null default '{}';
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create or replace function public.touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- A project groups scripts, runs, tasks and assets. state = the saved map (layers, basemap, open script).
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  state jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner, name)
);
create index if not exists projects_owner on public.projects (owner, updated_at desc);

-- Python (earthengine-api) scripts of a project
create table if not exists public.scripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects on delete cascade,
  owner uuid not null references auth.users on delete cascade,
  name text not null check (name ~ '^[A-Za-z0-9_][A-Za-z0-9_. -]{0,78}\.py$'),
  content text not null default '' check (octet_length(content) <= 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);
create index if not exists scripts_project on public.scripts (project_id, name);

-- One row per Run press: the code that ran and everything it printed or drew
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  project_id uuid references public.projects on delete cascade,
  script_id uuid references public.scripts on delete set null,
  script_name text not null,
  code text not null,
  kind text not null default 'script' check (kind in ('script', 'predict')),
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  output jsonb not null default '{}',            -- {logs: [...], layers: [...], center: ...}
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists runs_project on public.runs (project_id, started_at desc);

-- Earth Engine exports created by a run (Export.*). READY until the user presses Run on it.
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  run_id uuid references public.runs on delete set null,
  description text not null,
  export_type text not null,                     -- e.g. image.toAsset
  params jsonb not null default '{}',            -- the Export call's plain arguments (assetId, scale, ...)
  code text not null,                            -- script snapshot; re-run to start this export
  state text not null default 'READY' check (state in ('READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  ee_task_id text,
  progress real not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_project on public.tasks (project_id, created_at desc);

-- Finished exports (Earth Engine asset IDs or other outputs) a user can add back to the map
create table if not exists public.assets (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null references auth.users on delete cascade,
  project_id uuid not null references public.projects on delete cascade,
  task_id uuid references public.tasks on delete set null,
  name text not null,
  ee_asset_id text,
  vis jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists assets_project on public.assets (project_id, created_at desc);

drop trigger if exists touch on public.projects;
create trigger touch before update on public.projects for each row execute function public.touch();
drop trigger if exists touch on public.scripts;
create trigger touch before update on public.scripts for each row execute function public.touch();
drop trigger if exists touch on public.tasks;
create trigger touch before update on public.tasks for each row execute function public.touch();

-- Row level security: a user only ever sees and changes their own rows (the API also filters by owner).
alter table public.projects enable row level security;
alter table public.scripts enable row level security;
alter table public.runs enable row level security;
alter table public.tasks enable row level security;
alter table public.assets enable row level security;

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists "own scripts" on public.scripts;
create policy "own scripts" on public.scripts for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
drop policy if exists "own runs" on public.runs;
create policy "own runs" on public.runs for select to authenticated using (owner = (select auth.uid()));
drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for select to authenticated using (owner = (select auth.uid()));
drop policy if exists "own assets" on public.assets;
create policy "own assets" on public.assets for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()));

-- Indexes on the columns row level security and the API filter or join on (owner on every table, and the
-- foreign keys looked up when tasks finish or rows are deleted)
create index if not exists scripts_owner on public.scripts (owner);
create index if not exists runs_owner on public.runs (owner);
create index if not exists runs_script on public.runs (script_id);
create index if not exists tasks_owner on public.tasks (owner);
create index if not exists tasks_run on public.tasks (run_id);
create index if not exists assets_owner on public.assets (owner);
create index if not exists assets_task on public.assets (task_id);
create index if not exists files_owner on public.files (owner);
create index if not exists jobs_owner on public.jobs (owner);

-- The two SECURITY DEFINER trigger functions live in public; nobody should be able to call them directly.
revoke execute on function public.guard_osu_email() from public, anon, authenticated;
revoke execute on function public.create_profile() from public, anon, authenticated;

-- ---- Roles and invitations -----------------------------------------------------------------------------------
-- role: 'admin' can invite people (POST /admin/invites). Change it only with SQL in the dashboard, e.g.
--   update public.profiles set role = 'admin' where email = 'lastname.1@osu.edu';
alter table public.profiles add column if not exists role text not null default 'member' check (role in ('member', 'admin'));

-- Profiles are written only by the API (database owner) and the sign-up trigger. Browsers can read their own row
-- but never change it, so nobody can make themselves an admin through the Supabase Data API.
drop policy if exists "update own profile" on public.profiles;
revoke insert, update, delete on public.profiles from anon, authenticated;
