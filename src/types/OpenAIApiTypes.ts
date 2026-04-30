/**
 * src/types/OpenAIApiTypes.ts
 * OpenAI-compatible API shapes used by this router.
 * Router exposes: /v1/chat/completions, /v1/responses, /v1/embeddings, /v1/models
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageUrlContent {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface InputAudioContent {
  type: 'input_audio'
  input_audio: { data: string; format: 'wav' | 'mp3' }
}

export type MessageContentPart = TextContent | ImageUrlContent | InputAudioContent

export interface ChatMessage {
  role: MessageRole
  content: string | MessageContentPart[]
  name?: string
  tool_call_id?: string
}

export interface FunctionDef {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface Tool {
  type: 'function'
  function: FunctionDef
}

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  tools?: Tool[]
  tool_choice?: ToolChoice
  response_format?: { type: 'text' | 'json_object' | 'json_schema' }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

export interface ChatChoice {
  index: number
  message: AssistantMessage
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

export interface UsageStats {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface ChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatChoice[]
  usage: UsageStats
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface EmbeddingsRequest {
  model: string
  input: string | string[]
  encoding_format?: 'float' | 'base64'
}

export interface EmbeddingObject {
  object: 'embedding'
  index: number
  embedding: number[]
}

export interface EmbeddingsResponse {
  object: 'list'
  data: EmbeddingObject[]
  model: string
  usage: { prompt_tokens: number; total_tokens: number }
}

// ── Models ────────────────────────────────────────────────────────────────────

export interface ModelObject {
  id: string
  object: 'model'
  created?: number
  owned_by: string
}

export interface ModelsListResponse {
  object: 'list'
  data: ModelObject[]
}
