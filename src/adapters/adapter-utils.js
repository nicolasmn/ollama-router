// adapters/adapter-utils.js - Shared adapter utilities
/**
 * OpenAI request options that map to Ollama's nested `options` block.
 * Keys are OpenAI field names; values are the Ollama option names.
 */
export const OPTION_MAP = {
  temperature: 'temperature',
  top_p: 'top_p',
  max_tokens: 'num_predict',
  max_completion_tokens: 'num_predict',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  seed: 'seed',
}

/**
 * Translate an OpenAI messages array into Ollama-compatible format.
 *
 * OpenAI and Ollama differ in two ways for tool-related messages:
 * - Assistant messages with tool_calls may have `content: null`; Ollama requires a string.
 * - Tool call `arguments` are JSON strings in OpenAI format; Ollama expects a parsed object.
 * - Tool role messages carry `tool_call_id` which Ollama does not use.
 *
 * @param {Array} messages - OpenAI-format messages
 * @returns {Array} Ollama-compatible messages
 */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.type === 'text') return part.text ?? ''
        return ''
      })
      .join('')
  }
  return content ?? ''
}

export function translateMessages(messages) {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      return {
        role: 'assistant',
        content: flattenContent(msg.content),
        tool_calls: msg.tool_calls.map((tc) => {
          const args = tc.function?.arguments
          let parsedArgs
          try {
            parsedArgs =
              typeof args === 'string' ? JSON.parse(args) : (args ?? {})
          } catch {
            parsedArgs = {}
          }
          return {
            ...tc,
            function: { ...tc.function, arguments: parsedArgs },
          }
        }),
      }
    }

    if (msg.role === 'tool') {
      // eslint-disable-next-line no-unused-vars
      const { tool_call_id, ...rest } = msg
      return { ...rest, content: flattenContent(rest.content) }
    }

    return { ...msg, content: flattenContent(msg.content) }
  })
}

/**
 * Normalise an Ollama tool_calls array to OpenAI format.
 * - Adds a generated `id` if absent
 * - Ensures `type: "function"`
 * - Stringifies `arguments` if it is an object (Letta requires a JSON-encoded string)
 *
 * @param {Array} toolCalls - raw tool_calls from Ollama
 * @returns {Array} OpenAI-shaped tool_calls
 */
export function normaliseToolCalls(toolCalls) {
  return toolCalls.map((tc, i) => {
    const args = tc.function?.arguments
    return {
      id: tc.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function',
      function: {
        name: tc.function?.name ?? '',
        // Letta requires arguments to be a JSON-encoded string, not an object
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      },
    }
  })
}

/**
 * Map an Ollama done_reason to an OpenAI finish_reason.
 * @param {string|null|undefined} doneReason
 * @param {boolean} hasToolCalls
 * @returns {string}
 */
export function mapFinishReason(doneReason, hasToolCalls) {
  if (hasToolCalls) return 'tool_calls'
  if (doneReason === 'length') return 'length'
  return 'stop'
}
