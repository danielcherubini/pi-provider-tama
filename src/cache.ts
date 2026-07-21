import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { TamaCacheFile, TamaModel } from './types'

export const CACHE_PATH = join(homedir(), '.pi', 'agent', 'pi-provider-tama.json')
const STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000 // 12 hours

export function computeConfigHash(url?: string, token?: string): string {
  const raw = `${url || ''}|${token || ''}`
  return createHash('sha256').update(raw).digest('hex')
}

export async function readCache(): Promise<TamaCacheFile | null> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as TamaCacheFile
    if (parsed.version !== 1) return null
    if (!Array.isArray(parsed.models)) return null
    if (typeof parsed.lastFetchedMs !== 'number') return null
    if (typeof parsed.configHash !== 'string') return null
    if (typeof parsed.baseURL !== 'string' || !parsed.baseURL) return null
    return parsed
  } catch {
    return null // file missing or invalid JSON
  }
}

export async function writeCache(baseURL: string, models: TamaModel[], configHash: string): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  const entry: TamaCacheFile = {
    version: 1,
    baseURL,
    configHash,
    lastFetchedMs: Date.now(),
    models,
  }
  await writeFile(CACHE_PATH, JSON.stringify(entry, null, 2), 'utf-8')
}

export function isCacheStale(entry: TamaCacheFile, currentHash?: string): boolean {
  if (currentHash && entry.configHash !== currentHash) return true
  return Date.now() - entry.lastFetchedMs > STALE_THRESHOLD_MS
}
