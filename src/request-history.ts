// request-history.ts - Tracks recent requests for dashboard inspection

const DEFAULT_LIMIT = 40
const MAX_ATTEMPTS = 8
const MAX_CANDIDATES = 3
const ACTIVE_ATTEMPT_STATUSES = new Set(['waiting', 'running'])

export interface CandidateRationale {
  latencyScore: number
  tpsScore: number
  sizeFit: number
  warmBonus: number
  loadPenalty: number
  /** Fixed local-preference penalty, always −CLOUD_COST_PREFERENCE for cloud candidates (0 for local). */
  cloudCostPenalty: number
  /** Dynamic usage penalty, ramps 0 → 20 as cloud usage crosses 70 % → 100 %. */
  cloudUsagePenalty: number
  thinkingBonus: number
  contextMargin: number
  totalScore: number
  sizeReason: string
}

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
  rationale?: CandidateRationale | null
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

export interface ToolCallFunction {
  name: string
  arguments: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: ToolCallFunction
}

export interface MessageRecord {
  role: string
  content: string
  thinking?: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
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
  forcedModel: boolean
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
  forcedModel?: boolean
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

function stringifyFragment(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return stringifyContent(value)
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  return ''
}

function extractThinkingFromTaggedContent(
  content: string,
): { content: string; thinking: string } {
  if (!content) {
    return { content: '', thinking: '' }
  }

  const thinkingParts: string[] = []
  const withoutThinkingTags = content.replace(
    /<think>([\s\S]*?)<\/think>/giu,
    (_, group: string) => {
      if (group?.trim()) {
        thinkingParts.push(group.trim())
      }
      return ' '
    },
  )

  return {
    content: withoutThinkingTags.replace(/\s+/gu, ' ').trim(),
    thinking: thinkingParts.join('\n\n').trim(),
  }
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

function normalizeToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const calls: ToolCall[] = []
  for (const item of raw as Array<Record<string, unknown>>) {
    const fn = item?.function as Record<string, unknown> | undefined
    if (!fn) continue
    calls.push({
      id: String(item?.id || ''),
      type: 'function',
      function: {
        name: String(fn?.name || ''),
        arguments: typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
      },
    })
  }
  return calls.length > 0 ? calls : undefined
}

function buildMessageList(
  reqBody: Record<string, unknown>,
  endpointType: string,
): MessageRecord[] {
  if (endpointType !== 'chat') return []
  const messages = Array.isArray(reqBody?.messages)
    ? (reqBody.messages as Array<Record<string, unknown>>)
    : []
  return messages.map((msg) => {
    const record: MessageRecord = {
      role: String(msg?.role || 'unknown'),
      content: stringifyContent(msg?.content),
    }
    const toolCalls = normalizeToolCalls(msg?.tool_calls)
    if (toolCalls) record.toolCalls = toolCalls
    if (msg?.tool_call_id) record.toolCallId = String(msg.tool_call_id)
    if (msg?.name) record.name = String(msg.name)
    return record
  })
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
  return stringifyFragment(content).trim()
}

function normalizeResponseFragment(content: unknown): string {
  return stringifyFragment(content)
}

function summariseCandidate(candidate: {
  nodeHost: string
  modelName: string
  score?: number
  rationale?: CandidateRationale | null
}): CandidateSummary {
  const scoreValue =
    typeof candidate.score === 'number'
      ? Math.round(candidate.score * 100) / 100
      : null
  const rationale = candidate.rationale
    ? {
        latencyScore: candidate.rationale.latencyScore,
        tpsScore: candidate.rationale.tpsScore,
        sizeFit: candidate.rationale.sizeFit,
        warmBonus: candidate.rationale.warmBonus,
        loadPenalty: candidate.rationale.loadPenalty,
        cloudCostPenalty: candidate.rationale.cloudCostPenalty,
        cloudUsagePenalty: candidate.rationale.cloudUsagePenalty,
        thinkingBonus: candidate.rationale.thinkingBonus,
        contextMargin: candidate.rationale.contextMargin,
        totalScore: candidate.rationale.totalScore,
        sizeReason: candidate.rationale.sizeReason,
      }
    : null
  return {
    nodeHost: candidate.nodeHost,
    modelName: candidate.modelName,
    score: scoreValue,
    rationale,
  }
}

/**
 * Extracts content/thinking parts from a single streaming chunk, regardless of
 * whether it comes from an OpenAI-compatible stream (choices[0].delta) or from
 * a native Ollama endpoint (/api/generate → response field, /api/chat →
 * message.content field).
 *
 * Returns null when the chunk carries no text (e.g. a heartbeat / done:true
 * finalizer with no text payload).
 */
function decodeStreamingChunk(
  payload: Record<string, unknown>,
): { contentPart: string; thinkingPart: string; toolCalls: Array<Record<string, unknown>> } | null {
  // ── OpenAI-compatible: choices[0].delta ────────────────────────────────────
  const delta = (
    (payload?.choices as Array<Record<string, unknown>>)?.[0]?.delta
  ) as Record<string, unknown> | undefined

  if (delta) {
    const contentPart = normalizeResponseFragment(delta.content)
    const thinkingPart = [
      normalizeResponseFragment(delta.thinking),
      normalizeResponseFragment(delta.reasoning_content),
      normalizeResponseFragment(delta.reasoning),
    ]
      .filter(Boolean)
      .join('')
    const toolCalls = Array.isArray(delta.tool_calls)
      ? (delta.tool_calls as Array<Record<string, unknown>>)
      : []
    if (!contentPart && !thinkingPart && toolCalls.length === 0) return null
    return { contentPart, thinkingPart, toolCalls }
  }

  // ── Ollama-native /api/generate: { response: string, done: bool } ──────────
  if (typeof payload.response === 'string') {
    const contentPart = payload.response
    if (!contentPart) return null
    return { contentPart, thinkingPart: '', toolCalls: [] }
  }

  // ── Ollama-native /api/chat: { message: { role, content }, done: bool } ────
  if (payload.message && typeof payload.message === 'object') {
    const msg = payload.message as Record<string, unknown>
    const contentPart = normalizeResponseFragment(msg.content)
    if (!contentPart) return null
    return { contentPart, thinkingPart: '', toolCalls: [] }
  }

  return null
}

export class RequestHistoryManager {
  limit: number
  requests: RequestEntry[]
  readonly #abortControllers = new Map<string, AbortController>()

  constructor({ limit = DEFAULT_LIMIT }: RequestHistoryConfig = {}) {
    this.limit = limit
    this.requests = []
  }

  registerAbortController(requestId: string, controller: AbortController): void {
    this.#abortControllers.set(requestId, controller)
  }

  unregisterAbortController(requestId: string): void {
    this.#abortControllers.delete(requestId)
  }

  terminateRequest(requestId: string): boolean {
    const controller = this.#abortControllers.get(requestId)
    if (!controller) return false
    controller.abort()
    return true
  }

  startRequest({
    requestId,
    endpointType,
    reqBody,
    analysis,
    forcedModel = false,
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
      forcedModel,
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
    candidates: Array<{
      nodeHost: string
      modelName: string
      score?: number
      rationale?: CandidateRationale | null
    }>,
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
    this.#abortControllers.delete(requestId)
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

    let content: string
    let thinking: string | undefined
    let toolCalls: ToolCall[] | undefined

    if (typeof responseContent === 'string') {
      content = responseContent.trim()
    } else {
      const choice = responseContent as Record<string, unknown> | null | undefined
      const message = (choice?.message ?? choice) as Record<string, unknown> | null | undefined

      content = normalizeResponseContent(message?.content)
      const thinkingFromFields = [
        stringifyFragment(message?.thinking),
        stringifyFragment(message?.reasoning_content),
        stringifyFragment(message?.reasoning),
      ]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n')
        .trim()
      thinking = thinkingFromFields || undefined
      toolCalls = normalizeToolCalls(message?.tool_calls)
    }

    const extracted = extractThinkingFromTaggedContent(content)
    content = extracted.content
    if (extracted.thinking) {
      thinking = thinking
        ? `${thinking}\n\n${extracted.thinking}`
        : extracted.thinking
    }

    if (!content && !thinking && !toolCalls) return false

    const record: MessageRecord = { role: 'assistant', content }
    if (thinking) record.thinking = thinking
    if (toolCalls) record.toolCalls = toolCalls
    entry.messageList.push(record)
    return true
  }

  updateResponseFromSSE(requestId: string, rawSSE: string): boolean {
    const entry = this.#findRequest(requestId)
    if (!entry) return false
    if (!Array.isArray(entry.messageList)) {
      entry.messageList = []
    }

    const assembled = this.#parseSSEChunks(rawSSE)
    if (!assembled.content && !assembled.thinking && assembled.toolCalls.length === 0) return false

    const record: MessageRecord = { role: 'assistant', content: assembled.content }
    if (assembled.thinking) record.thinking = assembled.thinking
    if (assembled.toolCalls.length > 0) record.toolCalls = assembled.toolCalls
    entry.messageList.push(record)
    return true
  }

  applyStreamingEvent(
    requestId: string,
    payload: Record<string, unknown>,
  ): boolean {
    const entry = this.#findRequest(requestId)
    if (!entry) return false
    if (!Array.isArray(entry.messageList)) {
      entry.messageList = []
    }

    const decoded = decodeStreamingChunk(payload)
    if (!decoded) return false

    const { contentPart, thinkingPart, toolCalls } = decoded
    const message = this.#getOrCreateStreamingAssistantMessage(entry)

    if (contentPart) {
      message.content = `${message.content || ''}${contentPart}`
    }
    if (thinkingPart) {
      message.thinking = `${message.thinking || ''}${thinkingPart}`
    }

    if (toolCalls.length > 0) {
      const current = message.toolCalls ? [...message.toolCalls] : []
      for (const rawCall of toolCalls) {
        const idx =
          typeof rawCall.index === 'number' && rawCall.index >= 0
            ? rawCall.index
            : current.length
        while (current.length <= idx) {
          current.push({
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          })
        }
        const target = current[idx]
        if (rawCall.id) {
          target.id = String(rawCall.id)
        }
        const fn = rawCall.function as Record<string, unknown> | undefined
        if (fn?.name) {
          target.function.name = `${target.function.name}${String(fn.name)}`
        }
        if (fn?.arguments) {
          target.function.arguments = `${target.function.arguments}${String(fn.arguments)}`
        }
      }
      message.toolCalls = current
    }

    return true
  }

  finalizeStreamingResponse(requestId: string): boolean {
    const entry = this.#findRequest(requestId)
    if (!entry || !Array.isArray(entry.messageList) || entry.messageList.length === 0) {
      return false
    }

    const last = entry.messageList[entry.messageList.length - 1]
    if (!last || last.role !== 'assistant') {
      return false
    }

    const extracted = extractThinkingFromTaggedContent(last.content || '')
    last.content = extracted.content
    if (extracted.thinking) {
      last.thinking = last.thinking
        ? `${last.thinking}\n\n${extracted.thinking}`.trim()
        : extracted.thinking
    } else if (last.thinking) {
      last.thinking = last.thinking.trim()
    }

    return true
  }

  #parseSSEChunks(rawSSE: string): { content: string; thinking: string; toolCalls: ToolCall[] } {
    let content = ''
    let thinking = ''
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()

    for (const line of rawSSE.split('\n')) {
      const normalizedLine = line.trimStart()
      if (!normalizedLine.startsWith('data:')) continue
      const data = normalizedLine.slice(5).trimStart()
      if (data === '[DONE]') break
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>
        const delta = (
          (parsed?.choices as Array<Record<string, unknown>>)?.[0]?.delta
        ) as Record<string, unknown> | undefined
        if (!delta) continue

        content += stringifyFragment(delta.content)
        thinking += stringifyFragment(delta.thinking)
        thinking += stringifyFragment(delta.reasoning_content)
        thinking += stringifyFragment(delta.reasoning)

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            if (!toolCallMap.has(idx)) {
              toolCallMap.set(idx, { id: String(tc.id || ''), name: '', arguments: '' })
            }
            const entry = toolCallMap.get(idx)!
            if (tc.id) entry.id = String(tc.id)
            const fn = tc.function as Record<string, unknown> | undefined
            if (fn?.name) entry.name += String(fn.name)
            if (fn?.arguments) entry.arguments += String(fn.arguments)
          }
        }
      } catch {
        // skip malformed SSE lines
      }
    }

    const extracted = extractThinkingFromTaggedContent(content)
    content = extracted.content
    if (extracted.thinking) {
      thinking = thinking
        ? `${thinking}\n\n${extracted.thinking}`
        : extracted.thinking
    }

    const toolCalls: ToolCall[] = []
    for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
      toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })
    }

    return { content: content.trim(), thinking: thinking.trim(), toolCalls }
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

  #getOrCreateStreamingAssistantMessage(entry: RequestEntry): MessageRecord {
    const last = entry.messageList[entry.messageList.length - 1]
    if (last && last.role === 'assistant') {
      return last
    }
    const created: MessageRecord = { role: 'assistant', content: '' }
    entry.messageList.push(created)
    return created
  }
}
