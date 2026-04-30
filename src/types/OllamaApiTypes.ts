/**
 * src/types/OllamaApiTypes.ts
 * Native Ollama API shapes for /api/generate and /api/chat.
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export interface OllamaModelOptions {
  num_ctx?: number
  temperature?: number
  top_p?: number
  top_k?: number
  repeat_penalty?: number
  seed?: number
  num_predict?: number
  stop?: string[]
}

// ── /api/generate ─────────────────────────────────────────────────────────────

export interface OllamaGenerateRequest {
  model: string
  prompt: string
  system?: string
  template?: string
  context?: number[]
  stream?: boolean
  raw?: boolean
  format?: 'json'
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaGenerateResponse {
  model: string
  created_at: string
  response: string
  done: boolean
  context?: number[]
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
}

// ── /api/chat ─────────────────────────────────────────────────────────────────

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  images?: string[]
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  stream?: boolean
  format?: 'json'
  options?: OllamaModelOptions
  keep_alive?: string | number
}

export interface OllamaChatResponse {
  model: string
  created_at: string
  message: OllamaMessage
  done: boolean
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
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
}
