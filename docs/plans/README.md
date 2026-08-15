# Plans

## Quick Stats

| Metric | Count |
|--------|-------|
| Total Plans | 5 |
| Completed | 5 |
| Backlog | 0 |

## Completed Plans

| Plan | Status | Description | PR | Commits |
|------|--------|-------------|-----|---------|
| [done/plan-001](./done/plan-001-model-caching.md) | ✅ Completed | Model caching — eliminate startup blocking on slow networks by caching Tama models locally and refreshing in background | [#3](https://github.com/danielcherubini/pi-provider-tama/pull/3) | Squashed to main |
| [done/plan-002](./done/plan-002-v081-features.md) | ✅ Completed | v0.81.0 feature adoption — migrate to official @earendil-works packages, createProvider() with dual-path auth, backend-aware compat | [#4](https://github.com/danielcherubini/pi-provider-tama/pull/4) | Squashed to main |
| [done/plan-003](./done/plan-003-drop-cache.md) | ✅ Completed | Drop custom cache — use pi's ModelsStore via fetchModels for built-in persistence | [#4](https://github.com/danielcherubini/pi-provider-tama/pull/4) | Squashed to main |
| [done/plan-004](./done/plan-004-reasoning-variants.md) | ✅ Completed | Reasoning & variants — parse tama's new `reasoning`/`variants` endpoint fields into pi thinking levels (0.14.0) | — | Squashed to main (`0be8e01`) |
| [done/plan-005](./done/plan-005-reasoning-levels.md) | ✅ Completed | Editor-configured reasoning levels — map tama's `supportsReasoningEffort`/`reasoningLevels` (plan-189) into pi `thinkingLevelMap` with `off` → `none` wire translation, priority over `variants` (0.16.0) | — | In review (`feature/reasoning-levels-mapping`) |

## Backlog

(No pending plans)
