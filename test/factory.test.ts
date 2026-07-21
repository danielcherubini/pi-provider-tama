import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import extension from '../src/index'
import type { TamaModel } from '../src/types'

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

import { normalizeBaseURL, fetchTamaModels, autoDetectTama } from '../src/tama-api'

interface StubPi {
  registerProvider: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeStub(): StubPi {
  return { registerProvider: vi.fn(), on: vi.fn() }
}

describe('fetch-in-factory', () => {
  const savedURL = process.env.TAMA_URL
  const savedToken = process.env.TAMA_TOKEN

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    delete process.env.TAMA_URL
    delete process.env.TAMA_TOKEN
    // Default mocks so factory doesn't throw
    vi.mocked(fetchTamaModels).mockResolvedValue([])
    vi.mocked(autoDetectTama).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (savedURL === undefined) delete process.env.TAMA_URL
    else process.env.TAMA_URL = savedURL
    if (savedToken === undefined) delete process.env.TAMA_TOKEN
    else process.env.TAMA_TOKEN = savedToken
  })

  it('fetches models on startup and registers provider', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'model/one', name: 'Model One' },
    ])

    const pi = makeStub()
    await extension(pi as never)

    expect(fetchTamaModels).toHaveBeenCalledWith('http://test.example:5678', undefined)
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
  })

  it('skips registration when no tama detected', async () => {
    // No TAMA_URL, autoDetectTama returns null (default mock)
    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).not.toHaveBeenCalled()
  })

  it('auto-detects tama when no explicit URL', async () => {
    vi.mocked(autoDetectTama).mockResolvedValue('http://detected.example:8080')
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'detected/model', name: 'Detected Model' },
    ])

    const pi = makeStub()
    await extension(pi as never)

    expect(autoDetectTama).toHaveBeenCalled()
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.baseUrl).toBe('http://detected.example:8080/v1')
  })

  it('registers empty provider when fetch returns no models', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([])

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.getModels()).toEqual([])
  })

  it('subscribes to session_start', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('reload triggers background refresh with fresh models', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([]) // initial fetch returns empty

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)

    // Now simulate reload with new models
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'new/model', name: 'New Model' },
    ])
    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
    await vi.advanceTimersByTimeAsync(1)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2)
  })

  it('non-reload session_start is a no-op', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    const callCountBefore = 1 // initial registration

    const pi = makeStub()
    await extension(pi as never)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'new' })
    await vi.advanceTimersByTimeAsync(100)

    expect(pi.registerProvider).toHaveBeenCalledTimes(callCountBefore) // no additional registration
  })

  it('module state resets between factory runs', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'model/one', name: 'Model One' },
    ])

    const pi1 = makeStub()
    await extension(pi1 as never)

    // Second factory run (simulates reload)
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'model/two', name: 'Model Two' },
    ])
    const pi2 = makeStub()
    await extension(pi2 as never)

    // Both should have registered independently (state was reset)
    expect(pi1.registerProvider).toHaveBeenCalledTimes(1)
    expect(pi2.registerProvider).toHaveBeenCalledTimes(1)
  })

  it('background refresh errors do not crash', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([])

    const pi = makeStub()
    await extension(pi as never)

    // Simulate fetch failure on reload
    vi.mocked(fetchTamaModels).mockRejectedValue(new Error('network fail'))
    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
    await vi.advanceTimersByTimeAsync(1)

    // Should not have thrown; only initial registration
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
  })

  it('background refresh skips when models unchanged', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([
      { id: 'model/one', name: 'Model One' },
    ])

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)

    // Reload with same models — should not re-register
    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
    await vi.advanceTimersByTimeAsync(1)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1) // still 1, no re-registration
  })

  it('passes fetchModels callback to createProvider for pi persistence', async () => {
    process.env.TAMA_URL = 'http://test.example:5678'
    vi.mocked(fetchTamaModels).mockResolvedValue([])

    const pi = makeStub()
    await extension(pi as never)

    const provider = pi.registerProvider.mock.calls[0]![0]
    expect(provider.fetchModels).toBeDefined()
    expect(typeof provider.fetchModels).toBe('function')
  })
})
