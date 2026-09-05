import { ToolRegistry, type AgentTool } from '../toolRegistry';
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

export interface WorkbenchToolInfo {
  name: string;
  label: string;
  permissionClass: AgentTool['permissionClass'];
  description: string;
}

/** 设置页用的工具目录:用一套只会在被调用时才报错的假依赖构造一遍,不执行任何工具。 */
export function listWorkbenchTools(): WorkbenchToolInfo[] {
  const fail = (): never => { throw new Error('工具目录只用于展示,不能执行'); };
  const stub = new Proxy({}, { get: () => fail }) as unknown as ToolDeps;
  const deps: ToolDeps = { ...stub, adapter: stub.adapter, skills: [], enabledSkillIds: () => [] };
  return createWorkbenchToolRegistry(deps).getAll().map((t) => ({ name: t.name, label: t.label, permissionClass: t.permissionClass, description: t.description }));
}

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
