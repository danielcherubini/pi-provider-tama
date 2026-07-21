# Model Caching Plan

**Goal:** Eliminate startup blocking on slow networks by caching Tama models locally and refreshing in background.

**Architecture:** Add `src/cache.ts` for reading/writing `~/.pi/agent/pi-provider-tama.json`. Factory reads cache first (instant), registers provider with `refreshModels` callback for on-demand refresh via `/model > provider picker`. Background update runs after `session_start` to keep cache fresh. Auto-detection is preserved in the background path for zero-config setups.

**Tech Stack:** Node.js (`fs/promises`, `crypto`), TypeScript, Vitest.

---

### Task 1: Cache module — read/write/hash utilities

**Context:** New module handling all persistence logic independently from provider registration or API fetching. This lets us test cache behavior thoroughly without mocking ExtensionAPI.

**Files:**
- Create: `src/cache.ts`
- Modify: `src/types.ts` (add `TamaCacheFile` interface)
- Create: `test/cache.test.ts`

**What to implement:**

In `src/types.ts`, add after existing interfaces:
```typescript
export interface TamaCacheFile {
  version: number
  configHash: string
  lastFetchedMs: number
  baseURL: string
  models: TamaModel[]
}
```

In `src/cache.ts`, the full file (all imports spelled out):
```typescript
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
  await mkdir(join(CACHE_PATH, '..'), { recursive: true })
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
```

**Steps:**
- [ ] Write failing tests in `test/cache.test.ts` (mock `node:fs/promises` via `vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn() }))`) covering:
  - `computeConfigHash` returns same hash for same inputs, different for different inputs
  - `readCache` returns null when file doesn't exist (mock readFile to throw ENOENT)
  - `readCache` returns parsed entry when valid cache exists (mock readFile to return JSON string of a complete TamaCacheFile)
  - `readCache` returns null when lastFetchedMs is missing from cache
  - `readCache` returns null when baseURL is missing or empty
  - `isCacheStale` returns true when configHash mismatches
  - `isCacheStale` returns true when lastFetchedMs > 12h old
  - `isCacheStale` returns false when hash matches and timestamp is recent
  - `writeCache` calls writeFile with CACHE_PATH as first arg (import CACHE_PATH from cache.ts) and correct JSON structure containing baseURL, configHash, lastFetchedMs, models
- [ ] Run `npm run test:run -- test/cache.test.ts` — verify tests fail
- [ ] Implement `src/cache.ts` and add `TamaCacheFile` to `src/types.ts`
- [ ] Run `npm run test:run -- test/cache.test.ts` — all pass
- [ ] Run `npm run typecheck` — succeeds
- [ ] Commit: `feat: add cache module for model persistence`

**Acceptance criteria:**
- [ ] All cache functions work correctly in isolation
- [ ] Cache file at `~/.pi/agent/pi-provider-tama.json` follows the JSON schema with baseURL field
- [ ] Config hash invalidation works independently from staleness check
- [ ] Malformed cache entries (missing lastFetchedMs, empty baseURL) are rejected gracefully

---

### Task 2: Refactor factory — cache-first startup + refreshModels

**Context:** Replace the current blocking async factory (fetches network → registers) with cache-first approach. Factory reads cached models, registers immediately, then schedules background update. The `refreshModels` callback handles on-demand refresh via Pi's built-in `/model > provider picker` mechanism. Auto-detection is preserved in the background path for zero-config setups.

**Key typing note:** The runtime Pi (`@earendil-works/pi-coding-agent`) has `refreshModels` on `ProviderConfig` (line 1022 of types.d.ts), but the project's peer dependency stub (`@mariozechner/pi-coding-agent`) does not. To typecheck cleanly: define `RefreshModelsContext` and `ProviderModelConfig` locally in `src/types.ts`, and cast the config at the `registerProvider` call site via `as unknown as import('@mariozechner/pi-coding-agent').ProviderConfig`.

**Files:**
- Modify: `src/index.ts` (full rewrite)
- Modify: `src/types.ts` (add local type mirrors for RefreshModelsContext, ProviderModelConfig)
- Modify: `test/extension.test.ts` (rewrite existing tests — see steps below)
- Create: `test/factory.test.ts` (new factory-specific tests)

**What to implement:**

First, add to `src/types.ts`:
```typescript
// Local mirrors of Pi runtime types not exposed by the peer dep stub.
// @earendil-works/pi-coding-agent has these on ProviderConfig; mariozechner stub does not.
export interface RefreshModelsContext {
  credential?: unknown
  store: unknown
  allowNetwork: boolean
  force?: boolean
  signal?: AbortSignal
}

export type ProviderModelConfig = PiModel // same shape as our PiModel
```

Full rewrite of `src/index.ts`:
```typescript
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

// Module-level tracking so change-detection compares against last successful fetch, not original cache
let lastRegisteredModelIds: string[] = []

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

async function fetchAndCache(baseURL: string, token?: string, configHash: string): Promise<TamaModel[] | null> {
  const models = await fetchTamaModels(baseURL, token)
  if (models.length > 0) {
    await writeCache(baseURL, models, configHash)
  }
  return models.length > 0 ? models : null
}

function buildRefreshModels(baseURL: string, token?: string) {
  return async (ctx: RefreshModelsContext): Promise<ProviderModelConfig[]> => {
    if (!ctx.allowNetwork) return []
    try {
      const models = await fetchTamaModels(baseURL, token)
      // Also write to our cache file so next startup has fresh data
      const configHash = computeConfigHash(baseURL, token)
      if (models.length > 0) await writeCache(baseURL, models, configHash)
      return models.map(transformModel) as ProviderModelConfig[]
    } catch {
      return [] // graceful — Pi keeps existing models
    }
  }
}

async function registerWithModels(
  pi: ExtensionAPI,
  baseURL: string,
  models: TamaModel[],
  token?: string,
) {
  const sessionId = randomUUID()
  const config = {
    ...buildPiProviderConfig(baseURL, models, token, sessionId),
    refreshModels: buildRefreshModels(baseURL, token),
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
    await registerWithModels(pi, regURL, initialModels, tamaToken)
  } else if (tamaURL) {
    // Explicit URL but no cache — register empty provider so it appears in UI
    await registerWithModels(pi, normalizeBaseURL(tamaURL), [], tamaToken)
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

        const freshModels = await fetchAndCache(targetURL, tamaToken, configHash)
        if (!freshModels || !modelsChanged(freshModels)) return

        await registerWithModels(pi, targetURL, freshModels, tamaToken)
      } catch (err) {
        console.warn(`[pi-provider-tama] Background update failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, delayMs)
  })
}
```

**Key changes from current code:**
- Factory no longer awaits network fetch — reads cache, registers immediately
- `refreshModels` callback added to provider config for on-demand `/model > refresh`
- `session_start` handler schedules background update (0s delay on reload, 2s otherwise)
- Auto-detection preserved in background path for zero-config setups
- Re-registration only happens if model IDs actually changed (avoids churn)
- Module-level `lastRegisteredModelIds` tracks current state for accurate change detection across multiple reloads
- Cached `baseURL` is used as fallback when no explicit URL set (preserves correct port like 8080)
- Errors during background update are logged but don't affect running Pi

**Steps:**
- [ ] Add `RefreshModelsContext` and `ProviderModelConfig` to `src/types.ts`
- [ ] Write tests in `test/factory.test.ts`:
  - Mock `node:fs/promises` to prevent `readSettings()` from hitting the real filesystem (keeps tests hermetic even when TAMA_URL is unset and settings.url would be consulted):
    ```typescript
    vi.mock('node:fs/promises', () => ({
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    }))
    ```
  - Use `vi.mock('../src/cache', () => ({ readCache: vi.fn().mockResolvedValue(null), writeCache: vi.fn().mockResolvedValue(undefined), computeConfigHash: vi.fn().mockReturnValue('test-hash'), isCacheStale: vi.fn().mockReturnValue(false) }))` to control all cache behavior. Reset `readCache`/`writeCache` return values per-test as needed via `vi.mocked(readCache).mockResolvedValue(...)`.
  - Use `vi.mock('../src/tama-api', () => ({ normalizeBaseURL: vi.fn((u) => u), fetchTamaModels: vi.fn(), buildPiProviderConfig: vi.fn((b, m, t, s) => ({ baseUrl: `${b}/v1`, api: 'openai-completions', apiKey: t || 'tama', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, headers: { langfuse_session_id: s }, models: m })), transformModel: vi.fn((m) => m), autoDetectTama: vi.fn() }))` so background-path tests don't hit real delay/AbortSignal.timeout under fake timers
  - Use `vi.useFakeTimers()` for setTimeout-based background updates
  - Test: "registers with cached models immediately" — mock readCache to return entry with models, computeConfigHash returns matching hash, isCacheStale returns false. Assert registerProvider called once with those cached models and fetchTamaModels was NOT called.
  - Test: "registers empty provider when no cache but TAMA_URL set" — mock readCache to return null, set TAMA_URL env. Assert registerProvider called with empty models array + baseURL.
  - Test: "subscribes to session_start" — assert pi.on called with 'session_start'.
  - Test: "background update re-registers only on model changes" — mock fetchTamaModels to return different models, advance timers by 2001ms, assert registerProvider called twice (initial + background). Then mock fetchTamaModels to return same IDs, advance timers, assert registerProvider NOT called again.
  - Test: "background update auto-detects Tama when no explicit URL" — unset TAMA_URL, mock readCache null, mock autoDetectTama to return URL, mock fetchTamaModels to return models, advance timers, assert registerProvider called with detected URL.
  - Test: "background update errors don't crash" — mock fetchTamaModels to throw, advance timers, assert no unhandled rejection and existing provider not cleared.
  - Test: "reload reason skips the 2s delay" — set event.reason = 'reload', advance timers by 1ms, assert background update ran immediately.
- [ ] Rewrite `test/extension.test.ts` to match new factory behavior. Add cache mock at the top of the file (same pattern as factory.test.ts) so real filesystem writes don't pollute cross-test state:
  ```typescript
  vi.mock('../src/cache', () => ({
    readCache: vi.fn().mockResolvedValue(null),
    writeCache: vi.fn().mockResolvedValue(undefined),
    computeConfigHash: vi.fn().mockReturnValue('test-hash'),
    isCacheStale: vi.fn().mockReturnValue(false),
  }))
  ```
  Per-test rewrite instructions:
  - *"is an async factory"* → keep as-is (still async)
  - *"registers the tama provider with discovered models before resolving"* → **rename to** "registers with empty models on cold start when no cache". With cache mock returning null and TAMA_URL set, assert `registerProvider` called once with `config.models).toHaveLength(0)`. Remove any `fetch.mock.calls` assertions (factory no longer fetches during init).
  - *"subscribes to session_start for mid-session refresh"* → keep as-is
  - *"forwards TAMA_TOKEN as Bearer header and as provider apiKey"* → **change**: verify `config.apiKey` equals the token from settings/env. Remove the `fetch.mock.calls` assertion (no fetch during factory).
  - *"does not register a provider when tama is unreachable"* → **rename to** "registers with empty models when no cache and Tama unreachable". Factory now registers even without network — assert `registerProvider` called with empty models array + baseURL.
  - *"re-registers on session_start with current models"* → **change**: use `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(2001)` to trigger the background update, then assert re-registration with fresh models. Reset cache mock per test: `vi.mocked(readCache).mockResolvedValue(null)`.
  - *"generates a fresh session ID on each registration cycle"* → **change**: same fake timer approach, verify langfuse_session_id header differs between initial and background registration. Reset cache mock per test.
- [ ] Run `npm run test:run` — all tests fail initially (expected for new tests)
- [ ] Rewrite `src/index.ts` with cache-first flow
- [ ] Update `test/extension.test.ts` per rewrite instructions above
- [ ] Run `npm run test:run` — all pass
- [ ] Run `npm run typecheck` — succeeds
- [ ] Commit: `feat: cache-first startup with background refresh and refreshModels callback`

**Acceptance criteria:**
- [ ] Factory completes without blocking on network calls
- [ ] Cached models appear immediately at startup, using cached baseURL as fallback port
- [ ] Background update runs after session_start (0s on reload, 2s otherwise), re-registers only on model ID changes
- [ ] `refreshModels` callback works for on-demand provider refresh (typechecks via local type mirrors + cast)
- [ ] Auto-detection preserved in background path for zero-config setups
- [ ] Errors during background fetch don't crash Pi or clear existing provider

---

### Task 3: Cleanup — verify integration and edge cases

**Context:** After refactoring, verify the full flow works end-to-end and clean up any loose ends.

**Files:**
- Modify: `test/factory.test.ts` (add edge case tests)

**What to implement:**
- Verify `src/index.ts` only imports what's actually used from other modules
- Keep `resolveAndFetch`, `checkTamaHealth` exported from `tama-api.ts` — they're still used by `autoDetectTama` and tested in `tama-api.test.ts`. Don't remove them.
- Add edge case tests to `test/factory.test.ts`:
  - Cache exists but config hash changed (settings updated) → factory skips cache, background re-fetches after session_start delay
  - Empty Tama response (fetchTamaModels returns `[]`) doesn't overwrite valid cache (writeCache not called with empty array)
  - Multiple rapid session_start events don't cause crashes (each schedules its own setTimeout; last-write-wins on cache)

**Steps:**
- [ ] Run `npm run test:run` — all existing tests pass
- [ ] Run `npm run typecheck` — succeeds
- [ ] Verify `src/index.ts` imports are minimal and correct (no unused imports/params)
- [ ] Add edge case tests listed above to `test/factory.test.ts`
- [ ] Run `npm run test:run` — all pass
- [ ] Commit: `chore: cleanup and integration verification for model caching`

**Acceptance criteria:**
- [ ] All tests pass, typecheck succeeds
- [ ] No unused imports in `src/index.ts`
- [ ] Edge cases handled: config change triggers re-fetch, empty responses don't clobber cache, rapid session_starts don't crash

---
