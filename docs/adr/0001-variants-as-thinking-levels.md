# Map tama variants to pi thinking levels

Tama's `/v1/opencode/models` endpoint exposes `variants: string[]` — named reasoning-effort overlays per model. Pi's model format has no "variant" concept; its only per-request selectable mechanism is `thinkingLevelMap`, which maps pi's fixed thinking-level vocabulary (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) to values sent as `reasoning_effort`. We decided to map each recognized variant name 1:1 to a pi thinking level, so a variant appears as a level in pi's thinking picker.

## Considered Options

- **One pi model per variant** (e.g. `qwen3:high`): rejected — pollutes the model list, breaks the model-id contract with tama's chat endpoint, and pi would still differentiate requests only via `reasoning_effort`.
- **Custom wire field** (e.g. `samplingParams: { variant }`): rejected — pi's `samplingParams` is fixed per model and merged into *every* request; it cannot vary per request, so pi could never let the user pick.
- **Name→level mapping table** for arbitrary variant names: deferred — tama will use the pi vocabulary; unrecognized names are dropped with a `console.warn` for now.

## Consequences

Variant names must come from pi's thinking-level vocabulary to surface in the UI. If tama later needs arbitrary variant names (e.g. `turbo`), this mapping must be extended (mapping table or a pi-side feature) — the endpoint contract itself won't change.
