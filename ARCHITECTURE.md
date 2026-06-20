# Architecture Map

A one-page orientation for humans and AI. For the detailed engineering rules and
refactor history see [AGENTS.md](AGENTS.md); for product vision see
`docs_and_plan/ideas.md` (kept outside the repo).

## The three processes

| Part | Tech | Role |
| --- | --- | --- |
| **Frontend** | React + TypeScript + Vite (`src/`) | UI only. Talks to the sidecar over localhost HTTP. |
| **Sidecar** | Python + FastAPI (`sidecar/`) | Owns NovelAI/LLM/vibe/upscale/metadata/tagger, SQLite history, file storage, and the OS-keychain token. |
| **Desktop shell** | Tauri 2 (`src-tauri/`) | Wraps the frontend; spawns + supervises the sidecar (`src-tauri/src/lib.rs`, port negotiation + cleanup). |
| **Legacy backend** | Python (`server/app.py`) | **Quarantined.** Old standalone monolith; optional cloud/queue/workshop adapter surface. Do not add features here. |

## The one boundary rule

```
UI component → domain hook/service → src/api/sidecar.ts (sidecarApi) → sidecar
```

- The frontend **never** calls NovelAI directly and **never** holds the NovelAI token.
  The token lives only in the OS secret store, managed by `sidecar/credentials.py`.
- New frontend → backend calls go through **`src/api/sidecar.ts`** (`sidecarApi`).
  Do not introduce new `getBackendUrl()` / `buildApiUrl()` (legacy backend) calls.
- `getBackendUrl()` / `getQueueServerUrl()` (`src/utils/apiConfig.ts`) are the **legacy/cloud**
  adapter surface (bot auth, cloud vibe sync, workshop, billing, KKT, banana). Intentional; not for new local features.

## Frontend layout (`src/`)

- **`api/sidecar.ts`** — the single sidecar HTTP client (`sidecarApi`, `requestJson`, port discovery).
- **`services/`** — domain logic (no JSX):
  - `bot/` — bot auth/session + task polling (`botSession`), legacy cloud adapter (`cloudLibraryAdapter`), online count.
  - `tag-autocomplete/` — `types`, `suggestionCache`, `ranking`, `remoteClient`, `wiki`, `localSearch`, `translation`; orchestrated by `tagAutocomplete.ts`.
  - `publicLibrary/` — vibe/OC/artist/CR CRUD **via sidecar** (`sidecarApi`).
  - `localLibrary/` — browser-local (localStorage/IndexedDB) settings, auth flag (`authSession`), presets.
  - `novelai.ts` — typed compatibility facade over the sidecar (no direct NovelAI calls).
  - `translate.ts`, `upscaleService.ts`, `backupService.ts`, `agentService.ts`, `queueService.ts`, …
- **`components/`** — UI. Desktop at the top level; mobile under `components/mobile/`. Large surfaces are split by
  domain into subfolders (`settings/`, `oc/`, `artist/`, `cr/`, `vibe/`, `inpaint/`, `prompt-editor/`,
  `desktop-chip-editor/`, `workshop/`, `mobile/*`).
- **`contexts/`** — `AuthContext`, `GenerationContext`, `DragDropContext`.
- **`hooks/`**, **`stores/`** (zustand `taskStore`), **`utils/`** (`apiConfig`, `imageMetadata`,
  `characterRecognition`, `weightConversion`, `promptTags`, …), **`types/`**, **`data/`**.

## Sidecar layout (`sidecar/`)

- **`server.py`** — `create_app(settings)`; core routes: `/generate`, `/vibe/encode`, `/upscale`,
  `/api/anlas`, `/auth/token*`, `/history`, `/settings`, `/api/translate/*`, `/agent/generate-prompt`,
  tag-translation endpoints. Calls `register_library_routes`.
- **`library_routes.py`** + `library_{vibes,ocs,artists,cr,assets,files,tables}.py` — local library CRUD
  (`/api/{vibes,oc,artists,cr}/*`) backed by SQLite + asset files.
- **`nai/`** (`client.py`, `models.py`) — NovelAI API client (+ `_sanitize_for_log` redaction).
- **`llm/`** (`client.py`, `prompts.py`) — LLM prompt conversion.
- **`db.py`** (SQLite), **`credentials.py`** (OS keychain), **`config.py`** (`Settings`, env + data dir),
  **`storage.py`**, **`local_settings.py`**. Tests in `sidecar/tests/`.

## Where new code goes

- **New backend capability:** add logic to a `sidecar/` module → register a route (in `server.py` or a
  `register_*_routes`) → expose a method on `sidecarApi` → call it from a frontend hook/service. Add a
  `sidecar/tests/test_*.py`.
- **New UI:** a component (+ a hook for stateful logic) under the matching `components/` domain folder;
  shared state via an existing context or a new one. Keep files ≲300 lines; split by responsibility
  (section components + domain hooks + pure helpers).

## Conventions

- Line endings are **LF** (`.gitattributes`); style in `.editorconfig`.
- **Never log** token / cookie / Authorization / full base64 image payloads.
- Per change, run: `npm run build`, `npm run scan:secrets`, `npm run test:sidecar`, `git diff --check`
  (and `cargo check --manifest-path src-tauri/Cargo.toml` if Rust changed).
- Don't commit build output (`dist/`).
