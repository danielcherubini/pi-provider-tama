import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readCache, writeCache, computeConfigHash, isCacheStale } from './cache'
import type { TamaModel } from './types'
import { normalizeBaseURL, fetchTamaModels, transformModel, autoDetectTama } from './tama-api'
import { resolveTamaAuth, loginTama } from './auth'

const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

// Module-level state — reset at factory start to avoid test pollution / stale state across reloads.
let lastRegisteredModelIds: string[] = []

interface Settings {
  url?: string
  token?: string
}

async function readSettings(): Promise<Settings> {
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

function modelsChanged(newModels: TamaModel[]): boolean {
  const newIds = newModels.map(m => m.id).sort().join(',')
  const oldIds = lastRegisteredModelIds.join(',')
  return newIds !== oldIds
}

/** Build a createProvider() Provider object for the tama provider. */
function buildProvider(
  baseURL: string,
  models: TamaModel[],
  settings: Settings,
  sessionId?: string,
) {
  const normalizedBase = normalizeBaseURL(baseURL)
  const transformed = models.map(m => transformModel(m, `${normalizedBase}/v1`))

  return createProvider({
    id: 'tama',
    name: 'Tama',
    baseUrl: `${normalizedBase}/v1`,
    headers: sessionId ? { langfuse_session_id: sessionId } : undefined,
    auth: {
      apiKey: {
        name: 'Tama API Token',
        login: loginTama,
        resolve: ({ ctx, credential }) => resolveTamaAuth({ credential, ctx, settings }),
      },
    },
    models: transformed,
    api: openAICompletionsApi(),
  })
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Reset module-level state to avoid stale data across reloads / test pollution
  lastRegisteredModelIds = []

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
    const sessionId = randomUUID()
    const provider = buildProvider(regURL, initialModels, settings, sessionId)
    pi.registerProvider(provider)
  } else if (tamaURL) {
    // Explicit URL but no cache — register empty provider so it appears in UI
    const sessionId = randomUUID()
    const provider = buildProvider(normalizeBaseURL(tamaURL), [], settings, sessionId)
    pi.registerProvider(provider)
  }

  // 3. Background update on session_start
  pi.on('session_start', async (event) => {
    const reason = event.reason
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

        const freshModels = await fetchTamaModels(targetURL, tamaToken)
        // fetchTamaModels returns [] (truthy) on failure — guard against empty arrays
        if (freshModels.length === 0 || !modelsChanged(freshModels)) return

        // Write to cache for next startup
        if (freshModels.length > 0) {
          await writeCache(targetURL, freshModels, configHash)
        }

        // Re-register with fresh createProvider (new sessionId for langfuse)
        const newSessionId = randomUUID()
        const provider = buildProvider(targetURL, freshModels, settings, newSessionId)
        pi.registerProvider(provider)
        lastRegisteredModelIds = freshModels.map(m => m.id).sort()
      } catch (err) {
        console.warn(`[pi-provider-tama] Background update failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, delayMs)
  })
}
