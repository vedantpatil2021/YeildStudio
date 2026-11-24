/**
 * Where a user's work lives. One interface, two versions:
 *  - ApiStore (live accounts): the FastAPI backend, which keeps everything in Supabase and runs scripts on Earth Engine.
 *  - LocalStore (tester@osu.edu): this browser's storage only. Nothing reaches the server; runs use the in-browser demo.
 */
import { api, type Mode } from "./auth"
import type { Crop } from "./api"

export type SavedLayer = { id: string; key: string; name: string; visible: boolean; opacity: number }
export type ProjectState = { layers?: SavedLayer[]; basemap?: string; showCounties?: boolean; scriptId?: string }
export type Project = { id: string; name: string; description: string; state: ProjectState; updated_at: string; scripts?: number }
export type Script = { id: string; project_id: string; name: string; content: string; updated_at: string }
export type TaskState = "READY" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"
export type Task = {
  id: string; description: string; export_type: string; params: Record<string, unknown>; state: TaskState
  progress: number; error: string | null; created_at: string
}
export type Asset = { id: string; name: string; ee_asset_id: string | null; created_at: string; key?: string }
export type Settings = {
  panels?: { left: number; right: number; top: number }
  lastProject?: string
  explore?: { crop?: Crop; year?: number }
}
export type RunLayer = { name: string; url: string; visible: boolean; opacity: number }
export type RunResult = {
  logs: ({ type: "text"; text: string; value?: string | number } | { type: "object"; label: string; value: Record<string, unknown> })[]
  layers: RunLayer[]
  center: { bounds?: [[number, number], [number, number]]; lat?: number; lon?: number; zoom?: number | null } | null
  error: string | null
  tasks: Task[]
}
export type MapStats = { mean_t_ha: number; min_t_ha: number; max_t_ha: number; pixels_30m: number; source: string }

export interface Store {
  mode: Mode
  settings(): Promise<Settings>
  saveSettings(patch: Settings): Promise<void>
  listProjects(): Promise<Project[]>
  createProject(name: string, description: string, scripts: { name: string; content: string }[]): Promise<Project>
  updateProject(id: string, patch: { name?: string; description?: string; state?: ProjectState }): Promise<Project>
  deleteProject(id: string): Promise<void>
  listScripts(projectId: string): Promise<Script[]>
  createScript(projectId: string, name: string, content: string): Promise<Script>
  updateScript(id: string, patch: { name?: string; content?: string }): Promise<Script>
  deleteScript(id: string): Promise<void>
  /** Live only: runs the code on Earth Engine. */
  run?(projectId: string, script: Script, code: string): Promise<RunResult>
  /** Tester only: the in-browser demo runner records its exports here. */
  addTask?(projectId: string, description: string, params: Record<string, unknown>): Promise<Task>
  predict(projectId: string, crop: Crop, year: number): Promise<MapStats | null>
  listTasks(projectId: string): Promise<Task[]>
  startTask(id: string): Promise<Task>
  deleteTask(id: string): Promise<void>
  listAssets(projectId: string): Promise<Asset[]>
  assetTiles?(id: string): Promise<{ name: string; url: string }>
  deleteAsset(id: string): Promise<void>
}

/** Script file names: letters, digits, _ - . and spaces, ending in .py (the database checks the same rule). */
export function scriptName(raw: string) {
  const name = raw.trim().endsWith(".py") ? raw.trim() : `${raw.trim()}.py`
  return /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,78}\.py$/.test(name) ? name : null
}

const json = (body: unknown) => ({ body: JSON.stringify(body) })

export class ApiStore implements Store {
  mode = "live" as const
  settings = async () => (await api<{ settings: Settings }>("/me")).settings
  saveSettings = async (patch: Settings) => { await api("/me/settings", { method: "PUT", ...json({ settings: patch }) }) }
  listProjects = () => api<Project[]>("/projects")
  createProject = (name: string, description: string, scripts: { name: string; content: string }[]) =>
    api<Project>("/projects", { method: "POST", ...json({ name, description, scripts }) })
  updateProject = (id: string, patch: object) => api<Project>(`/projects/${id}`, { method: "PATCH", ...json(patch) })
  deleteProject = async (id: string) => { await api(`/projects/${id}`, { method: "DELETE" }) }
  listScripts = (projectId: string) => api<Script[]>(`/projects/${projectId}/scripts`)
  createScript = (projectId: string, name: string, content: string) =>
    api<Script>(`/projects/${projectId}/scripts`, { method: "POST", ...json({ name, content }) })
  updateScript = (id: string, patch: object) => api<Script>(`/scripts/${id}`, { method: "PATCH", ...json(patch) })
  deleteScript = async (id: string) => { await api(`/scripts/${id}`, { method: "DELETE" }) }
  run = (projectId: string, script: Script, code: string) =>
    api<RunResult>(`/projects/${projectId}/runs`, { method: "POST", ...json({ script_id: script.id, script_name: script.name, code }) })
  predict = (projectId: string, crop: Crop, year: number) =>
    api<MapStats>(`/projects/${projectId}/predict`, { method: "POST", ...json({ crop, year }) })
  listTasks = (projectId: string) => api<Task[]>(`/projects/${projectId}/tasks`)
  startTask = (id: string) => api<Task>(`/tasks/${id}/start`, { method: "POST" })
  deleteTask = async (id: string) => { await api(`/tasks/${id}`, { method: "DELETE" }) }
  listAssets = (projectId: string) => api<Asset[]>(`/projects/${projectId}/assets`)
  assetTiles = (id: string) => api<{ name: string; url: string }>(`/assets/${id}/tiles`, { method: "POST" })
  deleteAsset = async (id: string) => { await api(`/assets/${id}`, { method: "DELETE" }) }
}

/* ---- tester: everything in localStorage ------------------------------------------------------------------- */

type LocalTask = Task & { project_id: string; started?: number }
type LocalAsset = Asset & { project_id: string; task_id: string }
type LocalDb = { settings: Settings; projects: Project[]; scripts: Script[]; tasks: LocalTask[]; assets: LocalAsset[] }
const KEY = "yield-studio-tester-workspace"
const TASK_MS = 6000            // a demo export "runs" for 6 seconds

export class LocalStore implements Store {
  mode = "tester" as const
  private mem: LocalDb | null = null

  private db(): LocalDb {
    if (this.mem) return this.mem
    let saved: LocalDb | null = null
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? "null") } catch { /* storage blocked: memory only */ }
    return (this.mem = saved ?? { settings: {}, projects: [], scripts: [], tasks: [], assets: [] })
  }
  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.mem)) } catch { /* memory only */ } }
  private now = () => new Date().toISOString()
  private id = () => crypto.randomUUID()
  private find<T extends { id: string }>(rows: T[], id: string, what: string) {
    const row = rows.find((r) => r.id === id)
    if (!row) throw new Error(`${what} not found`)
    return row
  }
  private touch(projectId: string) { const p = this.db().projects.find((x) => x.id === projectId); if (p) p.updated_at = this.now() }

  settings = async () => this.db().settings
  saveSettings = async (patch: Settings) => { Object.assign(this.db().settings, patch); this.save() }

  listProjects = async () => {
    const d = this.db()
    return [...d.projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((p) => ({ ...p, scripts: d.scripts.filter((s) => s.project_id === p.id).length }))
  }
  createProject = async (name: string, description: string, scripts: { name: string; content: string }[]) => {
    const d = this.db()
    if (d.projects.some((p) => p.name === name.trim())) throw new Error("That name is already used. Pick another one.")
    const p: Project = { id: this.id(), name: name.trim(), description: description.trim(), state: {}, updated_at: this.now() }
    d.projects.push(p)
    scripts.forEach((s) => d.scripts.push({ id: this.id(), project_id: p.id, name: s.name, content: s.content, updated_at: this.now() }))
    this.save()
    return p
  }
  updateProject = async (id: string, patch: { name?: string; description?: string; state?: ProjectState }) => {
    const d = this.db(), p = this.find(d.projects, id, "Project")
    if (patch.name && d.projects.some((x) => x.id !== id && x.name === patch.name!.trim())) throw new Error("That name is already used. Pick another one.")
    Object.assign(p, { ...patch, ...(patch.name && { name: patch.name.trim() }), updated_at: this.now() })
    this.save()
    return { ...p }
  }
  deleteProject = async (id: string) => {
    const d = this.db()
    this.find(d.projects, id, "Project")
    d.projects = d.projects.filter((p) => p.id !== id)
    d.scripts = d.scripts.filter((s) => s.project_id !== id)
    d.tasks = d.tasks.filter((t) => t.project_id !== id)
    d.assets = d.assets.filter((a) => a.project_id !== id)
    this.save()
  }

  listScripts = async (projectId: string) => this.db().scripts.filter((s) => s.project_id === projectId).sort((a, b) => a.name.localeCompare(b.name)).map((s) => ({ ...s }))
  createScript = async (projectId: string, name: string, content: string) => {
    const d = this.db()
    if (d.scripts.some((s) => s.project_id === projectId && s.name === name)) throw new Error("That name is already used. Pick another one.")
    const s: Script = { id: this.id(), project_id: projectId, name, content, updated_at: this.now() }
    d.scripts.push(s); this.touch(projectId); this.save()
    return { ...s }
  }
  updateScript = async (id: string, patch: { name?: string; content?: string }) => {
    const d = this.db(), s = this.find(d.scripts, id, "Script")
    if (patch.name && d.scripts.some((x) => x.id !== id && x.project_id === s.project_id && x.name === patch.name)) throw new Error("That name is already used. Pick another one.")
    Object.assign(s, patch, { updated_at: this.now() }); this.touch(s.project_id); this.save()
    return { ...s }
  }
  deleteScript = async (id: string) => { const d = this.db(); this.find(d.scripts, id, "Script"); d.scripts = d.scripts.filter((s) => s.id !== id); this.save() }

  addTask = async (projectId: string, description: string, params: Record<string, unknown>) => {
    const t: LocalTask = { id: this.id(), project_id: projectId, description, export_type: "image.toAsset", params, state: "READY", progress: 0, error: null, created_at: this.now() }
    this.db().tasks.push(t); this.save()
    return { ...t }
  }
  predict = async () => null          // the page reads the stats from meta.json
  listTasks = async (projectId: string) => {
    const d = this.db()
    for (const t of d.tasks.filter((x) => x.project_id === projectId && x.state === "RUNNING" && x.started)) {
      t.progress = Math.min(100, ((Date.now() - t.started!) / TASK_MS) * 100)
      if (t.progress >= 100) {
        t.state = "COMPLETED"
        d.assets.push({ id: this.id(), project_id: projectId, task_id: t.id, name: t.description, ee_asset_id: null, key: t.params.key as string, created_at: this.now() })
      }
    }
    this.save()
    return d.tasks.filter((t) => t.project_id === projectId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((t) => ({ ...t }))
  }
  startTask = async (id: string) => {
    const t = this.find(this.db().tasks, id, "Task")
    Object.assign(t, { state: "RUNNING", started: Date.now(), progress: 0, error: null }); this.save()
    return { ...t }
  }
  deleteTask = async (id: string) => { const d = this.db(); d.tasks = d.tasks.filter((t) => t.id !== id); this.save() }
  listAssets = async (projectId: string) => this.db().assets.filter((a) => a.project_id === projectId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => ({ ...a }))
  deleteAsset = async (id: string) => { const d = this.db(); d.assets = d.assets.filter((a) => a.id !== id); this.save() }
}

let stores: Partial<Record<Mode, Store>> = {}
export const storeFor = (mode: Mode): Store => (stores[mode] ??= mode === "live" ? new ApiStore() : new LocalStore())
/** Forget cached stores (on sign-out), so the next account starts clean. */
export const resetStores = () => { stores = {} }
