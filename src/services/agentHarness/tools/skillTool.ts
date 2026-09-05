/** load_skill:按需加载技能正文。只认当前预设开放的技能。 */

import { findSkill } from '../skillCatalog';
import { toolError, type AgentTool } from '../toolRegistry';
import type { ToolDeps } from './deps';

export function createSkillTool(deps: ToolDeps): AgentTool {
  const tool: AgentTool = {
    name: 'load_skill',
    label: '加载专业技能指令',
    description: '按需加载指定 Skill 的完整专业规范、工作流与指令内容。当任务需要深入调用该 Skill 时调用。',
    parameters: {
      type: 'object',
      properties: { skill_name: { type: 'string', description: '要加载的技能标识或名称' } },
      required: ['skill_name'],
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const name = typeof args.skill_name === 'string' ? args.skill_name.trim() : '';
      if (!name) return toolError(toolCallId, tool.name, '错误:必须提供 skill_name 参数。');
      const enabled = new Set(deps.enabledSkillIds());
      const available = deps.skills.filter((s) => enabled.has(s.id) || [...enabled].some((id) => s.id.startsWith(`${id}/`)));
      const skill = findSkill(name, available);
      if (!skill) return toolError(toolCallId, tool.name, `未找到技能 "${name}"。当前可用技能列表: ${available.map((s) => s.id).join(', ')}`);
      return { toolCallId, toolName: tool.name, content: `<skill name="${skill.id}">\n### 【${skill.name}】专业指令与工作流\n${skill.systemPrompt}\n</skill>` };
    },
  };
  return tool;
}
