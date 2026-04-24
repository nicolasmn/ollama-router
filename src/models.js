// models.js

/**
 * Structured model capability profile built from /api/show response.
 * No heuristics — all data comes directly from the Ollama API.
 */
export class ModelProfile {
  constructor({
    capabilities = new Set(),
    parameters = 0,        // in billions (float)
    contextLength = 4096,
    supportsTools = false,
    supportsVision = false,
    supportsAudio = false,
    supportsThinking = false,
    isEmbedding = false,
    embeddingDim = 0,       // output vector dimension (0 = unknown)
    architecture = '',     // general.architecture from model_info
  } = {}) {
    this.capabilities = capabilities instanceof Set ? capabilities : new Set(capabilities)
    this.parameters = parameters
    this.contextLength = contextLength
    this.supportsTools = supportsTools
    this.supportsVision = supportsVision
    this.supportsAudio = supportsAudio
    this.supportsThinking = supportsThinking
    this.isEmbedding = isEmbedding
    this.embeddingDim = embeddingDim
    this.architecture = architecture
  }

  toJSON() {
    return {
      capabilities: [...this.capabilities],
      parameters: this.parameters,
      contextLength: this.contextLength,
      supportsTools: this.supportsTools,
      supportsVision: this.supportsVision,
      supportsAudio: this.supportsAudio,
      supportsThinking: this.supportsThinking,
      isEmbedding: this.isEmbedding,
      embeddingDim: this.embeddingDim,
      architecture: this.architecture,
    }
  }
}

export class ModelInfo {
  constructor(name, family, size, profile) {
    this.name = name
    this.family = family
    this.size = size // bytes from /api/tags
    this.profile =
      profile instanceof ModelProfile ? profile : new ModelProfile(profile)
    this.status = 'idle'
    this.activeRequests = 0
    this.totalRequests = 0
    this.recentLatency = 0
    this.recentTps = 0
    this.failures = 0
    this.lastSeen = Date.now()
    this.lastRoutingEndpoint = null
    this.lastRoutedAt = 0
  }

  toJSON() {
    return {
      name: this.name,
      family: this.family,
      size: this.size,
      profile: this.profile,
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

export class NodeInfo {
  constructor(host) {
    this.host = host
    this.models = new Map()
    this.reachable = false
    this.lastSeen = 0
    this.activeRequests = 0
    this.failures = 0
    this.lastFailure = 0
  }

  toJSON() {
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
