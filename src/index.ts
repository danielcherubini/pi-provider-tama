import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createProvider } from '@earendil-works/pi-ai'
import type { RefreshModelsContext, Model, Api } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { TamaModel } from './types'
import { normalizeBaseURL, fetchTamaModels, transformModel, autoDetectTama } from './tama-api'
import { resolveTamaAuth, loginTama } from './auth'

const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

// Module-level state — reset at factory start to avoid test pollution / stale state across reloads.
let lastRegisteredModelIds: string[] = []
let refreshTimer: ReturnType<typeof setTimeout> | undefined

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
  fetchModelsCb?: (context: RefreshModelsContext) => Promise<readonly Model<Api>[]>,
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
    fetchModels: fetchModelsCb,
    api: openAICompletionsApi(),
  })
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // Reset module-level state to avoid stale data across reloads / test pollution
  lastRegisteredModelIds = []
  refreshTimer = undefined

  const settings = await readSettings()
  const tamaURL = process.env.TAMA_URL || settings.url
  const tamaToken = process.env.TAMA_TOKEN || settings.token

  // Resolve URL: explicit > auto-detect
  let targetURL: string | null = null
  if (tamaURL) {
    targetURL = normalizeBaseURL(tamaURL)
  } else {
    targetURL = await autoDetectTama(tamaToken)
  }

  if (!targetURL) {
    console.log('[pi-provider-tama] Tama not detected — skip registration')
    return // No tama available, don't register at all
  }

  // Fetch models (blocks startup — pi waits for async factory)
  const models = await fetchTamaModels(targetURL, tamaToken)

  // fetchModels callback: tells pi how to refresh the model list.
  // Pi calls this during refresh and persists results to models-store.json.
  const fetchModelsCb = async (): Promise<readonly Model<Api>[]> => {
    const fresh = await fetchTamaModels(targetURL, tamaToken)
    return fresh.map(m => transformModel(m, `${normalizeBaseURL(targetURL)}/v1`)) as readonly Model<Api>[]
  }

  const sessionId = randomUUID()
  const provider = buildProvider(targetURL, models, settings, sessionId, fetchModelsCb)
  pi.registerProvider(provider)
  lastRegisteredModelIds = models.map(m => m.id).sort()

  // Background refresh on reload only (pi has cached models for other reasons)
  pi.on('session_start', async (event) => {
    if (event.reason !== 'reload') return // skip non-reload — models already cached by pi

    // Cancel any pending refresh timer
    if (refreshTimer) clearTimeout(refreshTimer)

    refreshTimer = setTimeout(async () => {
      refreshTimer = undefined
      try {
        const freshModels = await fetchTamaModels(targetURL, tamaToken)
        if (freshModels.length === 0 || !modelsChanged(freshModels)) return

        const newSessionId = randomUUID()
        const provider = buildProvider(targetURL, freshModels, settings, newSessionId, fetchModelsCb)
        pi.registerProvider(provider)
        lastRegisteredModelIds = freshModels.map(m => m.id).sort()
      } catch (err) {
        console.warn(`[pi-provider-tama] Background refresh failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, 0) // reload = immediate (no delay needed — user explicitly requested fresh models)
  })
}
