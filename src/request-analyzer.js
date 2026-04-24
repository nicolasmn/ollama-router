// request-analyzer.js - Analyzes incoming requests for capability requirements

const REASONING_SIGNALS =
  /\b(explain|analy[sz]e|compare|evaluate|reason(?:ing)?|step[-\s]?by[-\s]?step|critique|strategy|plan|debug|why|analysiere|analyse|vergleiche|bewerte|begr[üu]nde|erkl[äa]re|schritt[-\s]?f[üu]r[-\s]?schritt|warum|strategie)\b/iu

const CODE_SIGNALS =
  /```|def\s+|class\s+|import\s+|function\s*[\w(]|#include|SELECT\s+.+\s+FROM/i

const LIST_SIGNALS = /(^|\n)\s*(?:[-*•]|\d+[.)])\s+\S/mu
const COMPARISON_SIGNALS = /\b(vs\.?|versus)\b|->|=>|<->/i

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

function countMatches(text, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`
  const matches = text.match(new RegExp(regex.source, flags))
  return matches ? matches.length : 0
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

function deriveComplexityFlags(
  totalText,
  userText,
  needsTools,
  maxOutputTokens,
  messageCount,
) {
  const estimatedInputTokens = estimateTokens(totalText)
  const estimatedUserTokens = estimateTokens(userText)
  const hasReasoningSignals = REASONING_SIGNALS.test(userText)
  const hasCodeSignals = CODE_SIGNALS.test(userText)
  const reasoningHintCount = countMatches(userText, REASONING_SIGNALS)
  const questionCount = countMatches(userText, /\?/g)
  const lineCount = countMatches(userText, /\n/g) + (userText.trim() ? 1 : 0)
  const hasListStructure = LIST_SIGNALS.test(userText)
  const hasComparisonStructure = COMPARISON_SIGNALS.test(userText)

  let reasoningScore = 0
  if (reasoningHintCount > 0) reasoningScore += Math.min(2, reasoningHintCount)
  if (hasCodeSignals) reasoningScore += 2
  if (estimatedUserTokens >= 150) reasoningScore += 1
  if (estimatedUserTokens >= 400) reasoningScore += 1
  if (questionCount >= 2) reasoningScore += 1
  if (lineCount >= 4) reasoningScore += 1
  if (hasListStructure) reasoningScore += 1
  if (hasComparisonStructure) reasoningScore += 1
  if (maxOutputTokens >= 1200) reasoningScore += 1

  // Complexity is driven by what the user actually asked, not by language-specific phrasing.
  const preferReasoning = reasoningScore >= 2

  const preferFast =
    !needsTools &&
    !preferReasoning &&
    !hasCodeSignals &&
    estimatedUserTokens < 180 &&
    maxOutputTokens <= 800 &&
    messageCount <= 10

  return {
    estimatedInputTokens,
    hasReasoningSignals,
    hasCodeSignals,
    preferReasoning,
    preferFast,
    messageCount,
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
        messageCount: 0,
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
      messageCount,
    } = deriveComplexityFlags(
      totalText,
      userText,
      needsTools,
      maxOutputTokens,
      messages.length,
    )

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
      messageCount,
    }
  }
}
