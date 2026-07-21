# Drop Custom Cache Plan

**Goal:** Remove the extension's custom model cache (`src/cache.ts`, `~/.pi/agent/pi-provider-tama.json`) and rely on pi's built-in `ModelsStore` for persistence via `fetchModels`, following pi's v0.81.0 recommended pattern of fetching models in the async factory.

**Architecture:** The factory fetches models from tama directly (blocking startup — pi waits for async factories) and registers with `createProvider({ ..., fetchModels })`. The `fetchModels` callback tells pi how to refresh the model list, and pi automatically persists/restores the catalog via `~/.pi/agent/models-store.json`. On next startup, pi restores cached tama models before extensions run, so the factory's network fetch is only needed for fresh data. Background refresh on `session_start` (reload reason) keeps models current when tama's model list changes.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` ^0.81.0, `@earendil-works/pi-ai` ^0.81.0

---

### Task 1: Remove cache module and refactor factory with fetchModels

**Context:** The extension currently caches raw tama API responses to disk (`~/.pi/agent/pi-provider-tama.json`) with config hash validation and 12h staleness threshold. Pi v0.81.0 provides built-in model persistence via `ModelsStore` when a provider supplies a `fetchModels` callback to `createProvider()`. This callback is called by pi during refresh, and pi writes the results to `~/.pi/agent/models-store.json`, restoring them on next startup before extensions run. Our custom cache is redundant — pi's store handles persistence when we wire it correctly. This task removes the cache module and refactors the factory to follow pi's recommended pattern: fetch models in the async factory (pi waits), register with `fetchModels` for persistence, background refresh on reload only.

**Files:**
- Delete: `src/cache.ts`
- Delete: `test/cache.test.ts`
- Modify: `src/index.ts`
- Modify: `src/types.ts` (remove `TamaCacheFile`)
- Test: `test/factory.test.ts`
- Test: `test/extension.test.ts`

**What to implement:**

1. **Delete files:**
   - `src/cache.ts` — entire module
   - `test/cache.test.ts` — tests for the deleted module
   - Remove `TamaCacheFile` interface from `src/types.ts` (only used by cache module)

2. **Refactor `src/index.ts` factory with `fetchModels`:**

   ```typescript
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
     const fetchModels = async () => {
       const fresh = await fetchTamaModels(targetURL, tamaToken)
       return fresh.map(m => transformModel(m, `${normalizeBaseURL(targetURL)}/v1`))
     }

     const sessionId = randomUUID()
     const provider = buildProvider(targetURL, models, settings, sessionId, fetchModels)
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
           const provider = buildProvider(targetURL, freshModels, settings, newSessionId, fetchModels)
           pi.registerProvider(provider)
           lastRegisteredModelIds = freshModels.map(m => m.id).sort()
         } catch (err) {
           console.warn(`[pi-provider-tama] Background refresh failed: ${err instanceof Error ? err.message : String(err)}`)
         }
       }, 0) // reload = immediate (no delay needed — user explicitly requested fresh models)
     })
   }
   ```

3. **Update `buildProvider` signature** to accept an optional `fetchModels` parameter:

   ```typescript
   import type { RefreshModelsContext, Model, Api } from '@earendil-works/pi-ai'

   function buildProvider(
     baseURL: string,
     models: TamaModel[],
     settings: Settings,
     sessionId?: string,
     fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<Api>[]>,
   ) {
     // ... existing code ...
     return createProvider({
       id: 'tama',
       name: 'Tama',
       baseUrl: `${normalizedBase}/v1`,
       headers: sessionId ? { langfuse_session_id: sessionId } : undefined,
       auth: { /* ... */ },
       models: transformed,
       fetchModels, // NEW — enables pi's ModelsStore persistence
       api: openAICompletionsApi(),
     })
   }
   ```

4. **Remove dead code:**
   - Cache imports: `readCache`, `writeCache`, `computeConfigHash`, `isCacheStale`
   - `configHash` variable (no longer used without cache)
   - `initialModels` branching logic and `cached` variable
   - `resolveToken()` function — inline `tamaToken` usage is sufficient

5. **Keep:**
   - Module state reset (`lastRegisteredModelIds = []`, `refreshTimer = undefined`)
   - `readSettings()`, `modelsChanged()`, `lastRegisteredModelIds`
   - `buildProvider()`, `refreshTimer` debouncing
   - Auth module (`src/auth.ts`)
   - Auto-detect logic (`autoDetectTama`)

**Steps:**
- [ ] Delete `src/cache.ts`
- [ ] Delete `test/cache.test.ts`
- [ ] Remove `TamaCacheFile` interface from `src/types.ts`
- [ ] Remove cache imports from `src/index.ts`: `readCache`, `writeCache`, `computeConfigHash`, `isCacheStale`
- [ ] Refactor factory to fetch-in-factory pattern with `fetchModels` callback (code above)
- [ ] Update `buildProvider` to accept and pass `fetchModels` to `createProvider()`
- [ ] Remove dead variables: `cached`, `configHash`, `initialModels`, `resolveToken()`
- [ ] Simplify session_start handler: only act on `reason === 'reload'`, no delay
- [ ] Update `test/factory.test.ts`:
  - Rename describe block from "cache-first factory" to "fetch-in-factory"
  - Remove cache mocks (`readCache`, `writeCache`, `computeConfigHash`, `isCacheStale`)
  - Rewrite tests for fetch-in-factory pattern (factory fetches models directly, no cache branching)
  - Set default mocks: `fetchTamaModels.mockResolvedValue([])`, `autoDetectTama.mockResolvedValue(null)` in beforeEach so the factory doesn't throw
  - Key tests: factory fetches on start, factory auto-detects tama when no explicit URL, factory skips when no tama detected, reload triggers refresh, non-reload session_start is a no-op, module state resets between runs
- [ ] Update `test/extension.test.ts`:
  - Remove `vi.mock('../src/cache', ...)` block (cache module is gone)
  - Rewrite "re-registers on session_start with current models" to call handler with `{ reason: 'reload' }` and `vi.advanceTimersByTimeAsync(1)` (delay is 0 for reload)
  - Rewrite "generates a fresh session ID on each registration cycle": **move `mockTamaResponse(...)` to AFTER `extension(pi)`** so the factory's initial fetch returns `[]` (no mock), then the handler's fetch returns mocked models → `modelsChanged` triggers re-registration with fresh session ID. Call handler with `{ reason: 'reload' }` and `vi.advanceTimersByTimeAsync(1)`.
  - Note that `fetchTamaModels` is now called during `extension(pi)` itself, so global `fetch` stubs must be configured before invoking the factory
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Run `npm run test:run`
  - Did all tests pass? If not, fix failures and re-run.
- [ ] Commit with message: "refactor: drop custom cache, use pi's ModelsStore via fetchModels"

**Acceptance criteria:**
- [ ] `src/cache.ts` and `test/cache.test.ts` deleted
- [ ] `TamaCacheFile` removed from `src/types.ts`
- [ ] No imports of `readCache`, `writeCache`, `computeConfigHash`, `isCacheStale` anywhere
- [ ] Factory fetches models from tama directly (no cache read)
- [ ] `createProvider()` receives a `fetchModels` callback (enables pi's ModelsStore persistence)
- [ ] Factory returns without registering when no tama URL is configured and auto-detect fails; with an explicit URL it always registers (possibly with zero models if the fetch fails)
- [ ] session_start only acts on `reason === 'reload'` (no delay, no background refresh for other reasons)
- [ ] Module-level state (`lastRegisteredModelIds`, `refreshTimer`) is reset at the start of the factory
- [ ] `npm run typecheck` passes with zero errors
- [ ] All tests pass

---

### Task 2: Update README to mention reload-only refresh

**Context:** The README's "How it works" section says the extension "re-runs the same flow on `session_start`." Under the new behavior, it only re-fetches on `/reload` (not on every session_start). Tighten this description.

**Files:**
- Modify: `README.md`

**What to implement:**

1. In `README.md`, update two spots:
   - **"What it does" point #4**: Change "Background-refreshes models on each new session (`session_start`)" to "Background-refreshes models on `/reload` (pi's built-in model store persists across sessions)"
   - **"How it works" section**: Change "re-runs the same flow on `session_start`" to "re-fetches models on `/reload` (pi's built-in model store persists models across sessions)"

**Steps:**
- [ ] Update the session_start description in README.md
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix and re-run.
- [ ] Run `npm run test:run`
  - Did ALL tests pass? If not, fix and re-run.
- [ ] Commit with message: "docs: clarify reload-only refresh in README"

**Acceptance criteria:**
- [ ] README mentions `/reload` specifically for model refresh
- [ ] Full test suite passes
- [ ] Typecheck passes
