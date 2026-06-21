# Architecture Map

A detailed orientation for humans and AI. For the engineering rules and refactor
history see [AGENTS.md](AGENTS.md); for product vision see `docs_and_plan/ideas.md`
(kept outside the repo). Read this first to orient, then AGENTS.md for the rules.

## The three processes (+ one quarantine)

| Part | Tech | Owns (nothing else may) |
| --- | --- | --- |
| **Desktop shell** | Tauri 2 / Rust (`src-tauri/`) | Spawns + supervises the sidecar, negotiates its port, hosts the webview. The only process that spawns a child. |
| **Frontend** | React + TS + Vite (`src/`) | UI + domain logic only. Never calls NovelAI, never holds the token, never loads inference models. |
| **Sidecar** | Python + FastAPI (`sidecar/`) | NovelAI calls, LLM, vibe encode, upscale, metadata, tags/wiki, SQLite, files, OS credentials. The backend truth lives here. |
| **Legacy (quarantined)** | Python (`server/app.py`) + cloud adapters | Old standalone monolith + public bot/QQ/queue/workshop service. Read-only; do not add features. Being superseded by the sidecar. |

## Startup & connection (how the two halves find each other)

1. Tauri `spawn_python_sidecar()` runs `python -m sidecar.server`.
2. **Port negotiation:** reads `ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT` (default `38176`);
   `available_port()` scans upward to **38210** for the first free port and passes the
   chosen port back to Python via the same env var.
   `ULTIMATE_NOVELAI_LAUNCHER_SKIP_SIDECAR=1` skips the spawn (for `npm run sidecar` dev).
3. The frontend never assumes the port. `resolveSidecarUrl()` in
   [src/api/sidecar.ts](src/api/sidecar.ts) probes `/health` across candidate ports
   (`38176–38210`, `8766–8795`, `8765`), accepts `{ok:true}`, then **caches the URL in
   localStorage** (`ultimate_novelai_launcher_sidecar_url`) for subsequent direct calls.
4. All requests then go through `requestJson` / `requestBlob`, which prepend the resolved base URL.

## The one boundary rule, and the two doors

```
UI component → domain hook/service → src/api/sidecar.ts (sidecarApi) → sidecar
```

- **Main door (use this for all new code):** `sidecarApi`. Everything local — generation,
  library, tags, LLM, settings, credentials — enters here.
- **Side door (legacy, do not extend):** `getBackendUrl()` / `getQueueServerUrl()` in
  [src/utils/apiConfig.ts](src/utils/apiConfig.ts). Used only by intentionally-retained
  external surfaces (bot/QQ auth, cloud vibe sync, workshop, billing, KKT, banana).
  - **Important fallback:** `getBackendUrl()` returns the user's `backendUrl` **only** when
    `serverMode === 'custom'`. In `public`/default mode it falls back to **the local sidecar**.
    So legacy `/api/bot/*`, `/ws/bot`, `/api/task/*`, `/ws/queue` calls only reach a real
    backend when the user sets server mode to *custom* and points it at a deployed `server/app.py`.
    The sidecar implements none of those routes.
- Iron rules: the frontend never calls NovelAI directly and never holds the token. The token
  lives only in the OS secret store, managed by [sidecar/credentials.py](sidecar/credentials.py).

## Sidecar (`sidecar/`, ~3.9k lines)

### Modules

| Module | Role |
| --- | --- |
| [server.py](sidecar/server.py) | `create_app(settings)`; mounts core routes; calls `register_library_routes` + `register_tag_routes`. |
| [tags.py](sidecar/tags.py) | Danbooru proxy (`curl_cffi` Chrome-TLS impersonation to pass Cloudflare) + wiki + LLM-backed Chinese summary / related. |
| [credentials.py](sidecar/credentials.py) | Cross-platform secret store: macOS `security`, Windows `Cred*` (ctypes), Linux `secret-tool`. Raises if no secure store — **never writes plaintext**. |
| [nai/client.py](sidecar/nai/client.py) | NovelAI HTTP client + `_sanitize_for_log` redaction. `nai/models.py` = model catalog. |
| [llm/client.py](sidecar/llm/client.py) | Multi-provider (OpenAI / Anthropic / Gemini) + primary→backup fallback. `llm/prompts.py` = templates. |
| [db.py](sidecar/db.py) | SQLite connection + history/translation tables. |
| [library_routes.py](sidecar/library_routes.py) + `library_{vibes,assets,artists,ocs,cr,tables,files}.py` | Local library CRUD + SQLite table defs. |
| `config.py` / `local_settings.py` / `storage.py` | `Settings` (incl. `llm_slots()`), non-secret settings, path/file helpers. |

### Endpoint catalog (the backend contract)

**Core / infra** — [server.py](sidecar/server.py)
- `GET /health` · `GET|POST /settings`
- Credentials: `GET|POST|DELETE /auth/token` · `GET|POST|DELETE /auth/llm-key` (POST/DELETE take `slot=primary|backup`)

**Generation / images**
- `POST /generate` · `GET /generation/tasks` · `POST /generation/tasks/{id}/cancel`
- `GET /history` · `GET /images/{image_id}`

**NovelAI capabilities**
- `POST /vibe/encode` · `POST /upscale` · `GET /api/anlas` · `GET /api/nai-status`

**LLM / agent / translation**
- `POST /agent/generate-prompt` · `POST /api/agent/web/generate-prompt`
- `POST /api/translate/en2zh` · `POST /api/translate/proxy`
- `POST /api/tags/translations/lookup` · `POST /api/tags/translations/submit`

**Metadata / data / presence**
- `POST /metadata/import` · `GET /api/data/{filename}` · `POST /api/online/heartbeat` · `GET /api/online/count`

**Local library CRUD** — [library_routes.py](sidecar/library_routes.py)
- OC: `list / create / preview/{id} / PUT {name} / DELETE {name}`
- Vibe: `list / upload / thumbnail / file (GET/PUT/DELETE) / encoding / download`
- Artist: `list / create / preview / PUT / DELETE / {name}/use`
- CR: `list / create / preview / PUT / DELETE`

**Tags / wiki** — [tags.py](sidecar/tags.py)
- `GET /api/tags/autocomplete` · `POST /api/tags/verify`
- `GET /api/tags/wiki` · `POST /api/tags/wiki-exists-batch`
- `GET /api/tags/wiki-preview` · `GET /api/tags/wiki-preview-summary-zh`
- `POST /api/tags/search` · `POST /api/tags/related`

> The sidecar has **no** bot / QQ / auth-code / queue / websocket endpoints. Those exist
> only in the legacy backend.

## Where data lives (three stores, non-overlapping)

| Store | Location | Contents |
| --- | --- | --- |
| **SQLite** | sidecar data dir | `generations` (+ `created_at` index), `tag_translations`, `ocs`, `artists`, `crs`, `vibes` |
| **OS secret store** | system | 3 accounts (service `Ultimate Novelai launcher`): `novelai-token`, `llm-api-key`, `llm-api-key-backup` |
| **Files** | sidecar data dir | generated images, vibe files/thumbnails, OC/artist/CR previews |
| Frontend localStorage / IndexedDB | browser | **non-secret only**: UI settings, a `token-configured` boolean flag, presets, vibe cache, the resolved sidecar URL |

> Security invariants: token/key never reach the frontend and are never stored in plaintext.
> Env vars (`LLM_API_KEY` / `LLM_BACKUP_API_KEY` / NovelAI token) take precedence over UI-entered values.

## Frontend layout (`src/`, ~85k lines)

- **Entry / layout:** `main.tsx` → [App.tsx](src/App.tsx) code-splits desktop vs mobile by
  **window width** (`< 768`) via `React.lazy`, and idle-prefetches the other layout to avoid a
  resize flash → `AppContent` / `MobileAppContent`.
- **`api/`** — only [sidecar.ts](src/api/sidecar.ts): the single HTTP client + port discovery + all `sidecarApi.*` methods.
- **`services/`** — domain logic, no JSX:
  - `bot/` — `botSession` (bot auth/session + task polling), `cloudLibraryAdapter` (legacy cloud), `onlineService`; `botService.ts` is a thin re-export facade (~24 importers).
  - `tag-autocomplete/` — `types / suggestionCache / ranking / remoteClient / wiki / localSearch / translation`, orchestrated by `tagAutocomplete.ts`.
  - `publicLibrary/` — vibe/oc/artist/cr/session, **all via sidecar**.
  - `localLibrary/` (26 files) — browser-local settings, `authSession` (flag only), presets, vibe cache, `idb`.
  - top level — `novelai.ts` (typed sidecar facade, no direct calls), `translate / upscaleService / backupService / agentService / queueService / costCalculator / tagRelated / tokenizer / wdTagger / naiStatus`, …
- **`components/`** — desktop at top level, mobile under `mobile/`. Large surfaces split by domain:
  `artist · cr · vibe · oc · inpaint · prompt-editor · desktop-chip-editor · tag-manager · inspiration · left-sidebar · settings · generation · workshop · desktop · mobile/*`.
- **`contexts/`** — `AuthContext · GenerationContext · DragDropContext`. **`stores/`** — `taskStore` (zustand).

## Legacy / cloud / bot surface (intentionally retained, do not extend)

- [server/app.py](server/app.py) — the old ~9k-line monolith. Quarantined: NovelAI/vibe/upscale/anlas
  duplicated here historically, plus the bot/QQ + queue business. No new features; migrate active
  behavior to the sidecar instead.
- **Bot / QQ business** lives **entirely** in the legacy backend, reached via the side door:
  - Frontend ([src/services/bot/botSession.ts](src/services/bot/botSession.ts)) calls
    `/api/bot/auth/generate` → `/api/bot/auth/check` → `/ws/bot` → `/api/bot/generate` →
    `/api/bot/auth/validate`, plus `/api/task/{id}` and `/ws/queue`.
  - Legacy backend binds an auth code to a `bot_user_id` (QQ number) via `bot_auth_manager` /
    `verify_auth_code`, and runs the shared queue.
  - The actual QQ bot program (the thing logged into QQ) is **not in this repo** — it is the original
    author's external public service. Whether it works depends on that service + a deployed
    `server/app.py`, not on this codebase.
  - This identity underpins login, anlas/points, cloud library (OC/artist/vibe/tag), workshop, billing.
- Other side-door services: `kktService`, `bananaService`, `workshop/workshopApi`, billing/platform-stats,
  `cloudLibraryAdapter`, `queueService` — all via `getBackendUrl()` / `getQueueServerUrl()`.

## Where new code goes

- **New backend capability:** add a `sidecar/` module → register a route → expose a `sidecarApi`
  method → call it from a frontend hook/service → add `sidecar/tests/test_*.py`.
- **New UI:** a component (+ a hook for state) under the matching `components/` domain folder; shared
  state via an existing context. Keep files ≲300 lines; split by responsibility when they grow.
- **Do not:** call NovelAI from the frontend, store the token in plaintext, add features to
  `server/app.py`, introduce new `getBackendUrl()` calls, or commit `dist/`.

## Conventions

- Line endings are **LF** (`.gitattributes`); style in `.editorconfig`.
- **Never log** token / cookie / Authorization / full base64 image payloads (not even previews).
- Per change run: `npm run build`, `npm run scan:secrets`, `npm run test:sidecar`, `git diff --check`
  (and `cargo check --manifest-path src-tauri/Cargo.toml` if Rust changed).
- Don't commit build output (`dist/`).
