/**
 * src/types/index.ts
 * Central re-export of all shared interfaces and type aliases.
 * Import from here instead of individual modules to keep coupling low.
 */

// ── Config ────────────────────────────────────────────────────────────────────
export type { Config } from '../config.js'

// ── Models / Nodes ────────────────────────────────────────────────────────────
export type {
  ModelProfileData,
  ModelInfoJSON,
  NodeInfoJSON,
} from '../models.js'
export { ModelProfile, ModelInfo, NodeInfo } from '../models.js'

// ── Request analysis ──────────────────────────────────────────────────────────
export type {
  EndpointType,
  AnalysisResult,
  MessagePart,
  RequestMessage,
} from '../request-analyzer.js'

// ── Routing ───────────────────────────────────────────────────────────────────
export type {
  RoutingCandidate,
  ModelCatalogEntry,
  RouterError,
} from '../request-router.js'
