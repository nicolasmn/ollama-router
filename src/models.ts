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
}

export interface ModelInfoJSON {
  name: string
  family: string
  size: number
  profile: ModelProfileData
  recentLatency: number
  recentTps: number
  failures: number
  totalRequests: number
  status: string
  lastSeen?: number
  lastRoutingEndpoint?: string | null
  lastRoutedAt?: number
}

export class ModelInfo {
  name: string
  family: string
  size: number
  profile: ModelProfile
  recentLatency: number
  recentTps: number
  failures: number
  totalRequests: number
  status: string
  lastSeen: number
  lastRoutingEndpoint: string | null
  lastRoutedAt: number

  constructor(name: string, family: string, size: number, profile: ModelProfile) {
    this.name = name
    this.family = family
    this.size = size
    this.profile = profile
    this.recentLatency = 0
    this.recentTps = 0
    this.failures = 0
    this.totalRequests = 0
    this.status = 'idle'
    this.lastSeen = 0
    this.lastRoutingEndpoint = null
    this.lastRoutedAt = 0
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
  }
}
