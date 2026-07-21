import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent'
import { readCache, writeCache, computeConfigHash, isCacheStale } from './cache'
import type { RefreshModelsContext, ProviderModelConfig, TamaModel } from './types'
import { normalizeBaseURL, fetchTamaModels, buildPiProviderConfig, transformModel, autoDetectTama } from './tama-api'

const PROVIDER_NAME = 'tama'
const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

// Module-level state — reset at factory start to avoid test pollution / stale state across reloads.
let lastRegisteredModelIds: string[] = []
// Track the last successful model list so refreshModels can return it on failure instead of [] (which would clear Pi's provider).
let lastSuccessfulModels: ProviderModelConfig[] = []

async function readSettings(): Promise<{ url?: string; token?: string }> {
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf-8')
    const section = JSON.parse(raw)?.['pi-provider-tama']
    return {
      url: typeof section?.url === 'string' ? section.url : undefined,
      token: typeof section?.token === 'string' ? section.token : undefined,
    }
  } catch {
    return {}
  }
}

async function fetchAndCache(baseURL: string, configHash: string, token?: string): Promise<TamaModel[] | null> {
  const models = await fetchTamaModels(baseURL, token)
  if (models.length > 0) {
    await writeCache(baseURL, models, configHash)
  }
  return models.length > 0 ? models : null
}

function buildRefreshModels(baseURL: string, configHash: string, token?: string) {
  return async (ctx: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
    if (!ctx.allowNetwork) return lastSuccessfulModels // don't clear models when offline
    try {
      const models = await fetchTamaModels(baseURL, token)
      const transformed = models.map(transformModel)
      // Also write to our cache file so next startup has fresh data
      if (models.length > 0) await writeCache(baseURL, models, configHash)
      lastSuccessfulModels = transformed
      return transformed
    } catch {
      return lastSuccessfulModels // preserve existing models on transient failure
    }
  }
}

async function registerWithModels(
  pi: ExtensionAPI,
  baseURL: string,
  models: TamaModel[],
  configHash: string,
  token?: string,
) {
  const sessionId = randomUUID()
  const config = {
    ...buildPiProviderConfig(baseURL, models, token, sessionId),
    refreshModels: buildRefreshModels(baseURL, configHash, token),
  }
  // Cast because mariozechner stub lacks refreshModels; runtime @earendil-works has it.
  pi.registerProvider(PROVIDER_NAME, config as unknown as ProviderConfig)
  lastRegisteredModelIds = models.map(m => m.id).sort()
}

function modelsChanged(newModels: TamaModel[]): boolean {
  const newIds = newModels.map(m => m.id).sort().join(',')
  const oldIds = lastRegisteredModelIds.join(',')
  return newIds !== oldIds
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Reset module-level state to avoid stale data across reloads / test pollution
  lastRegisteredModelIds = []
  lastSuccessfulModels = []

  const settings = await readSettings()
  const tamaURL = process.env.TAMA_URL || settings.url
  const tamaToken = process.env.TAMA_TOKEN || settings.token
  const configHash = computeConfigHash(tamaURL, tamaToken)

  // 1. Load cached models (instant — no network)
  const cached = await readCache()
  let initialModels: TamaModel[] = []

  if (cached && !isCacheStale(cached, configHash)) {
    initialModels = cached.models
  }

  // 2. Register immediately with whatever we have (no network blocking)
  if (initialModels.length > 0) {
    // Prefer explicit URL from settings/env; fall back to cached baseURL (preserves correct port)
    const regURL = tamaURL ? normalizeBaseURL(tamaURL) : cached?.baseURL ?? 'http://127.0.0.1:11434'
    await registerWithModels(pi, regURL, initialModels, configHash, tamaToken)
  } else if (tamaURL) {
    // Explicit URL but no cache — register empty provider so it appears in UI
    await registerWithModels(pi, normalizeBaseURL(tamaURL), [], configHash, tamaToken)
  }

  // 3. Background update on session_start
  pi.on('session_start', async (event) => {
    const reason = event.reason
    // Skip delay on reload — user explicitly wants fresh models now
    const delayMs = reason === 'reload' ? 0 : 2000

    setTimeout(async () => {
      try {
        let targetURL = tamaURL ? normalizeBaseURL(tamaURL) : ''

        // Auto-detect if no explicit URL (preserves zero-config behavior)
        if (!targetURL) {
          const detected = await autoDetectTama(tamaToken)
          if (detected) {
            targetURL = normalizeBaseURL(detected)
          } else {
            return // can't update without a reachable Tama
          }
        }

        const freshModels = await fetchAndCache(targetURL, configHash, tamaToken)
        if (!freshModels || !modelsChanged(freshModels)) return

        await registerWithModels(pi, targetURL, freshModels, configHash, tamaToken)
      } catch (err) {
        console.warn(`[pi-provider-tama] Background update failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, delayMs)
  })
}
