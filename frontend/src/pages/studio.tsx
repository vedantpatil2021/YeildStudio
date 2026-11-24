import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import Editor, { type OnMount } from "@monaco-editor/react"
import { motion } from "motion/react"
import { Check, CheckCircle2, ChevronRight, CircleHelp, Database, Download, FileCode2, FolderOpen, Globe, Layers, Loader2, Maximize2, MapPin, Minimize2, Pencil, Play, Plus, RotateCcw, Save, Sparkles, Sprout, Trash2, Upload, Wand2, X } from "lucide-react"
import { Assistant } from "@/components/assistant"
import type L from "leaflet"
import { TextureButton } from "@/components/ui/texture-button"
import { TextureCard } from "@/components/ui/texture-card"
import { BasemapSwitch, CountiesToggle, LayersCard, Legend, MapView, type Basemap, type MapLayer } from "@/components/map"
import { Tip, Tour, seen, type TourStep } from "@/components/guide"
import { GeeDialog } from "@/components/gee-dialog"
import { ResizeHandle } from "@/components/resize-handle"
import { Segmented } from "@/components/segmented"
import { SiteHeader } from "@/components/site-header"
import { YearTimeline } from "@/components/year-timeline"
import { FIRST_YEAR, HLS_FROM, LAST_YEAR, YEARS, modelFor, useCounties, useMeta, valueAt, type Crop, type Meta } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { countyAt, countyInfo, countyTipHtml } from "@/lib/county"
import { CROP_NAME, PROJECT, countyLabel, fmt } from "@/lib/constants"
import { LAYERS, layerKind, statements, stringsIn, studioScripts } from "@/lib/scripts"
import { scriptName, storeFor, type Asset, type Project, type Script, type Settings, type Task } from "@/lib/store"
import { cn } from "@/lib/utils"

type LogEntry =
  | { type: "cmd" | "note" | "error" | "text"; text: string; value?: string | number }
  | { type: "object"; label: string; value: Record<string, unknown> }
  | { type: "chart"; crop: Crop; year: number }
type Log = LogEntry & { id: number }
type Status = { mode: "idle" | "running" | "done" | "error"; text?: string }
type Panels = NonNullable<Settings["panels"]>

const DEFAULT_PANELS: Panels = { left: 290, right: 370, top: 0.45 }
const LIMITS = { left: [200, 560], right: [260, 680], top: [0.18, 0.85] } as const
const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v))
const NEW_SCRIPT = `# New Earth Engine script. Map.addLayer, print and Export work as in the Code Editor.
import ee
ee.Initialize(project="${PROJECT}")

counties = ee.FeatureCollection("TIGER/2018/Counties").filter(ee.Filter.eq("STATEFP", "39"))
print("Ohio counties:", counties.size())
Map.centerObject(counties, 7)
Map.addLayer(counties, {"color": "1f2937"}, "Ohio counties")
`

let uid = 0
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function saveFile(name: string, blob: Blob) {
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

function ObjectTree({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(true)
  if (value === null || typeof value !== "object")
    return <div className="pl-4 font-mono text-xs"><span className="text-muted-foreground">{label}: </span><span className="text-sky-700">{typeof value === "number" ? +value.toFixed(4) : String(value)}</span></div>
  return (
    <div className="font-mono text-xs">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-foreground"><ChevronRight size={12} className={cn("transition", open && "rotate-90")} />{label}</button>
      {open && <div className="ml-1.5 border-l pl-3">{Object.entries(value).map(([k, v]) => <ObjectTree key={k} label={k} value={v} />)}</div>}
    </div>
  )
}

/** Model vs USDA county yields; the chosen year is highlighted. Downloads as PNG or CSV. */
function CountyChart({ meta, crop, year }: { meta: Meta; crop: Crop; year: number }) {
  const rows = meta.counties[crop]
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<(typeof rows)[number] | null>(null)
  const W = 320, H = 220, P = 32
  const title = `${CROP_NAME[crop]}: model vs USDA county yield (t/ha), ${year} highlighted`
  const vals = rows.flatMap((r) => [r.obs, r.pred]), lo = Math.floor(Math.min(...vals)), hi = Math.ceil(Math.max(...vals))
  const x = (v: number) => P + ((v - lo) / (hi - lo)) * (W - P - 8), y = (v: number) => H - P + 4 - ((v - lo) / (hi - lo)) * (H - P - 4)
  const file = `${crop}_${year}_model_vs_usda`

  const png = () => {
    const xml = new XMLSerializer().serializeToString(svg.current!)
    const img = new Image()
    img.onload = () => {
      const k = 3, head = 28, c = document.createElement("canvas")
      c.width = W * k; c.height = (H + head) * k
      const ctx = c.getContext("2d")!
      ctx.scale(k, k)
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H + head)
      ctx.fillStyle = "#111"; ctx.font = "600 10px system-ui, sans-serif"; ctx.fillText(title, 8, 17)
      ctx.drawImage(img, 0, head, W, H)
      ctx.font = "9px system-ui, sans-serif"; ctx.fillStyle = "#666"
      ctx.fillText("x: USDA NASS  ·  y: model", W - 118, H + head - 2)
      c.toBlob((b) => b && saveFile(`${file}.png`, b), "image/png")
    }
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml)
  }
  const csv = () => {
    const lines = ["crop,GEOID,county,year,usda_t_ha,model_t_ha,highlighted",
      ...rows.map((r) => [crop, r.GEOID, `"${countyLabel(r)}"`, r.year, r.obs, r.pred, r.year === year].join(","))]
    saveFile(`${file}.csv`, new Blob([lines.join("\n") + "\n"], { type: "text/csv" }))
  }

  return (
    <TextureCard><div className="relative p-3">
      <div className="flex items-start gap-2">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="ml-auto flex shrink-0 gap-1">
          {([["PNG", png], ["CSV", csv]] as const).map(([t, f]) => (
            <button key={t} onClick={f} title={`Download as ${t}`} className="flex items-center gap-1 rounded-md border bg-white px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:border-neutral-400 hover:text-foreground"><Download size={11} />{t}</button>
          ))}
        </div>
      </div>
      <svg ref={svg} xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} fontFamily="system-ui, sans-serif">
        <rect width={W} height={H} fill="#fff" />
        <line x1={x(lo)} y1={y(lo)} x2={x(hi)} y2={y(hi)} stroke="#c9cfc8" strokeDasharray="4 4" />
        {[lo, (lo + hi) / 2, hi].map((t) => <g key={t} fontSize="9.5" fill="#8a948e"><text x={P - 6} y={y(t) + 3} textAnchor="end">{fmt(t, 1)}</text><text x={x(t)} y={H - 10} textAnchor="middle">{fmt(t, 1)}</text></g>)}
        {rows.map((r, i) => r.year !== year && <circle key={i} cx={x(r.obs)} cy={y(r.pred)} r={2.5} fill="#dfe4dd" />)}
        {rows.map((r, i) => r.year === year && <circle key={`s${i}`} cx={x(r.obs)} cy={y(r.pred)} r={hover === r ? 6 : 4.5} fill="#171717" stroke="#fff" strokeWidth={1.5} onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} />)}
      </svg>
      {hover && <div className="pointer-events-none absolute rounded-lg border bg-white px-2 py-1 text-[11px] shadow" style={{ left: Math.min(x(hover.obs) + 10, W - 150), top: y(hover.pred) + 20 }}>{countyLabel(hover)}<br />USDA {fmt(hover.obs)} · model {fmt(hover.pred)}</div>}
    </div></TextureCard>
  )
}

function LogLine({ meta, log }: { meta: Meta; log: Log }) {
  if (log.type === "cmd") return <div className="pt-2 font-mono text-xs text-muted-foreground"><span className="text-emerald-700">❯</span> {log.text}</div>
  if (log.type === "error") return <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 font-mono text-xs text-red-700">{log.text}</div>
  if (log.type === "note") return <div className="text-xs text-muted-foreground">{log.text}</div>
  if (log.type === "object") return <ObjectTree label={log.label} value={log.value} />
  if (log.type === "chart") return <CountyChart meta={meta} crop={log.crop} year={log.year} />
  return <div className="whitespace-pre-wrap font-mono text-xs text-foreground">{log.text}{log.value != null && <span className="text-sky-700"> {String(log.value)}</span>}</div>
}

function ModelPanel({ meta, onPredict, busy }: { meta: Meta; onPredict: (crop: Crop, year: number) => void; busy: boolean }) {
  const [crop, setCrop] = useState<Crop>("corn")
  const [year, setYear] = useState(LAST_YEAR)
  const m = modelFor(meta, crop, year), sign = (v: number) => `${v < 0 ? "−" : "+"} ${Math.abs(v).toFixed(Math.abs(v) < 0.1 ? 4 : 2)}`
  return (
    <div className="space-y-4 text-sm">
      <p className="rounded-xl bg-neutral-100 px-3 py-2 text-emerald-700">No code needed: choose and press Predict.</p>
      <Segmented value={crop} onChange={setCrop} options={[["corn", "Corn"], ["soybean", "Soybean"]]} />
      <div className="grid grid-cols-6 gap-1">
        {YEARS.map((y) => <button key={y} onClick={() => setYear(y)} className={cn("rounded-lg border py-1 text-xs tabular-nums transition", y === year ? "border-neutral-900 bg-neutral-100 font-semibold" : y >= HLS_FROM ? "bg-sky-50 hover:border-neutral-400" : "bg-white hover:border-neutral-400")}>{y}</button>)}
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">Models · {year >= HLS_FROM ? `HLS, trained 2013–${LAST_YEAR}` : "HISTARFM, trained 2009–2019 (paper)"} <Tip text="Test R² is the share of county-to-county differences explained (1 is perfect). RMSE is the typical error in t/ha." /></div>
        {m.metrics.map((r) => (
          <div key={r.model} className={cn("rounded-xl border px-3 py-2", r.model === "MLR" ? "border-neutral-900 bg-neutral-50" : "bg-white")}>
            <div className="flex items-center text-foreground">{{ MLR: "Linear regression", RF: "Random forest", SVM: "SVM (radial)" }[r.model]}
              <span className="ml-auto text-[10px] font-semibold uppercase text-muted-foreground">{r.model === "MLR" ? "used for maps" : "compare"}</span></div>
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">test R² <b className="text-foreground">{fmt(r.test_R2)}</b> · RMSE <b className="text-foreground">{fmt(r.test_RMSE)}</b> t/ha</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border bg-white p-3 font-mono text-xs leading-5 text-foreground">
        yield = {fmt(m.intercept)}<br />&nbsp;&nbsp;{sign(m.coef["mean.NDVI"])}·NDVI {sign(m.coef["mean.EVI2"])}·EVI2<br />&nbsp;&nbsp;{sign(m.coef.mean_aug_temp)}·Temp {sign(m.coef.mean_aug_ppt)}·Rain
      </div>
      <TextureButton variant="primary" disabled={busy} onClick={() => onPredict(crop, year)} className="disabled:opacity-60"><Sprout size={15} /> Predict yield map</TextureButton>
    </div>
  )
}

/** Small inline text field used for new and renamed projects and scripts (no browser pop-ups). */
function InlineName({ initial, placeholder, onSubmit, onCancel }: { initial?: string; placeholder: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial ?? "")
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()) }} className="flex items-center gap-1">
      <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === "Escape" && onCancel()}
        className="min-w-0 flex-1 rounded-lg border bg-white px-2 py-1.5 font-mono text-xs outline-none focus:border-neutral-900" />
      <button type="submit" className="rounded-md p-1 text-emerald-700 hover:bg-muted" title="Save"><Check size={14} /></button>
      <button type="button" onClick={onCancel} className="rounded-md p-1 text-muted-foreground hover:bg-muted" title="Cancel"><X size={14} /></button>
    </form>
  )
}

function Confirm({ text, onYes, onNo }: { text: string; onYes: () => void; onNo: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button onClick={onYes} className="font-semibold hover:underline">Delete</button>
      <button onClick={onNo} className="text-muted-foreground hover:underline">Cancel</button>
    </div>
  )
}

export default function Studio() {
  const meta = useMeta()
  const navigate = useNavigate()
  const { mode, email } = useAuth()
  const store = storeFor(mode ?? "tester")
  const live = store.mode === "live"
  const templates = useRef<Record<string, string>>({})

  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState<Project | null>(null)
  const [scripts, setScripts] = useState<Script[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [scriptId, setScriptId] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ kind: "newProject" | "renameProject" | "newScript" | "renameScript"; id?: string } | null>(null)
  const [confirm, setConfirm] = useState<{ kind: "project" | "script" | "task" | "asset"; id: string; name: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)

  const [left, setLeft] = useState<"scripts" | "models" | "assets">("scripts")
  const [right, setRight] = useState<"inspector" | "console" | "tasks">("console")
  const [chat, setChat] = useState(false)
  const [layers, setLayers] = useState<MapLayer[]>([])
  const [logs, setLogs] = useState<Log[]>([{ id: uid++, type: "note", text: "Output appears here. Press Run (⌘/Ctrl + Enter) to start." }])
  const [tasks, setTasks] = useState<Task[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [status, setStatus] = useState<Status>({ mode: "idle" })
  const [inspect, setInspect] = useState<{ lat: number; lng: number; values: { name: string; unit: string; v: number | null }[]; county: string | null } | null>(null)
  const counties = useCounties()
  const [basemap, setBasemap] = useState<Basemap>("Map")
  const [showCounties, setShowCounties] = useState(true)
  const [predicted, setPredicted] = useState<{ crop: Crop; year: number } | null>(null)
  const [gee, setGee] = useState<{ crop: Crop; year: number } | null>(null)
  const [tour, setTour] = useState(() => !seen.get("ys_studio_tour"))
  const [panels, setPanels] = useState<Panels>(DEFAULT_PANELS)
  const [maximized, setMaximized] = useState(false)
  const mapRef = useRef<L.Map | null>(null)
  const work = useRef<HTMLDivElement>(null)
  const busy = useRef(false)
  const layersRef = useRef(layers)
  layersRef.current = layers
  const savedState = useRef("")

  const script = scripts.find((s) => s.id === scriptId) ?? null
  const code = script ? drafts[script.id] ?? script.content : ""
  const fail = (e: unknown) => setProblem(message(e))
  const log = (...entries: LogEntry[]) => setLogs((l) => [...l, ...entries.map((e) => ({ ...e, id: uid++ }))])

  /* ---- loading ----------------------------------------------------------------------------------------- */

  const openProject = useCallback(async (p: Project) => {
    setProject(p); setProblem(null); setDrafts({}); setInspect(null); setPredicted(null); setEdit(null); setConfirm(null)
    try {
      const [s, t, a] = await Promise.all([store.listScripts(p.id), store.listTasks(p.id), store.listAssets(p.id)])
      setScripts(s); setTasks(t); setAssets(a)
      const st = p.state ?? {}
      setLayers(st.layers ?? [])
      setBasemap((st.basemap as Basemap) ?? "Map")
      setShowCounties(st.showCounties ?? true)
      setScriptId(s.some((x) => x.id === st.scriptId) ? st.scriptId! : s[0]?.id ?? null)
      savedState.current = JSON.stringify(st)
      setLogs([{ id: uid++, type: "note", text: `Project "${p.name}" · ${s.length} script${s.length === 1 ? "" : "s"}${live ? " · saved to your account" : " · tester mode: saved in this browser only"}.` }])
      void store.saveSettings({ lastProject: p.id }).catch(() => {})
    } catch (e) { fail(e) }
  }, [store])

  useEffect(() => {
    if (!meta) return
    templates.current = studioScripts(meta)
    const starter = () => Object.entries(templates.current).map(([name, content]) => ({ name, content }))
    ;(async () => {
      try {
        const settings = await store.settings()
        if (settings.panels) setPanels(settings.panels)
        panelsLoaded.current = true
        let list = await store.listProjects()
        if (!list.length) list = [await store.createProject("My first project", "Starter scripts from the Maumee yield study", starter())]
        setProjects(list)
        await openProject(list.find((p) => p.id === settings.lastProject) ?? list[0])
      } catch (e) { fail(e) } finally { setBooting(false) }
    })()
  }, [meta, store])

  /* ---- saving: map state per project, scripts as you type, panel sizes per user ------------------------- */

  useEffect(() => {
    if (!project) return
    const state = { layers: layers.filter((l) => !l.tiles).map(({ id, key, name, visible, opacity }) => ({ id, key, name, visible, opacity })), basemap, showCounties, scriptId: scriptId ?? undefined }
    const s = JSON.stringify(state)
    if (s === savedState.current) return
    const t = setTimeout(() => {
      savedState.current = s
      store.updateProject(project.id, { state }).then((p) => setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...p } : x)))).catch(fail)
    }, 800)
    return () => clearTimeout(t)
  }, [layers, basemap, showCounties, scriptId, project?.id])

  const saveScripts = useCallback(async () => {
    const pending = Object.entries(drafts).filter(([id, c]) => scripts.find((s) => s.id === id)?.content !== c)
    if (!pending.length) return
    setSaving(true)
    try {
      const saved = await Promise.all(pending.map(([id, content]) => store.updateScript(id, { content })))
      setScripts((ss) => ss.map((s) => saved.find((x) => x.id === s.id) ?? s))
      setDrafts((d) => { const n = { ...d }; saved.forEach((s) => { if (n[s.id] === s.content) delete n[s.id] }); return n })
    } catch (e) { fail(e) } finally { setSaving(false) }
  }, [drafts, scripts, store])
  useEffect(() => { const t = setTimeout(saveScripts, 1200); return () => clearTimeout(t) }, [drafts])
  const unsaved = (id: string) => drafts[id] != null && drafts[id] !== scripts.find((s) => s.id === id)?.content

  /** Move one panel edge by delta (px; for "top" a share of the work area). Builds on the latest value, so no drag step is lost. */
  const nudge = (k: keyof Panels, delta: number) => setPanels((p) => ({ ...p, [k]: clamp(p[k] + delta, LIMITS[k]) }))
  const reset = (k: keyof Panels) => setPanels((p) => ({ ...p, [k]: DEFAULT_PANELS[k] }))
  const panelsLoaded = useRef(false)      // never save the defaults over a user's layout before it has loaded
  useEffect(() => {
    if (!panelsLoaded.current) return
    const t = setTimeout(() => void store.saveSettings({ panels }).catch(() => {}), 600)
    return () => clearTimeout(t)
  }, [panels])

  /* ---- projects and scripts ---------------------------------------------------------------------------- */

  const createProject = async (name: string) => {
    try {
      const p = await store.createProject(name, "", Object.entries(templates.current).map(([n, content]) => ({ name: n, content })))
      setProjects((ps) => [p, ...ps]); setEdit(null); await openProject(p)
    } catch (e) { fail(e) }
  }
  const renameProject = async (name: string) => {
    if (!project) return
    try { const p = await store.updateProject(project.id, { name }); setProject(p); setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...p } : x))); setEdit(null) } catch (e) { fail(e) }
  }
  const deleteProject = async (id: string) => {
    try {
      await store.deleteProject(id)
      const rest = projects.filter((p) => p.id !== id)
      setProjects(rest); setConfirm(null)
      if (rest.length) await openProject(rest[0])
      else { setProject(null); setScripts([]); setTasks([]); setAssets([]); setLayers([]) }
    } catch (e) { fail(e) }
  }
  const createScript = async (raw: string) => {
    const name = scriptName(raw)
    if (!project) return
    if (!name) return setProblem("Script names use letters, digits, _ - . or spaces and end in .py.")
    try { const s = await store.createScript(project.id, name, NEW_SCRIPT); setScripts((ss) => [...ss, s].sort((a, b) => a.name.localeCompare(b.name))); setScriptId(s.id); setEdit(null); setProblem(null) } catch (e) { fail(e) }
  }
  const renameScript = async (id: string, raw: string) => {
    const name = scriptName(raw)
    if (!name) return setProblem("Script names use letters, digits, _ - . or spaces and end in .py.")
    try { const s = await store.updateScript(id, { name }); setScripts((ss) => ss.map((x) => (x.id === id ? s : x)).sort((a, b) => a.name.localeCompare(b.name))); setEdit(null); setProblem(null) } catch (e) { fail(e) }
  }
  const deleteScript = async (id: string) => {
    try {
      await store.deleteScript(id)
      const rest = scripts.filter((s) => s.id !== id)
      setScripts(rest); setConfirm(null); setDrafts((d) => { const n = { ...d }; delete n[id]; return n })
      if (scriptId === id) setScriptId(rest[0]?.id ?? null)
    } catch (e) { fail(e) }
  }

  /* ---- running ----------------------------------------------------------------------------------------- */

  const addLayer = (key: string, name: string, id = `l${uid++}`, tiles?: string) =>
    setLayers((ls) => ls.some((l) => l.id === id) ? ls.map((l) => (l.id === id ? { ...l, key, name, tiles } : l)) : [...ls, { id, key, name, visible: true, opacity: 0.95, tiles }])
  const finish = (t0: number, ok = true, text?: string) => {
    setStatus({ mode: ok ? "done" : "error", text: text ?? `Finished in ${((performance.now() - t0) / 1000).toFixed(1)} s` })
    setTimeout(() => setStatus({ mode: "idle" }), 2500)
    busy.current = false
  }

  /** tester@osu.edu: walks the script and turns Map / print / Export calls into the precomputed layers. */
  const demoRun = async (t0: number, code: string) => {
    const crop = ((code.match(/\bcrop\s*=\s*["'](corn|soybean)["']/) || [])[1] || "corn") as Crop
    const year = +((code.match(/\byear\s*=\s*(\d{4})/) || [])[1] || LAST_YEAR)
    await sleep(400)
    if (year < FIRST_YEAR || year > LAST_YEAR) { log({ type: "error", text: `No data for ${year}: maps cover ${FIRST_YEAR}–${LAST_YEAR} (HISTARFM to 2019, HLS from ${HLS_FROM}).` }); return finish(t0, false, "Script error") }
    if (year >= HLS_FROM) log({ type: "note", text: `${year}: greenness from HLS (Landsat + Sentinel-2), model trained on HLS.` })
    for (const s of statements(code)) {
      if (/^ee\.Initialize/.test(s)) log({ type: "note", text: `Tester mode · precomputed results, no Earth Engine` })
      else if (/^Map\.centerObject/.test(s)) mapRef.current?.flyToBounds(meta!.layers.yield_corn_2019.bounds, { padding: [30, 30], duration: 1 })
      else if (/^Map\.addLayer/.test(s)) {
        const kind = layerKind(s.split(",")[0]) ?? layerKind(s)
        if (!kind) { log({ type: "error", text: `No precomputed tiles for "${stringsIn(s).pop()}" in tester mode. Sign in with your OSU address to run it on Earth Engine.` }); continue }
        const info = LAYERS[kind](crop, year)
        if (!meta!.layers[info.key]) { log({ type: "error", text: `No GeoTIFF for ${info.name}: the source file is missing from data/gee_export.` }); continue }
        setStatus({ mode: "running", text: `Loading ${info.band}` })
        await sleep(400)
        addLayer(info.key, info.name)
      } else if (/^print\(/.test(s)) {
        const label = stringsIn(s)[0] ?? "", kind = layerKind(s.slice(label.length + 8))
        if (/\.size\(\)/.test(s)) log({ type: "text", text: label, value: 14 })
        else if (kind && /reduceRegion/.test(s)) {
          const info = LAYERS[kind](crop, year), st = meta!.layers[info.key]?.stats
          if (!st) log({ type: "error", text: `No GeoTIFF for ${info.name}.` })
          else log({ type: "object", label, value: /mean\(\)/.test(s) ? { [info.band]: st.mean } : { [`${info.band}_min`]: st.min, [`${info.band}_max`]: st.max } })
        } else log({ type: "text", text: label })
      } else if (/Export\.image/.test(s)) {
        const desc = ((s.match(/description\s*=\s*f?["']([^"']+)/) || [])[1] ?? `${crop}_${year}`).replace("{crop}", crop).replace("{year}", String(year))
        const t = await store.addTask!(project!.id, desc, { crop, year, key: `yield_${crop}_${year}` })
        setTasks((ts) => [t, ...ts])
        log({ type: "note", text: `Task "${desc}" created. Start it in Tasks.` })
      }
    }
    finish(t0)
  }

  const run = useCallback(async () => {
    if (!meta || !project || !script || busy.current) return
    busy.current = true
    setRight("console")
    const t0 = performance.now()
    log({ type: "cmd", text: `python ${script.name}` })
    void saveScripts()
    if (!store.run) return demoRun(t0, code)
    setStatus({ mode: "running", text: "Running on Earth Engine" })
    try {
      const r = await store.run(project.id, script, code)
      if (r.logs.length) log(...r.logs)
      r.layers.forEach((l) => addLayer(l.url, l.name, `l${uid++}`, l.url))
      if (r.center?.bounds) mapRef.current?.flyToBounds(r.center.bounds, { padding: [30, 30], duration: 1, ...(r.center.zoom && { maxZoom: r.center.zoom }) })
      else if (r.center?.lat != null) mapRef.current?.flyTo([r.center.lat, r.center.lon!], r.center.zoom ?? mapRef.current.getZoom())
      if (r.tasks.length) { setTasks((ts) => [...r.tasks, ...ts]); r.tasks.forEach((t) => log({ type: "note", text: `Task "${t.description}" created. Start it in Tasks.` })) }
      if (r.error) log({ type: "error", text: r.error })
      finish(t0, !r.error, r.error ? "Script error" : undefined)
    } catch (e) { log({ type: "error", text: message(e) }); finish(t0, false, "Could not reach the server") }
  }, [meta, project, script, code, store, saveScripts])
  const runRef = useRef(run)
  runRef.current = run
  const saveRef = useRef(saveScripts)
  saveRef.current = saveScripts

  const predict = async (crop: Crop, year: number) => {
    if (!meta || !project || busy.current) return
    busy.current = true
    setRight("console")
    const t0 = performance.now(), metric = modelFor(meta, crop, year).metrics[0]
    log({ type: "cmd", text: `predict --crop ${crop} --year ${year} --model MLR${year >= HLS_FROM ? " --source hls" : ""}` })
    setStatus({ mode: "running", text: "Reading the 30 m map" })
    try {
      const st = meta.layers[`yield_${crop}_${year}`].stats
      const stats = (await store.predict(project.id, crop, year)) ?? { mean_t_ha: st.mean, min_t_ha: st.min, max_t_ha: st.max, pixels_30m: st.n, source: year >= HLS_FROM ? "HLS" : "HISTARFM" }
      addLayer(`yield_${crop}_${year}`, `Predicted ${crop} yield ${year}`, "prediction")
      setPredicted({ crop, year })
      log({ type: "object", label: `${CROP_NAME[crop]} yield ${year}`, value: { ...stats, test_R2: metric.test_R2, test_RMSE: metric.test_RMSE } }, { type: "chart", crop, year })
      finish(t0)
    } catch (e) { log({ type: "error", text: message(e) }); finish(t0, false, "Predict failed") }
  }

  /* ---- tasks and assets -------------------------------------------------------------------------------- */

  const refreshTasks = useCallback(async () => {
    if (!project) return
    try {
      const [t, a] = await Promise.all([store.listTasks(project.id), store.listAssets(project.id)])
      setTasks(t); setAssets(a)
    } catch (e) { fail(e) }
  }, [project, store])
  const anyRunning = tasks.some((t) => t.state === "RUNNING")
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(refreshTasks, live ? 5000 : 500)
    return () => clearInterval(t)
  }, [anyRunning, refreshTasks])

  const startTask = async (id: string) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, state: "RUNNING", progress: 0, error: null } : t)))
    try { const t = await store.startTask(id); setTasks((ts) => ts.map((x) => (x.id === id ? t : x))) } catch (e) { fail(e); void refreshTasks() }
  }
  const deleteTask = async (id: string) => { try { await store.deleteTask(id); setTasks((ts) => ts.filter((t) => t.id !== id)); setConfirm(null) } catch (e) { fail(e) } }
  const deleteAsset = async (id: string) => { try { await store.deleteAsset(id); setAssets((as) => as.filter((a) => a.id !== id)); setConfirm(null) } catch (e) { fail(e) } }
  const addAsset = async (a: Asset) => {
    if (a.key) return addLayer(a.key, `Asset · ${a.name}`)
    try { const t = await store.assetTiles!(a.id); addLayer(t.url, `Asset · ${a.name}`, `l${uid++}`, t.url) } catch (e) { fail(e) }
  }
  const geeOf = (params: Record<string, unknown>) => (params.crop && params.year ? { crop: params.crop as Crop, year: Number(params.year) } : null)

  /* ---- map --------------------------------------------------------------------------------------------- */

  const onMapClick = async (lat: number, lng: number) => {
    if (!meta) return
    setRight("inspector")
    const visible = layersRef.current.filter((l) => l.visible && !l.tiles).reverse()
    const values = await Promise.all(visible.map(async (l) => ({ name: l.name, unit: meta.palettes[meta.layers[l.key]?.kind]?.unit ?? "", v: await valueAt(meta, l.key, lat, lng) })))
    setInspect({ lat, lng, values, county: showCounties && counties ? countyAt(counties, lat, lng) : null })
  }
  const countyTip = (g: string) => countyTipHtml(countyInfo(meta!, counties!, g, predicted?.crop, predicted?.year), predicted?.crop, predicted?.year, "Predict a map in Models to see yields")

  const onMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current())
  }

  if (!meta) return null
  const top = [...layers].reverse().find((l) => l.visible)
  const topShare = maximized ? LIMITS.top[1] : panels.top
  const height = () => work.current?.clientHeight || window.innerHeight
  const steps: TourStep[] = [
    { target: "left", title: "Projects and scripts", text: "Each project keeps its own scripts, map, tasks and assets. Add, rename or delete scripts here; edits save by themselves.", before: () => setLeft("scripts") },
    { target: "editor", title: "Write and run", text: live ? "Edit Python Earth Engine code, then press Run or ⌘/Ctrl + Enter. It runs on Earth Engine under the lab's project." : "Edit the code, then press Run or ⌘/Ctrl + Enter. Tester mode shows precomputed results; sign in with your own OSU address to run on Earth Engine." },
    { target: "right", title: "Results", text: "Console shows output and charts (download them as PNG or CSV), Inspector shows values where you click the map, Tasks lists exports." },
    { target: "map", title: "Map", text: "Layers land here. Drag the bars between the panels to resize them; double-click a bar to reset." },
    { target: "left", title: "No code needed", text: "Models predicts a 30 m yield map and checks it against USDA county yields.", before: () => setLeft("models") },
  ]

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader sub="Studio · code + map">
        <div className={cn("hidden min-w-52 items-center gap-2 rounded-full border px-3 py-1.5 text-xs md:flex",
          status.mode === "running" ? "border-sky-200 bg-sky-50" : status.mode === "error" ? "border-red-200 bg-red-50" : status.mode === "done" ? "border-emerald-200 bg-neutral-100" : "bg-white")}>
          {status.mode === "running" ? <Loader2 size={13} className="animate-spin" /> : status.mode === "idle" ? <span className={cn("size-2 rounded-full", live ? "bg-emerald-600" : "bg-amber-500")} /> : <CheckCircle2 size={13} />}
          <motion.span key={status.text} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}>{status.mode === "idle" ? (live ? "Live · Earth Engine" : "Tester mode · offline") : status.text}</motion.span>
        </div>
        <TextureButton variant="minimal" className="w-auto" onClick={() => setTour(true)}><CircleHelp size={15} /> Help</TextureButton>
        <TextureButton variant="minimal" className="w-auto" onClick={() => navigate("/explore")}><Wand2 size={15} /> Explore</TextureButton>
        <TextureButton variant="minimal" aria-pressed={chat} className={cn("w-auto", chat && "ring-2 ring-neutral-900/20")} onClick={() => setChat(!chat)}><Sparkles size={15} /> Assistant</TextureButton>
        <Tip below text={predicted ? "Code that shows this map in the Earth Engine Code Editor" : "Predict a map in Models first"}>
          <TextureButton variant="minimal" className="w-auto disabled:opacity-50" disabled={!predicted} onClick={() => setGee(predicted)}><Globe size={15} /> Show in GEE</TextureButton>
        </Tip>
        <TextureButton variant="primary" className="w-auto disabled:opacity-60" disabled={!script} onClick={run}><Play size={14} /> Run</TextureButton>
      </SiteHeader>

      {problem && (
        <div role="alert" className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span className="min-w-0 flex-1">{problem}</span>
          <button onClick={() => setProblem(null)} className="text-red-700/70 hover:text-red-700" aria-label="Dismiss"><X size={15} /></button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
      <div ref={work} className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0" style={{ height: `${topShare * 100}%` }}>
        <aside data-tour="left" className="flex min-h-0 shrink-0 flex-col bg-white" style={{ width: panels.left }}>
          <div className="space-y-1.5 border-b px-2.5 pb-2.5 pt-2.5">
            {edit?.kind === "newProject" ? <InlineName placeholder="Project name" onSubmit={createProject} onCancel={() => setEdit(null)} />
              : edit?.kind === "renameProject" && project ? <InlineName initial={project.name} placeholder="Project name" onSubmit={renameProject} onCancel={() => setEdit(null)} />
              : confirm?.kind === "project" ? <Confirm text={`Delete "${confirm.name}" and all its scripts?`} onYes={() => deleteProject(confirm.id)} onNo={() => setConfirm(null)} />
              : (
                <div className="flex items-center gap-1">
                  <FolderOpen size={14} className="shrink-0 text-muted-foreground" />
                  <select value={project?.id ?? ""} disabled={booting} onChange={(e) => { const p = projects.find((x) => x.id === e.target.value); if (p) void openProject(p) }}
                    className="min-w-0 flex-1 truncate rounded-lg border bg-white px-2 py-1.5 text-xs font-medium outline-none focus:border-neutral-900" aria-label="Project">
                    {!project && <option value="">{booting ? "Loading…" : "No project"}</option>}
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <button onClick={() => setEdit({ kind: "newProject" })} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="New project"><Plus size={14} /></button>
                  <button onClick={() => setEdit({ kind: "renameProject" })} disabled={!project} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" title="Rename project"><Pencil size={13} /></button>
                  <button onClick={() => project && setConfirm({ kind: "project", id: project.id, name: project.name })} disabled={!project} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-red-600 disabled:opacity-40" title="Delete project"><Trash2 size={13} /></button>
                </div>
              )}
            <Segmented value={left} onChange={setLeft} options={[["scripts", "Scripts"], ["models", "Models"], ["assets", `Assets${assets.length ? ` ${assets.length}` : ""}`]]} />
          </div>
          <div className="flex-1 overflow-auto px-3 pb-4 pt-2">
            {left === "scripts" && (
              <div className="space-y-1">
                {scripts.map((s) => edit?.kind === "renameScript" && edit.id === s.id
                  ? <InlineName key={s.id} initial={s.name} placeholder="name.py" onSubmit={(v) => renameScript(s.id, v)} onCancel={() => setEdit(null)} />
                  : confirm?.kind === "script" && confirm.id === s.id
                  ? <Confirm key={s.id} text={`Delete ${s.name}?`} onYes={() => deleteScript(s.id)} onNo={() => setConfirm(null)} />
                  : (
                    <div key={s.id} className={cn("group flex items-center rounded-lg transition", s.id === scriptId ? "bg-neutral-100" : "hover:bg-muted")}>
                      <button onClick={() => setScriptId(s.id)} onDoubleClick={() => setEdit({ kind: "renameScript", id: s.id })}
                        className={cn("flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left font-mono text-xs", s.id === scriptId ? "text-foreground" : "text-muted-foreground")}>
                        <FileCode2 size={14} className="shrink-0" /><span className="truncate">{s.name}</span>
                        {unsaved(s.id) && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-amber-500" title="Unsaved changes" />}
                      </button>
                      <span className="hidden shrink-0 pr-1 group-hover:flex">
                        <button onClick={() => setEdit({ kind: "renameScript", id: s.id })} className="rounded p-1 text-muted-foreground hover:text-foreground" title="Rename"><Pencil size={12} /></button>
                        <button onClick={() => setConfirm({ kind: "script", id: s.id, name: s.name })} className="rounded p-1 text-muted-foreground hover:text-red-600" title="Delete"><Trash2 size={12} /></button>
                      </span>
                    </div>
                  ))}
                {edit?.kind === "newScript"
                  ? <InlineName placeholder="my_script.py" onSubmit={createScript} onCancel={() => setEdit(null)} />
                  : <button onClick={() => setEdit({ kind: "newScript" })} disabled={!project} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"><Plus size={14} /> New script</button>}
                {!scripts.length && project && <p className="px-2.5 text-xs text-muted-foreground">No scripts in this project yet.</p>}
                <button onClick={() => setLeft("models")} className="mt-3 w-full rounded-xl border border-dashed p-3 text-left text-xs text-muted-foreground hover:border-neutral-400">
                  <span className="block font-medium text-foreground">Don't want to code?</span>Open Models and press Predict.
                </button>
              </div>
            )}
            {left === "models" && <ModelPanel meta={meta} onPredict={predict} busy={status.mode === "running"} />}
            {left === "assets" && (
              <div className="space-y-2">
                {assets.length === 0 && <p className="text-xs leading-relaxed text-muted-foreground">No saved maps yet. Run 3_predict_yield.py, then press Run on its task.</p>}
                {assets.map((a) => confirm?.kind === "asset" && confirm.id === a.id
                  ? <Confirm key={a.id} text={`Remove ${a.name}?`} onYes={() => deleteAsset(a.id)} onNo={() => setConfirm(null)} />
                  : (
                    <div key={a.id} className="rounded-xl border bg-white p-2.5">
                      <div className="flex items-center gap-2 font-mono text-xs"><Database size={13} className="shrink-0" /><span className="truncate" title={a.ee_asset_id ?? a.name}>{a.ee_asset_id ?? `yield/${a.name}`}</span></div>
                      <div className="mt-2 flex gap-1.5">
                        <TextureButton variant="minimal" size="sm" className="w-auto" onClick={() => addAsset(a)}><Layers size={12} /> Add</TextureButton>
                        {a.key && geeOf({ crop: a.key.split("_")[1], year: a.key.split("_")[2] }) && <TextureButton variant="minimal" size="sm" className="w-auto" onClick={() => setGee(geeOf({ crop: a.key!.split("_")[1], year: a.key!.split("_")[2] }))}><Globe size={12} /> GEE</TextureButton>}
                        <button onClick={() => setConfirm({ kind: "asset", id: a.id, name: a.name })} className="ml-auto rounded p-1 text-muted-foreground hover:text-red-600" title="Remove from list"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </aside>

        <ResizeHandle axis="x" label="Scripts panel width" onDrag={(d) => nudge("left", d)} onReset={() => reset("left")} />

        <section data-tour="editor" className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-xs">
            <span className="truncate rounded-md border bg-muted px-2 py-0.5 font-mono">{script?.name ?? "no script"}</span>
            <span className="hidden text-muted-foreground lg:inline">Python · earthengine-api</span>
            <span className="text-muted-foreground">{saving ? "Saving…" : script && unsaved(script.id) ? "Edited" : script ? (live ? "Saved" : "Saved in this browser") : ""}</span>
            <span className="ml-auto flex items-center gap-3">
              <button onClick={() => void saveScripts()} disabled={!script || !unsaved(script.id)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground disabled:opacity-40" title="Save (⌘/Ctrl + S)"><Save size={13} /> Save</button>
              {script && templates.current[script.name] && <button onClick={() => setDrafts((d) => ({ ...d, [script.id]: templates.current[script.name] }))} className="flex items-center gap-1 text-muted-foreground hover:text-foreground" title="Replace with the starter version"><RotateCcw size={12} /> Reset</button>}
              <button onClick={() => setLogs([])} className="text-muted-foreground hover:text-foreground">Clear console</button>
              <button onClick={() => setMaximized(!maximized)} className="text-muted-foreground hover:text-foreground" title={maximized ? "Restore panels" : "Expand panels"}>{maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
            </span>
          </div>
          <div className="min-h-0 flex-1">
            {script ? (
              <Editor path={script.id} language="python" value={code} onChange={(v) => setDrafts((d) => ({ ...d, [script.id]: v ?? "" }))} onMount={onMount}
                options={{ fontSize: 12.5, minimap: { enabled: false }, scrollBeyondLastLine: false, padding: { top: 10 } }} />
            ) : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{booting ? <Loader2 size={16} className="animate-spin" /> : "Create or pick a script on the left."}</div>}
          </div>
        </section>

        <ResizeHandle axis="x" label="Console panel width" onDrag={(d) => nudge("right", -d)} onReset={() => reset("right")} />

        <aside data-tour="right" className="flex min-h-0 shrink-0 flex-col bg-white" style={{ width: panels.right }}>
          <Segmented className="m-2.5" value={right} onChange={setRight} options={[["inspector", "Inspector"], ["console", "Console"], ["tasks", `Tasks${tasks.length ? ` ${tasks.length}` : ""}`]]} />
          <div className="flex-1 space-y-1.5 overflow-auto px-3 pb-4">
            {right === "console" && logs.map((l) => <LogLine key={l.id} meta={meta} log={l} />)}
            {right === "inspector" && (!inspect
              ? <p className="text-xs text-muted-foreground">Click the map to read the visible layers at that spot.</p>
              : <>
                  <div className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><MapPin size={13} /> {fmt(inspect.lat, 5)}, {fmt(inspect.lng, 5)}</div>
                  {inspect.county && counties && (() => {
                    const c = countyInfo(meta, counties, inspect.county, predicted?.crop, predicted?.year)
                    return (
                      <div className="rounded-xl border bg-neutral-50 px-3 py-2 text-xs">
                        <div className="font-medium text-foreground">{c.label} <span className="font-normal text-muted-foreground">· GEOID {c.geoid} · {c.areaKm2.toLocaleString()} km²</span></div>
                        {!c.study
                          ? <div className="mt-1 text-muted-foreground">Outside the study area: no yield data.</div>
                          : predicted
                          ? <div className="mt-1 grid grid-cols-3 gap-2 tabular-nums">
                              {([["30 m map", c.mapMean], ["County model", c.model], ["USDA", c.usda]] as const).map(([t, v]) => (
                                <div key={t}><div className="text-muted-foreground">{t}</div><div className="font-semibold text-foreground">{v == null ? "—" : fmt(v, 2)}</div></div>))}
                            </div>
                          : <div className="mt-1 text-muted-foreground">Predict a map in Models to see this county's yields.</div>}
                      </div>)
                  })()}
                  {inspect.values.map((v) => (
                    <div key={v.name} className="rounded-xl border px-3 py-2">
                      <div className="truncate text-xs text-muted-foreground">{v.name}</div>
                      <div className="text-lg font-semibold">{v.v == null ? <span className="text-sm font-normal text-muted-foreground">no value here</span> : <>{fmt(v.v, v.unit === "mm" ? 0 : 2)} <span className="text-xs font-normal text-muted-foreground">{v.unit}</span></>}</div>
                    </div>
                  ))}
                  <p className="text-[11px] text-muted-foreground">Values are the 30 m pixel read from each layer's GeoTIFF. Earth Engine layers from a run are not read here.</p>
                </>)}
            {right === "tasks" && (tasks.length === 0
              ? <p className="text-xs text-muted-foreground">No tasks yet. Exports from scripts land here, ready to run.</p>
              : tasks.map((t) => confirm?.kind === "task" && confirm.id === t.id
                ? <Confirm key={t.id} text={t.state === "RUNNING" ? `Cancel and remove ${t.description}?` : `Remove ${t.description}?`} onYes={() => deleteTask(t.id)} onNo={() => setConfirm(null)} />
                : (
                <div key={t.id} className="rounded-xl border px-3 py-2.5">
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <span className={cn("size-2 shrink-0 rounded-full", t.state === "COMPLETED" ? "bg-neutral-900" : t.state === "RUNNING" ? "animate-pulse bg-sky-500" : t.state === "FAILED" ? "bg-red-500" : t.state === "CANCELLED" ? "bg-neutral-300" : "bg-amber-400")} />
                    <span className="min-w-0 truncate" title={t.description}>{t.description}</span>
                    {["READY", "FAILED", "CANCELLED"].includes(t.state)
                      ? <TextureButton variant="primary" size="sm" className="ml-auto w-auto" onClick={() => startTask(t.id)}><Upload size={12} /> {t.state === "READY" ? "Run" : "Retry"}</TextureButton>
                      : <span className="ml-auto text-[10px] font-semibold text-muted-foreground">{t.state}</span>}
                    <button onClick={() => setConfirm({ kind: "task", id: t.id, name: t.description })} className="rounded p-0.5 text-muted-foreground hover:text-red-600" title={t.state === "RUNNING" ? "Cancel" : "Remove"}><X size={13} /></button>
                  </div>
                  <div className="mt-1 text-[10px] text-muted-foreground">{t.export_type}{typeof t.params.assetId === "string" && ` → ${t.params.assetId}`}</div>
                  {(t.state === "RUNNING" || t.state === "COMPLETED") && <div className="mt-2 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-neutral-900 transition-all" style={{ width: `${Math.max(4, t.progress)}%` }} /></div>}
                  {t.error && <p className="mt-1.5 text-xs text-red-700">{t.error}</p>}
                  {t.state === "COMPLETED" && (geeOf(t.params)
                    ? <button className="mt-1.5 text-xs text-emerald-700 hover:underline" onClick={() => setGee(geeOf(t.params))}>Saved to assets · show in GEE</button>
                    : <p className="mt-1.5 text-xs text-emerald-700">Done · listed under Assets</p>)}
                </div>
              )))}
          </div>
        </aside>
      </div>

      <ResizeHandle axis="y" label="Map height" onDrag={(d) => { if (maximized) { setMaximized(false); setPanels((p) => ({ ...p, top: LIMITS.top[1] })) } nudge("top", d / height()) }} onReset={() => { setMaximized(false); reset("top") }} />

      <div data-tour="map" className="relative min-h-0 flex-1">
        <MapView meta={meta} layers={layers} basemap={basemap} onClick={onMapClick} marker={inspect && [inspect.lat, inspect.lng]} mapRef={mapRef}
          counties={counties} selected={inspect?.county} countyTip={countyTip} showCounties={showCounties} />
        <div className="absolute right-3 top-3 z-[1000]"><LayersCard layers={layers} setLayers={setLayers} /></div>
        <div className="absolute bottom-6 left-3 z-[1000]"><Legend meta={meta} layer={top} /></div>
        {predicted && layers.some((l) => l.id === "prediction") && (
          <div className="absolute bottom-6 left-1/2 z-[1000] -translate-x-1/2">
            <YearTimeline meta={meta} crop={predicted.crop} year={predicted.year} onYear={(y) => { addLayer(`yield_${predicted.crop}_${y}`, `Predicted ${predicted.crop} yield ${y}`, "prediction"); setPredicted({ ...predicted, year: y }) }} />
          </div>
        )}
        <div className="absolute bottom-16 right-3 z-[1000] flex flex-col items-end gap-2"><CountiesToggle checked={showCounties} onChange={setShowCounties} /><BasemapSwitch value={basemap} onChange={setBasemap} /></div>
      </div>
      </div>
      {chat && <Assistant meta={meta} context={{ page: "studio", crop: predicted?.crop, year: predicted?.year, county: inspect?.county }} onClose={() => setChat(false)} />}
      </div>

      {tour && <Tour steps={steps} onClose={() => { setTour(false); seen.set("ys_studio_tour"); setLeft("scripts") }} />}
      {gee && <GeeDialog meta={meta} crop={gee.crop} year={gee.year} onClose={() => setGee(null)} />}
      {email && !live && <span className="sr-only">Signed in as {email} in tester mode</span>}
    </div>
  )
}
