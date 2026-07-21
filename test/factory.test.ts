import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import extension from '../src/index'
import type { TamaModel } from '../src/types'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

vi.mock('../src/cache', () => ({
  readCache: vi.fn().mockResolvedValue(null),
  writeCache: vi.fn().mockResolvedValue(undefined),
  computeConfigHash: vi.fn().mockReturnValue('test-hash'),
  isCacheStale: vi.fn().mockReturnValue(false),
}))

vi.mock('../src/tama-api', () => ({
  normalizeBaseURL: vi.fn((u: string) => u || 'http://127.0.0.1:11434'),
  fetchTamaModels: vi.fn(),
  buildPiProviderConfig: vi.fn((b, m, t, s) => ({
    baseUrl: `${b}/v1`,
    api: 'openai-completions',
    apiKey: t || 'tama',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    headers: { langfuse_session_id: s },
    models: m,
  })),
  transformModel: vi.fn((m) => m),
  autoDetectTama: vi.fn(),
}))

import { readCache, writeCache, computeConfigHash, isCacheStale } from '../src/cache'
import { fetchTamaModels, autoDetectTama, normalizeBaseURL } from '../src/tama-api'

interface StubPi {
  registerProvider: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeStub(): StubPi {
  return { registerProvider: vi.fn(), on: vi.fn() }
}

describe('cache-first factory', () => {
  const savedURL = process.env.TAMA_URL
  const savedToken = process.env.TAMA_TOKEN

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    delete process.env.TAMA_URL
    delete process.env.TAMA_TOKEN
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (savedURL === undefined) delete process.env.TAMA_URL
    else process.env.TAMA_URL = savedURL
    if (savedToken === undefined) delete process.env.TAMA_TOKEN
    else process.env.TAMA_TOKEN = savedToken
  })

  it('registers with cached models immediately', async () => {
    const cachedModels: TamaModel[] = [
      { id: 'cached/model', name: 'Cached Model' },
    ]
    vi.mocked(readCache).mockResolvedValue({
      version: 1,
      configHash: 'test-hash',
      lastFetchedMs: Date.now() - 1000,
      baseURL: 'http://127.0.0.1:9999',
      models: cachedModels,
    })
    vi.mocked(isCacheStale).mockReturnValue(false)

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const [name, config] = pi.registerProvider.mock.calls[0]!
    expect(name).toBe('tama')
    expect(config.models).toBe(cachedModels)
    expect(fetchTamaModels).not.toHaveBeenCalled()
  })

  it('registers empty provider when no cache but TAMA_URL set', async () => {
    process.env.TAMA_URL = 'http://explicit.example:1234'
    vi.mocked(readCache).mockResolvedValue(null)

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const [name, config] = pi.registerProvider.mock.calls[0]!
    expect(name).toBe('tama')
    expect(config.models).toEqual([])
    expect(config.baseUrl).toBe('http://explicit.example:1234/v1')
  })

  it('subscribes to session_start', async () => {
    vi.mocked(readCache).mockResolvedValue(null)

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('background update re-registers only on model changes', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(readCache).mockResolvedValue(null)

    const pi = makeStub()
    await extension(pi as never)

    // First session_start: different models
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'new/model', name: 'New Model' },
    ])
    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2) // initial + 1 update

    // Second session_start: same model IDs — should NOT re-register
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'new/model', name: 'New Model' },
    ])
    await (handler as (event: { reason?: string }) => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2) // still 2
  })

  it('background update auto-detects Tama when no explicit URL', async () => {
    vi.mocked(readCache).mockResolvedValue(null)
    vi.mocked(autoDetectTama).mockResolvedValue('http://detected.example:8080')
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'detected/model', name: 'Detected Model' },
    ])

    const pi = makeStub()
    await extension(pi as never)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    expect(autoDetectTama).toHaveBeenCalled()
    expect(pi.registerProvider).toHaveBeenCalledTimes(1) // only background update (no initial since no cache + no URL)
    const [name, config] = pi.registerProvider.mock.calls[0]!
    expect(config.baseUrl).toBe('http://detected.example:8080/v1')
  })

  it('background update errors do not crash', async () => {
    process.env.TAMA_URL = 'http://error.example:9999'
    vi.mocked(readCache).mockResolvedValue(null)
    vi.mocked(fetchTamaModels).mockRejectedValue(new Error('network fail'))

    const pi = makeStub()
    await extension(pi as never)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    // Should not have thrown; registerProvider was called once (initial empty)
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
  })

  it('reload reason skips the 2s delay', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(readCache).mockResolvedValue(null)
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'reload/model', name: 'Reload Model' },
    ])

    const pi = makeStub()
    await extension(pi as never)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
    // With reload, delay is 0 — should run immediately at 1ms
    await vi.advanceTimersByTimeAsync(1)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2)
  })
})
