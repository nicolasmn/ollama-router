// config.ts
import 'dotenv/config'

export interface Config {
  OLLAMA_NODES: string[]
  DISCOVERY_INTERVAL: number
  MAX_CONCURRENT_PER_NODE: number
  PORT: number | string
  AUTO_DISCOVER: boolean
  NETWORK_SCAN_INTERVAL: number
  METRICS_FILE: string
  /** Inference timeout in ms. Default 600 000 ms (10 min). Set to 0 to disable. */
  INFERENCE_TIMEOUT: number
  OLLAMA_CLOUD_URL: string
  OLLAMA_CLOUD_API_KEY: string
  /**
   * Session cookie for ollama.com/settings usage scraping.
   * Falls back to Chrome cookie store via @steipete/sweet-cookie when unset.
   */
  OLLAMA_CLOUD_SESSION_COOKIE: string
  /**
   * When true, requests for unknown models fall back to `auto` routing
   * instead of returning 404. Set ROUTER_FALLBACK_TO_AUTO=true to enable.
   */
  ROUTER_FALLBACK_TO_AUTO: boolean
}

export const OLLAMA_NODES: string[] =
  process.env.OLLAMA_NODES?.split(',').filter(Boolean) ?? []

export const DISCOVERY_INTERVAL = 15_000
export const MAX_CONCURRENT_PER_NODE = 3
export const PORT: number | string = process.env.PORT || 8000

/** Auto-discover by default when no nodes are explicitly configured. */
export const AUTO_DISCOVER: boolean =
  process.env.AUTO_DISCOVER !== undefined
    ? process.env.AUTO_DISCOVER === 'true'
    : OLLAMA_NODES.length === 0

export const NETWORK_SCAN_INTERVAL: number = Number.parseInt(
  process.env.NETWORK_SCAN_INTERVAL || '60000',
  10,
)

export const METRICS_FILE: string =
  process.env.METRICS_FILE || './data/model-metrics.json'

export const DISABLED_MODELS_FILE: string =
  process.env.DISABLED_MODELS_FILE || './data/disabled-models.json'

/**
 * Timeout in ms for inference requests.
 * Default: 600 000 ms (10 min) — large models on Pi can be slow.
 * Set INFERENCE_TIMEOUT=0 to disable entirely.
 */
export const INFERENCE_TIMEOUT: number = Number.parseInt(
  process.env.INFERENCE_TIMEOUT || '600000',
  10,
)

/** Base URL for the Ollama cloud API. Defaults to https://ollama.com */
export const OLLAMA_CLOUD_URL: string =
  process.env.OLLAMA_CLOUD_URL || 'https://ollama.com'

/** API key for ollama.com cloud inference. If set, cloud node is registered. */
export const OLLAMA_CLOUD_API_KEY: string =
  process.env.OLLAMA_CLOUD_API_KEY || ''

/**
 * Session cookie for scraping cloud usage from ollama.com/settings.
 * Optional — falls back to Chrome cookie store via @steipete/sweet-cookie.
 * Format: full Cookie header value, e.g. "__Secure-next-auth.session-token=abc..."
 */
export const OLLAMA_CLOUD_SESSION_COOKIE: string =
  process.env.OLLAMA_CLOUD_SESSION_COOKIE || ''

/**
 * When true, requests for unknown models fall back to `auto` routing
 * (best available model) instead of returning 404.
 * Default: false — preserve existing 404 behaviour unless opted in.
 */
export const ROUTER_FALLBACK_TO_AUTO: boolean =
  process.env.ROUTER_FALLBACK_TO_AUTO === 'true'
