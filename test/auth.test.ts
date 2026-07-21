import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { resolveTamaAuth, loginTama } from '../src/auth'

function makeMockCtx() {
  return {
    env: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(false),
  }
}

/** Helpers to manage process.env.TAMA_TOKEN across tests. */
let savedEnvToken: string | undefined

function saveEnvToken() {
  savedEnvToken = process.env.TAMA_TOKEN
  delete process.env.TAMA_TOKEN
}

function restoreEnvToken() {
  if (savedEnvToken !== undefined) process.env.TAMA_TOKEN = savedEnvToken
}

describe('resolveTamaAuth', () => {
  beforeEach(() => {
    saveEnvToken()
  })

  afterAll(() => {
    restoreEnvToken()
  })

  it('stored credential takes priority over env var', async () => {
    const ctx = makeMockCtx()
    const result = await resolveTamaAuth({
      credential: { type: 'api_key' as const, key: 'stored-key' },
      ctx,
      settings: {},
    })
    expect(result).toEqual({ auth: { apiKey: 'stored-key' }, source: 'stored token' })
  })

  it('env var takes priority over settings.json', async () => {
    const ctx = makeMockCtx()
    vi.mocked(ctx.env).mockResolvedValueOnce('env-token')
    const result = await resolveTamaAuth({
      credential: undefined,
      ctx,
      settings: { token: 'settings-token' },
    })
    expect(result).toEqual({ auth: { apiKey: 'env-token' }, source: 'TAMA_TOKEN env' })
  })

  it('settings.json takes priority over fallback', async () => {
    const ctx = makeMockCtx()
    const result = await resolveTamaAuth({
      credential: undefined,
      ctx,
      settings: { token: 'settings-token' },
    })
    expect(result).toEqual({ auth: { apiKey: 'settings-token' }, source: 'settings.json' })
  })

  it('returns fallback tama when all sources absent', async () => {
    const ctx = makeMockCtx()
    const result = await resolveTamaAuth({ credential: undefined, ctx, settings: {} })
    expect(result).toEqual({ auth: { apiKey: 'tama' }, source: 'fallback' })
  })

  it('ctx.env is tried before process.env', async () => {
    // Re-set process.env.TAMA_TOKEN to a value that would win if not overridden by ctx.env
    process.env.TAMA_TOKEN = 'process-token'
    const ctx = makeMockCtx()
    vi.mocked(ctx.env).mockResolvedValueOnce('ctx-token')
    const result = await resolveTamaAuth({ credential: undefined, ctx, settings: {} })
    expect(result).toEqual({ auth: { apiKey: 'ctx-token' }, source: 'TAMA_TOKEN env' })
  })
})

describe('loginTama', () => {
  it('calls interaction.prompt with type select and two options', async () => {
    const mockInteraction = {
      prompt: vi.fn().mockResolvedValueOnce('prompt'),
    }
    try {
      await loginTama(mockInteraction as never)
    } catch { /* may throw on second prompt — we only care about the first call */ }

    expect(mockInteraction.prompt).toHaveBeenNthCalledWith(1, {
      type: 'select',
      message: 'Token source:',
      options: [
        { id: 'prompt', label: 'Enter token' },
        { id: 'env', label: 'Use TAMA_TOKEN env var' },
      ],
    })
  })

  it('returns credential when user selects prompt and enters token', async () => {
    const mockInteraction = {
      prompt: vi.fn()
        .mockResolvedValueOnce('prompt')
        .mockResolvedValueOnce('my-secret-token'),
    }
    const result = await loginTama(mockInteraction as never)
    expect(result).toEqual({ type: 'api_key', key: 'my-secret-token' })
    expect(mockInteraction.prompt).toHaveBeenNthCalledWith(2, {
      type: 'secret',
      message: 'Tama token:',
    })
  })

  it('returns credential from env var when user selects env option', async () => {
    const savedToken = process.env.TAMA_TOKEN
    process.env.TAMA_TOKEN = 'env-token-from-login'
    const mockInteraction = {
      prompt: vi.fn().mockResolvedValueOnce('env'),
    }
    try {
      const result = await loginTama(mockInteraction as never)
      expect(result).toEqual({ type: 'api_key', key: 'env-token-from-login' })
    } finally {
      if (savedToken === undefined) delete process.env.TAMA_TOKEN
      else process.env.TAMA_TOKEN = savedToken
    }
  })

  it('throws when user selects env option but TAMA_TOKEN is not set', async () => {
    const savedToken = process.env.TAMA_TOKEN
    delete process.env.TAMA_TOKEN
    const mockInteraction = {
      prompt: vi.fn().mockResolvedValueOnce('env'),
    }
    try {
      await expect(loginTama(mockInteraction as never)).rejects.toThrow(
        'TAMA_TOKEN env var is not set'
      )
    } finally {
      if (savedToken === undefined) delete process.env.TAMA_TOKEN
      else process.env.TAMA_TOKEN = savedToken
    }
  })
})
