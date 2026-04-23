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
  let userText = ''

  for (const msg of messages) {
    const content = msg?.content
    if (hasImageContent(content)) needsVision = true
    if (hasAudioContent(content)) needsAudio = true
    const text = ' ' + stringifyContent(content)
    totalText += text
    if (msg?.role === 'user') userText += text
  }

  return { needsVision, needsAudio, totalText, userText }
}

function deriveComplexityFlags(totalText, userText, needsTools) {
  const estimatedInputTokens = estimateTokens(totalText)
  const estimatedUserTokens = estimateTokens(userText)
  const hasReasoningSignals = REASONING_SIGNALS.test(userText)
  const hasCodeSignals = CODE_SIGNALS.test(userText)

  // Complexity is driven by what the user actually asked, not by system prompts or history size
  const preferReasoning = hasReasoningSignals || hasCodeSignals

  const preferFast =
    !needsTools &&
    !hasReasoningSignals &&
    !hasCodeSignals &&
    estimatedUserTokens < 300

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

    let userText
    if (endpointType === 'completions') {
      totalText = typeof reqBody?.prompt === 'string' ? reqBody.prompt : ''
      userText = totalText
    } else {
      const modal = detectMultimodalNeeds(messages)
      needsVision = modal.needsVision
      needsAudio = modal.needsAudio
      totalText = modal.totalText
      userText = modal.userText
    }

    const {
      estimatedInputTokens,
      hasCodeSignals,
      preferReasoning,
      preferFast,
    } = deriveComplexityFlags(totalText, userText, needsTools)

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
