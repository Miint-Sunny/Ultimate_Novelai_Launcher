# Ultimate Novelai launcher Engineering Rules

Ultimate Novelai launcher is a NovelAI desktop creation tool, macOS first and Windows-aware.

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

## Refactor Handoff: How To Continue

This section is the working handoff for future agents. The current phase is still **structure cleanup only**:

- Do not add new product features.
- Do not redesign visible UI.
- Do not rename buttons/text unless a task explicitly asks for copy changes.
- Preserve reference behavior and user-visible workflows.
- Reduce large files by moving cohesive UI, hooks, and service logic into small files.
- Keep every cut buildable, testable, and easy to review.

The preferred refactor style is a strangler pattern:

1. Extract pure UI JSX first when possible.
2. Extract stateful side effects into hooks only after the UI boundary is stable.
3. Extract parsing/formatting/payload construction into small helpers or services.
4. Keep old component props, event names, localStorage keys, and service return shapes stable.
5. Do not combine unrelated cleanup with behavior changes.
6. Commit one logical cut at a time.

For each cut, run:

```bash
npm run build
npm run scan:secrets
git diff --check
```

Then commit with a narrow message such as `Extract mobile inpaint bottom toolbar`.

## Current Refactor Progress

As of the last handoff, the active cleanup has focused on the mobile pages and their largest inline UI blocks.

### Mobile Generate Page

`src/components/mobile/MobileGeneratePage.tsx` has already been reduced to about 529 lines.

Existing extracted area:

- `src/components/mobile/generate/`
- generation params
- prompt/token helpers
- image import workflows
- metadata/tagger import actions
- Vibe/OC/artist/CR mobile library hooks
- prompt assist and translation hooks
- generation runner and preparation helpers

Do not add new business logic directly to `MobileGeneratePage.tsx`. Put new behavior into `src/components/mobile/generate/` or an existing nearby component.

### Mobile Image/Gallery Page

`src/components/mobile/MobileImagePage.tsx` has already been reduced to about 452 lines.

Extracted files:

- `src/components/mobile/gallery/useMobileSaveDownloadWorkflow.ts`
- `src/components/mobile/gallery/useMobileInpaintBridge.ts`
- `src/components/mobile/gallery/MobileCompactGalleryStrip.tsx`
- `src/components/mobile/gallery/MobileCurrentImageToolbar.tsx`
- `src/components/mobile/MobileExpandedGallerySheet.tsx`
- `src/components/mobile/MobileSaveSettingsSheet.tsx`
- `src/components/mobile/MobileFullscreenImageViewer.tsx`

Important preserved behavior:

- save settings localStorage keys remain unchanged.
- `open-image-import`, `open-inpaint-mode`, `inpaint-generate`, and `inpaint-pasteback-done` event names remain unchanged.
- batch download ZIP naming and image metadata import payloads should remain compatible.

### Mobile Settings Page

`src/components/mobile/MobileSettingsPage.tsx` has already been reduced from about 1249 lines to about 545 lines.

Extracted files:

- `src/components/mobile/settings/MobileProfileSettingsSection.tsx`
- `src/components/mobile/settings/MobileBackupSettingsSection.tsx`
- `src/components/mobile/settings/MobilePresetSettingsSection.tsx`
- `src/components/mobile/settings/MobileAISettingsSection.tsx`
- `src/components/mobile/settings/MobileSettingsToggle.tsx`

Remaining reasonable cuts:

- extract theme settings section.
- extract autocomplete settings section.
- extract login/token/Bot auth settings section.
- optionally extract the settings main list/header shell after sections are stable.

Do not change token storage semantics while doing UI cleanup. Token handling must continue through sidecar/keychain-oriented APIs and must not introduce plaintext storage beyond existing compatibility paths.

### Mobile Inpaint Overlay

`src/components/mobile/MobileInpaintOverlay.tsx` has already been reduced from about 1201 lines to about 765 lines.

Extracted files:

- `src/components/mobile/inpaint/MobileInpaintBottomToolbar.tsx`
- `src/components/mobile/inpaint/MobileInpaintHeader.tsx`
- `src/components/mobile/inpaint/MobileInpaintProgressPill.tsx`
- `src/components/mobile/inpaint/MobileInpaintExpandOverlay.tsx`
- `src/components/mobile/inpaint/MobileInpaintCropPreview.tsx`
- `src/components/mobile/inpaint/MobileInpaintCompareOverlay.tsx`
- `src/components/mobile/inpaint/maskUtils.ts` (mobile-specific `expandMaskRegions` + `getMaskBase64FromCanvas`; intentionally distinct from desktop `src/components/inpaint/maskUtils.ts`)
- `src/components/mobile/inpaint/expandPayload.ts` (`buildExpandPayload` + `ExpandSelection`/`ExpandPayload` types; main file re-exports types so `useMobileInpaintBridge` import path stays stable)
- `src/components/mobile/inpaint/scaleUtils.ts` (`calculateBaseScale` pure helper for `baseScale` useMemo)

Important preserved behavior:

- brush, eraser, undo, clear, crop mode, expand mode, compare-hold, brush size, and strength controls should behave exactly as before.
- `inpaint-strength-sync` and `inpaint-panel-strength-change` events remain unchanged.
- crop/expand payload shape passed to `onGenerate` must remain unchanged.
- canvas dimensions, mask expansion, and 8x8 alignment behavior are sensitive; avoid changing algorithms while extracting.
- The original-image compare overlay is driven by `snapshotRef` (a ref, read during render) paired with `showOriginal`; re-render visibility is triggered by `setHasSnapshot(true)` set right after the ref in `handleGenerate`, so passing `snapshot={snapshotRef.current}` as a prop preserves timing.

Next good cuts:

- Extract canvas image lifecycle/loading into a hook only if the boundary is very clear.
- Extract touch/pinch/draw event handling into a hook after UI extraction is complete.
- Optionally extract the crop-rect computation inside `handleGenerate` (the `isCropMode` branch calling `calculateCropRect`) into a small helper.

### Mobile Tools Page

`src/components/mobile/MobileToolsPage.tsx` has been reduced from about 875 lines to about 436 lines.

Extracted files:

- `src/components/mobile/tools/weightConvert.tsx` (`mobileWeightConvert` namespace: `convertSDToNAI`/`convertNAIToSD`/`renderNAIHighlighted`/`renderSDHighlighted`; intentionally distinct from `utils/promptTags.ts` single-tag version and duplicated in desktop `ToolsModal.tsx` — merging needs a dedicated behavior-alignment task).
- `src/components/mobile/tools/characterRecognition.ts` (`useCharacterRecognition` hook + `CharacterMatch` type + matchers/fetchers; duplicated verbatim in desktop `ToolsModal.tsx` — same merging caveat).
- `src/components/mobile/tools/MobileMetadataDetail.tsx` (full-screen metadata detail panel; imports `MetadataFile` type from main file which now `export`s it).

Remaining reasonable cuts:

- Extract `cleanImageMetadataProper` into a small helper (`formatFileSize` already moved into `MobileMetadataDetail`).
- After helpers are stable, extract the weight-convert UI section and the metadata tool UI section into section components.

Important preserved behavior:

- Weight conversion output (including the `1.05`/`0.952381` special-weight mapping and `\(` escaping) must remain byte-identical.
- Character recognition LCS threshold (`0.90`) and the 5-match cap must remain unchanged.
- `switch-to-generate` event name and metadata import payload shape must remain unchanged.

## Current Large File Map

Approximate sizes at this handoff:

- `src/components/mobile/MobileInpaintOverlay.tsx`: 765 lines
- `src/components/mobile/MobileSettingsPage.tsx`: 545 lines
- `src/components/mobile/MobileGeneratePage.tsx`: 529 lines
- `src/components/mobile/MobileImagePage.tsx`: 452 lines
- `src/components/mobile/MobileToolsPage.tsx`: 436 lines

These numbers will drift. Update this section when a future cleanup phase significantly changes them.

## Refactor Rules For Future Agents

- Prefer folders by domain:
  - mobile generation logic: `src/components/mobile/generate/`
  - mobile gallery/image logic: `src/components/mobile/gallery/`
  - mobile settings sections: `src/components/mobile/settings/`
  - mobile inpaint pieces: `src/components/mobile/inpaint/`
- New components should generally be under 300 lines.
- Avoid creating a large "misc" helper file.
- If a new component grows beyond about 300-350 lines, split it immediately by UI subpart or hook.
- Do not move logic across desktop/mobile boundaries unless there is already a stable shared helper.
- Do not remove legacy localStorage/IndexedDB compatibility during cleanup-only phases.
- Do not inline sidecar calls in random components. Use existing API/facade layers.
- Do not reintroduce direct NovelAI API calls from frontend code.
- Do not commit generated build output.

## Known Validation Warnings

`npm run build` currently emits existing Vite warnings about large chunks and ineffective dynamic imports. Those warnings are expected for now and are not failures. TypeScript build errors, secret scan failures, or `git diff --check` output are blockers.
