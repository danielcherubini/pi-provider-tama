import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

import extension from '../src/index'
import type { TamaModel } from '../src/types'

// Minimal stub of the pi ExtensionAPI surface that the extension touches.
interface StubPi {
  registerProvider: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function makeStub(): StubPi {
  return { registerProvider: vi.fn(), on: vi.fn() }
}

function mockTamaResponse(models: TamaModel[]) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

describe('default extension factory', () => {
  const savedURL = process.env.TAMA_URL
  const savedToken = process.env.TAMA_TOKEN

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn())
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

  it('is an async factory', () => {
    expect(extension.constructor.name).toBe('AsyncFunction')
  })

  it('registers with empty models on cold start when no cache', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const [name, config] = pi.registerProvider.mock.calls[0]!
    expect(name).toBe('tama')
    expect(config.models.length).toBe(0)
  })

  it('subscribes to session_start for mid-session refresh', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('forwards TAMA_TOKEN as Bearer header and as provider apiKey', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'
    process.env.TAMA_TOKEN = 'env-token'

    const pi = makeStub()
    await extension(pi as never)

    const [, config] = pi.registerProvider.mock.calls[0]!
    expect(config.apiKey).toBe('env-token')
  })

  it('registers with empty models when no cache and Tama unreachable', async () => {
    process.env.TAMA_URL = 'http://unreachable.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    expect(pi.registerProvider).toHaveBeenCalledTimes(1)
    const [, config] = pi.registerProvider.mock.calls[0]!
    expect(config.models.length).toBe(0)
    expect(config.baseUrl).toBe('http://unreachable.example:11434/v1')
    // session_start should still be wired so /reload can retry.
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function))
  })

  it('re-registers on session_start with current models', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    // Initial registration (empty models)
    expect(pi.registerProvider).toHaveBeenCalledTimes(1)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    mockTamaResponse([
      { id: 'test/model', name: 'Test', context_length: 8192 },
      { id: 'new/added-model', name: 'Added', context_length: 32768 },
    ])
    await (handler as () => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    expect(pi.registerProvider).toHaveBeenCalledTimes(2)
    const [, refreshed] = pi.registerProvider.mock.calls[1]!
    expect(refreshed.models).toHaveLength(2)
  })

  it('injects a langfuse_session_id header on the registered provider', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'

    const pi = makeStub()
    await extension(pi as never)

    const [, config] = pi.registerProvider.mock.calls[0]!
    expect(config.headers).toBeDefined()
    expect(config.headers!.langfuse_session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('generates a fresh session ID on each registration cycle (initial + reload)', async () => {
    process.env.TAMA_URL = 'http://remote.example:11434'
    mockTamaResponse([{ id: 'test/model', name: 'Test', context_length: 8192 }])

    const pi = makeStub()
    await extension(pi as never)

    const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
    await (handler as () => Promise<void>)({})
    await vi.advanceTimersByTimeAsync(2001)

    const firstId = pi.registerProvider.mock.calls[0]![1].headers!.langfuse_session_id
    const secondId = pi.registerProvider.mock.calls[1]![1].headers!.langfuse_session_id
    expect(firstId).toBeDefined()
    expect(secondId).toBeDefined()
    expect(firstId).not.toBe(secondId)
  })
})
