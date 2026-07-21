# pi-provider-tama

[Pi agent](https://pi.dev) extension that auto-discovers models from a local [tama](https://github.com/danielcherubini/tama) server and registers them as a provider.

## What it does

When pi starts (or on `/reload`), this extension:

1. Auto-detects tama on ports `11434` or `8080`
2. Fetches available models from tama's API
3. Registers a `tama` provider in pi with all discovered models
4. Background-refreshes models on each new session (`session_start`)

Models appear in `/model` immediately — no manual `models.json` editing needed.

## Installation

### Option A: npm (recommended)

```bash
pi install npm:pi-provider-tama
```

### Option B: git

```bash
pi install git:github.com/danielcherubini/pi-provider-tama
```

Use `-l` to install to project scope (`.pi/settings.json`) instead of global:

```bash
pi install -l npm:pi-provider-tama
```

### Option C: Local development

```bash
git clone https://github.com/danielcherubini/pi-provider-tama.git
cd pi-provider-tama
npm install

# Install from local path
pi install ./pi-provider-tama
```

## Configuration

By default, the extension auto-detects tama on `127.0.0.1:11434` and `127.0.0.1:8080`.

No configuration is needed if tama is running locally on the default port.

### Remote tama server

Add the tama URL to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["npm:pi-provider-tama"],
  "pi-provider-tama": {
    "url": "http://myserver:11434"
  }
}
```

Or use the `TAMA_URL` environment variable (takes priority over settings.json):

```bash
export TAMA_URL=http://myserver:11434
```

**Priority order:** `TAMA_URL` env var → `settings.json` → auto-detect localhost

### Authentication

#### Interactive login (primary)

Run `/login tama` in the pi chat. You'll be prompted to choose a token source:

- **Enter token** — type or paste your tama API token interactively
- **Use TAMA_TOKEN env var** — delegates to the fallback path below

The stored credential is cached and reused on every provider registration until you run `/login tama` again.

#### Fallback sources (env var / settings.json)

If you prefer not to use interactive login, or as a backup when tama requires auth but no token was stored:

1. **`TAMA_TOKEN` environment variable** (highest priority):

   ```bash
   export TAMA_TOKEN=your-token-here
   ```

2. **`token` field in `~/.pi/agent/settings.json`**:

   ```json
   {
     "packages": ["npm:pi-provider-tama"],
     "pi-provider-tama": {
       "url": "https://tama.example.com",
       "token": "your-token-here"
     }
   }
   ```

The token is sent as `Authorization: Bearer <token>` on both model discovery and inference requests. When unset, no auth header is sent (fine for localhost).

**Priority order:** stored credential → `TAMA_TOKEN` env var → `settings.json` token → fallback `"tama"`

## New in v0.81.0

### Interactive auth via `/login tama`

The extension now supports interactive login through pi's auth system. Run `/login tama` to securely enter your API token without exposing it in environment variables or config files. The credential is stored and automatically resolved on every provider registration cycle.

See the [Authentication](#authentication) section above for full details on the dual-path auth flow.

### Backend-aware per-model compatibility

Each tama model now carries compatibility flags derived from its upstream backend metadata (`llama.cpp`, `ONNX`, etc.). The extension maps backends to the right `compat` settings automatically — for example, `llama.cpp` backends get `maxTokensField: "max_tokens"` and `requiresToolResultName: false`, while unknown backends receive sensible defaults.

No manual configuration needed; the flags are applied per-model at registration time.

### Context overflow auto-compaction

pi v0.81.0 includes built-in context overflow detection (`isContextOverflow()`), which handles common overflow patterns from llama.cpp, Ollama, LM Studio, and other local backends. The extension no longer needs custom overflow handling — pi auto-compacts when the context exceeds available space.

### Official package dependencies

This extension now depends on `@earendil-works/pi-coding-agent` (v0.81.0+) and `@earendil-works/pi-ai` (v0.81.0+), replacing the previous `@mariozechner/pi-coding-agent` fork. The migration brings native `createProvider()` support, cleaner auth wiring, and up-to-date type definitions.

## How it works

The extension is an **async factory**: pi awaits it before resolving which
models are available, so every tama model is registered before pi decides
what's selectable.

On startup the factory:

1. Resolves the tama URL/token (env → `settings.json` → auto-detect localhost).
2. Fetches the live model list from `/v1/opencode/models`.
3. Creates a `createProvider()`-based provider and registers it with pi.

It also re-runs the same flow on `session_start`, so `/reload` picks up
models that were added to tama after pi started. A new session ID is
generated each cycle for Langfuse tracing.

> Requires pi ≥ v0.81.0 with async-factory and `createProvider()` support (pi-mono ≥ Jan 2026). If tama is offline when pi boots, no tama models register — bring tama up and run `/reload`.

Discovered models are mapped to pi's provider format:

| Tama field                          | Pi field        | Fallback                      |
| ----------------------------------- | --------------- | ----------------------------- |
| `id` (lowercased HF repo)           | model `id`      | —                             |
| `name` (pretty display)             | model `name`    | `id`                          |
| `context_length` or `limit.context` | `contextWindow` | `128000`                      |
| `limit.output`                      | `maxTokens`     | `contextWindow / 16` or `8192`|
| `modalities.input`                  | `input`         | `["text"]`                    |

All models are registered with:

- `api: "openai-completions"` (OpenAI-compatible)
- `reasoning: false`
- `cost: { input: 0, output: 0, ... }` (local = free)
- `compat:` merged from default + backend-specific overrides (see [Backend-aware compat](#backend-aware-per-model-compat))
- `provider: "tama"`, `api: "openai-completions"` for pi's internal routing

## Migrating from pi-tama

This package was previously published as `pi-tama`. To migrate:

1. Reinstall: `pi install npm:pi-provider-tama`
2. Rename the settings key in `~/.pi/agent/settings.json` from `"pi-tama"` to `"pi-provider-tama"`
3. Uninstall the old package

## Development

```bash
npm install
npm test          # Run tests in watch mode
npm run test:run  # Run tests once
npm run typecheck # Type check
```

## Requirements

- [tama](https://github.com/danielcherubini/tama) running locally with `tama serve`
- [pi](https://pi.dev) ≥ v0.81.0 (with async-factory and `createProvider()` support)
- Peer dependency: `@earendil-works/pi-coding-agent` ^0.81.0, `@earendil-works/pi-ai` ^0.81.0

## License

MIT
