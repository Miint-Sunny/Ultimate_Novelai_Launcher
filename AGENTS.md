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

For mobile cleanup, split by product domain instead of line count:

- Page shells own layout, sheet visibility, and orchestration only.
- Domain hooks own stateful workflows, persistence, events, and cross-feature rules.
- Section components own visible UI for one coherent feature area.
- Pure helpers own parsing, formatting, payload construction, and byte-sensitive conversions.
- Avoid "parts" files that collect unrelated JSX just to shrink a parent file.

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

`src/components/mobile/MobileGeneratePage.tsx` has already been reduced to about 526 lines.

Existing extracted area:

- `src/components/mobile/generate/`
- generation params
- prompt/token helpers
- image import workflows
- metadata/tagger import actions
- Vibe/OC/artist/CR mobile library hooks
- `useMobileReferenceLibraries`, which coordinates Vibe/CR mutual exclusion so the page does not wire those two libraries together directly
- `useMobileVibeTags`, which owns Vibe tag pool, tag editor, batch tagging, and tag CRUD state/actions
- `mobileVibeFilters`, which owns Vibe model compatibility, public/local filtering, and tag usage counting
- `mobileOCData`, which owns mobile OC mapping, search filtering, and selected OC to character prompt construction
- `useMobileOCEditor`, which owns OC editor draft state, create/edit save, preview generation, paste fallback, and delete-current-editor flow
- prompt assist and translation hooks
- generation runner and preparation helpers

Do not add new business logic directly to `MobileGeneratePage.tsx`. Put new behavior into `src/components/mobile/generate/` or an existing nearby component. Cross-feature rules such as "adding Vibe clears CR" belong in coordinator hooks, not in the page shell.

Important preserved behavior:

- Vibe add still clears active precise references through `useMobileReferenceLibraries`.
- Public Vibe async file completion, local Vibe import/export/delete, recent usage, and tag editing behavior are unchanged.
- OC creation/edit/delete/preview generation and confirmation into character prompts are unchanged; editor workflow is now separate from list/selection management.

### Mobile Image Import Modal

`src/components/mobile/MobileImageImportModal.tsx` is now the modal shell and mode router.

Extracted files:

- `src/components/mobile/MobileImageImportModalViews.tsx` owns the four visible modes: tagger result, full metadata, metadata import, and no-metadata use-as choice.
- `src/components/mobile/MobileImageImportModalParts.tsx` still owns small reusable controls such as use-as buttons and import option rows.

Important preserved behavior:

- Tagger result copy/import, include-character toggle, and clean-import toggle are unchanged.
- Full metadata still renders through `MetadataDetailPanel`.
- Metadata import options and unsupported-settings disabling are unchanged.
- Use-as Vibe / Img2Img / CR buttons keep the same callbacks and placement semantics.

### Mobile Image/Gallery Page

`src/components/mobile/MobileImagePage.tsx` has already been reduced to about 370 lines.

Extracted files:

- `src/components/mobile/gallery/useMobileSaveDownloadWorkflow.ts`
- `src/components/mobile/gallery/useMobileInpaintBridge.ts`
- `src/components/mobile/gallery/useMobileGalleryBackStack.ts`
- `src/components/mobile/gallery/useMobileGallerySelection.ts`
- `src/components/mobile/gallery/useMobileGenerationErrorToast.ts`
- `src/components/mobile/gallery/useMobileUpscaleCompletion.ts`
- `src/components/mobile/gallery/MobileCompactGalleryStrip.tsx`
- `src/components/mobile/gallery/MobileCurrentImageToolbar.tsx`
- `src/components/mobile/gallery/MobileImageStatusPill.tsx`
- `src/components/mobile/MobileExpandedGallerySheet.tsx`
- `src/components/mobile/MobileSaveSettingsSheet.tsx`
- `src/components/mobile/MobileFullscreenImageViewer.tsx`

Important preserved behavior:

- save settings localStorage keys remain unchanged.
- `open-image-import`, `open-inpaint-mode`, `inpaint-generate`, and `inpaint-pasteback-done` event names remain unchanged.
- batch download ZIP naming and image metadata import payloads should remain compatible.
- mobile back priority remains fullscreen, expanded gallery, save settings, upscale sheet, inpaint.

### Mobile Settings Page

`src/components/mobile/MobileSettingsPage.tsx` has already been reduced from about 1249 lines to about 359 lines.

Extracted files:

- `src/components/mobile/settings/MobileProfileSettingsSection.tsx`
- `src/components/mobile/settings/MobileBackupSettingsSection.tsx`
- `src/components/mobile/settings/MobilePresetSettingsSection.tsx`
- `src/components/mobile/settings/MobileAISettingsSection.tsx`
- `src/components/mobile/settings/MobileAutocompleteSettingsSection.tsx`
- `src/components/mobile/settings/MobileThemeSettingsSection.tsx`
- `src/components/mobile/settings/MobileLoginSettingsSection.tsx`
- `src/components/mobile/settings/AdvancedSettingControls.tsx`
- `src/components/mobile/settings/MobileSettingsToggle.tsx`

Remaining reasonable cuts:

- optionally extract the settings main list/header shell if future edits make the page grow again.

Do not change token storage semantics while doing UI cleanup. Token handling must continue through sidecar/keychain-oriented APIs and must not introduce plaintext storage beyond existing compatibility paths.

### Mobile Inpaint Overlay

`src/components/mobile/MobileInpaintOverlay.tsx` has already been reduced from about 1201 lines to about 377 lines.

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
- `src/components/mobile/inpaint/generationPayload.ts` (`calculateInpaintGenerationDimensions` + `buildMaskGenerationPayload` for crop/normal mask payload construction)
- `src/components/mobile/inpaint/useInpaintStrengthSync.ts` (window event bridge for `inpaint-strength-sync` / `inpaint-panel-strength-change`)
- `src/components/mobile/inpaint/useInpaintCanvasLoader.ts`
- `src/components/mobile/inpaint/useInpaintContainerSize.ts`
- `src/components/mobile/inpaint/useInpaintCompositePreview.ts`
- `src/components/mobile/inpaint/useInpaintDrawing.ts`
- `src/components/mobile/inpaint/useInpaintSnapshot.ts`

Important preserved behavior:

- brush, eraser, undo, clear, crop mode, expand mode, compare-hold, brush size, and strength controls should behave exactly as before.
- `inpaint-strength-sync` and `inpaint-panel-strength-change` events remain unchanged.
- crop/expand payload shape passed to `onGenerate` must remain unchanged.
- canvas dimensions, mask expansion, and 8x8 alignment behavior are sensitive; avoid changing algorithms while extracting.
- The original-image compare overlay is driven by `useInpaintSnapshot`; it still stores `snapshotRef` in a ref, pairs it with `showOriginal`, and triggers visibility by setting `hasSnapshot` right after capture.
- Strength sync event names remain unchanged: `inpaint-strength-sync` from img2img controls into the overlay, and `inpaint-panel-strength-change` from overlay back to img2img controls.

Next good cuts:

- If touching the overlay again, prefer making the existing hooks narrower over adding more state to the overlay file.
- The next plausible extraction is a small crop/expand mode controller hook around `isExpandMode`, `expandPadding`, `isCropMode`, `resetExpand`, `adjustExpand`, `handleToggleCrop`, and `handleToggleExpand`; do this only if it stays behavior-preserving.

### Mobile Tools Page

`src/components/mobile/MobileToolsPage.tsx` has been reduced from about 875 lines to about 49 lines. It is now only the tools tab shell.

Extracted files:

- `src/components/mobile/tools/weightConvert.tsx` (`mobileWeightConvert` namespace: `convertSDToNAI`/`convertNAIToSD`/`renderNAIHighlighted`/`renderSDHighlighted`; intentionally distinct from `utils/promptTags.ts` single-tag version and duplicated in desktop `ToolsModal.tsx` — merging needs a dedicated behavior-alignment task).
- `src/components/mobile/tools/characterRecognition.ts` (`useCharacterRecognition` hook + `CharacterMatch` type + matchers/fetchers; duplicated verbatim in desktop `ToolsModal.tsx` — same merging caveat).
- `src/components/mobile/tools/MobileMetadataDetail.tsx` (full-screen metadata detail panel; imports `MetadataFile` type from main file which now `export`s it).
- `src/components/mobile/tools/MobileWeightToolSection.tsx`
- `src/components/mobile/tools/MobileMetadataToolSection.tsx`
- `src/components/mobile/tools/useMobileMetadataBatch.ts`

Remaining reasonable cuts:

- Future work should focus on desktop/mobile behavior alignment for duplicated weight conversion and character recognition, not more mobile page splitting.

Important preserved behavior:

- Weight conversion output (including the `1.05`/`0.952381` special-weight mapping and `\(` escaping) must remain byte-identical.
- Character recognition LCS threshold (`0.90`) and the 5-match cap must remain unchanged.
- `switch-to-generate` event name and metadata import payload shape must remain unchanged.
- Metadata batch download naming (`processed_${Date.now()}.zip`, `_clean`, `_custom`) must remain unchanged.

### Mobile AI Assistant Sheet

`src/components/mobile/MobileAIAssistantSheet.tsx` has been reduced from about 394 lines to about 105 lines. It is now the sheet shell: open/close overlay, panel sizing, send action, and composition.

Extracted files:

- `src/components/mobile/ai-assistant/useMobileAssistantSheetState.ts` (input state, random suggestions, thinking ticker, visual viewport height, log auto-scroll, open-focus)
- `src/components/mobile/ai-assistant/AssistantHeader.tsx`
- `src/components/mobile/ai-assistant/AssistantInputBar.tsx`
- `src/components/mobile/ai-assistant/AssistantEmptySuggestions.tsx`
- `src/components/mobile/ai-assistant/AssistantLogList.tsx` (success/error/normal log rows, retry/restore/regenerate actions, progress row)
- `src/components/mobile/ai-assistant/AssistantMessageParts.tsx` (`TypewriterText` + `TagButton` + `renderMessageContent`)

Important preserved behavior:

- Random empty-state suggestions are still chosen when the sheet opens.
- `visualViewport` resize handling, log auto-scroll, and delayed input focus are unchanged.
- Enter-to-send, Shift+Enter newline, textarea auto-height, clear logs, retry, restore, regenerate, success thinking expansion, and progress typewriter behavior are unchanged.

## Current Large File Map

Approximate sizes at this handoff:

- `src/components/mobile/MobileGeneratePage.tsx`: 526 lines
- `src/components/mobile/MobileInpaintOverlay.tsx`: 377 lines
- `src/components/mobile/MobileImagePage.tsx`: 370 lines
- `src/components/mobile/MobileSettingsPage.tsx`: 359 lines
- `src/components/mobile/FullscreenEditor.tsx`: 354 lines
- `src/components/mobile/MobileInspirationSheet.tsx`: 300 lines
- `src/components/mobile/generate/useMobileVibeLibrary.ts`: 277 lines
- `src/components/mobile/MobileUpscaleSheet.tsx`: 259 lines
- `src/components/mobile/MobileArtistModal.tsx`: 243 lines
- `src/components/mobile/generate/useMobileOCEditor.ts`: 190 lines
- `src/components/mobile/generate/useMobileOCManager.ts`: 165 lines
- `src/components/mobile/MobileImageImportModal.tsx`: 128 lines
- `src/components/mobile/MobileAIAssistantSheet.tsx`: 105 lines
- `src/components/mobile/MobileToolsPage.tsx`: 49 lines

These numbers will drift. Update this section when a future cleanup phase significantly changes them.

### Additional extracted files (beyond the per-page sections above)

These were extracted during a broader sweep of mobile sheets/components:

- `src/components/mobile/ai-assistant/` (`AssistantHeader`, `AssistantInputBar`, `AssistantLogList`, `AssistantEmptySuggestions`, `AssistantMessageParts`, `useMobileAssistantSheetState` from `MobileAIAssistantSheet`)
- `src/components/mobile/artist/MobileArtistEditorSheet.tsx` and `src/components/mobile/artist/MobileArtistListItem.tsx` (editor/list UI from `MobileArtistModal`)
- `src/components/mobile/fullscreen-editor/` hooks and parts (`FullscreenChipEditorArea`, `FullscreenRawTextEditor`, `NaturalLanguageLoadingPill`, `SelectedTagPanel`, `SuggestionStrip`, `useSuggestionSelection`, tag action/translation/wiki/drag hooks, editor lifecycle hooks, input workflow hook, tag editing hook)
- `src/components/mobile/inspiration/MobileInspirationCategoryGroup.tsx` (`CategoryGroup` from `MobileInspirationSheet`)
- `src/components/mobile/prompt-summary/PromptSummaryParts.tsx` (prompt summary card pieces)
- `src/components/mobile/upscale/loadImageToCanvas.ts` (`loadImageToCanvas` from `MobileUpscaleSheet`)
- `src/components/mobile/upscale/useMobileUpscaleWorkflow.ts` (state/progress/local/API/img2img branches from `MobileUpscaleSheet`)
- `src/components/mobile/tools/types.ts` (shared `MetadataFile` type, moved out of `MobileToolsPage` to avoid child→parent dependency)

## Recommended Next Mobile Cuts

1. `MobileGeneratePage`: keep shrinking orchestration only when a new domain coordinator is obvious; avoid moving JSX around without changing ownership.
2. `MobileAIAssistantSheet`: now small enough; only revisit if assistant behavior changes or `AssistantLogList` grows beyond its current message-stream boundary.
3. `MobileInpaintOverlay`: it is near the threshold; only touch for crop/expand helper boundaries or to narrow existing hooks.
4. `MobileImagePage`: remaining code is mostly layout plus already-extracted workflow hooks; touch it only for a specific boundary.

## Refactor Rules For Future Agents

- Prefer folders by domain:
  - mobile generation logic: `src/components/mobile/generate/`
  - mobile gallery/image logic: `src/components/mobile/gallery/`
  - mobile settings sections: `src/components/mobile/settings/`
  - mobile inpaint pieces: `src/components/mobile/inpaint/`
  - mobile tools helpers: `src/components/mobile/tools/`
  - mobile AI assistant parts: `src/components/mobile/ai-assistant/`
  - mobile inspiration parts: `src/components/mobile/inspiration/`
  - mobile upscale helpers: `src/components/mobile/upscale/`
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
