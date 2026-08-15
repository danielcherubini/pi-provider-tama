# Reasoning & Variants Support Plan

**Goal:** Parse the new `reasoning: boolean` and `variants: string[]` fields from tama's `/v1/opencode/models` endpoint and surface them in pi as native thinking-level support.

**Architecture:** Tama models that report `reasoning: true` are mapped onto pi's thinking-level mechanism: each recognized variant name (from pi's fixed vocabulary `minimal`/`low`/`medium`/`high`/`xhigh`/`max`) becomes an offered thinking level, and `off`–matching levels send their name verbatim as `reasoning_effort` in the chat-completions body. Unrecognized variant names are dropped with a warning. The reload change-detection fingerprint is extended so capability changes on an existing model id trigger re-registration.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-ai` `ThinkingLevelMap` type, existing extension factory pattern.

**Background (read before executing):** pi's model format has no "variant" concept. Its only per-request selectable mechanism is `thinkingLevelMap` on the model object, which maps pi thinking levels to values sent as `reasoning_effort` (pi sends `reasoning_effort` only when `model.reasoning === true` AND `compat.supportsReasoningEffort === true`). See `docs/adr/0001-variants-as-thinking-levels.md` for why variants map to thinking levels. Backward compatibility is mandatory: a tama server that does NOT send the new fields must produce byte-identical output to today (the existing test `transforms a minimal model` uses exact `toEqual` and must keep passing unchanged).

**Commands used throughout:**
- Tests: `npm run test:run`
- Typecheck: `npm run typecheck`
- There is no formatter configured in this repo. Do not add one.

---

### Task 1: Endpoint types + `buildThinkingLevelMap` helper

**Context:**
This task adds the two new fields to the tama response type and the pure mapping helper that converts a `variants` array into pi's `thinkingLevelMap`. It is types + one isolated function, so it is independently commitable with zero behavior change to the running extension (nothing calls the helper yet, and the new model fields are optional).

**Files:**
- Modify: `src/types.ts`
- Modify: `src/tama-api.ts`
- Test: `test/tama-api.test.ts`

**What to implement:**

1. In `src/types.ts`:
   - Add to the `TamaModel` interface (after the `gpu_layers` field):
     ```ts
     /** Whether the model supports reasoning (thinking). Absent/undefined = false. */
     reasoning?: boolean
     /** Named reasoning-effort overlays. Names are expected from pi's thinking-level vocabulary. */
     variants?: string[]
     ```
   - Add to the `PiModel` interface (after the `reasoning: boolean` field):
     ```ts
     thinkingLevelMap?: ThinkingLevelMap
     ```
   - Add a type import at the top of the file:
     ```ts
     import type { ThinkingLevelMap } from '@earendil-works/pi-ai'
     ```
   - Do NOT change `PiCompat` or anything else in `src/types.ts`.

2. In `src/tama-api.ts`:
   - Add these constants near the other module-level constants (e.g. after `DEFAULT_MAX_TOKENS`). The `as const` tuples are required — with plain `string[]`, indexing `map[level]` fails the strict `tsc` gate (TS7053):
     ```ts
     /** pi thinking levels that are offered by default and must be explicitly nulled to hide. */
     const STANDARD_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
     /** pi thinking levels that require an explicit string entry to be offered at all. */
     const EXTENDED_LEVELS = ['xhigh', 'max'] as const
     const KNOWN_LEVELS: readonly string[] = [...STANDARD_LEVELS, ...EXTENDED_LEVELS]
     ```
   - Add this exported pure function (place it directly above `transformModel`):
     ```ts
     /**
      * Map tama's `variants` (named reasoning-effort overlays) to pi's thinkingLevelMap.
      *
      * Rules:
      * - standard levels (minimal/low/medium/high) absent from variants → `null` (hidden)
      * - standard levels present in variants → omitted (pi default sends the level name)
      * - extended levels (xhigh/max) present in variants → explicit string value
      * - extended levels absent → omitted (unsupported)
      * - unknown names are ignored by the caller (which logs a warning)
      * - undefined/empty input, or no recognizable names → undefined (no map)
      */
     export function buildThinkingLevelMap(variants?: string[]): ThinkingLevelMap | undefined {
       if (!variants || variants.length === 0) return undefined
       const known = new Set(variants.filter((v) => KNOWN_LEVELS.includes(v)))
       if (known.size === 0) return undefined

       const map: ThinkingLevelMap = {}
       for (const level of STANDARD_LEVELS) {
         if (!known.has(level)) map[level] = null
       }
       for (const level of EXTENDED_LEVELS) {
         if (known.has(level)) map[level] = level
       }
       return Object.keys(map).length > 0 ? map : undefined
     }
     ```
   - Import `ThinkingLevelMap` from `@earendil-works/pi-ai` in `src/tama-api.ts` (add it to the existing `./types` import area as: `import type { ThinkingLevelMap } from '@earendil-works/pi-ai'`).

   Do NOT modify `transformModel` or anything else in this task.

**Steps:**
- [ ] In `test/tama-api.test.ts`, add `buildThinkingLevelMap` to the existing import from `'../src/tama-api'`, and add a new describe block (place it after the `buildAPIURL` describe, before `transformModel`):
  ```ts
  describe('buildThinkingLevelMap', () => {
    it('returns undefined for undefined input', () => {
      expect(buildThinkingLevelMap(undefined)).toBeUndefined()
    })

    it('returns undefined for empty array', () => {
      expect(buildThinkingLevelMap([])).toBeUndefined()
    })

    it('returns undefined when no name is recognizable', () => {
      expect(buildThinkingLevelMap(['turbo'])).toBeUndefined()
    })

    it('nulls absent standard levels and adds explicit extended levels', () => {
      expect(buildThinkingLevelMap(['high', 'max'])).toEqual({
        minimal: null,
        low: null,
        medium: null,
        max: 'max',
      })
    })

    it('omits matching standard levels (pi default applies)', () => {
      expect(buildThinkingLevelMap(['low', 'high'])).toEqual({
        minimal: null,
        medium: null,
      })
    })

    it('exposes only off + max when only max is a variant', () => {
      expect(buildThinkingLevelMap(['max'])).toEqual({
        minimal: null,
        low: null,
        medium: null,
        high: null,
        max: 'max',
      })
    })

    it('maps the full vocabulary to only the explicit extended entries', () => {
      expect(buildThinkingLevelMap(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])).toEqual({
        xhigh: 'xhigh',
        max: 'max',
      })
    })

    it('ignores unknown names alongside known ones', () => {
      expect(buildThinkingLevelMap(['turbo', 'high'])).toEqual({
        minimal: null,
        low: null,
        medium: null,
      })
    })
  })
  ```
- [ ] Run `npm run test:run`
  - Did the new `buildThinkingLevelMap` tests fail because the export does not exist yet (vitest/esbuild reports a missing export at import time)? That is the expected first-run failure. If anything passes unexpectedly, stop and investigate why. Note: `npm run typecheck` only typechecks `src/` (tsconfig excludes `test/`), so test files are never part of that gate.
- [ ] Implement the types and helper in `src/types.ts` and `src/tama-api.ts` exactly as specified above.
- [ ] Run `npm run test:run`
  - Did all tests pass (new + pre-existing)? If not, fix the failures and re-run before continuing.
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix and re-run before continuing.
- [ ] Commit with message: `feat: add reasoning/variants endpoint types and buildThinkingLevelMap helper`

**Acceptance criteria:**
- [ ] `TamaModel` has optional `reasoning?: boolean` and `variants?: string[]`; `PiModel` has optional `thinkingLevelMap?: ThinkingLevelMap` imported from `@earendil-works/pi-ai`
- [ ] `buildThinkingLevelMap` is exported from `src/tama-api.ts` and all 8 new tests pass
- [ ] All pre-existing tests still pass unmodified; `npm run typecheck` is clean
- [ ] `transformModel` output is unchanged (no pre-existing test was edited in this task)

---

### Task 2: Wire reasoning/variants through `transformModel`

**Context:**
This task makes the transform actually consume the new fields: `reasoning: true` models get `reasoning: true`, the `thinkingLevelMap` from Task 1, and a per-model `compat.supportsReasoningEffort: true` override (required for pi to send `reasoning_effort` on the wire). Unknown variant names produce a `console.warn` (the helper itself stays pure). The one pre-existing test that pins the old hardcoded behavior (`always sets reasoning to false`) is renamed and re-scoped to the absent-field case.

**Files:**
- Modify: `src/tama-api.ts`
- Test: `test/tama-api.test.ts`

**What to implement:**

1. In `src/tama-api.ts`, modify `transformModel` (the non-overload implementation). Current body ends with a `return { ... }` where `reasoning: false` and `compat: { ...DEFAULT_COMPAT, ...backendCompat }`. Replace the tail of the function (from `const backendCompat = ...` to the end of the return object) with:

   ```ts
   const backendCompat = model.backend ? BACKEND_COMPAT[model.backend] : undefined

   // Reasoning: expose tama variants as pi thinking levels. pi sends
   // reasoning_effort only when model.reasoning && compat.supportsReasoningEffort.
   const isReasoning = model.reasoning === true
   if (isReasoning) {
     for (const variant of model.variants ?? []) {
       if (!KNOWN_LEVELS.includes(variant)) {
         console.warn(
           `[pi-provider-tama] Model ${model.id}: unrecognized reasoning variant "${variant}" — ignored`
         )
       }
     }
   }
   const thinkingLevelMap = isReasoning ? buildThinkingLevelMap(model.variants) : undefined

   return {
     id: model.id,
     name: model.name || model.id,
     reasoning: isReasoning,
     ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
     input,
     contextWindow,
     maxTokens,
     cost: {
       input: 0,
       output: 0,
       cacheRead: 0,
       cacheWrite: 0,
     },
     compat: { ...DEFAULT_COMPAT, ...backendCompat, ...(isReasoning ? { supportsReasoningEffort: true } : {}) },
     provider: 'tama',
     api: 'openai-completions',
     ...(baseUrl ? { baseUrl } : {}),
   }
   ```

   Notes:
   - The conditional spread `...(thinkingLevelMap ? { thinkingLevelMap } : {})` is intentional: when there is no map, the key must be absent entirely (the legacy `toEqual` test relies on exact object shape).
   - `isReasoning ? { supportsReasoningEffort: true } : {}` is spread LAST so a per-model truth overrides any backend-level default. `BACKEND_COMPAT` entries today do not set `supportsReasoningEffort`, but keep the order.
   - Keep both function overloads and their JSDoc untouched.

2. In `test/tama-api.test.ts`:
   - Replace the existing test:
     ```ts
     it('always sets reasoning to false', () => {
       const result = transformModel(baseModel)
       expect(result.reasoning).toBe(false)
     })
     ```
     with:
     ```ts
     it('defaults reasoning to false when field is absent', () => {
       const result = transformModel(baseModel)
       expect(result.reasoning).toBe(false)
     })
     ```
   - Add these new tests inside the `describe('transformModel', ...)` block (after the reasoning-defaults test). Use `vi` (already imported from vitest at the top of the file) for the console.warn spy:
     ```ts
     it('omits thinkingLevelMap key for legacy payloads (no reasoning field)', () => {
       const result = transformModel(baseModel)
       expect('thinkingLevelMap' in result).toBe(false)
     })

     it('sets reasoning true with no variants: no map, supportsReasoningEffort true', () => {
       const result = transformModel({ ...baseModel, reasoning: true })
       expect(result.reasoning).toBe(true)
       expect('thinkingLevelMap' in result).toBe(false)
       expect(result.compat).toEqual({
         supportsDeveloperRole: false,
         supportsReasoningEffort: true,
         maxTokensField: 'max_tokens',
       })
     })

     it('builds thinkingLevelMap from variants', () => {
       const result = transformModel({ ...baseModel, reasoning: true, variants: ['high', 'max'] })
       expect(result.reasoning).toBe(true)
       expect(result.thinkingLevelMap).toEqual({
         minimal: null,
         low: null,
         medium: null,
         max: 'max',
       })
       expect(result.compat!.supportsReasoningEffort).toBe(true)
     })

     it('warns and ignores unrecognized variant names, but keeps known ones', () => {
       const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
       const result = transformModel({
         ...baseModel,
         reasoning: true,
         variants: ['turbo', 'high'],
       })
       expect(warn).toHaveBeenCalledWith(
         expect.stringContaining('unrecognized reasoning variant "turbo"')
       )
       expect(result.thinkingLevelMap).toEqual({ minimal: null, low: null, medium: null })
       warn.mockRestore()
     })

     it('warns once per unrecognized name and no map when all variants are unknown', () => {
       const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
       const result = transformModel({ ...baseModel, reasoning: true, variants: ['turbo'] })
       expect(warn).toHaveBeenCalledTimes(1)
       expect('thinkingLevelMap' in result).toBe(false)
       warn.mockRestore()
     })

     it('does not warn for non-reasoning models with unknown variants', () => {
       const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
       const result = transformModel({ ...baseModel, reasoning: false, variants: ['turbo'] })
       expect(warn).not.toHaveBeenCalled()
       expect(result.reasoning).toBe(false)
       warn.mockRestore()
     })

     it('llama.cpp backend + reasoning: merges backend compat and adds supportsReasoningEffort', () => {
       const result = transformModel({
         ...baseModel,
         backend: 'llama.cpp',
         reasoning: true,
         variants: ['high'],
       })
       expect(result.compat).toEqual({
         supportsDeveloperRole: false,
         supportsReasoningEffort: true,
         maxTokensField: 'max_tokens',
         requiresToolResultName: false,
       })
     })
     ```
   - Do NOT touch the `transforms a minimal model` exact-`toEqual` test — it is the backward-compatibility guard and must pass unchanged.

**Steps:**
- [ ] Apply the test changes in `test/tama-api.test.ts` first (rename the old test, add the 7 new tests).
- [ ] Run `npm run test:run`
  - Did the new tests fail (e.g. `result.reasoning` is `false`, `thinkingLevelMap` undefined, no warn call)? If a new test passed unexpectedly, stop and investigate why.
- [ ] Modify `transformModel` in `src/tama-api.ts` exactly as specified.
- [ ] Run `npm run test:run`
  - Did ALL tests pass, including the untouched `transforms a minimal model` exact-match test? If not, fix the failures and re-run before continuing.
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix and re-run before continuing.
- [ ] Commit with message: `feat: expose tama reasoning variants as pi thinking levels`

**Acceptance criteria:**
- [ ] `transformModel({ reasoning: true, variants: ['high','max'] })` yields `reasoning: true`, `thinkingLevelMap: { minimal: null, low: null, medium: null, max: 'max' }`, and `compat.supportsReasoningEffort: true`
- [ ] Legacy payloads (no `reasoning` field) produce output with no `thinkingLevelMap` key, `reasoning: false`, `supportsReasoningEffort: false` — the exact-`toEqual` legacy test passes unchanged
- [ ] Unknown variant names log a `console.warn` containing the model id and variant name, only for `reasoning: true` models, and are excluded from the map
- [ ] Backend compat merging still works (llama.cpp test passes with the added `supportsReasoningEffort: true`)
- [ ] `npm run test:run` and `npm run typecheck` are clean

---

### Task 3: Include reasoning/variants in the reload change-detection fingerprint

**Context:**
`src/index.ts` decides whether a background refresh (on `/reload`) should re-register the provider by comparing a fingerprint of the model list. Today the fingerprint is the sorted list of model ids only, so a model that keeps its id but gains/loses `reasoning` or `variants` would never trigger re-registration and the user would not see the new thinking levels until restart. This task extends the fingerprint to include the two new fields. `modelsChanged` is module-private; it is tested indirectly through the factory's `session_start` reload handler, following the existing tests in `test/factory.test.ts`.

**Files:**
- Modify: `src/index.ts`
- Test: `test/factory.test.ts`

**What to implement:**

1. In `src/index.ts`:
   - Replace the module-level state declaration `let lastRegisteredModelIds: string[] = []` with:
     ```ts
     let lastRegisteredFingerprint: string = ''
     ```
   - Replace the `modelsChanged` function with:
     ```ts
     /** Fingerprint the model list for change detection: id + reasoning (+ variants when reasoning). */
     function fingerprint(models: TamaModel[]): string {
       return models
         .map(
           (m) =>
             `${m.id}|${m.reasoning ? 1 : 0}|${m.reasoning ? (m.variants ?? []).join(',') : ''}`
         )
         .sort()
         .join(';')
     }

     function modelsChanged(newModels: TamaModel[]): boolean {
       return fingerprint(newModels) !== lastRegisteredFingerprint
     }
     ```

     Note: variants are fingerprinted only when `m.reasoning` is true, because `transformModel` ignores `variants` entirely on non-reasoning models — fingerprinting them there would cause spurious re-registrations on irrelevant churn.
   - Replace BOTH assignments to `lastRegisteredModelIds` (one in the factory after the initial `pi.registerProvider(provider)`, one in the `session_start` reload handler after the re-registration) with `lastRegisteredFingerprint = fingerprint(models)` and `lastRegisteredFingerprint = fingerprint(freshModels)` respectively — i.e. keep the same local variable each site already used (`models` at the top level, `freshModels` in the handler).
   - Replace the reset line at the top of the factory (`lastRegisteredModelIds = []`) with `lastRegisteredFingerprint = ''`.
   - Change nothing else in `src/index.ts`.

2. In `test/factory.test.ts`, add this test inside the `describe('fetch-in-factory', ...)` block (place it right after the existing `background refresh skips when models unchanged` test):

   ```ts
   it('reload re-registers when reasoning capability changes on the same model ids', async () => {
     process.env.TAMA_URL = 'http://test.example:5678'
     vi.mocked(fetchTamaModels).mockResolvedValue([
       { id: 'model/one', name: 'Model One' },
     ])

     const pi = makeStub()
     await extension(pi as never)

     expect(pi.registerProvider).toHaveBeenCalledTimes(1)

     // Same ids, but the model now reports reasoning + variants
     vi.mocked(fetchTamaModels).mockResolvedValue([
       { id: 'model/one', name: 'Model One', reasoning: true, variants: ['high', 'max'] },
     ])
     const [, handler] = pi.on.mock.calls.find((c) => c[0] === 'session_start')!
     await (handler as (event: { reason?: string }) => Promise<void>)({ reason: 'reload' })
     await vi.advanceTimersByTimeAsync(1)

     expect(pi.registerProvider).toHaveBeenCalledTimes(2)
   })
   ```

   Note: `test/factory.test.ts` mocks `../src/tama-api` wholesale, so `transformModel` is a pass-through stub there — the fingerprint change is in `src/index.ts` and works on raw `TamaModel` fields, which is exactly what this test exercises. Do NOT modify the existing `background refresh skips when models unchanged` test; it must keep passing (same ids, no new fields → identical fingerprint → no re-registration).

**Steps:**
- [ ] Add the new test in `test/factory.test.ts` first.
- [ ] Run `npm run test:run`
  - Did the new test fail with `registerProvider` called 1 time instead of 2? If it passed unexpectedly, stop and investigate why.
- [ ] Apply the `src/index.ts` changes exactly as specified.
- [ ] Run `npm run test:run`
  - Did ALL tests pass, including the untouched `background refresh skips when models unchanged`? If not, fix the failures and re-run before continuing.
- [ ] Run `npm run typecheck`
  - Did it succeed? If not, fix and re-run before continuing.
- [ ] Commit with message: `fix: include reasoning/variants in model-change fingerprint for reload refresh`

**Acceptance criteria:**
- [ ] Same model ids with a flipped `reasoning` field (or changed `variants`) on reload cause a second `pi.registerProvider` call
- [ ] Identical model lists (with or without the new fields, consistently) still skip re-registration
- [ ] No reference to `lastRegisteredModelIds` remains in `src/index.ts`
- [ ] `npm run test:run` and `npm run typecheck` are clean

---

### Task 4: README documentation + version bump to 0.14.0

**Context:**
The feature is complete but undocumented, and `package.json` still says 0.13.0. This task documents the two new endpoint fields and the wire contract for tama (so someone building the tama side knows what to implement), and bumps the version to 0.14.0 (minor: additive, backward-compatible — old tama servers that omit the fields produce exactly the same pi models as before).

**Files:**
- Modify: `README.md`
- Modify: `package.json`

**What to implement:**

1. In `README.md`:
   - In the `## How it works` section, add a new subsection `### Reasoning & thinking levels` at the end of that section, immediately before `## Migrating from pi-tama`, with exactly this content:
     ```md
     ### Reasoning & thinking levels

     Tama models that report `"reasoning": true` on `/v1/opencode/models` are registered in pi with thinking-level support. The optional `variants` array (named reasoning-effort overlays) maps onto pi's thinking levels:

     - Each variant name from pi's vocabulary (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`) is offered as a thinking level in pi's picker.
     - When the user picks a level, pi sends `reasoning_effort: "<level>"` in the chat-completions request body. **Tama's chat endpoint must consume `reasoning_effort` and apply the matching variant.**
     - Picking `off` sends no `reasoning_effort` field — tama runs its default behavior.
     - Variant names outside pi's vocabulary are ignored with a warning in pi's console.
     - `reasoning: true` without `variants` offers pi's default levels (`off`–`high`).
     - Models without `reasoning` (or on older tama servers that omit the field) behave exactly as before.
     ```
   - Do not restructure or rewrite any other part of the README.

2. In `README.md`, additionally update the now-stale fixed-registration description in `## How it works` (do not touch anything else there):
   - In the field-mapping table, add two rows after the `modalities.input` row:
     ```md
     | `reasoning`                          | `reasoning`       | `false`                     |
     | `variants` (reasoning models only)    | `thinkingLevelMap` | omitted (pi default levels)  |
     ```
   - In the "All models are registered with:" bullet list, replace the bullet `` - `reasoning: false` `` with:
     ```md
     - `reasoning: false` — except models that report `"reasoning": true` on the endpoint, which are registered with `reasoning: true` and a `thinkingLevelMap` built from `variants` (see [Reasoning & thinking levels](#reasoning--thinking-levels))
     ```

3. In `package.json`:
   - Change `"version": "0.13.0"` to `"version": "0.14.0"`.
   - Change nothing else in `package.json`.

**Steps:**
- [ ] Add the README subsection and the two table rows, and update the stale `reasoning: false` bullet exactly as specified.
- [ ] Bump the version in `package.json`.
- [ ] Run `npm run test:run`
  - Did all tests pass? (No code changes in this task — this is a sanity guard.) If not, fix and re-run before continuing.
- [ ] Commit with message: `docs: document reasoning/variants support; bump 0.14.0`

**Acceptance criteria:**
- [ ] README `## How it works` contains the `### Reasoning & thinking levels` subsection with the wire contract (tama consumes `reasoning_effort`)
- [ ] README mapping table has `reasoning` and `variants` rows; no bullet claims every model is registered with `reasoning: false` unconditionally
- [ ] `package.json` version is `0.14.0`
- [ ] All tests still pass
