// cloud-usage.ts - Fetches and caches Ollama cloud usage from ollama.com/settings
//
// Cookie resolution order:
//   1. OLLAMA_CLOUD_SESSION_COOKIE env var
//   2. Auto-extract from Chrome via @steipete/sweet-cookie
//
// Adapted from pi-ollama-cloud-usage-tracker (scraper.ts)
// https://pi.dev/packages/@entelligentsia/pi-ollama-cloud-usage-tracker

import { request } from 'undici'
import { createLogger } from './logger.js'
import { OLLAMA_CLOUD_SESSION_COOKIE } from './config.js'

const logger = createLogger('cloud-usage')

const REFRESH_INTERVAL_MS = 5 * 60 * 1000
const SETTINGS_URL = 'https://ollama.com/settings'

export interface CloudUsage {
  /** 0–100 */
  sessionPct: number
  /** 0–100 */
  weeklyPct: number
  /** Unix ms when session resets (0 if unknown) */
  sessionResetMs: number
  /** Unix ms when weekly quota resets (0 if unknown) */
  weeklyResetMs: number
  plan: 'Free' | 'Pro' | 'Max' | null
  /** Date.now() of last successful fetch */
  fetchedAt: number
  /** true if last fetch failed; data is from previous successful fetch */
  stale: boolean
}

const EMPTY_USAGE: CloudUsage = {
  sessionPct: 0,
  weeklyPct: 0,
  sessionResetMs: 0,
  weeklyResetMs: 0,
  plan: null,
  fetchedAt: 0,
  stale: false,
}

/** Resolve cookie string from env var or Chrome cookie store. */
async function resolveCookie(): Promise<string | null> {
  if (OLLAMA_CLOUD_SESSION_COOKIE) return OLLAMA_CLOUD_SESSION_COOKIE
  try {
    // @steipete/sweet-cookie@0.3.x API: getCookies({ url, names }) + toCookieHeader(cookies)
    const { getCookies, toCookieHeader } = await import('@steipete/sweet-cookie')
    const { cookies } = await getCookies({
      url: 'https://ollama.com',
      names: ['__Secure-next-auth.session-token'],
      browsers: ['chrome'],
    })
    if (cookies.length > 0) {
      logger.debug('Cloud usage cookie sourced from Chrome cookie store')
      return toCookieHeader(cookies)
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'sweet-cookie failed — set OLLAMA_CLOUD_SESSION_COOKIE manually')
  }
  return null
}

/** Fetch raw HTML from ollama.com/settings with the given cookie. */
async function fetchSettingsHtml(cookie: string): Promise<string> {
  const resp = await request(SETTINGS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ollama-router)',
      'Accept': 'text/html',
      'Cookie': cookie,
    },
    headersTimeout: 10_000,
    bodyTimeout: 15_000,
  })
  if (resp.statusCode !== 200) {
    await resp.body.dump()
    throw new Error(`ollama.com/settings returned HTTP ${resp.statusCode}`)
  }
  return resp.body.text()
}

/**
 * Parse usage from ollama.com/settings HTML.
 *
 * The page encodes values in attributes, not plain text:
 *   - aria-label="Session usage 0% used"  / aria-label="Weekly usage 1.6% used"
 *   - style="width: 1.6%" on the bar fill div
 *   - data-time="2026-06-08T17:00:00Z" on .local-time reset divs
 *   - plan badge: first <span> after the text "Cloud usage" in the page
 */
function parseUsageFromHtml(html: string): Omit<CloudUsage, 'fetchedAt' | 'stale'> {
  // --- percentages via aria-label (most reliable) ---
  const ariaSession = html.match(/aria-label="Session usage ([\d.]+)%\s*used"/i)
  const ariaWeekly  = html.match(/aria-label="Weekly usage ([\d.]+)%\s*used"/i)

  const parsePct = (m: RegExpMatchArray | null, fallbackRe: RegExp): number => {
    const raw = m ? m[1] : (html.match(fallbackRe)?.[1] ?? '0')
    const n = parseFloat(raw)
    return Number.isNaN(n) ? 0 : Math.min(100, Math.max(0, Math.round(n * 10) / 10))
  }

  const sessionPct = parsePct(ariaSession, /data-usage-track[^>]*aria-label="Session usage ([\d.]+)%/i)
  const weeklyPct  = parsePct(ariaWeekly,  /data-usage-track[^>]*aria-label="Weekly usage ([\d.]+)%/i)

  // --- plan: slice to just after "Cloud usage", then match the first <span>...</span> ---
  // Works regardless of whitespace, class names, or compression artefacts.
  let plan: CloudUsage['plan'] = null
  const anchor = html.indexOf('Cloud usage')
  if (anchor !== -1) {
    const slice = html.slice(anchor, anchor + 300)
    const planMatch = slice.match(/<span[^>]*>\s*(free|pro|max)\s*<\/span>/i)
    if (planMatch) {
      const p = planMatch[1].charAt(0).toUpperCase() + planMatch[1].slice(1).toLowerCase()
      if (p === 'Free' || p === 'Pro' || p === 'Max') plan = p
    }
  }
  logger.debug({ plan }, 'Cloud usage plan parsed')

  // --- reset times from data-time attributes on .local-time elements ---
  // First occurrence = session reset, second = weekly reset
  const dateTimes: number[] = []
  const dataTimeRe = /data-time="(\d{4}-\d{2}-\d{2}T[^"]+)"/g
  let dtm: RegExpExecArray | null
  while ((dtm = dataTimeRe.exec(html)) !== null) {
    const ts = Date.parse(dtm[1])
    if (!Number.isNaN(ts)) dateTimes.push(ts)
  }

  const sessionResetMs = dateTimes[0] ?? 0
  const weeklyResetMs  = dateTimes[1] ?? 0

  return { sessionPct, weeklyPct, sessionResetMs, weeklyResetMs, plan }
}

// ---------------------------------------------------------------------------
// Singleton store
// ---------------------------------------------------------------------------

class CloudUsageStore {
  private _current: CloudUsage = { ...EMPTY_USAGE }
  private _timer: NodeJS.Timeout | null = null

  get(): CloudUsage {
    return this._current
  }

  /** Start background refresh. Performs an immediate fetch, then every 5 min. */
  start(): void {
    if (this._timer) return
    void this._refresh()
    this._timer = setInterval(() => void this._refresh(), REFRESH_INTERVAL_MS)
    this._timer.unref() // don't block process exit
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  /** Force an immediate re-fetch (e.g. after cookie change). */
  async refresh(): Promise<CloudUsage> {
    await this._refresh()
    return this._current
  }

  private async _refresh(): Promise<void> {
    try {
      const cookie = await resolveCookie()
      if (!cookie) {
        logger.debug('No cloud usage cookie available — skipping refresh')
        return
      }
      const html = await fetchSettingsHtml(cookie)
      const parsed = parseUsageFromHtml(html)
      this._current = { ...parsed, fetchedAt: Date.now(), stale: false }
      logger.debug(
        {
          sessionPct: parsed.sessionPct,
          weeklyPct: parsed.weeklyPct,
          plan: parsed.plan,
        },
        'Cloud usage refreshed',
      )
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Cloud usage fetch failed')
      // Preserve last known data, mark stale
      this._current = { ...this._current, stale: true }
    }
  }
}

export const cloudUsageStore = new CloudUsageStore()
