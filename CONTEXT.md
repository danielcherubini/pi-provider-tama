# pi-provider-tama

Pi extension that auto-detects a running Tama server, fetches its model list from `/v1/opencode/models`, and registers it as a pi provider.

## Language

**Variant**:
A named reasoning-effort overlay that Tama exposes per model on `/v1/opencode/models` (`variants: string[]`). Surfaced in pi as a thinking level via the model's `thinkingLevelMap`.
_Avoid_: Model variant, config overlay, effort preset
