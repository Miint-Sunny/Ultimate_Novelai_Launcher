import { ToolRegistry } from '../toolRegistry';
import { createAskUserTool } from './askUserTool';
import { createCanvasTools } from './canvasTools';
import { createCharacterTools } from './characterTools';
import { createDanbooruTools } from './danbooruTools';
import type { ToolDeps } from './deps';
import { createNovelaiTools } from './novelaiTools';
import { createPromptLibraryTools } from './promptLibraryTools';
import { createSkillTool } from './skillTool';
import { createStudioTools } from './studioTools';

export type { ToolDeps, PromptLibraryEntry, TagSuggestItem, TagSuggestSource } from './deps';
export { normalizeStudioUpdate, describeStudioDiff, RESOLUTION_PRESETS } from './studioTools';
export { parseQuestions } from './askUserTool';
export { buildOverlaySpec, anchorDisplayFor, freePositioningForModel, type OverlaySpec, type OverlayAnchor } from './canvasOverlay';

/** 一期全部工具,注册进一个 registry。白名单过滤在 harness 里按预设做。 */
export function createWorkbenchToolRegistry(deps: ToolDeps): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    ...createStudioTools(deps),
    ...createCharacterTools(deps),
    ...createNovelaiTools(deps),
    ...createCanvasTools(deps),
    createAskUserTool(deps),
    createSkillTool(deps),
    ...createDanbooruTools(deps),
    ...createPromptLibraryTools(deps),
  ]);
  return registry;
}
