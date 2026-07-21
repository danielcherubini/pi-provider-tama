import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  computeConfigHash,
  readCache,
  writeCache,
  isCacheStale,
  CACHE_PATH,
} from '../src/cache'
import type { TamaCacheFile, TamaModel } from '../src/types'

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}))

const fsPromises = await import('node:fs/promises')
const mockReadFile = vi.mocked(fsPromises.readFile)
const mockWriteFile = vi.mocked(fsPromises.writeFile)
const mockMkdir = vi.mocked(fsPromises.mkdir)

// ---------- computeConfigHash ----------

describe('computeConfigHash', () => {
  it('returns same hash for same inputs', () => {
    const a = computeConfigHash('http://localhost:11434', 'token123')
    const b = computeConfigHash('http://localhost:11434', 'token123')
    expect(a).toBe(b)
  })

  it('returns different hash for different inputs', () => {
    const a = computeConfigHash('http://localhost:11434', 'token123')
    const b = computeConfigHash('http://localhost:8080', 'token123')
    expect(a).not.toBe(b)
  })

  it('returns different hash for different tokens', () => {
    const a = computeConfigHash('http://localhost:11434', 'token123')
    const b = computeConfigHash('http://localhost:11434', 'other')
    expect(a).not.toBe(b)
  })

  it('returns consistent hash when no inputs', () => {
    const a = computeConfigHash()
    const b = computeConfigHash()
    expect(a).toBe(b)
  })
})

// ---------- readCache ----------

describe('readCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when file does not exist (ENOENT)', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('ENOENT'))
    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null on any readFile error', async () => {
    mockReadFile.mockRejectedValueOnce(new Error('EACCES'))
    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns parsed entry when valid cache exists', async () => {
    const models: TamaModel[] = [
      { id: 'test/model', name: 'Test' },
    ]
    const cacheFile: TamaCacheFile = {
      version: 1,
      configHash: 'abc123',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models,
    }
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()

    expect(result).not.toBeNull()
    expect(result!.version).toBe(1)
    expect(result!.configHash).toBe('abc123')
    expect(result!.baseURL).toBe('http://localhost:11434')
    expect(result!.models).toEqual(models)
  })

  it('returns null when lastFetchedMs is missing', async () => {
    const cacheFile = {
      version: 1,
      configHash: 'abc',
      baseURL: 'http://localhost:11434',
      models: [],
    } as unknown as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null when version is not 1', async () => {
    const cacheFile = {
      version: 2,
      configHash: 'abc',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: [],
    } as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null when models is not an array', async () => {
    const cacheFile = {
      version: 1,
      configHash: 'abc',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: 'not-an-array' as unknown as TamaModel[],
    } as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null when configHash is missing', async () => {
    const cacheFile = {
      version: 1,
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: [],
    } as unknown as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null when baseURL is missing', async () => {
    const cacheFile = {
      version: 1,
      configHash: 'abc',
      lastFetchedMs: Date.now(),
      models: [],
    } as unknown as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null when baseURL is empty string', async () => {
    const cacheFile = {
      version: 1,
      configHash: 'abc',
      lastFetchedMs: Date.now(),
      baseURL: '',
      models: [],
    } as TamaCacheFile
    mockReadFile.mockResolvedValueOnce(JSON.stringify(cacheFile))

    const result = await readCache()
    expect(result).toBeNull()
  })

  it('returns null on invalid JSON', async () => {
    mockReadFile.mockResolvedValueOnce('not-json')

    const result = await readCache()
    expect(result).toBeNull()
  })
})

// ---------- isCacheStale ----------

describe('isCacheStale', () => {
  it('returns true when configHash mismatches', () => {
    const entry: TamaCacheFile = {
      version: 1,
      configHash: 'old-hash',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: [],
    }
    expect(isCacheStale(entry, 'new-hash')).toBe(true)
  })

  it('returns true when lastFetchedMs > 12h old', () => {
    const entry: TamaCacheFile = {
      version: 1,
      configHash: 'same-hash',
      lastFetchedMs: Date.now() - (13 * 60 * 60 * 1000), // 13 hours ago
      baseURL: 'http://localhost:11434',
      models: [],
    }
    expect(isCacheStale(entry, 'same-hash')).toBe(true)
  })

  it('returns false when hash matches and timestamp is recent', () => {
    const entry: TamaCacheFile = {
      version: 1,
      configHash: 'same-hash',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: [],
    }
    expect(isCacheStale(entry, 'same-hash')).toBe(false)
  })

  it('returns false when no currentHash provided and not time-stale', () => {
    const entry: TamaCacheFile = {
      version: 1,
      configHash: 'any-hash',
      lastFetchedMs: Date.now(),
      baseURL: 'http://localhost:11434',
      models: [],
    }
    expect(isCacheStale(entry)).toBe(false)
  })

  it('returns true when no currentHash but entry is time-stale', () => {
    const entry: TamaCacheFile = {
      version: 1,
      configHash: 'any-hash',
      lastFetchedMs: Date.now() - (24 * 60 * 60 * 1000), // 24 hours ago
      baseURL: 'http://localhost:11434',
      models: [],
    }
    expect(isCacheStale(entry)).toBe(true)
  })
})

// ---------- writeCache ----------

describe('writeCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls writeFile with CACHE_PATH as first arg and correct JSON structure', async () => {
    const models: TamaModel[] = [
      { id: 'test/model', name: 'Test' },
    ]
    const baseURL = 'http://localhost:11434'
    const configHash = 'sha256-hash-here'

    // Mock Date.now() to return a fixed value for determinism
    const fixedTime = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(fixedTime)

    await writeCache(baseURL, models, configHash)

    expect(mockMkdir).toHaveBeenCalledWith(
      `${CACHE_PATH.substring(0, CACHE_PATH.lastIndexOf('/'))}`,
      { recursive: true }
    )
    expect(mockWriteFile).toHaveBeenCalledTimes(1)
    expect(mockWriteFile).toHaveBeenCalledWith(
      CACHE_PATH,
      expect.stringContaining('"baseURL"'),
      'utf-8'
    )

    // Verify the written JSON structure
    const writtenJson = mockWriteFile.mock.calls[0][1] as string
    const parsed = JSON.parse(writtenJson)
    expect(parsed.baseURL).toBe(baseURL)
    expect(parsed.configHash).toBe(configHash)
    expect(parsed.lastFetchedMs).toBe(fixedTime)
    expect(parsed.models).toEqual(models)
    expect(parsed.version).toBe(1)

    vi.restoreAllMocks()
  })

  it('writes empty models array when no models', async () => {
    const fixedTime = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(fixedTime)

    await writeCache('http://localhost:11434', [], 'hash')

    const writtenJson = mockWriteFile.mock.calls[0][1] as string
    const parsed = JSON.parse(writtenJson)
    expect(parsed.models).toEqual([])

    vi.restoreAllMocks()
  })
})
