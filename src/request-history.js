// request-history.js - Tracks recent requests for dashboard inspection

const DEFAULT_LIMIT = 40
const MAX_ATTEMPTS = 8
const MAX_CANDIDATES = 3

function normalizeInlineText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactId(value, length = 10) {
  if (!value) return ''
  if (value.length <= length) return value
  return `${value.slice(0, length)}…`
}

function hashString(input) {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }

  return Math.abs(hash).toString(36)
}

function stringifyContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text || ''
      if (part?.type === 'image_url' || part?.type === 'image') return '[image]'
      if (part?.type === 'input_audio' || part?.type === 'audio')
        return '[audio]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function stringifyEmbeddingInput(input) {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''

  return input
    .slice(0, 3)
    .map((item) => {
      if (typeof item === 'string') return item
      if (Array.isArray(item)) return `[vector:${item.length}]`
      return String(item ?? '')
    })
    .join(' | ')
}

function buildPreview(reqBody, endpointType) {
  if (endpointType === 'embeddings') {
    return stringifyEmbeddingInput(reqBody?.input)
  }

  if (endpointType === 'completions') {
    return typeof reqBody?.prompt === 'string' ? reqBody.prompt : ''
  }

  const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : []
  const userMessages = messages.filter((message) => message?.role === 'user')
  const lastUserMessage = userMessages.at(-1)

  const previewSource = lastUserMessage
    ? stringifyContent(lastUserMessage.content)
    : stringifyContent(messages.at(-1)?.content)
  return previewSource
}

function getNestedValue(source, keys) {
  for (const key of keys) {
    if (!source || typeof source !== 'object') continue
    if (source[key]) return source[key]
  }

  return null
}

function extractConversationIdentifier(reqBody) {
  const idKeys = [
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
    'session_id',
    'sessionId',
    'chat_id',
    'chatId',
  ]

  const rootId = getNestedValue(reqBody, idKeys)
  if (rootId) return String(rootId)

  const metadata = reqBody?.metadata
  const metadataId = getNestedValue(metadata, idKeys)
  if (metadataId) return String(metadataId)

  return null
}

function buildConversationInfo(reqBody, endpointType, preview) {
  const explicitId = extractConversationIdentifier(reqBody)
  if (explicitId) {
    return {
      id: `id:${explicitId}`,
      label: `Conversation ${compactId(explicitId)}`,
      source: 'explicit',
    }
  }

  if (endpointType === 'chat') {
    // Use the first user message as the stable conversation anchor — it stays
    // the same across all turns while the last user message changes each turn.
    const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : []
    const firstUserMessage = messages.find((m) => m?.role === 'user')
    const anchor = normalizeInlineText(
      firstUserMessage ? stringifyContent(firstUserMessage.content) : preview,
    )
    if (anchor) {
      const digest = hashString(anchor.toLowerCase())
      return {
        id: `chat:${digest}`,
        label: anchor,
        source: 'derived',
      }
    }
  }

  return {
    id: `request:${hashString(`${endpointType}:${Date.now()}:${Math.random()}`)}`,
    label: `${endpointType} request`,
    source: 'none',
  }
}

function buildMessageList(reqBody, endpointType) {
  if (endpointType !== 'chat') return []
  const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : []
  return messages.map((msg) => ({
    role: msg?.role || 'unknown',
    content: stringifyContent(msg?.content),
  }))
}

function buildInputSummary(reqBody, endpointType) {
  if (endpointType === 'embeddings') {
    const input = reqBody?.input
    if (Array.isArray(input)) {
      return `${input.length} input item${input.length === 1 ? '' : 's'}`
    }
    return '1 input item'
  }

  if (endpointType === 'completions') {
    return typeof reqBody?.prompt === 'string'
      ? `${Math.max(1, reqBody.prompt.split(/\s+/u).filter(Boolean).length)} words`
      : 'completion prompt'
  }

  const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : []
  const userMessages = messages.filter(
    (message) => message?.role === 'user',
  ).length
  return `${messages.length} msg${messages.length === 1 ? '' : 's'} · ${userMessages} user msg${userMessages === 1 ? '' : 's'}`
}

function buildAnalysisSummary(analysis) {
  return {
    needsTools: Boolean(analysis?.needsTools),
    needsVision: Boolean(analysis?.needsVision),
    needsAudio: Boolean(analysis?.needsAudio),
    needsEmbeddings: Boolean(analysis?.needsEmbeddings),
    preferReasoning: Boolean(analysis?.preferReasoning),
    preferFast: Boolean(analysis?.preferFast),
    hasCodeSignals: Boolean(analysis?.hasCodeSignals),
    estimatedInputTokens: analysis?.estimatedInputTokens || 0,
    maxOutputTokens: analysis?.maxOutputTokens || 0,
  }
}

function summariseCandidate(candidate) {
  return {
    nodeHost: candidate.nodeHost,
    modelName: candidate.modelName,
    score:
      typeof candidate.score === 'number'
        ? Math.round(candidate.score * 100) / 100
        : null,
  }
}

export class RequestHistoryManager {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = limit
    this.requests = []
  }

  startRequest({ requestId, endpointType, reqBody, analysis }) {
    const preview = buildPreview(reqBody, endpointType)
    const conversation = buildConversationInfo(reqBody, endpointType, preview)

    const entry = {
      requestId,
      endpointType,
      conversationId: conversation.id,
      conversationLabel: conversation.label,
      conversationSource: conversation.source,
      requestedModel: reqBody?.model || 'auto',
      status: 'running',
      stream: Boolean(reqBody?.stream),
      createdAt: Date.now(),
      finishedAt: 0,
      latency: 0,
      responseStatus: 0,
      error: null,
      selectedModel: null,
      selectedNode: null,
      tokensGenerated: 0,
      inputSummary: buildInputSummary(reqBody, endpointType),
      promptPreview: preview,
      messageList: buildMessageList(reqBody, endpointType),
      analysis: buildAnalysisSummary(analysis),
      candidateCount: 0,
      candidates: [],
      attemptCount: 0,
      attempts: [],
    }

    this.requests = [
      entry,
      ...this.requests.filter((item) => item.requestId !== requestId),
    ]
    return entry
  }

  recordSelection(requestId, candidates) {
    const entry = this.#findRequest(requestId)
    if (!entry) return

    const normalised = Array.isArray(candidates)
      ? candidates.filter(Boolean)
      : [candidates].filter(Boolean)

    entry.candidateCount = normalised.length
    entry.candidates = normalised
      .slice(0, MAX_CANDIDATES)
      .map(summariseCandidate)
  }

  recordAttempt(requestId, attempt) {
    const entry = this.#findRequest(requestId)
    if (!entry) return

    const last = entry.attempts[entry.attempts.length - 1]
    if (
      last &&
      last.nodeHost === attempt.nodeHost &&
      last.modelName === attempt.modelName &&
      last.status === 'running'
    ) {
      last.status = attempt.status
      last.latency = attempt.latency || last.latency
      last.error = attempt.error || null
      entry.attemptCount = entry.attempts.length
      return
    }

    entry.attempts.push({
      nodeHost: attempt.nodeHost,
      modelName: attempt.modelName,
      status: attempt.status,
      latency: attempt.latency || 0,
      error: attempt.error || null,
      at: Date.now(),
    })
    entry.attempts = entry.attempts.slice(-MAX_ATTEMPTS)
    entry.attemptCount = entry.attempts.length
  }

  finishRequest(requestId, result = {}) {
    const entry = this.#findRequest(requestId)
    if (!entry) return false

    entry.status = result.status || entry.status || 'success'
    entry.finishedAt = Date.now()
    entry.latency = result.latency || entry.latency || 0
    entry.responseStatus = result.responseStatus || entry.responseStatus || 0
    entry.error = result.error || null
    entry.tokensGenerated = result.tokensGenerated || entry.tokensGenerated || 0
    entry.selectedModel = result.modelName || entry.selectedModel || null
    entry.selectedNode = result.nodeHost || entry.selectedNode || null
  }

  getRecentRequests() {
    return this.requests.map((request) => ({
      ...request,
      analysis: { ...request.analysis },
      candidates: request.candidates.map((candidate) => ({ ...candidate })),
      attempts: request.attempts.map((attempt) => ({ ...attempt })),
    }))
  }

  #findRequest(requestId) {
    return (
      this.requests.find((request) => request.requestId === requestId) || null
    )
  }
}
