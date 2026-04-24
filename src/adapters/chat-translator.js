// adapters/chat-translator.js - Chat request/response translation
import {
  OPTION_MAP,
  translateMessages,
  normaliseToolCalls,
  mapFinishReason,
} from './adapter-utils.js'

/**
 * Build the Ollama /api/chat request body from an OpenAI chat completions body.
 * Translates messages to Ollama format and maps sampling options.
 *
 * @param {Object} openaiBody - incoming OpenAI-format request body
 * @param {string} modelName - resolved model name (may differ from openaiBody.model for virtual models)
 * @returns {Object} Ollama-compatible request body
 */
export function translateRequestBody(openaiBody, modelName, supportsThinking = false) {
  const options = {}
  for (const [openaiKey, ollamaKey] of Object.entries(OPTION_MAP)) {
    if (openaiBody[openaiKey] !== undefined) {
      options[ollamaKey] = openaiBody[openaiKey]
    }
  }

  const body = {
    model: modelName,
    messages: translateMessages(openaiBody.messages ?? []),
    stream: openaiBody.stream ?? false,
  }

  if (supportsThinking) {
    body.think = true
  }

  if (openaiBody.tools?.length) {
    body.tools = openaiBody.tools
  }

  if (Object.keys(options).length > 0) {
    body.options = options
  }

  return body
}

/**
 * Translate a complete Ollama /api/chat JSON response to OpenAI chat.completion format.
 *
 * @param {Object} ollamaJson - parsed JSON from Ollama /api/chat
 * @param {string} requestedModel - model name to echo back in the response
 * @param {string} [completionId] - pre-generated id; created if omitted
 * @param {number} [created] - Unix timestamp; defaults to now
 * @returns {Object} OpenAI-shaped chat completion object
 */
export function translateResponseBody(
  ollamaJson,
  requestedModel,
  completionId,
  created,
) {
  const id = completionId ?? `chatcmpl-${Date.now().toString(36)}`
  const ts = created ?? Math.floor(Date.now() / 1000)

  const rawMessage = ollamaJson.message ?? {}
  const rawToolCalls = rawMessage.tool_calls?.length
    ? rawMessage.tool_calls
    : null

  const toolCalls = rawToolCalls ? normaliseToolCalls(rawToolCalls) : null
  const finishReason = mapFinishReason(
    ollamaJson.done_reason,
    Boolean(toolCalls),
  )

  const message = {
    role: rawMessage.role ?? 'assistant',
    // content must be null when tool calls are present (Letta requirement)
    content: toolCalls ? null : (rawMessage.content ?? ''),
  }
  if (rawMessage.thinking) {
    message.thinking = rawMessage.thinking
  }
  if (toolCalls) {
    message.tool_calls = toolCalls
  }

  return {
    id,
    object: 'chat.completion',
    created: ts,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: ollamaJson.prompt_eval_count ?? 0,
      completion_tokens: ollamaJson.eval_count ?? 0,
      total_tokens:
        (ollamaJson.prompt_eval_count ?? 0) + (ollamaJson.eval_count ?? 0),
    },
  }
}
