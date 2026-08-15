import type { ThinkingLevelMap } from '@earendil-works/pi-ai'

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
  /** Whether the model supports reasoning (thinking). Absent/undefined = false. */
  reasoning?: boolean
  /** Named reasoning-effort overlays. Names are expected from pi's thinking-level vocabulary. */
  variants?: string[]
  /** Whether the model accepts reasoning-effort control. camelCase, as emitted by tama's /v1/opencode/models. Absent/undefined = false. */
  supportsReasoningEffort?: boolean
  /**
   * Editor-configured reasoning levels, in pi's 7-level vocabulary
   * (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). camelCase,
   * as emitted by tama's /v1/opencode/models. Absent when the model has no levels.
   */
  reasoningLevels?: string[]
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
  thinkingLevelMap?: ThinkingLevelMap
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

/** Pi provider configuration passed to pi.registerProvider(). */
export interface PiProviderConfig {
  baseUrl: string
  api: string
  apiKey: string
  models: PiModel[]
}
