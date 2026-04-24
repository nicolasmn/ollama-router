// adapters/sse-transform.js - Server-Sent Events stream transformer
import { Transform } from 'node:stream'

/**
 * Build a single SSE `data:` line from one parsed Ollama NDJSON chunk.
 * Returns null for lines that should be skipped.
 * Mutates `toolCallIdEmitted` to track first-chunk id/type emission.
 *
 * @param {Object} ollamaChunk
 * @param {string} completionId
 * @param {string} modelName
 * @param {number} created
 * @param {Set<number>} toolCallIdEmitted
 * @returns {string|null} SSE line(s) to push, or null to skip
 */
function buildSSELine(
  ollamaChunk,
  completionId,
  modelName,
  created,
  toolCallIdEmitted,
) {
  if (ollamaChunk.done) {
    const rawToolCalls = ollamaChunk.message?.tool_calls
    const finishReason = rawToolCalls?.length ? 'tool_calls' : 'stop'
    const finalChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelName,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    }
    return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`
  }

  const rawDelta = ollamaChunk.message ?? {}
  const delta = {}

  if (rawDelta.role) delta.role = rawDelta.role
  if (rawDelta.content) delta.content = rawDelta.content

  if (rawDelta.tool_calls?.length) {
    delta.tool_calls = buildToolCallDelta(
      rawDelta.tool_calls,
      completionId,
      toolCallIdEmitted,
    )
  }

  const sseChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
  return `data: ${JSON.stringify(sseChunk)}\n\n`
}

/**
 * Build the tool_calls delta array for an SSE chunk.
 * Emits id/type only on the first chunk per tool call index.
 *
 * @param {Array} rawToolCalls
 * @param {string} completionId
 * @param {Set<number>} toolCallIdEmitted
 * @returns {Array}
 */
function buildToolCallDelta(rawToolCalls, completionId, toolCallIdEmitted) {
  return rawToolCalls.map((tc, i) => {
    const callChunk = { index: i }
    if (!toolCallIdEmitted.has(i)) {
      callChunk.id = tc.id || `call_${completionId}_${i}`
      callChunk.type = 'function'
      toolCallIdEmitted.add(i)
    }
    const args = tc.function?.arguments
    callChunk.function = {
      name: tc.function?.name ?? '',
      arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
    }
    return callChunk
  })
}

/**
 * Create a Node.js Transform stream that converts Ollama NDJSON streaming output
 * into OpenAI-compatible Server-Sent Events (SSE).
 *
 * Each Ollama line  ->  data: <OpenAI chunk JSON>\n\n
 * Final line (done) ->  data: [DONE]\n\n
 *
 * For tool call chunks, `id` and `type` are emitted only on the first chunk per
 * tool call index, matching the OpenAI streaming specification.
 *
 * @param {string} completionId - shared id for all chunks in this response
 * @param {string} modelName - model name echoed in each chunk
 * @param {number} created - Unix timestamp shared across chunks
 * @returns {Transform}
 */
export function createSSETransform(completionId, modelName, created) {
  let buffer = ''
  // Track which tool call indices have already had their id/type emitted
  const toolCallIdEmitted = new Set()

  return new Transform({
    readableObjectMode: false,
    writableObjectMode: false,

    transform(chunk, _encoding, callback) {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      // Retain the last (possibly incomplete) line
      buffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let ollamaChunk
        try {
          ollamaChunk = JSON.parse(trimmed)
        } catch {
          continue
        }

        const sseLine = buildSSELine(
          ollamaChunk,
          completionId,
          modelName,
          created,
          toolCallIdEmitted,
        )
        if (sseLine) this.push(sseLine)
      }

      callback()
    },

    flush(callback) {
      // Drain any data remaining in the buffer after the stream ends
      if (buffer.trim()) {
        let ollamaChunk = null
        try {
          ollamaChunk = JSON.parse(buffer.trim())
        } catch {
          // ignore malformed trailing data
        }
        if (ollamaChunk?.done) {
          this.push('data: [DONE]\n\n')
        }
      }
      callback()
    },
  })
}
