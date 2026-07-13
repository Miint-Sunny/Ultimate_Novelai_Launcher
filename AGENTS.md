# Ultimate NovelAI Launcher engineering rules

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing backend code. It is the
current system map; this file contains the rules that keep that architecture intact.

## Branch contract

- `main` contains shared architecture, security, persistence, reliability, API
  contracts, and legacy/cloud hardening.
- `dev` contains all of `main` plus product features such as the complete desktop
  Agent. It may be ahead of `main`, but must never be behind it.
- The formal `server/agent_router/resources/prompts.yaml` is required to package the
  `dev` Agent. Do not invent a substitute or silently fall back when it is absent.
- `npm run check:agent-prompts` validates that exact formal resource through the
  Agent package loader. `npm run build:sidecar` runs the same preflight before
  PyInstaller and bundles the file as package data. A missing resource is an
  expected hard failure, not a reason to copy prompts from tests or legacy data.
- Do not add product behavior to `main` merely to make a `dev` build pass.

## Dependency boundaries

Backend dependencies flow in one direction:

```text
API adapters -> application services -> backend_core protocols <- infrastructure
```

- `backend_core/` is transport-neutral. It must not import FastAPI, sidecar,
  `server.app`, or concrete deployment paths.
- `sidecar/server.py` is a composition root only: lifespan, middleware, routers, and
  `/livez`. Routes receive services from the process-wide `AppRuntime`; they do not
  open SQLite files, mutate settings globals, or create provider clients.
- Canonical local APIs live under `/api/v1` and use named strict Pydantic request and
  response models. Unknown fields are errors. Failures use Problem Details.
- Historical local routes belong in `sidecar/api/compat/`, carry deprecation headers,
  and may preserve old shapes for one bundled release. Do not add new canonical
  behavior there.
- Cloud identity, ownership, jobs, events, quota, and security belong in
  `cloud_backend/`. `server/app.py` is the compatibility host, not a domain layer.
- New frontend backend traffic goes through `localSidecarApi`, `cloudBackendApi`, or
  the mode-aware `appBackendApi`; do not add raw backend `fetch` calls elsewhere.

## Security invariants

- `/livez` is the only anonymous sidecar status endpoint. All private local reads and
  mutations require the process Bearer credential; the old `X-Sidecar-Auth` header is
  compatibility-only.
- Browser pairing codes are short-lived, one-use, attempt-limited, and exchanged for
  a token held only in `sessionStorage`.
- NovelAI and LLM secrets live in the OS credential store. Secure-store failures are
  fail-closed. Never write secrets to settings JSON, localStorage, logs, fixtures,
  generated assets, or command-line arguments.
- Count request bytes at ASGI `receive`; never trust `Content-Length`. Preserve the
  decoded image, text-context, asset, and generation budgets documented in
  `ARCHITECTURE.md`.
- Outbound provider URLs must pass the shared SSRF policy for every DNS answer and
  redirect. Never forward authorization, cookies, or private headers across origins.
- Private/cloud records are always scoped by a verified `Principal`. Missing and
  cross-owner records intentionally have the same 404 behavior.
- User-controlled filenames and archive paths are data, not filesystem paths. Keep
  traversal, symlink, hardlink, ZIP-bomb, and quota checks in place.
- Never log full tokens, cookies, authorization headers, prompts containing secrets,
  or base64 image bodies. Provider error messages must be redacted before returning.

## Persistence and lifecycle invariants

- Python dependencies come only from `pyproject.toml` and `uv.lock`. Do not restore
  per-directory `requirements.txt` files.
- SQLite schema changes use numbered, checksummed migrations under
  `sidecar/persistence/`. Migrations run transactionally after an online backup.
  Future, corrupt, or checksum-mismatched databases fail readiness; never replace
  them with an empty database.
- Generation state transitions must follow the persisted state machine in
  `backend_core`. Cancellation must reach the active upstream task and settle only
  after the worker acknowledges it.
- Idempotency keys are durable. Reusing a key with different input is a conflict, not
  a second job.
- Assets are catalogued before exposure, addressed by asset ID, and reconciled on
  startup. Do not auto-delete user data to satisfy quota.
- Backup restore validates in staging, enters maintenance, swaps durably, and rolls
  back on failure. OS credential-store secrets are never exported.
- Lifespan owns shared HTTP clients, workers, SQLite, and WAL checkpointing. Shutdown
  seals new paid work, drains or cancels within the bounded deadline, and closes in
  reverse startup order.

## Product and UI constraints

- Preserve visible workflows unless the task explicitly requests a product change.
- The frontend must not call NovelAI directly, persist provider tokens, probe sidecar
  ports, or download inference models.
- Desktop images and thumbnails are authenticated Blob downloads; revoke object URLs
  when their backend/session changes.
- In local mode both Agent phases use the sidecar primary LLM: requests send an
  empty `model`, and all Agent surfaces show a read-only local-primary-model status.
  Custom/private-cloud mode retains the five historical model choices.
- Keep large page shells as orchestration layers. Put domain state in focused hooks or
  services and visible sections in focused components. Avoid unrelated "parts" files.
- Keep existing event names, storage keys, public facade shapes, and compatibility
  payloads stable unless a versioned migration accompanies the change.

## Change discipline

- Preserve unrelated and uncommitted user changes. Do not reset, stash, force-push,
  or rewrite history unless the user explicitly asks.
- Prefer small application/domain modules over adding more global state to
  `server/app.py`, `LeftSidebar`, or mobile page shells.
- Keep paths platform-aware and route writable data through storage services.
- Add failure-path tests with every persistence, cancellation, identity, or security
  change. Fake all paid/provider upstreams.
- Regenerate the OpenAPI snapshot and TypeScript client after changing a v1 contract.
- Treat deprecation and security warnings as tracked debt; do not hide them by
  broadening ignore lists.

## Required validation

Run the full gate before publishing backend changes:

```bash
uv sync --frozen --group dev
npm ci
npm audit --audit-level=high
uv run --frozen --group dev pip-audit --strict
npm run lint:python
npm run typecheck:python
npm run test:python
npm run check:api-contract
npm run check:api-boundaries
npm run build
npm run scan:secrets
npm run build:sidecar
node scripts/smoke-sidecar.mjs
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
git diff --check
```

Package smoke tests for macOS and Windows run in CI. They must use mock providers and
must not call paid APIs. Known non-blocking upstream warnings are documented in CI or
the release handoff rather than suppressed globally.
