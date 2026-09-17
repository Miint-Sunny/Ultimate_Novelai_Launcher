/** 技能目录的纯逻辑(查找、目录格式化);技能正文的 ?raw 导入在 skills.ts。 */

export interface Skill {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** 假 = 出现在目录里,模型可以按需加载。 */
  disableModelInvocation?: boolean;
  /**
   * 技能包(照他的 ca4f2e7):配套资源存在应用托管的 IndexedDB 里,这里只记随机键,
   * 不接受技能文档里的路径作为存储位置。
   */
  packageId?: string;
  /** 包内 SKILL.md 之外的文件,相对技能根目录,已排序;load_skill 只认这份清单。 */
  resourcePaths?: string[];
  /** license / compatibility / metadata / allowed-tools 等扩展字段原样保留;allowed-tools 只是元数据,不授予权限。 */
  extraFrontmatter?: Record<string, unknown>;
}

export function stripFrontmatter(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return normalized.trim();
  const end = normalized.indexOf('\n---', 3);
  return end < 0 ? normalized.trim() : normalized.slice(end + 4).trim();
}

export function findSkill(idOrName: string, skills: readonly Skill[]): Skill | undefined {
  const key = idOrName.trim().toLowerCase();
  return skills.find((s) => s.id.toLowerCase() === key || s.name.toLowerCase() === key)
    ?? skills.find((s) => s.id.toLowerCase().endsWith(`/${key}`));
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 照他的 `formatSkillsForSystemPrompt`:目录进系统提示词,正文不进。 */
export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return '';
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    'Use `load_skill` for relevant instructions not already present in the current context. Reload after compaction if needed.',
    '',
    '<available_skills>',
  ];
  for (const skill of visible) {
    lines.push('  <skill>', `    <name>${escapeXml(skill.id)}</name>`, `    <description>${escapeXml(skill.description)}</description>`, '  </skill>');
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}
