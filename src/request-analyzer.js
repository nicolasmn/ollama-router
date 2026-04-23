// request-analyzer.js - Analyzes incoming requests for capability requirements

const REASONING_SIGNALS =
  /\b(explain|analyze|analyse|compare|evaluate|think|reasoning|step.by.step|step by step|pros.and.cons|debate|critique|strategy|complex|detailed analysis)\b/i

const CODE_SIGNALS =
  /```|def\s+|class\s+|import\s+|function\s*\(|#include|SELECT\s+.+\s+FROM/i

function estimateTokens(text) {
  return Math.ceil((text || '').length / 4)
}

function stringifyContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text || ''
        return ''
      })
      .join(' ')
  }
  return ''
}

function hasImageContent(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => part?.type === 'image_url' || part?.type === 'image',
  )
}

function hasAudioContent(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (part) => part?.type === 'input_audio' || part?.type === 'audio',
  )
}

function detectMultimodalNeeds(messages) {
  let needsVision = false
  let needsAudio = false
  let totalText = ''

  for (const msg of messages) {
    const content = msg?.content
    if (hasImageContent(content)) needsVision = true
    if (hasAudioContent(content)) needsAudio = true
    totalText += ' ' + stringifyContent(content)
  }

  return { needsVision, needsAudio, totalText }
}

function deriveComplexityFlags(
  totalText,
  messages,
  maxOutputTokens,
  needsTools,
) {
  const estimatedInputTokens = estimateTokens(totalText)
  const hasReasoningSignals = REASONING_SIGNALS.test(totalText)
  const hasCodeSignals = CODE_SIGNALS.test(totalText)
  const isLongConversation = messages.length > 6
  const isLargeInput = estimatedInputTokens > 2000
  const isLargeOutput = maxOutputTokens > 1000

  const preferReasoning =
    hasReasoningSignals || isLongConversation || (isLargeInput && isLargeOutput)

  const preferFast =
    !needsTools &&
    !hasReasoningSignals &&
    !isLargeInput &&
    estimatedInputTokens < 300 &&
    maxOutputTokens <= 200

  return {
    estimatedInputTokens,
    hasReasoningSignals,
    hasCodeSignals,
    preferReasoning,
    preferFast,
  }
}

export class RequestAnalyzer {
  /**
   * Analyze an incoming request and determine what the model needs to support.
   * @param {Object} reqBody - request body
   * @param {'chat'|'completions'|'embeddings'} endpointType
   * @returns {RequestRequirements}
   */
  analyze(reqBody, endpointType) {
    if (endpointType === 'embeddings') {
      return {
        endpointType,
        needsEmbeddings: true,
        needsVision: false,
        needsAudio: false,
        needsTools: false,
        estimatedInputTokens: 0,
        maxOutputTokens: 0,
        isStreaming: false,
        preferReasoning: false,
        preferFast: true,
        hasCodeSignals: false,
      }
    }

    const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : []
    const isStreaming = Boolean(reqBody?.stream)
    const maxOutputTokens =
      Number(reqBody?.max_completion_tokens ?? reqBody?.max_tokens) || 0
    const needsTools = Array.isArray(reqBody?.tools) && reqBody.tools.length > 0

    let needsVision = false
    let needsAudio = false
    let totalText

    if (endpointType === 'completions') {
      totalText = typeof reqBody?.prompt === 'string' ? reqBody.prompt : ''
    } else {
      const modal = detectMultimodalNeeds(messages)
      needsVision = modal.needsVision
      needsAudio = modal.needsAudio
      totalText = modal.totalText
    }

    const {
      estimatedInputTokens,
      hasCodeSignals,
      preferReasoning,
      preferFast,
    } = deriveComplexityFlags(totalText, messages, maxOutputTokens, needsTools)

    return {
      endpointType,
      needsEmbeddings: false,
      needsVision,
      needsAudio,
      needsTools,
      estimatedInputTokens,
      maxOutputTokens,
      isStreaming,
      preferReasoning,
      preferFast,
      hasCodeSignals,
    }
  }
}
