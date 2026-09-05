/**
 * 内置预设。形状照他的 `AgentPreset`(系统提示词 + 技能清单 + 工具白名单 + 可改参数白名单);
 * 文案按我们的接线改:技能是用户自己的 nai5-prompting,不是他的 v5-architect。
 */

import type { AgentPreset } from './harness';

export const PARAM_KEYS = [
  'prompt', 'negative_prompt', 'model', 'resolution', 'width', 'height', 'steps', 'scale',
  'cfg_rescale', 'sampler', 'noise_schedule', 'quality_preset', 'character_ai_position',
] as const;

/** 一期工具(契约 §3 标「一期」的那些)。 */
export const PHASE_ONE_TOOLS = [
  'get_studio_parameters', 'update_studio_parameters',
  'list_character_prompts', 'add_character_prompt', 'update_character_prompt', 'remove_character_prompt',
  'novelai_generate', 'novelai_upscale', 'novelai_account_info', 'novelai_suggest_tags',
  'view_canvas_image', 'ask_user', 'load_skill',
  'danbooru_search_tags', 'danbooru_related_tags',
  'search_prompt_library', 'add_prompt_library_entry', 'update_prompt_library_entry', 'delete_prompt_library_entry',
] as const;

export const V5_ARCHITECT_PRESET: AgentPreset = {
  id: 'v5-architect-preset',
  name: 'V5 自然语言架构师',
  systemPrompt: `你是 Ultimate NovelAI Launcher 里的动漫艺术总监与提示词架构师,负责把用户的创意构思变成高精度的 NovelAI 提示词,并直接操作工作台。

【工作流】
1. 动笔之前先调用 load_skill 载入 nai5-prompting 方法层;需要细节时再按小节加载(通用写法 / 通用构思)。严格按方法层的铁律写:画师串只用用户给的;负面与质量尾不抄前端预设;能查证就查证。
2. 构思好提示词,或需要调整尺寸、步数、模型等参数时,调用 update_studio_parameters 把改动同步到工作台;只传要改的字段。
3. 多角色、分镜、需要精确定位的元素,用角色提示词工具(list / add / update / remove_character_prompt)做空间布局与隔离。
4. 参数就绪后调用 novelai_generate(无需传参)按工作台当前参数出图;出图后可以用 view_canvas_image 检查结果再迭代。
5. 关键取舍拿不准时用 ask_user 问用户,不要替用户做决定;也不要每轮都问。`,
  enabledSkillIds: ['nai5-prompting'],
  enabledToolNames: [...PHASE_ONE_TOOLS],
  allowedModifiableParams: [...PARAM_KEYS],
};

export const BUILTIN_PRESETS: readonly AgentPreset[] = [V5_ARCHITECT_PRESET];
