import type { AuthContext, AuthInteraction, ApiKeyCredential } from '@earendil-works/pi-ai'

interface Settings {
  url?: string
  token?: string
}

export interface TamaAuthParams {
  credential?: ApiKeyCredential
  ctx: AuthContext
  settings: Settings
}

/** Resolve Tama API key with priority: stored credential > env var > settings > fallback. Always returns a value (fallback to 'tama' if all sources absent). */
export async function resolveTamaAuth({
  credential,
  ctx,
  settings,
}: TamaAuthParams): Promise<{ auth: { apiKey: string }; source: string }> {
  if (credential?.type === 'api_key' && credential.key) {
    return { auth: { apiKey: credential.key }, source: 'stored token' }
  }
  // ctx.env() is async — await it. Fall through to process.env as backup.
  const envToken = (await ctx.env('TAMA_TOKEN')) || process.env.TAMA_TOKEN
  if (envToken) return { auth: { apiKey: envToken }, source: 'TAMA_TOKEN env' }
  if (settings.token) return { auth: { apiKey: settings.token }, source: 'settings.json' }
  return { auth: { apiKey: 'tama' }, source: 'fallback' }
}

/** Create the login interaction for /login tama. Returns ApiKeyCredential (not AuthResult). */
export async function loginTama(interaction: AuthInteraction): Promise<ApiKeyCredential> {
  const method = await interaction.prompt({
    type: 'select',
    message: 'Token source:',
    options: [
      { id: 'prompt', label: 'Enter token' },
      { id: 'env', label: 'Use TAMA_TOKEN env var' },
    ],
  })

  if (method === 'prompt') {
    const key = await interaction.prompt({
      type: 'secret',
      message: 'Tama token:',
    })
    return { type: 'api_key', key }
  }

  // User selected "Use TAMA_TOKEN env var" — read it and store as credential
  const envKey = process.env.TAMA_TOKEN
  if (!envKey) {
    throw new Error('TAMA_TOKEN env var is not set')
  }
  return { type: 'api_key', key: envKey }
}
