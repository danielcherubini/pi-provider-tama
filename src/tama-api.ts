import type { TamaModel, TamaModelsResponse, PiModel, PiProviderConfig, PiCompat } from './types'
import type { ThinkingLevelMap } from '@earendil-works/pi-ai'

const DEFAULT_TAMA_URL = 'http://127.0.0.1:11434'
const TAMA_MODELS_ENDPOINT = '/v1/opencode/models'

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 8192

/** pi thinking levels that are offered by default and must be explicitly nulled to hide. */
const STANDARD_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
/** pi thinking levels that require an explicit string entry to be offered at all. */
const EXTENDED_LEVELS = ['xhigh', 'max'] as const
const KNOWN_LEVELS: readonly string[] = [...STANDARD_LEVELS, ...EXTENDED_LEVELS]

/** pi's full thinking-level vocabulary, including `off`. */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Backend-specific compatibility overrides. */
const BACKEND_COMPAT: Record<string, PiCompat> = {
  'llama.cpp': {
    maxTokensField: 'max_tokens',
    requiresToolResultName: false,
  },
  onnx: {
    maxTokensField: 'max_tokens',
  },
}

/** Default compatibility when no backend-specific override applies. */
const DEFAULT_COMPAT: PiCompat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
}

/** Normalize a base URL by stripping trailing slashes and /v1 suffix. */
export function normalizeBaseURL(baseURL: string = DEFAULT_TAMA_URL): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

/** Build a full URL from base + endpoint. */
export function buildAPIURL(baseURL: string, endpoint: string = TAMA_MODELS_ENDPOINT): string {
  const normalized = normalizeBaseURL(baseURL)
  return `${normalized}${endpoint}`
}

/** Build Authorization header when a token is provided. */
export function buildAuthHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** Delay for the given milliseconds. Exported for test mocking. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** HTTP statuses worth retrying (transient failures). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Check if tama is reachable at the given base URL, with retries on transient failures. */
export async function checkTamaHealth(
  baseURL: string = DEFAULT_TAMA_URL,
  token?: string,
  maxRetries: number = 3
): Promise<boolean> {
  const url = buildAPIURL(baseURL, TAMA_MODELS_ENDPOINT)

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: buildAuthHeaders(token),
        signal: AbortSignal.timeout(3000),
      })

      if (response.ok) {
        return true
      }

      // 401/403 won't resolve on retry; other 4xx are client errors
      if (response.status < 500 && response.status !== 429) {
        return false
      }

      // Retry 5xx and 429 if we have attempts left
      if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) {
        return false
      }
    } catch {
      // Network errors, timeouts — always transient. Bail if out of attempts.
      if (attempt === maxRetries) {
        return false
      }
    }

    const backoff = Math.min(1000 * 2 ** attempt, 8000)
    await delay(backoff)
  }

  return false
}

/** Auto-detect tama on common ports. Returns the base URL or null. */
export async function autoDetectTama(token?: string): Promise<string | null> {
  const ports = [11434, 8080]
  for (const port of ports) {
    const baseURL = `http://127.0.0.1:${port}`
    const isHealthy = await checkTamaHealth(baseURL, token)
    if (isHealthy) {
      return baseURL
    }
  }
  return null
}

/** Fetch raw model list from tama's opencode endpoint. */
export async function fetchTamaModels(baseURL: string = DEFAULT_TAMA_URL, token?: string): Promise<TamaModel[]> {
  try {
    const url = buildAPIURL(baseURL, TAMA_MODELS_ENDPOINT)
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...buildAuthHeaders(token) },
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        console.warn(`[pi-provider-tama] Tama rejected auth (${response.status}) — check TAMA_TOKEN`)
      } else {
        console.warn(`[pi-provider-tama] Tama returned ${response.status}: ${response.statusText}`)
      }
      return []
    }

    const data = (await response.json()) as TamaModelsResponse
    return data.models ?? []
  } catch (error) {
    console.warn(
      `[pi-provider-tama] Failed to fetch models: ${error instanceof Error ? error.message : String(error)}`
    )
    return []
  }
}

/**
 * Map tama's `variants` (named reasoning-effort overlays) to pi's thinkingLevelMap.
 *
 * Rules:
 * - standard levels (minimal/low/medium/high) absent from variants → `null` (hidden)
 * - standard levels present in variants → omitted (pi default sends the level name)
 * - extended levels (xhigh/max) present in variants → explicit string value
 * - extended levels absent → omitted (unsupported)
 * - unknown names are ignored by the caller (which logs a warning)
 * - undefined/empty input, or no recognizable names → undefined (no map)
 */
export function buildThinkingLevelMap(variants?: string[]): ThinkingLevelMap | undefined {
  if (!variants || variants.length === 0) return undefined
  const known = new Set(variants.filter((v) => KNOWN_LEVELS.includes(v)))
  if (known.size === 0) return undefined

  const map: ThinkingLevelMap = {}
  for (const level of STANDARD_LEVELS) {
    if (!known.has(level)) map[level] = null
  }
  for (const level of EXTENDED_LEVELS) {
    if (known.has(level)) map[level] = level
  }
  return Object.keys(map).length > 0 ? map : undefined
}

/**
 * Build pi's thinkingLevelMap from tama's editor-configured reasoningLevels.
 * - each pi level in the list → itself, EXCEPT "off" → "none"
 *   (tama repo ADR-0009: no backend accepts "off" as reasoning_effort)
 * - each pi level NOT in the list → null (explicit hole — absent keys would mean "supported" in pi)
 * - levels outside pi's vocabulary are dropped (tama validates server-side; this is defensive)
 * - absent/empty input, or no recognizable names → undefined (pi defaults apply)
 */
export function buildThinkingLevelMapFromLevels(levels?: string[]): ThinkingLevelMap | undefined {
  if (!levels || levels.length === 0) return undefined
  // Intentionally silent (unlike the variants path): tama validates these names server-side,
  // so no warning here.
  const known = new Set(
    levels.filter((l) => (PI_THINKING_LEVELS as readonly string[]).includes(l))
  )
  if (known.size === 0) return undefined

  const map: ThinkingLevelMap = {}
  for (const level of PI_THINKING_LEVELS) {
    if (!known.has(level)) {
      map[level] = null
    } else if (level === 'off') {
      map[level] = 'none'
    } else {
      map[level] = level
    }
  }
  return map
}

/** Transform a single tama model into pi's model format. */
export function transformModel(model: TamaModel): PiModel
export function transformModel(model: TamaModel, baseUrl: string): PiModel & { baseUrl: string }
export function transformModel(model: TamaModel, baseUrl?: string): PiModel {
  const contextWindow = model.context_length ?? model.limit?.context ?? DEFAULT_CONTEXT_WINDOW
  // Use || (not ??) so that 0 also falls through to the computed default.
  // Some providers set limit.output = 0 meaning "no explicit limit", which would
  // otherwise give pi an auto-compact threshold of contextWindow - 0 = contextWindow
  // (i.e. never compact).  contextWindow/16 is the reservation heuristic (~6%).
  const maxTokens = model.limit?.output || (Math.floor(contextWindow / 16) || DEFAULT_MAX_TOKENS)

  // Map modalities: tama uses ["text", "image"], pi uses the same format
  const validInputTypes = new Set(['text', 'image'])
  const input: ('text' | 'image')[] = model.modalities?.input?.length
    ? (model.modalities.input.filter((m) => validInputTypes.has(m)) as ('text' | 'image')[])
    : ['text']

  const backendCompat = model.backend ? BACKEND_COMPAT[model.backend] : undefined

  // Reasoning: editor-configured levels (tama plan-189) are the authoritative
  // source and take priority; otherwise the legacy variants path (plan-004)
  // runs unchanged. An all-out-of-vocabulary list yields no usable map and
  // likewise falls back to the legacy path (reasoning then comes from
  // model.reasoning alone). pi sends reasoning_effort only when model.reasoning &&
  // compat.supportsReasoningEffort.
  const hasLevels =
    (model.supportsReasoningEffort ?? false) && (model.reasoningLevels?.length ?? 0) > 0
  const levelsMap = hasLevels ? buildThinkingLevelMapFromLevels(model.reasoningLevels) : undefined
  const isReasoning = levelsMap !== undefined || model.reasoning === true
  if (isReasoning) {
    for (const variant of model.variants ?? []) {
      if (!KNOWN_LEVELS.includes(variant)) {
        console.warn(
          `[pi-provider-tama] Model ${model.id}: unrecognized reasoning variant "${variant}" — ignored`
        )
      }
    }
  }
  const thinkingLevelMap = levelsMap ?? (isReasoning ? buildThinkingLevelMap(model.variants) : undefined)

  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: isReasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input,
    contextWindow,
    maxTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: { ...DEFAULT_COMPAT, ...backendCompat, ...(isReasoning ? { supportsReasoningEffort: true } : {}) },
    provider: 'tama',
    api: 'openai-completions',
    ...(baseUrl ? { baseUrl } : {}),
  }
}

/** @deprecated Use `buildProvider()` in src/index.ts with createProvider() instead. Kept for backward compatibility. */
export function buildPiProviderConfig(
  baseURL: string,
  tamaModels: TamaModel[],
  token?: string,
  sessionId?: string
): PiProviderConfig {
  const normalized = normalizeBaseURL(baseURL)

  // Build Langfuse session header. Tama forwards langfuse_session_id to Langfuse
  // so all requests in one pi session group into a single trace session.
  // One session ID per /reload — a new pi session gets a new group of traces.
  return {
    baseUrl: `${normalized}/v1`,
    api: 'openai-completions',
    apiKey: token || 'tama',
    ...(sessionId ? { headers: { langfuse_session_id: sessionId } } : {}),
    models: tamaModels.map(m => transformModel(m)),
  }
}

/** @deprecated Use `buildProvider()` in src/index.ts with createProvider() instead. Kept for backward compatibility.
 * Resolve a tama base URL (explicit or auto-detected) and fetch its model list.
 * Returns the baseURL and raw models, or null on failure.
 */
export async function resolveAndFetch(
  tamaURL?: string,
  token?: string
): Promise<{ baseURL: string; models: TamaModel[] } | null> {
  let baseURL: string

  if (tamaURL) {
    baseURL = normalizeBaseURL(tamaURL)
    const isHealthy = await checkTamaHealth(baseURL, token)
    if (!isHealthy) {
      console.warn(`[pi-provider-tama] Tama not reachable at ${baseURL}`)
      return null
    }
  } else {
    const detected = await autoDetectTama(token)
    if (!detected) {
      console.log('[pi-provider-tama] Tama not detected on default ports (11434, 8080)')
      return null
    }
    baseURL = detected
  }

  const models = await fetchTamaModels(baseURL, token)
  if (models.length === 0) {
    console.warn('[pi-provider-tama] No models discovered — ensure tama serve is running')
    return null
  }

  return { baseURL, models }
}

/** @deprecated Use `buildProvider()` in src/index.ts with createProvider() instead. Kept for backward compatibility.
 * Full discovery flow: detect tama, fetch models, return pi provider config.
 * Returns null when tama is not reachable or has no models.
 *
 * `sessionId` (a UUID) is injected as the `langfuse_session_id` header on all
 * requests so tama can group traces into a single Langfuse session. One ID
 * per pi session — a new UUID is generated on each call (e.g., on /reload).
 */
export async function discoverTamaForPi(
  tamaURL?: string,
  token?: string,
  sessionId?: string
): Promise<PiProviderConfig | null> {
  const data = await resolveAndFetch(tamaURL, token)
  if (!data) return null
  return buildPiProviderConfig(data.baseURL, data.models, token, sessionId)
}
