// adapters/embeddings-translator.js - Embeddings request/response translation

/**
 * Translate an OpenAI /v1/embeddings request body to Ollama /api/embed format.
 *
 * @param {Object} openaiBody - incoming OpenAI-format request body
 * @param {string} modelName - resolved model name
 * @returns {Object} Ollama-compatible request body
 */
export function translateEmbeddingRequest(openaiBody, modelName) {
  return {
    model: modelName,
    input: openaiBody.input,
  }
}

/**
 * Translate an Ollama /api/embed response to OpenAI embeddings format.
 *
 * Ollama returns `{ embeddings: float[][] }`.
 * OpenAI expects `{ object: "list", data: [{ object, embedding, index }], model, usage }`.
 *
 * @param {Object} ollamaJson - parsed JSON from Ollama /api/embed
 * @param {string} requestedModel - model name to echo back in the response
 * @returns {Object} OpenAI-shaped embeddings response
 */
export function translateEmbeddingResponse(ollamaJson, requestedModel) {
  const embeddings = ollamaJson.embeddings ?? []
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding',
      embedding,
      index,
    })),
    model: requestedModel,
    usage: {
      prompt_tokens: ollamaJson.prompt_eval_count ?? 0,
      total_tokens: ollamaJson.prompt_eval_count ?? 0,
    },
  }
}
