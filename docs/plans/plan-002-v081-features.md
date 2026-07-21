# v0.81.0 Feature Adoption Plan

**Goal:** Adopt all new pi v0.81.0 custom provider features — official packages, interactive auth via createProvider(), backend-aware compat, and context overflow normalization.

**Architecture:** Replace the `@mariozechner/pi-coding-agent` fork with official `@earendil-works/` packages. Migrate from legacy provider config to `createProvider()` with dual-path auth (interactive `/login tama` + env/settings fallback). Add per-model compat derived from tama's backend metadata. Drop custom overflow handling — pi 0.81.0 already auto-compacts via built-in `isContextOverflow()`.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-coding-agent` ^0.81.0, `@earendil-works/pi-ai` ^0.81.0

---

### Task 1: Migrate to official packages

**Context:** The project currently depends on `@mariozechner/pi-coding-agent` (forked at v0.73.1) for type stubs. The official `@earendil-works/pi-coding-agent` is now at v0.81.0 and includes the types we need (`ExtensionAPI`, `ProviderConfig` with `refreshModels`). We also need `@earendil-works/pi-ai` for `createProvider()` and `openAICompletionsApi()`. This task removes the fork dependency and updates all imports, eliminating the `as unknown as ProviderConfig` cast workaround.

**Files:**
- Modify: `package.json`
- Modify: `src/index.ts`
- Modify: `src/types.ts`

**What to implement:**

1. In `package.json`:
   - Replace `"@mariozechner/pi-coding-agent"` with `"@earendil-works/pi-coding-agent": "^0.81.0"` in both `peerDependencies` and `devDependencies`
   - Add `"@earendil-works/pi-ai": "^0.81.0"` to both `peerDependencies` and `devDependencies`

2. In `src/index.ts`:
   - Change `import type { ExtensionAPI, ProviderConfig } from '@mariozechner/pi-coding-agent'` to `import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent'`

3. In `src/types.ts`:
   - Remove the comment referencing mariozechner: `/** Local mirrors of Pi runtime types not exposed by the peer dep stub. @earendil-works/pi-coding-agent has these on ProviderConfig; mariozechner stub does not. */`
   - Keep `RefreshModelsContext` and `ProviderModelConfig` for now (Task 2 handles realignment)

4. In `src/index.ts`:
   - Remove the cast `as unknown as ProviderConfig` on `pi.registerProvider()` calls — the official types have `refreshModels` on `ProviderConfig`
   - **Important:** The local `PiProviderConfig` returned by `buildPiProviderConfig` includes a top-level `compat` field. In 0.81.0, `compat` moved per-model (on `ProviderModelConfig`). The legacy `ProviderConfig` still has no top-level `compat`. After removing the cast, this excess property may cause a type error. **Fix:** Remove `compat` from `buildPiProviderConfig`'s return object in `src/tama-api.ts` (compat will be per-model via Task 3). Also remove it from the local `PiProviderConfig` interface.

5. Run `npm install` to update node_modules

**Steps:**
- [ ] Modify `package.json` — replace mariozechner with `"@earendil-works/pi-coding-agent": "^0.81.0"`, add `"@earendil-works/pi-ai": "^0.81.0"` in both peer and dev deps
- [ ] Run `npm install`
  - Did it succeed? If not, fix version conflicts and re-run.
- [ ] Update import in `src/index.ts` from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`
- [ ] Remove the `as unknown as ProviderConfig` cast from `pi.registerProvider()` call(s)
- [ ] In `src/tama-api.ts`, remove the top-level `compat` field from `buildPiProviderConfig`'s return object (it will be per-model via Task 3)
- [ ] In `src/types.ts`, remove `compat` from `PiProviderConfig` interface
- [ ] Update/remove the mariozechner comment in `src/types.ts`
- [ ] **Update `test/tama-api.test.ts`**: Remove the `expect(config.compat).toEqual(...)` assertion from the "builds a complete pi provider config" test (compat is no longer on the provider-level config)
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Run `npm run test:run`
  - Did all tests pass? If not, fix failures and re-run.
- [ ] Commit with message: "chore: migrate to official @earendil-works packages"

**Acceptance criteria:**
- [ ] `package.json` has no reference to `@mariozechner/pi-coding-agent`
- [ ] `src/index.ts` imports from `@earendil-works/pi-coding-agent`
- [ ] No `as unknown as ProviderConfig` casts remain
- [ ] Top-level `compat` removed from `buildPiProviderConfig` return and `PiProviderConfig` interface
- [ ] `npm run typecheck` passes with zero errors
- [ ] All existing tests pass


---

### Task 2: Migrate to createProvider() with dual-path auth

**Context:** The extension currently builds a legacy provider config and manually wires API keys, auth headers, and compat. pi v0.81.0 introduces `createProvider()` from `@earendil-works/pi-ai` which provides structured auth (`auth.apiKey.login` + `resolve`), and cleaner API wiring via `openAICompletionsApi()`. The dual-path approach means interactive login via `/login tama` is primary, but env vars and settings.json remain as fallbacks.

**Critical architecture note:** `createProvider()` returns a `Provider` object registered via `pi.registerProvider(provider)` (single-arg overload). The legacy `registerProvider(name, config)` form has NO `auth` field — the two are mutually exclusive. For model updates on `session_start`, we re-register a **fresh createProvider()** call each time (not the legacy form). Auth resolution is extracted into `src/auth.ts` for testability.

**Files:**
- Modify: `src/index.ts`
- Modify: `src/tama-api.ts`
- Modify: `src/types.ts`
- Create: `src/auth.ts` (new module for auth logic)
- Test: `test/extension.test.ts`
- Test: `test/factory.test.ts`
- Test: `test/tama-api.test.ts` (update buildPiProviderConfig tests — compat removed)
- Create: `test/auth.test.ts` (new test file for auth resolution logic)

**What to implement:**

1. **Create `src/auth.ts`** — extract auth resolution into a pure, testable module:

```typescript
import type { AuthContext, AuthInteraction, ApiKeyCredential } from '@earendil-works/pi-ai';

interface Settings {
  url?: string;
  token?: string;
}

export interface TamaAuthParams {
  credential?: ApiKeyCredential;
  ctx: AuthContext;
  settings: Settings;
}

/** Resolve Tama API key with priority: stored credential > env var > settings > fallback. Always returns a value (fallback to 'tama' if all sources absent). */
export async function resolveTamaAuth({ credential, ctx, settings }: TamaAuthParams): Promise<{ auth: { apiKey: string }; source: string }> {
  if (credential?.type === 'api_key' && credential.key) {
    return { auth: { apiKey: credential.key }, source: 'stored token' };
  }
  // ctx.env() is async — await it. Fall through to process.env as backup.
  const envToken = await ctx.env('TAMA_TOKEN') || process.env.TAMA_TOKEN;
  if (envToken) return { auth: { apiKey: envToken }, source: 'TAMA_TOKEN env' };
  if (settings.token) return { auth: { apiKey: settings.token }, source: 'settings.json' };
  return { auth: { apiKey: 'tama' }, source: 'fallback' };
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
  });

  if (method === 'prompt') {
    const key = await interaction.prompt({
      type: 'secret',
      message: 'Tama token:',
    });
    return { type: 'api_key', key };
  }

  throw new Error('Login cancelled — set TAMA_TOKEN or configure in settings.json');
}
```

2. **In `src/index.ts`**, replace the legacy provider registration with `createProvider()`:

```typescript
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { resolveTamaAuth, loginTama } from './auth';

// Inside the factory:
function buildProvider(
  baseURL: string,
  models: TamaModel[],
  sessionId?: string,
) {
  const normalizedBase = normalizeBaseURL(baseURL);
  const transformed = models.map(transformModel);

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
    models: transformed as any, // Model<Api> cast — Task 3 handles proper typing
    api: openAICompletionsApi(),
  });
}

// Initial registration — preserve the if/else branching from the original code:
if (initialModels.length > 0) {
  const regURL = tamaURL ? normalizeBaseURL(tamaURL) : cached?.baseURL ?? 'http://127.0.0.1:11434';
  const sessionId = randomUUID();
  const provider = buildProvider(regURL, initialModels, sessionId);
  pi.registerProvider(provider);
} else if (tamaURL) {
  // Explicit URL but no cache — register empty provider so it appears in UI
  const sessionId = randomUUID();
  const provider = buildProvider(normalizeBaseURL(tamaURL), [], sessionId);
  pi.registerProvider(provider);
  // No registration when no cache AND no URL — tama not configured
```

3. **For `session_start` re-registration:** Replace the current session_start handler with:

   ```typescript
   pi.on('session_start', async (event) => {
     const reason = event.reason;
     const delayMs = reason === 'reload' ? 0 : 2000;

     setTimeout(async () => {
       try {
         let targetURL = tamaURL ? normalizeBaseURL(tamaURL) : '';

         if (!targetURL) {
           const detected = await autoDetectTama(tamaToken);
           if (detected) {
             targetURL = normalizeBaseURL(detected);
           } else {
             return; // can't update without a reachable Tama
           }
         }

         const freshModels = await fetchTamaModels(targetURL, tamaToken);
         // fetchTamaModels returns [] (truthy) on failure — guard against empty arrays
         if (freshModels.length === 0 || !modelsChanged(freshModels)) return;

         // Write to cache for next startup
         if (freshModels.length > 0) {
           await writeCache(targetURL, freshModels, configHash);
         }

         // Re-register with fresh createProvider (new sessionId for langfuse)
         const newSessionId = randomUUID();
         const provider = buildProvider(targetURL, freshModels, newSessionId);
         pi.registerProvider(provider);
         lastRegisteredModelIds = freshModels.map(m => m.id).sort();
       } catch (err) {
         console.warn(`[pi-provider-tama] Background update failed: ${err instanceof Error ? err.message : String(err)}`);
       }
     }, delayMs);
   });
   ```

   This keeps `modelsChanged`, `autoDetectTama`, `fetchTamaModels`, and `writeCache` — only the registration call changes from `registerWithModels` to `buildProvider(pi, ...)`. Note: `tamaToken` is still passed to `fetchTamaModels` for the discovery fetch's Bearer header (extension-level network call, not provider API).

4. **In `src/tama-api.ts`:**
   - Keep `buildAuthHeaders()` — still used by `checkTamaHealth`/`fetchTamaModels` for extension-level discovery fetches (those use raw `fetch`, not the provider)
   - Remove top-level `compat` from `buildPiProviderConfig`'s return (done in Task 1)
   - Keep `buildPiProviderConfig`/`discoverTamaForPi`/`resolveAndFetch` — they're exported and tested. They still work as utility functions even if `src/index.ts` no longer calls them directly

5. **In `src/types.ts`:**
   - Remove `compat` from `PiProviderConfig` interface (done in Task 1)
   - Add `compat?` to `PiModel` (done in Task 3)
   - Keep `RefreshModelsContext`/`ProviderModelConfig` for now — Task 5 handles cleanup

6. **Remove dead code from `src/index.ts`:**
   - Remove `buildRefreshModels()` function — no longer used with createProvider
   - Remove `lastSuccessfulModels` module-level variable declaration AND the `lastSuccessfulModels = []` reset line in the factory body
   - Remove `registerWithModels()` helper function — replaced by `buildProvider()`
   - Remove `fetchAndCache()` helper function — its logic is now inlined in session_start
   - Remove `buildPiProviderConfig` from the import statement (no longer called after createProvider migration). Keep `transformModel`, `normalizeBaseURL`, `autoDetectTama` in imports.
   - Remove `ProviderModelConfig` from the type import (only used by `lastSuccessfulModels`)
   - Keep `modelsChanged()`, `lastRegisteredModelIds`, and `readSettings()` — still used by session_start

7. **Eliminate `as any` cast on models (Task 3 responsibility):** The `createProvider({ models })` field expects `readonly Model<TApi>[]`. `PiModel` is missing the `provider`, `api`, and `baseUrl` fields that `Model<Api>` requires. Task 3 fixes this by adding these fields to `transformModel()`'s return. Until Task 3 executes, the `as any` cast in `buildProvider` is temporary and accepted.

8. **Auth login behavior:** When the user selects "Use TAMA_TOKEN env var" during `/login tama`, `loginTama` throws an error. Pi's auth flow then falls back to calling `resolve()` which checks env/settings. This is the intended dual-path behavior — the interactive login offers entry, but if the user opts for env-based auth, resolve() handles the fallback.

9. **Update tests:**

   **Add mocks for `@earendil-works/pi-ai`:** Both `extension.test.ts` and `factory.test.ts` import `src/index.ts` which now imports `createProvider` and `openAICompletionsApi`. Add module mocks at the top of each test file:

   ```typescript
   vi.mock('@earendil-works/pi-ai', () => ({
     createProvider: vi.fn((opts) => ({
       id: opts.id,
       name: opts.name,
       baseUrl: opts.baseUrl,
       headers: opts.headers,
       auth: opts.auth,
       getModels: () => opts.models,
     })),
   }));

   vi.mock('@earendil-works/pi-ai/compat', () => ({
     openAICompletionsApi: vi.fn(() => ({ streamSimple: vi.fn() })),
   }));
   ```

   **Rewrite `extension.test.ts` assertions** — `registerProvider` now takes a single Provider arg (not `[name, config]`). Example before/after:

   ```typescript
   // Before (legacy two-arg):
   const [name, config] = pi.registerProvider.mock.calls[0]!;
   expect(name).toBe('tama');
   expect(config.models.length).toBe(0);
   expect(config.apiKey).toBe('env-token');

   // After (createProvider single-arg):
   const provider = pi.registerProvider.mock.calls[0]![0];
   expect(provider.id).toBe('tama');
   expect(provider.getModels().length).toBe(0);
   // apiKey testing moves to auth.test.ts (resolveTamaAuth)
   ```

   - `getModels()` returns `readonly Model[]` synchronously (not a Promise)

   **extension.test.ts test-by-test rewrite checklist:**
   - "is an async factory" — no change needed
   - "registers with empty models on cold start when no cache" — rewrite to `provider.getModels().length === 0`
   - "subscribes to session_start for mid-session refresh" — no change needed
   - "forwards TAMA_TOKEN as Bearer header and as provider apiKey" — **REMOVE** this test (auth tested in auth.test.ts)
   - "registers with empty models when no cache and Tama unreachable" — rewrite to `provider.getModels().length === 0` and `provider.baseUrl`
   - "re-registers on session_start with current models" — rewrite to use `provider.getModels()` for both initial and refreshed calls
   - "injects a langfuse_session_id header" — rewrite to `provider.headers?.langfuse_session_id`
   - "generates a fresh session ID on each registration cycle" — rewrite to compare `calls[0][0].headers.langfuse_session_id` vs `calls[1][0].headers.langfuse_session_id`

   **Rewrite `factory.test.ts`** — same structural update. Also:
   - Remove the `buildPiProviderConfig` mock entry from `vi.mock('../src/tama-api', ...)` (no longer called)
   - Update all `calls[0][1]` assertions to `calls[0][0]` Provider access
   - Change `expect(config.models).toBe(cachedModels)` to `expect(provider.getModels()).toEqual(cachedModels)` (map creates new array, reference equality no longer holds)

   **factory.test.ts test-by-test rewrite checklist:**
   - "registers with cached models immediately" — rewrite to `provider.id === 'tama'` and `provider.getModels().toEqual(cachedModels)` (use .toEqual not .toBe)
   - "registers empty provider when no cache but TAMA_URL set" — rewrite to `provider.getModels().toEqual([])` and `provider.baseUrl`
   - "subscribes to session_start" — no change needed
   - "background update re-registers only on model changes" — rewrite to use `provider.getModels()` for both calls
   - "background update auto-detects Tama when no explicit URL" — rewrite to `provider.baseUrl` from single-arg call
   - "background update errors do not crash" — no structural change, just verify registerProvider count
   - "reload reason skips the 2s delay" — rewrite to use single-arg Provider access
   - "cache exists but config hash changed" — rewrite to use single-arg Provider access for both initial and refresh calls
   - "empty Tama response doesn't overwrite valid cache" — rewrite to use single-arg Provider access
   - "multiple rapid session_start events don't crash" — rewrite to use single-arg Provider access

   **Update `test/tama-api.test.ts`:**
   - Remove `compat` from expected objects in `buildPiProviderConfig` tests (top-level compat removed in Task 1)

   **Create `test/auth.test.ts`** — new file testing `resolveTamaAuth`:
   ```typescript
   import { resolveTamaAuth } from '../src/auth';

   const mockCtx = {
     env: vi.fn().mockResolvedValue(undefined),
     fileExists: vi.fn().mockResolvedValue(false),
   };

   it('stored credential takes priority over env var', async () => {
     const result = await resolveTamaAuth({
       credential: { type: 'api_key', key: 'stored-key' },
       ctx: mockCtx,
       settings: {},
     });
     expect(result).toEqual({ auth: { apiKey: 'stored-key' }, source: 'stored token' });
   });

   it('env var takes priority over settings.json', async () => {
     vi.mocked(mockCtx.env).mockResolvedValueOnce('env-token');
     const result = await resolveTamaAuth({
       credential: undefined,
       ctx: mockCtx,
       settings: { token: 'settings-token' },
     });
     expect(result).toEqual({ auth: { apiKey: 'env-token' }, source: 'TAMA_TOKEN env' });
   });

   it('settings.json takes priority over fallback', async () => {
     const result = await resolveTamaAuth({
       credential: undefined,
       ctx: mockCtx,
       settings: { token: 'settings-token' },
     });
     expect(result).toEqual({ auth: { apiKey: 'settings-token' }, source: 'settings.json' });
   });

   it('returns fallback tama when all sources absent', async () => {
     const result = await resolveTamaAuth({
       credential: undefined,
       ctx: mockCtx,
       settings: {},
     });
     expect(result).toEqual({ auth: { apiKey: 'tama' }, source: 'fallback' });
   });

   it('ctx.env is tried before process.env', async () => {
     vi.mocked(mockCtx.env).mockResolvedValueOnce('ctx-token');
     const savedToken = process.env.TAMA_TOKEN;
     process.env.TAMA_TOKEN = 'process-token';
     try {
       const result = await resolveTamaAuth({ credential: undefined, ctx: mockCtx, settings: {} });
       expect(result).toEqual({ auth: { apiKey: 'ctx-token' }, source: 'TAMA_TOKEN env' });
     } finally {
       if (savedToken === undefined) delete process.env.TAMA_TOKEN;
       else process.env.TAMA_TOKEN = savedToken;
     }
   });
   ```

**Steps:**
- [ ] Create `src/auth.ts` with `resolveTamaAuth()` and `loginTama()` functions
- [ ] Write failing tests in `test/auth.test.ts`:
  - Test: stored credential takes priority over env var
  - Test: env var takes priority over settings.json token
  - Test: settings.json token takes priority over fallback "tama"
  - Test: all sources absent returns fallback "tama"
  - Test: ctx.env('TAMA_TOKEN') is tried before process.env
- [ ] Run `npm run test:run -- test/auth.test.ts`
  - Did it fail with expected errors (module doesn't exist yet)? If not, investigate.
- [ ] Implement `src/auth.ts` with the auth resolution logic
- [ ] Run `npm run test:run -- test/auth.test.ts`
  - Did all auth tests pass? If not, fix and re-run.
- [ ] Refactor `src/index.ts` to use `createProvider()` from `@earendil-works/pi-ai`
  - Import `openAICompletionsApi` from `@earendil-works/pi-ai/compat` (subpath)
  - Use `interaction.prompt({ type: 'select', ... })` — NOT `interaction.select()`
  - Pass required fields: `id`, `auth`, `models`, `api` (zero-arg `openAICompletionsApi()`)
  - Headers for langfuse session via `headers: { langfuse_session_id: sessionId }`
- [ ] Update `session_start` handler to build a fresh createProvider with updated models + new sessionId
- [ ] Keep `buildAuthHeaders()` in `src/tama-api.ts` (still used by health checks)
- [ ] Update `test/extension.test.ts`:
  - Change assertions from `calls[0][1]` (two-arg legacy) to `calls[0][0]` (single Provider arg)
  - Access models via `.getModels()` method, baseUrl via `.baseUrl`, headers via `.headers`
  - Update langfuse tests to check provider headers
- [ ] Update `test/factory.test.ts`:
  - Same structural update — single-arg registerProvider
  - Update mock expectations for Provider object shape
- [ ] Update `test/tama-api.test.ts`:
  - Remove `compat` from expected objects in `buildPiProviderConfig` tests
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Run `npm run test:run`
  - Did all tests pass? If not, fix failures and re-run. 
- [ ] Commit with message: "feat: migrate to createProvider() with dual-path auth"

**Acceptance criteria:**
- [ ] `pi.registerProvider()` uses `createProvider()` from `@earendil-works/pi-ai`
- [ ] Auth resolution via `auth.apiKey.resolve()` implements priority: stored > env > settings > fallback
- [ ] Interactive login via `auth.apiKey.login()` with `interaction.prompt({ type: 'select' })`
- [ ] `openAICompletionsApi()` called with zero arguments, imported from subpath
- [ ] Langfuse session headers via `createProvider({ headers: { langfuse_session_id } })`
- [ ] `session_start` re-registers a fresh createProvider (not legacy config)
- [ ] Auth logic extracted to `src/auth.ts` and independently testable
- [ ] All tests pass including new auth tests
- [ ] `npm run typecheck` passes


---

### Task 3: Backend-aware per-model compat

**Context:** Tama serves models from various backends (llama.cpp, ONNX, etc.), each with different API quirks. The extension currently applies no per-model compat. pi v0.81.0 supports per-model `compat` in the model definition (`Model.compat`). This task adds a backend-to-compat mapping so each model gets the right flags for its upstream backend.

**Files:**
- Modify: `src/tama-api.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts` (update buildProvider call + remove as any cast)
- Test: `test/tama-api.test.ts`

**What to implement:**

1. In `src/types.ts`, add a `PiCompat` interface and optional `compat` field on `PiModel`:

```typescript
export interface PiCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
}

export interface PiModel {
  // ... existing fields ...
  compat?: PiCompat;
  provider: 'tama';
  api: 'openai-completions';
  baseUrl?: string;
}
```

2. In `src/tama-api.ts`, add a backend-to-compat mapping:

```typescript
const BACKEND_COMPAT: Record<string, PiCompat> = {
  'llama.cpp': {
    maxTokensField: 'max_tokens',
    requiresToolResultName: false,
  },
  'onnx': {
    maxTokensField: 'max_tokens',
  },
};

const DEFAULT_COMPAT: PiCompat = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens',
};
```

3. In `transformModel()`, merge default compat with backend-specific overrides and add the Model<Api> required fields:

```typescript
export function transformModel(model: TamaModel, baseUrl?: string): PiModel {
  // ... existing transform logic (contextWindow, maxTokens, input) ...

  const backendCompat = model.backend ? BACKEND_COMPAT[model.backend] : undefined;

  return {
    id: model.id,
    name: model.name || model.id,
    reasoning: false,
    input,
    contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...DEFAULT_COMPAT, ...backendCompat },
    provider: 'tama' as const,
    api: 'openai-completions' as const,
    ...(baseUrl ? { baseUrl } : {}),
  };
}
```

The `baseUrl` parameter is optional (for backward compatibility with `buildPiProviderConfig` which doesn't pass it). In `buildProvider`, call `models.map(m => transformModel(m, `${normalizedBase}/v1`))` so the baseUrl is populated.
```

4. In `test/tama-api.test.ts`, update existing tests and add new ones:
   - **Update** the "transforms a minimal model" test — add expected `compat: DEFAULT_COMPAT`, `provider: 'tama'`, `api: 'openai-completions'` to the `toEqual` assertion (no baseUrl when not passed)
   - **Add:** transformModel applies llama.cpp compat for backend "llama.cpp"
   - **Add:** transformModel merges ONNX compat for backend "onnx"
   - **Add:** transformModel unknown backend gets DEFAULT_COMPAT only
   - **Add:** transformModel includes baseUrl when provided as second argument

**Steps:**
- [ ] Add `PiCompat` interface to `src/types.ts` and add `compat?` to `PiModel`
- [ ] Write failing tests in `test/tama-api.test.ts`:
  - Test: transformModel with backend "llama.cpp" produces llama.cpp compat
  - Test: transformModel with backend "onnx" produces ONNX compat
  - Test: transformModel with unknown backend gets DEFAULT_COMPAT
- [ ] Run `npm run test:run -- test/tama-api.test.ts`
  - Did the new tests fail (compat field doesn't exist yet)? If not, investigate.
- [ ] Implement `BACKEND_COMPAT` map and `DEFAULT_COMPAT` in `src/tama-api.ts`
- [ ] Update `transformModel()` to merge compat from backend and add provider/api/baseUrl fields
- [ ] In `src/tama-api.ts`, update `buildPiProviderConfig`'s call: change `tamaModels.map(transformModel)` to `tamaModels.map(m => transformModel(m))` (arrow wrapper prevents Array.map passing the index as baseUrl)
- [ ] In `src/index.ts` `buildProvider`, change `models.map(transformModel)` to `models.map(m => transformModel(m, `${normalizedBase}/v1`))`
- [ ] In `src/index.ts` `buildProvider`, remove the `as any` cast on the `models` field in createProvider (PiModel now has provider/api/baseUrl)
- [ ] **Update** the existing "transforms a minimal model" test — add expected `compat: DEFAULT_COMPAT`, `provider: 'tama'`, `api: 'openai-completions'` to the `toEqual` assertion
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Run `npm run test:run -- test/tama-api.test.ts`
  - Did all tests pass including new compat tests? If not, fix and re-run. 
- [ ] Commit with message: "feat: backend-aware per-model compat from tama metadata"

**Acceptance criteria:**
- [ ] `PiModel` has an optional `compat?: PiCompat` field
- [ ] `transformModel()` produces per-model compat merged from DEFAULT_COMPAT + backend-specific overrides
- [ ] Known backends (llama.cpp, onnx) have specific compat entries
- [ ] Unknown/missing backend gets DEFAULT_COMPAT
- [ ] Existing "transforms a minimal model" test updated with expected compat
- [ ] All tests pass including new compat tests

---

### Task 4: Drop custom overflow handling (pi already handles it)

**Context:** The original design called for a `message_end` handler to normalize context overflow errors from tama's upstream backends. However, pi 0.81.0 already auto-compacts on context overflow via the built-in `isContextOverflow()` function, which detects ~19 patterns including llama.cpp ("exceeds the available context size"), Ollama ("prompt too long; exceeded max context length"), LM Studio, and many more local LLM backends. It also has `NON_OVERFLOW_PATTERNS` to exclude rate-limit/throttling false positives.

**Decision:** Skip this task entirely — no code changes needed. Pi's built-in overflow detection covers the common cases. If a specific tama backend emits a genuinely novel overflow message not covered by `isContextOverflow`, file an upstream issue or add a targeted pattern later.

**Files:** None

**Steps:**
- [ ] No action required — pi 0.81.0 handles this

**Acceptance criteria:**
- [ ] N/A (no changes)

---

### Task 5: Clean up stale local type mirrors

**Context:** After migrating to official packages, the local `RefreshModelsContext` and `ProviderModelConfig` type mirrors in `src/types.ts` are stale — they were workarounds for the mariozechner stub lacking these types. The official `@earendil-works/pi-coding-agent` exports them. Task 2 already removed `buildRefreshModels`, `lastSuccessfulModels`, and `registerWithModels`. This task removes the remaining unused local type mirrors.

**Files:**
- Modify: `src/types.ts`

**What to implement:**

1. In `src/types.ts`:
   - Remove `RefreshModelsContext` interface — no longer used after Task 2
   - Remove `ProviderModelConfig` type alias — no longer used after Task 2
   - Keep `PiModel`, `PiCompat`, `TamaModel`, `TamaModelsResponse`, `TamaCacheFile`, `PiProviderConfig` — these are internal types

**Steps:**
- [ ] Verify `RefreshModelsContext` and `ProviderModelConfig` are not imported anywhere (Task 2 removed their usage)
- [ ] Remove `RefreshModelsContext` and `ProviderModelConfig` from `src/types.ts`
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix type errors and re-run.
- [ ] Run `npm run test:run`
  - Did all tests pass? If not, fix failures and re-run. 
- [ ] Commit with message: "refactor: remove stale local type mirrors after official package migration"

**Acceptance criteria:**
- [ ] No stale local mirrors of types available from official packages
- [ ] `npm run typecheck` passes
- [ ] All tests pass


---

### Task 6: Update README and verify end-to-end

**Context:** After all feature changes, the README needs updating to reflect the new capabilities (interactive auth via `/login tama`, backend-aware compat, official package deps). Final verification ensures everything works together.

**Files:**
- Modify: `README.md`
- Modify: `package.json` (version bump)

**What to implement:**

1. In `README.md`:
   - Update peer dependency name from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent`
   - Add documentation for `/login tama` interactive auth
   - Document the dual-path auth (env/settings still work as fallback)
   - Mention backend-aware compat (automatic per-backend API quirks handling)
   - Note that context overflow auto-compaction is handled by pi's built-in detection

2. In `package.json`:
   - Bump version from `0.11.0` to `0.12.0` (minor bump for new features)

**Steps:**
- [ ] Update `README.md` with new feature documentation
- [ ] Bump version in `package.json` to `0.12.0`
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix and re-run.
- [ ] Run `npm run test:run`
  - Did ALL tests pass (including all files)? If not, fix and re-run. 
- [ ] Commit with message: "docs: update README for v0.81.0 features, bump 0.12.0"

**Acceptance criteria:**
- [ ] README documents `/login tama`, dual-path auth, backend compat, and official packages
- [ ] Version bumped to `0.12.0`
- [ ] Full test suite passes
- [ ] Typecheck passes
