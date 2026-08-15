import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('../src/tama-api', () => ({
  normalizeBaseURL: vi.fn((u) => u || 'http://127.0.0.1:11434'),
  fetchTamaModels: vi.fn(),
  transformModel: vi.fn((m) => m),
  autoDetectTama: vi.fn(),
}))

vi.mock('@earendil-works/pi-ai', () => ({
  createProvider: vi.fn((opts) => ({
    id: opts.id,
    name: opts.name,
    baseUrl: opts.baseUrl,
    headers: opts.headers,
    auth: opts.auth,
    fetchModels: opts.fetchModels,
    getModels: () => opts.models,
  })),
}))

vi.mock('@earendil-works/pi-ai/compat', () => ({
  openAICompletionsApi: vi.fn(() => ({ streamSimple: vi.fn() })),
}))

import extension from '../src/index'
import { fetchTamaModels } from '../src/tama-api'

// Minimal stub of the pi ExtensionAPI surface that the extension touches.
interface StubPi {
  registerProvider: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeStub(): StubPi {
  return { registerProvider: vi.fn(), on: vi.fn() }
}

function mockTamaResponse(models: Array<{ id: string; name: string }>) {
  vi.mocked(fetchTamaModels).mockResolvedValue(models as never)
}

describe('default extension factory', () => {
  const savedURL = process.env.TAMA_URL
  const savedToken = process.env.TAMA_TOKEN

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
    delete process.env.TAMA_URL
    delete process.env.TAMA_TOKEN
    // Default mock so factory doesn't throw
    vi.mocked(fetchTamaModels).mockResolvedValue([])
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (savedURL === undefined) delete process.env.TAMA_URL
    else process.env.TAMA_URL = savedURL
    if (savedToken === undefined) delete process.env.TAMA_TOKEN
    else process.env.TAMA_TOKEN = savedToken
  })

  it('is an async factory', () => {
    expect(extension.constructor.name).toBe('AsyncFunction')
  })

  it('registers with empty models when fetch returns none', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.id).toBe('tama')
    expect(provider.getModels().length).toBe(0)
  })

  it('subscribes to session_start for reload refresh', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('registers with empty models when Tama unreachable', async () => {
    process.env.TAMA_URL = 'http://unreachable.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.getModels().length).toBe(0)
    expect(provider.baseUrl).toBe('http://unreachable.example:11434/v1')
    // session_start should still be wired so /reload can retry.
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('re-registers on reload with fresh models', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'
    // Initial fetch returns empty
    vi.mocked(fetchTamaModels).mockResolvedValue([])

    const pi = makeStub()
    await extension(pi as never)

    // Initial registration (empty models)
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)

    // Reload fetch returns new models
    mockTamaResponse([
      { id: 'test/model', name: 'Test' },
      { id: 'new/added-model', name: 'Added' },
    ])
    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
    await vi.advanceTimersByTimeAsync(1)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2)
    const provider = pi.registerProvider.mock.calls[1]![0]
    expect(provider.getModels()).toHaveLength(2)
  })

  it('does not set a provider-level session header (session grouping is per-model compat)', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    // pi ignores provider-level headers, and the old langfuse_session_id header
    // never worked. Session grouping now comes from the per-model compat flag set
    // by transformModel (covered in tama-api.test.ts), so no provider headers here.
    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.headers).toBeUndefined()
  })
})
