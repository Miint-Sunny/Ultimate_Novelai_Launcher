# NAI Studio Engineering Rules

NAI Studio is a NovelAI desktop creation tool, macOS first and Windows-aware.

## Product Direction

- `docs_and_plan/ideas.md` is the product source of truth.
- `main reference/novelai_web_ui` is the primary UI and workflow implementation reference.
- The workspace should become a five-zone creative app: top editor/status, left manual tag/parameter tools, center image stage, right conversational/workflow tools, bottom gallery/history.
- Preserve user-visible reference features where possible, but detach anything that depends on the original author's private services.

## Architecture

- Frontend: React + TypeScript + Vite, later hosted by a thin Tauri 2 shell.
- Sidecar: Python + FastAPI, responsible for NovelAI API calls, LLM prompt conversion, Vibe encoding, upscaling, metadata parsing, tagger work, SQLite history, and file storage.
- Communication: JSON over localhost HTTP.
- Frontend code must not call NovelAI directly, store NovelAI tokens in localStorage, or load inference models.

## Boundaries

- New frontend HTTP calls to the sidecar belong in `src/api/sidecar.ts`.
- Legacy services may remain temporarily, but they should become facades over the sidecar instead of doing work directly.
- Sensitive settings belong in environment variables, OS credential storage, or sidecar-managed local config.
- Do not copy `server/config.py` from the reference project. Use sanitized examples only.

## Cleanup Discipline

- Keep every milestone runnable.
- New files should stay around 300 lines where practical.
- Reduce `LeftSidebar`, `MobileGeneratePage`, and `server/app.py` over time; do not add new feature branches to those large files.
- Log errors, but never log tokens, cookies, or full base64 image payloads.
- Keep paths platform-aware and route app data through storage helpers.
