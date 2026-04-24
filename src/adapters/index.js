// adapters/index.js - Aggregate adapter exports
export {
  OPTION_MAP,
  translateMessages,
  normaliseToolCalls,
  mapFinishReason,
} from './adapter-utils.js'

export { translateRequestBody, translateResponseBody } from './chat-translator.js'

export {
  translateEmbeddingRequest,
  translateEmbeddingResponse,
} from './embeddings-translator.js'

export { createSSETransform } from './sse-transform.js'
