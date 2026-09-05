/**
 * 技能正文:用户自己的 nai5-prompting(已 vendored 到 server/agent_router/resources/skills,
 * 与后端 planner 共用同一份文件,不再抄一份)。两份参考各 18–82KB,整份塞进上下文会把
 * 注意力摊薄,所以拆成三个可加载单元:主文件、通用写法、通用构思。
 */

import skillMd from '../../../server/agent_router/resources/skills/nai5-prompting/SKILL.md?raw';
import writingMd from '../../../server/agent_router/resources/skills/nai5-prompting/references/通用写法.md?raw';
import ideationMd from '../../../server/agent_router/resources/skills/nai5-prompting/references/通用构思.md?raw';
import { stripFrontmatter, type Skill } from './skillCatalog';

export type { Skill } from './skillCatalog';
export { findSkill, formatSkillsForSystemPrompt } from './skillCatalog';

export const BUILTIN_SKILLS: readonly Skill[] = [
  {
    id: 'nai5-prompting',
    name: 'NAI V5 提示词方法层',
    description: '写 NovelAI V5 提示词时必读:四条铁律、字段模板、词组与句子的分工。写词之前先加载它。',
    systemPrompt: stripFrontmatter(skillMd),
  },
  {
    id: 'nai5-prompting/通用写法',
    name: 'V5 通用写法(参考)',
    description: '方法层的写法细节:取景、人数与姿势、文字渲染、多角色与分格、施受前缀等实测口径。需要具体写法时加载。',
    systemPrompt: writingMd.replace(/\r\n/g, '\n').trim(),
  },
  {
    id: 'nai5-prompting/通用构思',
    name: 'V5 通用构思(参考)',
    description: '方法层的构思流程:编剧 / 监督 / 原画 / 摄影四个岗位怎么把模糊需求变成画面。用户只给了方向时加载。',
    systemPrompt: ideationMd.replace(/\r\n/g, '\n').trim(),
  },
];
