import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { Navigate, useLocation } from "react-router-dom"
import { createClient } from "@supabase/supabase-js"

export const ALLOWED_DOMAINS = ["osu.edu", "buckeyemail.osu.edu"]

/** Exactly name@osu.edu or name@buckeyemail.osu.edu: no other subdomains. The database checks this again. */
export function isOsuEmail(email: string) {
  const e = email.trim().toLowerCase()
  return /^[^@\s]+@[^@\s]+$/.test(e) && ALLOWED_DOMAINS.includes(e.split("@")[1])
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
export const supabase = url && key ? createClient(url, key) : null

/**
 * Two kinds of session:
 *  - tester: tester@osu.edu only. UI mode: no email is sent (the code is always TESTER_CODE), nothing reaches the
 *    server, and projects and scripts are kept in this browser (see store.ts).
 *  - live: every other OSU address. Supabase emails a one-time code; projects, scripts, runs and tasks go through the
 *    FastAPI backend and the Supabase database.
 */
export type Mode = "tester" | "live"
export const TESTER_EMAIL = "tester@osu.edu"
export const TESTER_CODE = "0000"
export const LIVE_READY = !!supabase
const OTP_LENGTH = Number(import.meta.env.VITE_OTP_LENGTH ?? 6)
export const isTester = (email: string) => email.trim().toLowerCase() === TESTER_EMAIL
export const codeLength = (email: string) => (isTester(email) ? TESTER_CODE.length : OTP_LENGTH)
const TESTER_KEY = "yield-studio-tester-session"

const testerSession = () => {
  try { return localStorage.getItem(TESTER_KEY) === TESTER_EMAIL } catch { return false }
}

/** Supabase messages, in plain words. */
function explain(message: string) {
  if (/database error saving new user/i.test(message)) return "Only @osu.edu and @buckeyemail.osu.edu addresses can sign in."
  if (/after \d+ seconds|rate limit/i.test(message)) return "Too many codes asked for. Wait a minute and try again."
  if (/error sending .*email/i.test(message)) return "The sign-in email could not be sent. This is a setup problem on the server (email sender or email template), not your address. Please tell the Yield Studio team."
  if (/not authorized/i.test(message)) return "The email service can't send to this address yet (Supabase's test sender only reaches team members)."
  if (/expired|invalid/i.test(message)) return "That code is wrong or has expired. Check it, or send a new one."
  return message
}

type Auth = {
  email: string | null
  mode: Mode | null
  ready: boolean
  sendCode: (email: string) => Promise<string | null>                 // error message, or null when sent
  verifyCode: (email: string, code: string) => Promise<string | null>
  signOut: () => Promise<void>
}
const AuthContext = createContext<Auth | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const tester = testerSession()
  const [email, setEmail] = useState<string | null>(tester ? TESTER_EMAIL : null)
  const [mode, setMode] = useState<Mode | null>(tester ? "tester" : null)
  const [ready, setReady] = useState(tester || !supabase)

  useEffect(() => {
    if (!supabase || testerSession()) return
    const accept = (e: string | null) => {
      if (e && (!isOsuEmail(e) || isTester(e))) { void supabase.auth.signOut(); e = null }
      if (testerSession()) return
      setEmail(e)
      setMode(e ? "live" : null)
      setReady(true)
    }
    supabase.auth.getSession().then(({ data }) => accept(data.session?.user.email ?? null))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => accept(s?.user.email ?? null))   // refreshes, sign-outs in other tabs
    return () => data.subscription.unsubscribe()
  }, [])

  const sendCode = async (address: string) => {
    if (!isOsuEmail(address)) return `Use your ${ALLOWED_DOMAINS.map((d) => "@" + d).join(" or ")} address.`
    if (isTester(address)) return null
    if (!supabase) return `Live sign-in is not set up on this site yet (no Supabase keys). Use ${TESTER_EMAIL} for the offline demo.`
    const { error } = await supabase.auth.signInWithOtp({ email: address, options: { shouldCreateUser: true } })
    return error ? explain(error.message) : null
  }

  const verifyCode = async (address: string, code: string) => {
    if (isTester(address)) {
      if (code !== TESTER_CODE) return "That code is wrong. Check it and try again."
      try { localStorage.setItem(TESTER_KEY, TESTER_EMAIL) } catch { /* the session then lasts until reload */ }
      setEmail(TESTER_EMAIL); setMode("tester"); setReady(true)
      return null
    }
    if (!supabase) return "Live sign-in is not set up on this site yet."
    const { data, error } = await supabase.auth.verifyOtp({ email: address, token: code, type: "email" })
    if (error) return explain(error.message)
    setEmail(data.user?.email ?? address); setMode("live"); setReady(true)
    return null
  }

  const signOut = async () => {
    const wasTester = testerSession()
    try { localStorage.removeItem(TESTER_KEY) } catch { /* nothing stored */ }
    if (supabase && !wasTester) await supabase.auth.signOut()
    setEmail(null); setMode(null)
  }

  return <AuthContext.Provider value={{ email, mode, ready, sendCode, verifyCode, signOut }}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)!

export function RequireAuth({ children }: { children: ReactNode }) {
  const { email, ready } = useAuth()
  const location = useLocation()
  if (!ready) return null
  return email ? children : <Navigate to="/login" replace state={{ from: location.pathname }} />
}

/** Calls the FastAPI backend with the user's access token. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token
  const res = await fetch((import.meta.env.VITE_API_URL ?? "http://localhost:8000") + path, {
    ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null))?.detail
    throw new Error(typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : res.statusText)
  }
  return (res.status === 204 ? null : await res.json()) as T
}
