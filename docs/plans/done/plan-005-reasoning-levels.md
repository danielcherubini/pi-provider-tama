# Editor-Configured Reasoning Levels Plan

**Status:** ✅ Completed (0.16.0) — companion to tama's plan-189 (`feature/189-model-reasoning-effort`, commits `d5ed478a..ef9821a4`)

**Goal:** Map the new editor-configured `supportsReasoningEffort` / `reasoningLevels` fields emitted by tama's `/v1/opencode/models` endpoint into pi's `thinkingLevelMap`, taking priority over the existing `variants` fallback.

**Architecture:** When a model carries a non-empty `reasoningLevels` array (with `supportsReasoningEffort: true`), those levels — pi's 7-level vocabulary `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — are the authoritative source: each listed level maps to itself (except `off` → wire string `"none"`, per tama repo ADR-0009: no backend accepts `off`), and each unlisted level maps to an explicit `null` (absent keys would mean "supported via provider default" in pi). Levels outside pi's vocabulary are dropped defensively. When the fields are absent, the plan-004 `variants` path runs unchanged.

**Tech Stack:** TypeScript, vitest, `@earendil-works/pi-ai` `ThinkingLevelMap` type, existing `transformModel` in `src/tama-api.ts`.

**Background (read before executing):** pi sends `reasoning_effort` only when `model.reasoning === true` AND `compat.supportsReasoningEffort === true`. Backward compatibility is mandatory: a tama server that does NOT send the new fields must produce byte-identical output to before (the exact-`toEqual` test `transforms a minimal model` is the guard).

**Commands used throughout:**
- Tests: `npm run test:run`
- Typecheck: `npm run typecheck`
- There is no formatter configured in this repo. Do not add one.

---

### Task 1: `TamaModel` endpoint fields + `buildThinkingLevelMapFromLevels`

**Files:** `src/types.ts`, `src/tama-api.ts`, `test/tama-api.test.ts`

- `TamaModel` gains `supportsReasoningEffort?: boolean` and `reasoningLevels?: string[]` (camelCase, as emitted by tama).
- New exported helper `buildThinkingLevelMapFromLevels(levels?)` next to the existing `buildThinkingLevelMap(variants?)` (which stays untouched).
- 6 new helper tests + 5 `transformModel` cases (levels mapping with `off` → `"none"`, byte-identical legacy output, unknown-level dropping, levels-over-variants priority, variants fallback).

- [x] RED: new tests fail against the old mapping
- [x] GREEN: all 112 tests pass (97 pre-existing + 15 new), typecheck clean

### Task 2: Wire the priority logic into `transformModel`

**Files:** `src/tama-api.ts`

```ts
const hasLevels =
  (model.supportsReasoningEffort ?? false) && (model.reasoningLevels?.length ?? 0) > 0
const levelsMap = hasLevels ? buildThinkingLevelMapFromLevels(model.reasoningLevels) : undefined
const isReasoning = levelsMap !== undefined || model.reasoning === true
const thinkingLevelMap = levelsMap ?? (isReasoning ? buildThinkingLevelMap(model.variants) : undefined)
```

Note: an all-out-of-vocabulary `reasoningLevels` list makes `buildThinkingLevelMapFromLevels` return `undefined`, so `levelsMap` collapses to `undefined` and the transform falls through to the `model.reasoning`/variants path. Everything else in the returned object stays as-is (`reasoning: isReasoning`, the existing compat spread, no `thinkingFormat`). The `console.warn` loop for unrecognized variant names is kept as-is.

- [x] Levels take priority over variants when both are present
- [x] All pre-existing tests pass unchanged

### Task 3: README + version bump to 0.16.0

**Files:** `README.md`, `package.json`, `docs/plans/README.md`

- README "Reasoning & thinking levels" documents the new priority (editor-configured levels first, `off` → wire `"none"`, explicit `null` holes) and the variants fallback.
- Field-mapping table gains the `supportsReasoningEffort` + `reasoningLevels` row.
- Version bump `0.15.0` → `0.16.0` (new capability).

- [x] Docs updated, version bumped, all gates green

**Acceptance criteria (all met):**
- [x] A tama model with levels `off, low, medium, xhigh` yields `reasoning: true`, `compat.supportsReasoningEffort: true`, and the exact 7-key `thinkingLevelMap` `{ off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null }`
- [x] Models without the new fields behave EXACTLY as before (all pre-existing tests pass unchanged)
- [x] `npm run test:run` and `npm run typecheck` green
