import type { TamaModel, TamaModelsResponse, PiModel, PiProviderConfig, PiCompat } from './types'

const DEFAULT_TAMA_URL = 'http://127.0.0.1:11434'
const TAMA_MODELS_ENDPOINT = '/v1/opencode/models'

const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_TOKENS = 8192

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

  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: false,
    input,
    contextWindow,
    maxTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    compat: { ...DEFAULT_COMPAT, ...backendCompat },
    provider: 'tama',
    api: 'openai-completions',
    ...(baseUrl ? { baseUrl } : {}),
  }
}

/** Transform all tama models into a complete pi provider config. */
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

/**
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

/**
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
