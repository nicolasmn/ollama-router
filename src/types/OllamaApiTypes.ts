/**
 * src/types/OllamaApiTypes.ts
 * Native Ollama API shapes for /api/generate and /api/chat.
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export interface OllamaModelOptions {
  num_keep?: number
  seed?: number
  num_predict?: number
  top_k?: number
  top_p?: number
  min_p?: number
  typical_p?: number
  repeat_last_n?: number
  temperature?: number
  repeat_penalty?: number
  presence_penalty?: number
  frequency_penalty?: number
  penalize_newline?: boolean
  stop?: string[]
  numa?: boolean
  num_ctx?: number
  num_batch?: number
  num_gpu?: number
  main_gpu?: number
  use_mmap?: boolean
  num_thread?: number
}

// ── Tool types (used by /api/chat) ────────────────────────────────────────────

export interface OllamaToolFunction {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface OllamaTool {
  type: 'function'
  function: OllamaToolFunction
}

export interface OllamaToolCallFunction {
  name: string
  arguments: Record<string, unknown>
}

export interface OllamaToolCall {
  function: OllamaToolCallFunction
}

// ── /api/generate ─────────────────────────────────────────────────────────────

export interface OllamaGenerateRequest {
  model: string
  prompt?: string
  suffix?: string
  images?: string[]
  think?: boolean
  system?: string
  template?: string
  context?: number[]
  stream?: boolean
  raw?: boolean
  format?: 'json' | Record<string, unknown>
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaGenerateResponse {
  model: string
  created_at: string
  response: string
  done: boolean
  done_reason?: string
  context?: number[]
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

// ── /api/chat ─────────────────────────────────────────────────────────────────

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  /** Top-level image list (Ollama multimodal /api/chat shape). */
  images?: string[]
  tools?: OllamaTool[]
  think?: boolean
  stream?: boolean
  format?: 'json' | Record<string, unknown>
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaChatResponse {
  model: string
  created_at: string
  message: OllamaMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

// ── /api/tags ─────────────────────────────────────────────────────────────────

export interface OllamaModelDetails {
  parent_model: string
  format: string
  family: string
  families: string[] | null
  parameter_size: string
  quantization_level: string
}

export interface OllamaModelTag {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details: OllamaModelDetails
}

export interface OllamaTagsResponse {
  models: OllamaModelTag[]
}

// ── /api/show ─────────────────────────────────────────────────────────────────

export interface OllamaShowResponse {
  modelfile: string
  parameters: string
  template: string
  details: OllamaModelDetails
  model_info?: Record<string, unknown>
  capabilities?: string[]
}

// ── /api/embed (current) ──────────────────────────────────────────────────────

export interface OllamaEmbedRequest {
  model: string
  input: string | string[]
  truncate?: boolean
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaEmbedResponse {
  model: string
  embeddings: number[][]
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
}

// ── /api/embeddings (deprecated) ─────────────────────────────────────────────

export interface OllamaEmbeddingsRequest {
  model: string
  prompt: string
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaEmbeddingsResponse {
  embedding: number[]
}
