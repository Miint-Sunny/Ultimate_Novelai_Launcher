# Backend Architecture

This document describes the backend that exists on `main`. It is an orientation
map, not a roadmap. See [AGENTS.md](AGENTS.md) for repository-wide engineering
rules.

## Branch contract

| Branch | Backend responsibility |
| --- | --- |
| `main` | Shared architecture, security, persistence, reliability, API contracts, and legacy/cloud hardening. |
| `dev` | Everything in `main`, plus product features such as the complete two-stage desktop Agent. `dev` may be ahead of `main`; it must not be behind it. |

The `main` sidecar deliberately does **not** mount the complete desktop Agent. Its
compatibility endpoint `POST /api/agent/web/generate-prompt` validates the complete
request shape, then returns an explicit `503 desktop_agent_unavailable_on_main`.

On `dev`, that compatibility adapter is replaced by the complete request-scoped,
two-stage Agent. The adapter consumes the shared transport-neutral core and the
single lifespan-owned sidecar runtime; it does not create a second server or retain
conversation state. Images (with their real MIME type), caller history, Codex data,
knowledge-source selection, artist/OC context, and current whole/per-character
prompts all cross the typed frontend transport boundary. SSE preserves
`agent_token`, `tool_call`, `tool_result`, `degraded`, `final`, and `error`.

Both local Agent stages use the sidecar primary LLM and share one request-level
failover decision, so local requests intentionally send an empty `model`. Desktop,
left-sidebar, and mobile surfaces expose that setting as read-only; configured
private-cloud mode keeps the historical five-model selector. Provider/network
failover produces `degraded` and stays on the backup for the rest of that request.

The versioned package resource
`server/agent_router/resources/prompts.yaml` remains a hard build/runtime dependency.
`npm run check:agent-prompts` calls the package validator against that exact file,
and `npm run build:sidecar` runs the preflight before adding it to the PyInstaller
bundle. The formal file is present in the tree and loads through the package validator.
Tests may inject synthetic YAML in temporary directories; release builds must never
create or accept a placeholder resource.

## Runtime topology

| Process or layer | Current responsibility |
| --- | --- |
| Tauri desktop shell ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) | Enforces desktop single-instance behavior, starts and supervises the bundled sidecar, owns its process credential and endpoint, and coordinates bounded shutdown. |
| React frontend (`src/`) | UI and client-side domain state. It selects the local or configured cloud transport through typed API clients; it does not store NovelAI or LLM credentials. |
| Local sidecar (`sidecar/`) | Loopback FastAPI service for settings, local generation jobs, library data, assets, backups, credentials, and outbound provider calls. |
| Shared core (`backend_core/`) | Transport-neutral errors, job/event records, JSON types, and protocols used by local and cloud adapters. |
| Cloud/legacy backend (`cloud_backend/`, [server/app.py](server/app.py)) | Optional single-host Bot, queue, workshop, billing, and private-backend surface. `cloud_backend` supplies modern identity, job, event, quota, security, and persistence adapters while `server/app.py` remains the operational compatibility host. |

The desktop and cloud deployments are separate compositions. They may share domain
contracts, but they do not share a database, process token, or filesystem.

## Dependency boundaries

The canonical dependency direction is:

```text
API routers -> application services -> backend_core protocols <- infrastructure
```

- [backend_core](backend_core/) has no FastAPI, sidecar, legacy-server, or concrete
  filesystem dependency. `JobEvent` is equally usable by SSE and WebSocket
  transports.
- [sidecar/composition.py](sidecar/composition.py) constructs the single
  process-wide `AppRuntime` and its settings store, database, repositories/services,
  asset store, generation coordinator, task supervisor, HTTP clients, security,
  pairing, and backup service.
- [sidecar/runtime.py](sidecar/runtime.py) owns ordered startup, reverse-order
  shutdown, readiness, draining, cancellation, and WAL checkpoint coordination.
- [sidecar/server.py](sidecar/server.py) is only the FastAPI composition root:
  lifespan, middleware, router mounting, and `/livez`.
- Canonical `/api/v1` routers resolve services from the runtime and do not open
  SQLite files or provider clients themselves. The unversioned compatibility router
  still contains historical adapters and is intentionally isolated under
  [sidecar/api/compat](sidecar/api/compat/).

## Desktop startup, discovery, and shutdown

1. Tauri creates a random `instance_id` and process Bearer token. Its own
   single-instance plugin prevents duplicate desktop windows.
2. Tauri starts `sidecar.bootstrap` with loopback host and `port=0`. A packaged app
   ships it as a PyInstaller onedir build under `bundle.resources` (`sidecar/` in the
   resource directory), not a onefile binary: onefile unpacked every native module
   into a fresh temp directory on each launch, and the system re-validated them all.
   The window opens at once and does not wait for the sidecar.
   [sidecar/bootstrap.py](sidecar/bootstrap.py) also locks the data directory, binds
   and retains the kernel-assigned socket, and passes that same socket to Uvicorn.
   There is no probe-then-release port scan.
3. After the full lifespan starts, the sidecar emits one JSON readiness handshake
   containing `service`, `version`, `instance_id`, `protocol`, and the bound `port`.
   Tauri waits for it off the main thread for at most 120 seconds, rejects a
   mismatched instance/protocol, and kills a sidecar that never becomes usable. The
   `sidecar_connection` command resolves once that settles: with the exact endpoint
   and token, or with the failure, which the frontend shows in place of the app.
   A setup error would abort the app, so sidecar failures never become one.
4. [src/api/localSidecarApi.ts](src/api/localSidecarApi.ts) reads that desktop
   connection. It does not discover ports or persist a sidecar URL in
   `localStorage`.
5. On application exit, Tauri calls authenticated
   `POST /api/v1/system/drain`. The runtime seals new mutations, drains/cancels
   workers and upstream tasks, checkpoints SQLite, and closes lifecycle resources.
   Tauri waits at most eight seconds before hard-killing a stuck child.

Standalone browser development uses one configured (or development-default)
loopback endpoint and never scans a port range. The sidecar prints a six-digit,
one-use pairing code; exchanging it yields the process token, which the browser
stores only in `sessionStorage`. Codes expire after 120 seconds and are invalidated
after five failed attempts.

## Health and authentication

| Endpoint | Meaning | Authentication |
| --- | --- | --- |
| `GET /livez` | Process identity only: service, version, protocol, and instance. It does not inspect models or storage. | Anonymous |
| `GET /api/v1/system/ready` | Runtime state plus database, storage, lifecycle component, and capability readiness. An unconfigured model is a capability state, not process death. | Bearer |
| `POST /api/v1/auth/pair/exchange` | One-time browser pairing exchange. | Pairing code; anonymous at the HTTP middleware |
| All other non-preflight local routes | Settings, data, images, library, backups, jobs, and paid operations. | Process credential |

`/api/v1` accepts standard `Authorization: Bearer ...` only. Historical routes also
accept `X-Sidecar-Auth` for the one-release compatibility window. CORS is restricted
to Tauri origins, explicit configured web origins, and opt-in development origins.

## Canonical local API

The stable contract is `/api/v1`, assembled in
[sidecar/api/v1/router.py](sidecar/api/v1/router.py):

| Area | Canonical routes |
| --- | --- |
| System | `GET /system/ready`, `POST /system/drain` |
| Browser auth | `POST /auth/pair`, `POST /auth/pair/exchange` |
| Non-secret settings | `GET /settings`, `PATCH /settings` |
| Generation jobs | `POST /generation/jobs`, `GET /generation/jobs`, `GET /generation/jobs/{id}`, `POST /generation/jobs/{id}/cancel`, `GET /generation/jobs/{id}/events` |
| Local library | Typed owner-scoped CRUD under `/library/items` |
| Storage | `GET /storage`, asset list/metadata/content, explicit `POST /storage/prune` |
| Backups | Create/list/delete, validate, and restore under `/backups` |

Every v1 JSON request and response shape uses a named strict Pydantic model with
unknown fields forbidden. Errors use `application/problem+json` with stable `code`,
`status`, `title`, `detail`, `retryable`, and `request_id` fields. SSE errors reuse
the same shape.

`POST /api/v1/generation/jobs` is the canonical generation entry point. It returns
`202` and `Location`; a persisted `Idempotency-Key` replay returns the original job,
while a different request with the same key returns a conflict. The event stream
starts with a snapshot, continues with ordered persisted events and keepalives, and
supports `Last-Event-ID`/sequence resumption. Disconnecting closes the watcher; it
does not implicitly cancel the durable job.

The unversioned routes in [sidecar/api/compat/router.py](sidecar/api/compat/router.py)
preserve historical paths and response shapes for one bundled release and return
`Deprecation` and `Sunset` headers. In particular, old `POST /generate` is only a
shim that submits a persistent job and waits for its terminal result; it is not the
canonical generation API. Credential mutation and several older NovelAI, tags, and
library shapes still live in this compatibility surface while clients migrate.

The checked-in OpenAPI contract is
[openapi/sidecar-v1.openapi.json](openapi/sidecar-v1.openapi.json). Generated
TypeScript types are derived from it; `npm run check:api-contract` rejects drift.

## Persistent jobs, data, and storage

### SQLite and migrations

[sidecar/persistence](sidecar/persistence/) uses `aiosqlite`, WAL, and numbered,
checksummed migrations rather than an ORM. Existing databases are recognized as a
baseline. Migrations run under `BEGIN IMMEDIATE`, take an online pre-migration
backup, retain the latest three migration backups, and record
`schema_migrations(version, name, checksum, applied_at)`. A future schema, checksum
mismatch, failed `quick_check`, or logical-integrity failure stops readiness; code
must never replace it with an empty database.

### Generation jobs and events

[sidecar/services/jobs.py](sidecar/services/jobs.py) persists queue position,
request hash, idempotency key, result/error, and events. The state machine is:

```text
queued -> running -> succeeded | failed
   |          |
   v          v
cancelled  cancelling -> cancelled

running/cancelling at restart -> interrupted
```

[sidecar/services/generation.py](sidecar/services/generation.py) runs one worker by
default, supports one to four workers, and defaults to a queue capacity of 32.
Queued cancellation is immediate; running cancellation propagates to the active
provider task. Repeated cancellation is idempotent while cancelling/cancelled, and
other terminal jobs reject cancellation.

### Assets, quota, and backup

[sidecar/services/assets.py](sidecar/services/assets.py) catalogs managed files by
relative path, kind, MIME type, byte size, SHA-256, source job, and state. Generation
and library records refer to asset IDs. Startup reconciliation records missing and
orphaned files and recovers interrupted explicit deletions; it does not silently
delete user data.

The default managed-storage quota is 10 GiB with 1 GiB disk space reserved. New
writes fail with `507 insufficient_storage` when either bound would be crossed.
There is no automatic eviction: deletion is an explicit authenticated prune.

[sidecar/services/backup.py](sidecar/services/backup.py) creates versioned ZIPs with
an online SQLite snapshot, non-secret settings, optional assets, and a checksummed
manifest. OS credential-store secrets are never included. Restore first validates
paths, schema, checksums, expansion size, compression ratio, quota, and free space
in staging. It then enters maintenance, creates a safety backup, performs a durable
swap, rolls back failures, and requests a process restart.

## Network and input security

- [sidecar/security/body_limit.py](sidecar/security/body_limit.py) counts bytes at
  the ASGI receive layer, including chunked requests. The global limit is 72 MiB,
  with smaller route budgets for settings/credentials, assets, Agent payloads, and
  image operations. Typed decoders additionally enforce decoded image/text limits.
- [sidecar/security/outbound.py](sidecar/security/outbound.py) classifies configured
  LLM endpoints as `public`, `loopback`, or an explicit `trusted-lan` allowlist.
  Every DNS answer and redirect hop is revalidated; connections are pinned to the
  approved addresses. Metadata, link-local, userinfo, ambiguous numeric hosts, and
  unsafe schemes are rejected, and sensitive headers/cookies are stripped on
  cross-origin redirects. `public` also accepts the placeholder addresses a local
  fake-ip proxy (Clash, Mihomo, sing-box, Surge TUN) hands out, 198.18.0.0/15 by
  default plus `ULTIMATE_NOVELAI_LAUNCHER_FAKE_IP_RANGES` (private LAN blocks are
  refused there): they cannot reach LAN services, and the proxy resolves the real
  hostname upstream.
- [sidecar/infrastructure/http_clients.py](sidecar/infrastructure/http_clients.py)
  owns the shared cancellable HTTP clients and closes them through the runtime
  lifespan.
- [sidecar/credentials.py](sidecar/credentials.py) stores NovelAI and LLM secrets in
  macOS Keychain, Windows Credential Manager, or Secret Service. Secure storage
  failure is fail-closed; legacy plaintext token migration is accepted only after a
  successful secure write. Entries are keyed by service name, so every sidecar on
  the machine shares them; `ULTIMATE_NOVELAI_LAUNCHER_CREDENTIAL_NAMESPACE`
  suffixes the name for a test instance, and `python -m sidecar.credential_cli`
  stores a secret from a no-echo prompt into that store.

## Frontend transport boundary

Backend traffic is split by deployment rather than by ad hoc URL construction:

- [localSidecarApi.ts](src/api/localSidecarApi.ts) owns the process Bearer token,
  canonical sidecar methods, authenticated SSE, and authenticated Blob/object URL
  creation and revocation.
- [cloudBackendApi.ts](src/api/cloudBackendApi.ts) owns configured private-backend
  requests and refuses API redirects so session headers cannot cross origins.
- [appBackendApi.ts](src/api/appBackendApi.ts) is the mode-aware facade used by
  shared product services.
- [sidecar.ts](src/api/sidecar.ts) is a one-release compatibility re-export, not the
  place for new calls.

The API types under `src/api/generated/` come from the checked-in OpenAPI document.
`npm run check:api-boundaries` prevents new raw backend fetches outside the approved
transport modules.

## Cloud backend and legacy host

The legacy service is **operational**, not read-only and not yet fully decomposed.
[server/app.py](server/app.py) still composes the deployed Bot/QQ, queue, task,
workshop, billing/quota, cloud-library, and WebSocket behavior.

[cloud_backend](cloud_backend/) is the incremental modernization layer used by that
host:

- `Principal`, tenant/owner records, and 404-style access denial;
- single-job capability tokens for anonymous direct tasks;
- transport-neutral durable jobs and `JobEvent` adaptation;
- idempotent quota reservation, capture, and refund;
- body-size, pairing, and outbound-request policies;
- owner-only JSON and single-host SQLite/WAL repositories.

New shared domain behavior belongs in `backend_core` or a focused
`cloud_backend` service and is wired into the legacy host through
[cloud_backend/legacy_adapter.py](cloud_backend/legacy_adapter.py). Avoid adding new
unscoped global state to `server/app.py`. The private backend currently targets one
host and does not claim horizontal multi-instance support.

## Data ownership

| Store | Local sidecar contents |
| --- | --- |
| `ultimate_novelai_launcher.sqlite3` | Migrations, generation jobs/events/history, asset catalog, and local library records. |
| `assets/` | Generated images and managed OC/artist/CR/vibe files. |
| `backups/`, `migration-backups/` | User backups and the latest pre-migration snapshots. |
| `settings.json` | Validated non-secret provider/model/network settings only. |
| OS credential store | NovelAI token, primary LLM key, and backup LLM key. |
| Browser storage | Non-secret UI state; a browser-only sidecar process token may exist in `sessionStorage`, never `localStorage`. |

## Where changes go

- A transport-neutral error, job/event type, or protocol: `backend_core/`.
- A canonical local capability: sidecar application/service/infrastructure layer,
  then a strict `/api/v1` adapter and generated frontend contract.
- A temporary old-client bridge: `sidecar/api/compat/`, with deprecation tests and
  no new canonical behavior.
- Cloud identity, ownership, jobs, events, quota, or security: `cloud_backend/`,
  then a narrow legacy-host adapter.
- Complete desktop Agent behavior and its UI: `dev`, consuming the shared core and
  the formal packaged `prompts.yaml` resource.

The Python dependency source of truth is `pyproject.toml` plus `uv.lock`. Relevant
release checks are `npm run lint:python`, `npm run typecheck:python`,
`npm run test:python`, `npm run check:api-contract`, `npm run build`,
`npm run scan:secrets`, `cargo check --manifest-path src-tauri/Cargo.toml`, and
`git diff --check`.
