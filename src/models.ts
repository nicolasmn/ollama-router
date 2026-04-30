// models.ts

/** Raw data accepted by the ModelProfile constructor. */
export interface ModelProfileData {
  capabilities?: Set<string> | string[]
  parameters?: number
  contextLength?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsThinking?: boolean
  isEmbedding?: boolean
}

export interface ModelProfileJSON {
  capabilities: string[]
  parameters: number
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsThinking: boolean
  isEmbedding: boolean
}

/**
 * Structured model capability profile built from /api/show response.
 * No heuristics — all data comes directly from the Ollama API.
 */
export class ModelProfile {
  capabilities: Set<string>
  parameters: number
  contextLength: number
  supportsTools: boolean
  supportsVision: boolean
  supportsAudio: boolean
  supportsThinking: boolean
  isEmbedding: boolean

  constructor({
    capabilities = new Set<string>(),
    parameters = 0,
    contextLength = 4096,
    supportsTools = false,
    supportsVision = false,
    supportsAudio = false,
    supportsThinking = false,
    isEmbedding = false,
  }: ModelProfileData = {}) {
    this.capabilities =
      capabilities instanceof Set ? capabilities : new Set(capabilities)
    this.parameters = parameters
    this.contextLength = contextLength
    this.supportsTools = supportsTools
    this.supportsVision = supportsVision
    this.supportsAudio = supportsAudio
    this.supportsThinking = supportsThinking
    this.isEmbedding = isEmbedding
  }

  toJSON(): ModelProfileJSON {
    return {
      capabilities: [...this.capabilities],
      parameters: this.parameters,
      contextLength: this.contextLength,
      supportsTools: this.supportsTools,
      supportsVision: this.supportsVision,
      supportsAudio: this.supportsAudio,
      supportsThinking: this.supportsThinking,
      isEmbedding: this.isEmbedding,
    }
  }
}

export interface ModelInfoJSON {
  name: string
  family: string
  size: number
  profile: ModelProfileJSON
  status: string
  activeRequests: number
  totalRequests: number
  recentLatency: number
  recentTps: number
  failures: number
  lastSeen: number
  lastRoutingEndpoint: string | null
  lastRoutedAt: number
}

export class ModelInfo {
  name: string
  family: string
  size: number
  profile: ModelProfile
  status: string
  activeRequests: number
  totalRequests: number
  recentLatency: number
  recentTps: number
  failures: number
  lastSeen: number
  lastRoutingEndpoint: string | null
  lastRoutedAt: number

  constructor(
    name: string,
    family: string,
    size: number,
    profile: ModelProfile | ModelProfileData,
  ) {
    this.name = name
    this.family = family
    this.size = size
    this.profile =
      profile instanceof ModelProfile ? profile : new ModelProfile(profile)
    this.status = 'idle'
    this.activeRequests = 0
    this.totalRequests = 0
    this.recentLatency = 0
    this.recentTps = 0
    this.failures = 0
    this.lastSeen = 0
    this.lastRoutingEndpoint = null
    this.lastRoutedAt = 0
  }

  toJSON(): ModelInfoJSON {
    return {
      name: this.name,
      family: this.family,
      size: this.size,
      profile: this.profile.toJSON(),
      status: this.status,
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      recentLatency: this.recentLatency,
      recentTps: this.recentTps,
      failures: this.failures,
      lastSeen: this.lastSeen,
      lastRoutingEndpoint: this.lastRoutingEndpoint,
      lastRoutedAt: this.lastRoutedAt,
    }
  }
}

export interface NodeInfoJSON {
  host: string
  reachable: boolean
  lastSeen: number
  activeRequests: number
  failures: number
  lastFailure: number
}

export class NodeInfo {
  host: string
  models: Map<string, ModelInfo>
  reachable: boolean
  lastSeen: number
  activeRequests: number
  failures: number
  lastFailure: number

  constructor(host: string) {
    this.host = host
    this.models = new Map()
    this.reachable = false
    this.lastSeen = 0
    this.activeRequests = 0
    this.failures = 0
    this.lastFailure = 0
  }

  toJSON(): NodeInfoJSON {
    return {
      host: this.host,
      reachable: this.reachable,
      lastSeen: this.lastSeen,
      activeRequests: this.activeRequests,
      failures: this.failures,
      lastFailure: this.lastFailure,
    }
  }
}
