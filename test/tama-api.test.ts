import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizeBaseURL,
  buildAPIURL,
  transformModel,
  buildPiProviderConfig,
  checkTamaHealth,
  fetchTamaModels,
  autoDetectTama,
  discoverTamaForPi,
  resolveAndFetch,
} from '../src/tama-api'
import type { TamaModel } from '../src/types'

// ---------- Pure function tests (no network) ----------

describe('normalizeBaseURL', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseURL('http://localhost:11434/')).toBe('http://localhost:11434')
    expect(normalizeBaseURL('http://localhost:11434///')).toBe('http://localhost:11434')
  })

  it('strips /v1 suffix', () => {
    expect(normalizeBaseURL('http://localhost:11434/v1')).toBe('http://localhost:11434')
  })

  it('strips trailing slash then /v1', () => {
    expect(normalizeBaseURL('http://localhost:11434/v1/')).toBe('http://localhost:11434')
  })

  it('returns unchanged URL when no suffix', () => {
    expect(normalizeBaseURL('http://localhost:11434')).toBe('http://localhost:11434')
  })

  it('uses default when no argument', () => {
    expect(normalizeBaseURL()).toBe('http://127.0.0.1:11434')
  })
})

describe('buildAPIURL', () => {
  it('builds the default opencode models URL', () => {
    expect(buildAPIURL('http://localhost:11434')).toBe(
      'http://localhost:11434/v1/opencode/models'
    )
  })

  it('normalizes before building', () => {
    expect(buildAPIURL('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/opencode/models'
    )
  })

  it('accepts a custom endpoint', () => {
    expect(buildAPIURL('http://localhost:11434', '/health')).toBe(
      'http://localhost:11434/health'
    )
  })
})

describe('transformModel', () => {
  const baseModel: TamaModel = {
    id: 'unsloth/qwen3.5-35b-a3b-gguf',
    name: 'Unsloth: Qwen3.5 35B A3B',
  }

  it('transforms a minimal model', () => {
    const result = transformModel(baseModel)
    expect(result).toEqual({
      id: 'unsloth/qwen3.5-35b-a3b-gguf',
      name: 'Unsloth: Qwen3.5 35B A3B',
      reasoning: false,
      input: ['text'],
      contextWindow: 128000,
      maxTokens: 8000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('uses context_length when provided', () => {
    const model: TamaModel = { ...baseModel, context_length: 262144 }
    const result = transformModel(model)
    expect(result.contextWindow).toBe(262144)
    expect(result.maxTokens).toBe(Math.floor(262144 / 16))
  })

  it('uses limit.context when context_length is null', () => {
    const model: TamaModel = {
      ...baseModel,
      context_length: null,
      limit: { context: 65536, output: 4096 },
    }
    const result = transformModel(model)
    expect(result.contextWindow).toBe(65536)
    expect(result.maxTokens).toBe(4096)
  })

  it('prefers limit.output over computed maxTokens', () => {
    const model: TamaModel = {
      ...baseModel,
      context_length: 131072,
      limit: { context: 131072, output: 16384 },
    }
    const result = transformModel(model)
    expect(result.maxTokens).toBe(16384)
  })

  it('maps modalities', () => {
    const model: TamaModel = {
      ...baseModel,
      modalities: { input: ['text', 'image'], output: ['text'] },
    }
    const result = transformModel(model)
    expect(result.input).toEqual(['text', 'image'])
  })

  it('defaults to ["text"] when modalities are absent', () => {
    const result = transformModel(baseModel)
    expect(result.input).toEqual(['text'])
  })

  it('falls back to id when name is empty', () => {
    const model: TamaModel = { id: 'test/model', name: '' }
    const result = transformModel(model)
    expect(result.name).toBe('test/model')
  })

  it('always sets reasoning to false', () => {
    const result = transformModel(baseModel)
    expect(result.reasoning).toBe(false)
  })

  it('always sets cost to zero', () => {
    const result = transformModel(baseModel)
    expect(result.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('buildPiProviderConfig', () => {
  const models: TamaModel[] = [
    {
      id: 'unsloth/qwen3.5-35b-a3b-gguf',
      name: 'Unsloth: Qwen3.5 35B A3B',
      context_length: 262144,
    },
    {
      id: 'mudler/deltacoder-9b-gguf',
      name: 'Mudler: Deltacoder 9B',
      context_length: 131072,
      modalities: { input: ['text', 'image'], output: ['text'] },
    },
  ]

  it('builds a complete pi provider config', () => {
    const config = buildPiProviderConfig('http://127.0.0.1:11434', models)

    expect(config.baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(config.api).toBe('openai-completions')
    expect(config.apiKey).toBe('tama')
    expect(config.models).toHaveLength(2)
    expect(config.models[0]!.id).toBe('unsloth/qwen3.5-35b-a3b-gguf')
    expect(config.models[1]!.input).toEqual(['text', 'image'])
  })

  it('uses provided token as apiKey', () => {
    const config = buildPiProviderConfig('http://127.0.0.1:11434', models, 'secret-token')
    expect(config.apiKey).toBe('secret-token')
  })

  it('normalizes the base URL before appending /v1', () => {
    const config = buildPiProviderConfig('http://localhost:11434/v1/', models)
    expect(config.baseUrl).toBe('http://localhost:11434/v1')
  })
})

// ---------- Network tests (mocked fetch) ----------

describe('checkTamaHealth', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true when tama responds 200', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('OK', { status: 200 }))
    expect(await checkTamaHealth('http://localhost:11434')).toBe(true)
  })

  it('returns false when tama responds 500', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Error', { status: 500 }))
    expect(await checkTamaHealth('http://localhost:11434')).toBe(false)
  }, 10000)

  it('returns false when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Connection refused'))
    expect(await checkTamaHealth('http://localhost:11434')).toBe(false)
  }, 10000)
})

describe('fetchTamaModels', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns models on success', async () => {
    const body: { models: TamaModel[] } = {
      models: [
        { id: 'test/model', name: 'Test Model', context_length: 8192 },
      ],
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const models = await fetchTamaModels('http://localhost:11434')
    expect(models).toHaveLength(1)
    expect(models[0]!.id).toBe('test/model')
  })

  it('sends Authorization: Bearer header when token provided', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await fetchTamaModels('http://localhost:11434', 'secret-token')

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret-token')
  })

  it('does not send Authorization header when no token', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await fetchTamaModels('http://localhost:11434')

    const [, init] = vi.mocked(fetch).mock.calls[0]!
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  it('returns empty array on 401 (auth rejected)', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const models = await fetchTamaModels('http://localhost:11434', 'wrong-token')
    expect(models).toEqual([])
  })

  it('returns empty array on non-200', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('Not Found', { status: 404 }))
    const models = await fetchTamaModels('http://localhost:11434')
    expect(models).toEqual([])
  })

  it('returns empty array on fetch error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('timeout'))
    const models = await fetchTamaModels('http://localhost:11434')
    expect(models).toEqual([])
  })

  it('returns empty array when response has no models key', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    const models = await fetchTamaModels('http://localhost:11434')
    expect(models).toEqual([])
  })
})

describe('autoDetectTama', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns first healthy port', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('OK', { status: 200 }))
    const url = await autoDetectTama()
    expect(url).toBe('http://127.0.0.1:11434')
  })

  it('tries port 8080 when 11434 is down', async () => {
    // Port 11434: 4 rejections (initial + 3 retries)
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'))
      .mockRejectedValueOnce(new Error('refused'))
      // Port 8080: succeeds on first try
      .mockResolvedValueOnce(new Response('OK', { status: 200 }))

    const url = await autoDetectTama()
    expect(url).toBe('http://127.0.0.1:8080')
  }, 10000)

  it('returns null when no ports respond', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('refused'))
    const url = await autoDetectTama()
    expect(url).toBeNull()
  }, 30000)
})

describe('discoverTamaForPi', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns full pi config on successful discovery', async () => {
    const body = {
      models: [
        {
          id: 'unsloth/qwen3.5-35b-a3b-gguf',
          name: 'Unsloth: Qwen3.5 35B A3B',
          context_length: 262144,
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
      ],
    }

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const config = await discoverTamaForPi('http://localhost:11434')
    expect(config).not.toBeNull()
    expect(config!.baseUrl).toBe('http://localhost:11434/v1')
    expect(config!.models).toHaveLength(1)
    expect(config!.models[0]!.id).toBe('unsloth/qwen3.5-35b-a3b-gguf')
    expect(config!.models[0]!.input).toEqual(['text', 'image'])
    expect(config!.models[0]!.contextWindow).toBe(262144)
  })

  it('returns null when tama is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('refused'))
    const config = await discoverTamaForPi('http://localhost:11434')
    expect(config).toBeNull()
  }, 20000)

  it('returns null when no models are available', async () => {
    vi.mocked(fetch)
      // Health check succeeds
      .mockResolvedValueOnce(new Response('OK', { status: 200 }))
      // But models endpoint returns empty
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )

    const config = await discoverTamaForPi('http://localhost:11434')
    expect(config).toBeNull()
  })

  it('auto-detects when no URL is provided', async () => {
    const body = {
      models: [{ id: 'test/model', name: 'Test', context_length: 8192 }],
    }

    // Auto-detect health check on port 11434
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const config = await discoverTamaForPi()
    expect(config).not.toBeNull()
    expect(config!.baseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('resolveAndFetch returns baseURL plus raw models on success', async () => {
    const body = {
      models: [{ id: 'test/model', name: 'Test', context_length: 8192 }],
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const result = await resolveAndFetch('http://localhost:11434', 'tok')
    expect(result).not.toBeNull()
    expect(result!.baseURL).toBe('http://localhost:11434')
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.id).toBe('test/model')
  })

  it('resolveAndFetch returns null when tama is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('refused'))
    expect(await resolveAndFetch('http://localhost:11434')).toBeNull()
  }, 10000)

  it('threads token through to provider config and fetch calls', async () => {
    const body = {
      models: [{ id: 'test/model', name: 'Test', context_length: 8192 }],
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const config = await discoverTamaForPi('http://remote.example:11434', 'test-token')
    expect(config).not.toBeNull()
    expect(config!.apiKey).toBe('test-token')

    // Every fetch (health check + models) should have sent the bearer token
    for (const call of vi.mocked(fetch).mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-token')
    }
  })

  // ---- Langfuse session header ----

  it('buildPiProviderConfig sets langfuse_session_id when sessionId provided', () => {
    const config = buildPiProviderConfig(
      'http://127.0.0.1:11434',
      [{ id: 'test/model', name: 'Test', context_length: 8192 }],
      undefined,
      'my-session-uuid'
    )
    expect(config.headers).toEqual({ langfuse_session_id: 'my-session-uuid' })
  })

  it('buildPiProviderConfig omits headers when no sessionId', () => {
    const config = buildPiProviderConfig('http://127.0.0.1:11434', [
      { id: 'test/model', name: 'Test', context_length: 8192 },
    ])
    expect(config.headers).toBeUndefined()
  })

  it('buildPiProviderConfig threads sessionId alongside token', () => {
    const config = buildPiProviderConfig(
      'http://127.0.0.1:11434',
      [{ id: 'test/model', name: 'Test', context_length: 8192 }],
      'tok',
      'session-123'
    )
    expect(config.apiKey).toBe('tok')
    expect(config.headers).toEqual({ langfuse_session_id: 'session-123' })
  })

  it('discoverTamaForPi passes sessionId through to config', async () => {
    const body = {
      models: [{ id: 'test/model', name: 'Test', context_length: 8192 }],
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const config = await discoverTamaForPi('http://localhost:11434', undefined, 'sess-abc')
    expect(config).not.toBeNull()
    expect(config!.headers).toEqual({ langfuse_session_id: 'sess-abc' })
  })

  it('discoverTamaForPi produces config without headers when no sessionId', async () => {
    const body = {
      models: [{ id: 'test/model', name: 'Test', context_length: 8192 }],
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const config = await discoverTamaForPi('http://localhost:11434')
    expect(config).not.toBeNull()
    expect(config!.headers).toBeUndefined()
  })
})
