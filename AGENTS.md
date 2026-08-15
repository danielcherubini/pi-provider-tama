# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

`pi-provider-tama` is a pi agent extension (TypeScript, ESM, no build step) that auto-detects a running [tama](http://127.0.0.1:11434) local-AI server, fetches its model list from `/v1/opencode/models`, and registers it as a pi provider via `createProvider()`.

## Build & Testing (validation gate)

Run these before committing/merging — both must pass:

```bash
npm run test:run    # vitest, non-watch (CI) mode
npm run typecheck   # tsc --noEmit (strict; covers src/ only — test/ is excluded by tsconfig)
```

Other scripts:

```bash
npm run test        # vitest watch mode (local dev only)
npm run lint        # KNOWN BROKEN: eslint is not installed as a devDependency — do not rely on it as a gate
```

There is **no formatter** configured. Do not add one; match the existing style (no semicolons, single quotes, 2-space indent).

## Conventions

- Conventional commits (`feat:` / `fix:` / `docs:` / ...), one commit per logical change.
- Plans live in `docs/plans/` (index: `docs/plans/README.md`; completed plans move to `docs/plans/done/`). ADRs: `docs/adr/`. Project glossary: `CONTEXT.md`.
- `src/` layout: `index.ts` (extension factory + provider registration + reload refresh), `tama-api.ts` (endpoint helpers + `transformModel`), `auth.ts` (login/credential resolution), `types.ts` (endpoint + pi model types).
- Backward compatibility is a hard requirement: payloads from older tama servers (without new optional fields) must transform identically to before — the exact-`toEqual` test `transforms a minimal model` in `test/tama-api.test.ts` is the guard.
