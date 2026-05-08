// request-history.ts - Tracks recent requests for dashboard inspection

const DEFAULT_LIMIT = 40
const MAX_ATTEMPTS = 8
const MAX_CANDIDATES = 3
const ACTIVE_ATTEMPT_STATUSES = new Set(['waiting', 'running'])

export interface AttemptRecord {
  nodeHost: string
  modelName: string
  status: string
  latency: number
  error: string | null
  at: number
  attemptReason: string | null
}

export interface CandidateSummary {
  nodeHost: string
  modelName: string
  score: number | null
}

export interface AnalysisSummary {
  needsTools: boolean
  needsVision: boolean
  needsAudio: boolean
  needsEmbeddings: boolean
  preferReasoning: boolean
  preferFast: boolean
  hasCodeSignals: boolean
  estimatedInputTokens: number
  maxOutputTokens: number
}

export interface MessageRecord {
  role: string
  content: string
}

export interface ConversationInfo {
  id: string
  label: string
  source: 'explicit' | 'derived' | 'none'
}

export interface RequestEntry {
  requestId: string
  endpointType: string
  conversationId: string
  conversationLabel: string
  conversationSource: string
  requestedModel: string
  status: string
  stream: boolean
  createdAt: number
  executionStartedAt: number
  finishedAt: number
  latency: number
  queueWaitMs: number
  executionTimeMs: number
  responseStatus: number
  error: string | null
  abortReason: string | null
  failureCategory: string | null
  retryHint: string | null
  selectedModel: string | null
  selectedNode: string | null
  tokensGenerated: number
  inputSummary: string
  promptPreview: string
  messageList: MessageRecord[]
  analysis: AnalysisSummary
  candidateCount: number
  candidates: CandidateSummary[]
  attemptCount: number
  attempts: AttemptRecord[]
}

export interface StartRequestOptions {
  requestId: string
  endpointType: string
  reqBody: Record<string, unknown>
  analysis: Partial<AnalysisSummary>
}

export interface RecordAttemptOptions {
  nodeHost: string
  modelName: string
  status: string
  latency?: number
  error?: string | null
  attemptReason?: string | null
}

export interface FinishRequestOptions {
  status?: string
  latency?: number
  responseStatus?: number
  error?: string | null
  abortReason?: string | null
  failureCategory?: string | null
  retryHint?: string | null
  tokensGenerated?: number
  modelName?: string | null
  nodeHost?: string | null
}

export interface RequestHistoryConfig {
  limit?: number
}

function normalizeInlineText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function compactId(value: string, length = 10): string {
  if (!value) return ''
  if (value.length <= length) return value
  return `${value.slice(0, length)}\u2026`
}

function hashString(input: string): string {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Array<unknown>)
    .map((part) => {
      if (typeof part === 'string') return part
      const p = part as Record<string, unknown>
      if (p?.type === 'text') return p.text || ''
      if (p?.type === 'image_url' || p?.type === 'image') return '[image]'
      if (p?.type === 'input_audio' || p?.type === 'audio') return '[audio]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function stringifyEmbeddingInput(input: unknown): string {
  if (typeof input === 'string') return input
  if (!Array.isArray(input)) return ''
  return (input as unknown[])
    .slice(0, 3)
    .map((item) => {
      if (typeof item === 'string') return item
      if (Array.isArray(item)) return `[vector:${item.length}]`
      return String(item ?? '')
    })
    .join(' | ')
}

function buildPreview(
  reqBody: Record<string, unknown>,
  endpointType: string,
): string {
  if (endpointType === 'embeddings') {
    return stringifyEmbeddingInput(reqBody?.input)
  }
  if (endpointType === 'completions') {
    return typeof reqBody?.prompt === 'string' ? reqBody.prompt : ''
  }
  const messages = Array.isArray(reqBody?.messages)
    ? (reqBody.messages as Array<Record<string, unknown>>)
    : []
  const userMessages = messages.filter((m) => m?.role === 'user')
  const lastUserMessage = userMessages.at(-1)
  return lastUserMessage
    ? stringifyContent(lastUserMessage.content)
    : stringifyContent((messages.at(-1) as Record<string, unknown>)?.content)
}

function getNestedValue(
  source: Record<string, unknown> | null | undefined,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (!source || typeof source !== 'object') continue
    if (source[key]) return source[key]
  }
  return null
}

function extractConversationIdentifier(
  reqBody: Record<string, unknown>,
): string | null {
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
  const rootId = getNestedValue(reqBody as Record<string, unknown>, idKeys)
  if (rootId) return String(rootId)
  const metadataId = getNestedValue(
    reqBody?.metadata as Record<string, unknown>,
    idKeys,
  )
  if (metadataId) return String(metadataId)
  return null
}

function buildConversationInfo(
  reqBody: Record<string, unknown>,
  endpointType: string,
  preview: string,
): ConversationInfo {
  const explicitId = extractConversationIdentifier(reqBody)
  if (explicitId) {
    return {
      id: `id:${explicitId}`,
      label: `Conversation ${compactId(explicitId)}`,
      source: 'explicit',
    }
  }
  if (endpointType === 'chat') {
    const messages = Array.isArray(reqBody?.messages)
      ? (reqBody.messages as Array<Record<string, unknown>>)
      : []
    const firstUserMessage = messages.find((m) => m?.role === 'user')
    const anchor = normalizeInlineText(
      firstUserMessage
        ? stringifyContent(firstUserMessage.content)
        : preview,
    )
    if (anchor) {
      return {
        id: `chat:${hashString(anchor.toLowerCase())}`,
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

function buildMessageList(
  reqBody: Record<string, unknown>,
  endpointType: string,
): MessageRecord[] {
  if (endpointType !== 'chat') return []
  const messages = Array.isArray(reqBody?.messages)
    ? (reqBody.messages as Array<Record<string, unknown>>)
    : []
  return messages.map((msg) => ({
    role: String(msg?.role || 'unknown'),
    content: stringifyContent(msg?.content),
  }))
}

function buildInputSummary(
  reqBody: Record<string, unknown>,
  endpointType: string,
): string {
  if (endpointType === 'embeddings') {
    const input = reqBody?.input
    if (Array.isArray(input)) {
      return `${input.length} input item${input.length === 1 ? '' : 's'}`
    }
    return '1 input item'
  }
  if (endpointType === 'completions') {
    return typeof reqBody?.prompt === 'string'
      ? `${Math.max(1, (reqBody.prompt as string).split(/\s+/u).filter(Boolean).length)} words`
      : 'completion prompt'
  }
  const messages = Array.isArray(reqBody?.messages)
    ? (reqBody.messages as Array<Record<string, unknown>>)
    : []
  const userMessages = messages.filter((m) => m?.role === 'user').length
  return `${messages.length} msg${messages.length === 1 ? '' : 's'} \u00b7 ${userMessages} user msg${userMessages === 1 ? '' : 's'}`
}

function buildAnalysisSummary(analysis: Partial<AnalysisSummary>): AnalysisSummary {
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

function normalizeResponseContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  return stringifyContent(content).trim()
}

function summariseCandidate(candidate: {
  nodeHost: string
  modelName: string
  score?: number
}): CandidateSummary {
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
  limit: number
  requests: RequestEntry[]

  constructor({ limit = DEFAULT_LIMIT }: RequestHistoryConfig = {}) {
    this.limit = limit
    this.requests = []
  }

  startRequest({
    requestId,
    endpointType,
    reqBody,
    analysis,
  }: StartRequestOptions): RequestEntry {
    const preview = buildPreview(reqBody, endpointType)
    const conversation = buildConversationInfo(reqBody, endpointType, preview)

    const entry: RequestEntry = {
      requestId,
      endpointType,
      conversationId: conversation.id,
      conversationLabel: conversation.label,
      conversationSource: conversation.source,
      requestedModel: String(reqBody?.model || 'auto'),
      status: 'waiting',
      stream: Boolean(reqBody?.stream),
      createdAt: Date.now(),
      executionStartedAt: 0,
      finishedAt: 0,
      latency: 0,
      queueWaitMs: 0,
      executionTimeMs: 0,
      responseStatus: 0,
      error: null,
      abortReason: null,
      failureCategory: null,
      retryHint: null,
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
    ].slice(0, this.limit)
    return entry
  }

  recordSelection(
    requestId: string,
    candidates: Array<{ nodeHost: string; modelName: string; score?: number }>,
  ): void {
    const entry = this.#findRequest(requestId)
    if (!entry) return
    const normalised = Array.isArray(candidates)
      ? candidates.filter(Boolean)
      : [candidates].filter(Boolean)
    entry.candidateCount = normalised.length
    entry.candidates = normalised.slice(0, MAX_CANDIDATES).map(summariseCandidate)
  }

  recordAttempt(requestId: string, attempt: RecordAttemptOptions): void {
    const entry = this.#findRequest(requestId)
    if (!entry) return
    if (entry.executionStartedAt === 0 && attempt.status === 'waiting') {
      entry.executionStartedAt = Date.now()
      entry.queueWaitMs = Math.max(0, entry.executionStartedAt - entry.createdAt)
    }
    const last = entry.attempts[entry.attempts.length - 1]
    if (
      last &&
      last.nodeHost === attempt.nodeHost &&
      last.modelName === attempt.modelName &&
      ACTIVE_ATTEMPT_STATUSES.has(last.status)
    ) {
      last.status = attempt.status
      last.latency = attempt.latency || last.latency
      last.error = attempt.error || null
      last.attemptReason = attempt.attemptReason || last.attemptReason
      if (ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
        entry.status = attempt.status
      }
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
      attemptReason: attempt.attemptReason || null,
    })
    entry.attempts = entry.attempts.slice(-MAX_ATTEMPTS)
    entry.attemptCount = entry.attempts.length
    if (ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
      entry.status = attempt.status
    }
  }

  finishRequest(requestId: string, result: FinishRequestOptions = {}): boolean {
    const entry = this.#findRequest(requestId)
    if (!entry) return false
    if (entry.executionStartedAt === 0) {
      entry.executionStartedAt = Date.now()
    }
    entry.status = result.status || entry.status || 'success'
    entry.finishedAt = Date.now()
    entry.latency = result.latency || entry.latency || 0
    entry.queueWaitMs = Math.max(0, entry.executionStartedAt - entry.createdAt)
    entry.executionTimeMs = Math.max(0, entry.finishedAt - entry.executionStartedAt)
    entry.responseStatus = result.responseStatus || entry.responseStatus || 0
    entry.error = result.error || null
    entry.abortReason = result.abortReason || null
    entry.failureCategory = result.failureCategory || null
    entry.retryHint = result.retryHint || null
    entry.tokensGenerated = result.tokensGenerated || entry.tokensGenerated || 0
    entry.selectedModel = result.modelName || entry.selectedModel || null
    entry.selectedNode = result.nodeHost || entry.selectedNode || null
    return true
  }

  updateResponseContent(requestId: string, responseContent: unknown): boolean {
    const entry = this.#findRequest(requestId)
    if (!entry) return false
    if (!Array.isArray(entry.messageList)) {
      entry.messageList = []
    }
    const normalizedContent = normalizeResponseContent(responseContent)
    if (!normalizedContent) return false
    entry.messageList.push({ role: 'assistant', content: normalizedContent })
    return true
  }

  getRecentRequests(): RequestEntry[] {
    return this.requests.map((request) => ({
      ...request,
      analysis: { ...request.analysis },
      candidates: request.candidates.map((c) => ({ ...c })),
      attempts: request.attempts.map((a) => ({ ...a })),
    }))
  }

  #findRequest(requestId: string): RequestEntry | null {
    return this.requests.find((r) => r.requestId === requestId) || null
  }
}
