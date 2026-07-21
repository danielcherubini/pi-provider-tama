import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveTamaAuth } from '../src/auth'

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
