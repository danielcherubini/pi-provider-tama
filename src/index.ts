import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { buildPiProviderConfig, resolveAndFetch } from './tama-api'

const PROVIDER_NAME = 'tama'
const SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json')

/** Read the "pi-provider-tama" section from ~/.pi/agent/settings.json. */
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

async function discoverAndRegister(pi: ExtensionAPI): Promise<void> {
  const settings = await readSettings()
  const tamaURL = process.env.TAMA_URL || settings.url || undefined
  const tamaToken = process.env.TAMA_TOKEN || settings.token || undefined

  const data = await resolveAndFetch(tamaURL, tamaToken)
  if (!data) return

  // One session ID per registration cycle (initial load + each /reload).
  // Tama forwards langfuse_session_id to Langfuse, grouping all requests in
  // this pi session into a single trace session in the Langfuse UI.
  const sessionId = randomUUID()

  pi.registerProvider(
    PROVIDER_NAME,
    buildPiProviderConfig(data.baseURL, data.models, tamaToken, sessionId)
  )
}

// Async factory: pi awaits this before initial scope resolution, so every
// tama model is registered before pi decides which models are available.
export default async function (pi: ExtensionAPI): Promise<void> {
  await discoverAndRegister(pi)

  // Re-discover on /reload so new models in tama appear without restarting pi.
  pi.on('session_start', async () => {
    await discoverAndRegister(pi)
  })
}
