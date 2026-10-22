// request-history.ts - Tracks recent requests for dashboard inspection

const DEFAULT_LIMIT = 40
const MAX_ATTEMPTS = 8
const MAX_CANDIDATES = 3
const ACTIVE_ATTEMPT_STATUSES = new Set(['waiting', 'running'])

// Retention budgeting. The dashboard history used to copy the entire inbound
// conversation (full message content, base64 images, tool outputs) into every
// history entry for the last N requests — so a client that resends a growing
// transcript (agent loop, chat UI with history) made retained heap grow
// quadratically with conversation size until Node's heap limit was reached.
// Every captured chunk is now capped so total retained memory stays bounded.
const MAX_MESSAGE_TEXT_CHARS = 4_000
const MAX_MESSAGES_PER_ENTRY = 300
const MAX_ENTRY_TOTAL_BYTES = 512_000
const MAX_IMAGE_DATA_URL_CHARS = 64_000
const MAX_IMAGES_PER_MESSAGE = 4
const MAX_CAPTURED_CONTENT_CHARS = 64_000
const MAX_CAPTURED_THINKING_CHARS = 32_000
const MAX_TOOL_ARGUMENT_CHARS = 16_000
const MAX_PREVIEW_CHARS = 4_000

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

export interface MessageImage {
  url: string
  mimeType?: string
  width?: number
  height?: number
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
  images?: MessageImage[]
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
  /** Time Ollama spent loading the model into memory (ms). 0 = unknown/not reported. */
  modelLoadMs: number
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
  modelLoadMs?: number
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

// ---------------------------------------------------------------------------
// Capture caps — see the MAX_* constants at the top of this file.
// ---------------------------------------------------------------------------

function truncateCappedText(value: string, cap: number): string {
  if (value.length <= cap) return value
  return `${value.slice(0, cap)}…[truncated, ${value.length} chars total]`
}

/** Cap base64 data URLs; keep the MIME prefix so the type stays visible. */
function capImageDataUrl(url: string): string {
  if (url.length <= MAX_IMAGE_DATA_URL_CHARS) return url
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    if (comma !== -1 && comma <= 64) {
      return `${url.slice(0, comma + 1)}…[image data truncated, ${url.length} chars total]`
    }
    return `data:image/*;base64,…[truncated, ${url.length} chars total]`
  }
  return truncateCappedText(url, MAX_IMAGE_DATA_URL_CHARS)
}

function capImages(images: MessageImage[] | undefined): MessageImage[] | undefined {
  if (!images || images.length === 0) return undefined
  return images
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((img) => ({ ...img, url: capImageDataUrl(img.url) }))
}

function capToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined
  return toolCalls.map((call) => ({
    ...call,
    function: {
      ...call.function,
      arguments: truncateCappedText(call.function.arguments, MAX_TOOL_ARGUMENT_CHARS),
    },
  }))
}

function messagePayloadChars(msg: MessageRecord): number {
  let sum = (msg.content || '').length + (msg.thinking || '').length
  for (const img of msg.images ?? []) sum += img.url.length
  for (const call of msg.toolCalls ?? []) sum += (call.function?.arguments || '').length
  return sum
}

/** Keep the newest messages only when the entry payload exceeds the budget. */
function applyEntryBudget(messages: MessageRecord[]): MessageRecord[] {
  const capped = messages
    .slice(0, MAX_MESSAGES_PER_ENTRY)
    .map((msg) => {
      const record: MessageRecord = {
        ...msg,
        content: truncateCappedText(msg.content || '', MAX_MESSAGE_TEXT_CHARS),
      }
      if (record.thinking) {
        record.thinking = truncateCappedText(record.thinking, MAX_CAPTURED_THINKING_CHARS)
      }
      const images = capImages(record.images)
      if (images) record.images = images as any
      const toolCalls = capToolCalls(record.toolCalls)
      if (toolCalls) record.toolCalls = toolCalls
      return record
    })

  let total = 0
  for (const msg of capped) total += messagePayloadChars(msg)

  let index = 0
  let dropped = 0
  while (total > MAX_ENTRY_TOTAL_BYTES && index < capped.length) {
    total -= messagePayloadChars(capped[index])
    index += 1
    dropped += 1
  }
  if (dropped === 0) return capped
  return [
    {
      role: 'system',
      content: `(${dropped} earlier message${dropped === 1 ? '' : 's'} truncated to keep dashboard history bounded)`,
    },
    ...capped.slice(index),
  ]
}

/** Append text to a capture field without ever exceeding the cap. */
function appendCappedText(
  message: MessageRecord,
  field: 'content' | 'thinking',
  part: string,
): void {
  if (!part) return
  const cap = field === 'thinking' ? MAX_CAPTURED_THINKING_CHARS : MAX_CAPTURED_CONTENT_CHARS
  const current = (field === 'content' ? message.content : message.thinking) || ''
  if (current.length >= cap) {
    return // already at cap — the live stream still flows, capture just stops growing
  }
  if (current.length + part.length >= cap) {
    message[field] = `${current.slice(0, cap)}…[truncated]`
    return
  }
  message[field] = current + part
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
      if (p?.type === 'thought') return ''
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

function extractImages(content: unknown): MessageImage[] | undefined {
  const images: MessageImage[] = []
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'image_url') {
        const iu = p.image_url as Record<string, unknown> | string | undefined
        if (!iu) continue
        const url = typeof iu === 'string' ? iu : String((iu as any).url || '')
        if (url) {
          images.push({ url })
        }
      } else if (p.type === 'image') {
        const iu = p.image as Record<string, unknown> | string | undefined
        const url = typeof iu === 'string' ? iu : String((iu as any)?.url || (iu as any)?.data || '')
        if (url) images.push({ url })
      }
    }
  }
  return capImages(images)
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
  let preview: string
  if (endpointType === 'embeddings') {
    preview = stringifyEmbeddingInput(reqBody?.input)
  } else if (endpointType === 'completions') {
    preview = typeof reqBody?.prompt === 'string' ? reqBody.prompt : ''
  } else if (endpointType === 'systemone') {
    // Jev wire format has no `messages`; the `state` field is the input.
    // Can be a string or a JSON-serializable object/array.
    const state = reqBody?.state
    if (typeof state === 'string') preview = state
    else if (state && typeof state === 'object') preview = JSON.stringify(state)
    else preview = ''
  } else {
    const messages = Array.isArray(reqBody?.messages)
      ? (reqBody.messages as Array<Record<string, unknown>>)
      : []
    const userMessages = messages.filter((m) => m?.role === 'user')
    const lastUserMessage = userMessages.at(-1)
    preview = lastUserMessage
      ? stringifyContent(lastUserMessage.content)
      : stringifyContent((messages.at(-1) as Record<string, unknown>)?.content)
  }
  return truncateCappedText(preview, MAX_PREVIEW_CHARS)
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
      truncateCappedText(
        firstUserMessage
          ? stringifyContent(firstUserMessage.content)
          : preview,
        2_000,
      ),
    )
    if (anchor) {
      return {
        id: `chat:${hashString(anchor.toLowerCase())}`,
        label: truncateCappedText(anchor, 200),
        source: 'derived',
      }
    }
  }
  if (endpointType === 'systemone' && preview) {
    return {
      id: `systemone:${hashString(preview.toLowerCase())}`,
      label: truncateCappedText(normalizeInlineText(preview), 200),
      source: 'derived',
    }
  }
  return {
    id: `request:${hashString(`${endpointType}:${Date.now()}:${Math.random()}`)}`,
    label: `${endpointType} request`,
    source: 'none',
  }
}

function extractImagesFromDelta(delta: Record<string, unknown>): MessageImage[] | undefined {
  const images: MessageImage[] = []
  if (Array.isArray(delta.images)) {
    for (const img of delta.images) {
      if (!img || typeof img !== 'object') continue
      const url = String((img as any).url || (img as any).data || '')
      if (url) images.push({ url })
    }
  }
  if (Array.isArray(delta.image_url)) {
    for (const iu of delta.image_url) {
      const url = typeof iu === 'string' ? iu : String((iu as any)?.url || (iu as any)?.data || '')
      if (url) images.push({ url })
    }
  }
  if (delta.image_url && typeof delta.image_url === 'object') {
    const iu = delta.image_url as Record<string, unknown>
    const url = String(iu.url || iu.data || '')
    if (url) images.push({ url })
  }
  return capImages(images)
}

// Render a named Jev question with its type and criteria (the answer options)
// so the conversation preview shows what the model was choosing between.
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
        arguments: truncateCappedText(
          typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
          MAX_TOOL_ARGUMENT_CHARS,
        ),
      },
    })
  }
  return calls.length > 0 ? calls : undefined
}

function buildQuestionSummary(
  name: string,
  q: Record<string, unknown> | undefined,
): string {
  const parts: string[] = [`${name} (${String(q?.type ?? '?')})`]
  if (typeof q?.instructions === 'string' && q.instructions) {
    parts.push(q.instructions)
  }
  const criteria = q?.criteria
  if (Array.isArray(criteria)) {
    parts.push(`criteria: ${criteria.map(String).join(' | ')}`)
  } else if (criteria && typeof criteria === 'object') {
    const entries = Object.entries(
      criteria as Record<string, unknown>,
    ).map(([opt, desc]) =>
      typeof desc === 'string' && desc && desc !== opt
        ? `${opt} = ${desc}`
        : String(opt),
    )
    parts.push(`criteria: ${entries.join(' | ')}`)
  }
  return parts.join('\n')
}

function sniffImageMime(b64: string): string {
  // Sniff magic bytes from the decoded prefix. Raw base64 from Ollama carries
  // no MIME type; guessing png for everything mislabels JPEGs (which browsers
  // still render by content sniffing, but the declared type should be honest).
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('R0lGODlh')) return 'image/gif'
  if (b64.startsWith('UklGR')) return 'image/webp'
  if (b64.startsWith('PHN2Zy')) return 'image/svg+xml'
  return 'image/png'
}

function extractImagesFromStateImages(
  images: unknown,
): MessageImage[] | undefined {
  if (!Array.isArray(images)) return undefined
  const out: MessageImage[] = []
  for (const item of images) {
    if (typeof item !== 'string' || !item) continue
    // Ollama native format is raw base64; normalize to a data URL so the
    // dashboard <img> can render it. Data URLs and http(s) URLs pass through.
    if (item.startsWith('data:')) {
      out.push({ url: item })
    } else if (/^https?:\/\//iu.test(item)) {
      out.push({ url: item })
    } else {
      out.push({ url: `data:${sniffImageMime(item)};base64,${item}` })
    }
  }
  return capImages(out)
}

function buildMessageList(
  reqBody: Record<string, unknown>,
  endpointType: string,
): MessageRecord[] {
  if (endpointType === 'systemone') {
    // Jev wire format: show state + named questions as a readable exchange.
    const list: MessageRecord[] = []
    const state = reqBody?.state
    if (state !== undefined) {
      const stateRecord: MessageRecord = {
        role: 'state',
        content:
          typeof state === 'string' ? state : JSON.stringify(state),
      }
      const stateImages = extractImagesFromStateImages(reqBody?.images)
      if (stateImages) stateRecord.images = stateImages
      list.push(stateRecord)
    }
    const questions = reqBody?.questions
    if (questions && typeof questions === 'object' && !Array.isArray(questions)) {
      for (const [name, q] of Object.entries(
        questions as Record<string, Record<string, unknown>>,
      )) {
        list.push({
          role: 'question',
          content: buildQuestionSummary(name, q),
        })
      }
    }
    // Images without a state field still deserve a preview row.
    if (state === undefined) {
      const stateImages = extractImagesFromStateImages(reqBody?.images)
      if (stateImages) {
        list.unshift({
          role: 'state',
          content: '(image attachments)',
          images: stateImages,
        })
      }
    }
    return applyEntryBudget(list)
  }
  if (endpointType !== 'chat') return []
  const messages = Array.isArray(reqBody?.messages)
    ? (reqBody.messages as Array<Record<string, unknown>>)
    : []
  return applyEntryBudget(
    messages.map((msg) => {
      const record: MessageRecord = {
        role: String(msg?.role || 'unknown'),
        content: stringifyContent(msg?.content),
      }
      const toolCalls = normalizeToolCalls(msg?.tool_calls)
      if (toolCalls) record.toolCalls = toolCalls
      if (msg?.tool_call_id) record.toolCallId = String(msg.tool_call_id)
      if (msg?.name) record.name = String(msg.name)
      const images = extractImages(msg?.content)
      if (images) (record as any).images = images
      return record
    }),
  )
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
  if (endpointType === 'systemone') {
    const questions = reqBody?.questions
    const count =
      questions && typeof questions === 'object' && !Array.isArray(questions)
        ? Object.keys(questions).length
        : 0
    return `${count} question${count === 1 ? '' : 's'}`
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
      modelLoadMs: 0,
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

    // Pre-fill selectedNode/selectedModel from the top candidate so that
    // isCloudRequest() returns the correct value immediately — during both the
    // `waiting` and `running` phases — without waiting for finishRequest().
    // finishRequest() will overwrite these with the confirmed values once the
    // request completes, so there is no risk of stale data after completion.
    const top = normalised[0]
    if (top && !entry.selectedNode) {
      entry.selectedNode = top.nodeHost
      entry.selectedModel = top.modelName
    }
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
    if (typeof result.modelLoadMs === 'number' && result.modelLoadMs > 0) {
      entry.modelLoadMs = result.modelLoadMs
    }
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
  content = truncateCappedText(content, MAX_CAPTURED_CONTENT_CHARS)
  if (thinking) thinking = truncateCappedText(thinking, MAX_CAPTURED_THINKING_CHARS)

  if (!content && !thinking && !toolCalls) return false

  const record: MessageRecord = { role: 'assistant', content }
  if (thinking) record.thinking = thinking
  if (toolCalls) record.toolCalls = toolCalls
  const images = extractImages(responseContent)
  if (images) (record as any).images = images
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

    const record: MessageRecord = {
      role: 'assistant',
      content: truncateCappedText(assembled.content, MAX_CAPTURED_CONTENT_CHARS),
    }
    if (assembled.thinking) {
      record.thinking = truncateCappedText(assembled.thinking, MAX_CAPTURED_THINKING_CHARS)
    }
    if (assembled.toolCalls.length > 0) record.toolCalls = assembled.toolCalls
    if (assembled.images) (record as any).images = assembled.images
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
      appendCappedText(message, 'content', contentPart)
    }
    if (thinkingPart) {
      appendCappedText(message, 'thinking', thinkingPart)
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
          target.function.arguments = truncateCappedText(
            `${target.function.arguments}${String(fn.arguments)}`,
            MAX_TOOL_ARGUMENT_CHARS,
          )
        }
      }
      message.toolCalls = current
    }

    const deltaImages = extractImagesFromDelta(payload)
    if (deltaImages) {
      (message as any).images = [
        ...((message as any).images ?? []),
        ...deltaImages,
      ].slice(0, MAX_IMAGES_PER_MESSAGE * 2)
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
    last.content = truncateCappedText(extracted.content, MAX_CAPTURED_CONTENT_CHARS)
    if (extracted.thinking) {
      last.thinking = truncateCappedText(
        last.thinking
          ? `${last.thinking}\n\n${extracted.thinking}`.trim()
          : extracted.thinking,
        MAX_CAPTURED_THINKING_CHARS,
      )
    } else if (last.thinking) {
      last.thinking = truncateCappedText(last.thinking.trim(), MAX_CAPTURED_THINKING_CHARS)
    }

    return true
  }

  #parseSSEChunks(rawSSE: string): { content: string; thinking: string; toolCalls: ToolCall[]; images?: MessageImage[] } {
    let content = ''
    let thinking = ''
    const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>()
    const images: MessageImage[] = []

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

        const deltaImages = extractImagesFromDelta(delta)
        if (deltaImages) images.push(...deltaImages)

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

    return { content: content.trim(), thinking: thinking.trim(), toolCalls, images: images.length ? images : undefined }
  }

  getRecentRequests(): RequestEntry[] {
    return this.requests.map((request) => ({
      ...request,
      analysis: { ...request.analysis },
      candidates: request.candidates.map((c) => ({ ...c })),
      attempts: request.attempts.map((a) => ({ ...a })),
    }))
  }

  /**
   * Number of requests that are still in flight (queued or executing).
   * Used by the shutdown drain so a systemd restart waits for running
   * inference to finish instead of killing it mid-stream.
   */
  activeRequestCount(): number {
    return this.requests.reduce(
      (count, request) =>
        request.status === 'waiting' || request.status === 'running'
          ? count + 1
          : count,
      0,
    )
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
