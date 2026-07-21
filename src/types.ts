/** Model as returned by tama's /v1/opencode/models endpoint. */
export interface TamaModel {
  id: string
  name: string
  model?: string
  backend?: string
  context_length?: number | null
  limit?: {
    context: number | null
    output: number | null
  }
  modalities?: {
    input: string[]
    output: string[]
  }
  quant?: string
  gpu_layers?: number
}

/** Response from tama's /v1/opencode/models endpoint. */
export interface TamaModelsResponse {
  models: TamaModel[]
}


/** Per-model compatibility flags for upstream backend quirks. */
export interface PiCompat {
  supportsDeveloperRole?: boolean
  supportsReasoningEffort?: boolean
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  requiresToolResultName?: boolean
}

/** A model in pi's provider format. */
export interface PiModel {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  contextWindow: number
  maxTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  compat?: PiCompat
  provider: 'tama'
  api: 'openai-completions'
  baseUrl?: string
}

/** Cache file structure for model persistence. */
export interface TamaCacheFile {
  version: number
  configHash: string
  lastFetchedMs: number
  baseURL: string
  models: TamaModel[]
}

/** Pi provider configuration passed to pi.registerProvider(). */
export interface PiProviderConfig {
  baseUrl: string
  api: string
  apiKey: string
  models: PiModel[]
}
