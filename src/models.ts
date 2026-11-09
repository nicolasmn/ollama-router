// models.ts - Core data types for nodes, models, and profiles

export interface ModelProfileData {
  capabilities?: Set<string>
  parameters?: number
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsThinking?: boolean
  supportsDecision?: boolean
  isEmbedding?: boolean
  architecture?: string
  embeddingDim?: number
}

export class ModelProfile {
  capabilities: Set<string>
  parameters: number
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsThinking: boolean
  supportsDecision: boolean
  isEmbedding: boolean
  architecture: string
  embeddingDim: number

  constructor(data: ModelProfileData = {}) {
    this.capabilities = data.capabilities ?? new Set()
    this.parameters = data.parameters ?? 0
    this.contextLength = data.contextLength ?? 4096
    this.supportsTools = data.supportsTools ?? false
    this.supportsVision = data.supportsVision ?? false
    this.supportsAudio = data.supportsAudio ?? false
    this.supportsThinking = data.supportsThinking ?? false
    this.supportsDecision = data.supportsDecision ?? false
    this.isEmbedding = data.isEmbedding ?? false
    this.architecture = data.architecture ?? ''
    this.embeddingDim = data.embeddingDim ?? 0
  }

  /** Speech-synthesis (TTS) model: only serves /v1/audio/speech, never text chat. */
  get isSpeechSynthesis(): boolean {
    return this.capabilities.has('speech')
  }

  /** True when the model can answer text chat / completion requests. */
  get isChatCapable(): boolean {
    return !this.isEmbedding && !this.supportsDecision && !this.isSpeechSynthesis
  }
}

export interface ModelInfoJSON {
  name: string
  family: string
  size: number
  profile: ModelProfileData
  recentLatency: number
  recentTps: number
  /** EMA of time to first token, ms; 0 = not yet measured. */
  recentTtft?: number
  /** EMA of model load duration, ms; 0 = not yet measured. */
  recentLoadMs?: number
  failures: number
  totalRequests: number
  status: string
  lastSeen?: number
  lastRoutingEndpoint?: string | null
  lastRoutedAt?: number
}

/** A model currently resident in a node's memory, as reported by GET /api/ps. */
export interface LoadedModel {
  name: string
  /** Actual in-memory bytes (weights + KV cache). */
  size: number
  sizeVram: number
  /** Epoch ms when Ollama will unload the model; 0 = unknown. */
  expiresAt: number
}

/** Snapshot of a node's loaded models from the latest successful /api/ps poll. */
export interface LoadedState {
  models: LoadedModel[]
  /** Epoch ms of the poll that produced this snapshot. */
  updatedAt: number
}

/** What consecutive /api/ps snapshots have revealed about a node's memory and model limit (0 = unknown). */
export interface NodeMemoryLearning {
  /** Lower bound: largest Σ size of models seen loaded together. */
  fitBytes: number
  /** Upper bound: a total reaching this did not fit. */
  noFitBytes: number
  /** Loaded-model limit inferred from a count-triggered eviction. */
  maxLoaded: number
  /** Largest number of models seen loaded together. */
  maxSeenLoaded: number
  /** Models of the last successful /api/ps poll; null when a probe has failed since. Not persisted. */
  lastSnapshot: LoadedModel[] | null
}

export class ModelInfo {
  name: string
  family: string
  size: number
  profile: ModelProfile
  recentLatency: number
  recentTps: number
  /** EMA of time to first token, ms; 0 = not yet measured. */
  recentTtft: number
  /** EMA of model load duration, ms; 0 = not yet measured. */
  recentLoadMs: number
  /** Max choice criteria this model accepts for /v1/systemone (learned from
   *  upstream 400s); 0 = unknown — upstream decision models enforce
   *  model-specific caps the router cannot query directly. */
  systemoneMaxCriteria: number
  failures: number
  totalRequests: number
  status: string
  lastSeen: number
  lastRoutingEndpoint: string | null
  lastRoutedAt: number
  /** In-memory bytes measured via /api/ps the last time this model was seen
   *  loaded on this node; 0 = never observed loaded. */
  measuredFootprint: number

  constructor(name: string, family: string, size: number, profile: ModelProfile) {
    this.name = name
    this.family = family
    this.size = size
    this.profile = profile
    this.recentLatency = 0
    this.recentTps = 0
    this.recentTtft = 0
    this.recentLoadMs = 0
    this.systemoneMaxCriteria = 0
    this.failures = 0
    this.totalRequests = 0
    this.status = 'idle'
    this.lastSeen = 0
    this.lastRoutingEndpoint = null
    this.lastRoutedAt = 0
    this.measuredFootprint = 0
  }
}

export interface NodeInfoJSON {
  host: string
  reachable: boolean
  lastSeen: number
  failures: number
  lastFailure: number
  activeRequests: number
  models: Record<string, ModelInfoJSON>
  cloud?: boolean
  mac: string | null
}

export class NodeInfo {
  host: string
  reachable: boolean
  lastSeen: number
  failures: number
  lastFailure: number
  activeRequests: number
  models: Map<string, ModelInfo>
  /** True when this node is the ollama.com cloud endpoint. Requires auth header. */
  cloud: boolean
  /** Learned MAC address via ARP — null until node has been seen at least once. */
  mac: string | null
  /** Loaded-model snapshot from /api/ps; null = unknown (not polled yet or the poll failed). */
  loaded: LoadedState | null
  memory: NodeMemoryLearning

  constructor(host: string, cloud = false) {
    this.host = host
    this.reachable = false
    this.lastSeen = 0
    this.failures = 0
    this.lastFailure = 0
    this.activeRequests = 0
    this.models = new Map()
    this.cloud = cloud
    this.mac = null
    this.loaded = null
    this.memory = { fitBytes: 0, noFitBytes: 0, maxLoaded: 0, maxSeenLoaded: 0, lastSnapshot: null }
  }
}
