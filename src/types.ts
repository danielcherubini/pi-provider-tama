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
  compat: {
    supportsDeveloperRole: boolean
    supportsReasoningEffort: boolean
  }
  models: PiModel[]
}
