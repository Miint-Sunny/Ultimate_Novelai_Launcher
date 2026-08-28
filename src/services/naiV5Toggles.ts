/**
 * NAI Diffusion V5 的「开关词条」表。
 *
 * 这批词不是普通的 danbooru tag——它们写进提示词就整体改变出图取向,而且拼错了
 * **不报错**,只是悄悄不生效。用户靠记忆手打的成本就在这里:`depthness` 少一个 s、
 * `ultra complexity` 写成 `ultra complex`,出图看着"就是没开",没有任何反馈。
 * 所以这张表的价值不在省几次按键,而在**把字面量从记忆里搬到代码里**。
 *
 * 出处:用户自己的方法论仓 nai5-prompting(`nai5-prompting-skill.md` 第 9 节
 * 「V5 新增」,约 2000 张实测)。**逐字取自那里,改这张表前先回去核**。
 *
 * 两条刻意的缺席,别当成遗漏:
 *   - `res_mult:Nx` —— 我们自己的 V5 方案 P7 里列过它,但在 nai5-prompting 全文
 *     零命中,没有任何出处。没依据的词条放进面板就是"开了没用",比不放更糟。
 *   - `transparent background` —— 它已经有专门的 UI 开关(AISettingsPanel /
 *     MobileAdvancedSettingsSheet),而且那个开关除了插词还会发
 *     `tag_hint_transparent_background`。再做一个入口只会让两边打架。
 */

/** 组内是否互斥。exclusive = 分档单选,independent = 各自独立的开关。 */
export type V5ToggleGroupKind = 'exclusive' | 'independent';

export interface V5ToggleOption {
  /** 发给服务端的字面量,逐字,不要「顺手」改大小写或加连字符。 */
  literal: string;
  /** 中文显示名。 */
  label: string;
}

export interface V5ToggleGroup {
  id: string;
  /** 面板上的分组标题。 */
  title: string;
  kind: V5ToggleGroupKind;
  /** 一句话说明,用于 HelpTip / title 属性。 */
  hint: string;
  options: V5ToggleOption[];
}

export const V5_TOGGLE_GROUPS: readonly V5ToggleGroup[] = [
  {
    id: 'complexity',
    title: '内容复杂度',
    kind: 'exclusive',
    hint: '控制画面信息密度。正常美图用「高」,海报或大场景用「极高」。',
    options: [
      { literal: 'low complexity', label: '低' },
      { literal: 'medium complexity', label: '中' },
      { literal: 'high complexity', label: '高' },
      { literal: 'ultra complexity', label: '极高' },
    ],
  },
  {
    id: 'visual-novel',
    title: 'Galgame 风格',
    kind: 'exclusive',
    hint: '视觉小说的三种画面形态:背景图 / CG / 立绘。三选一。',
    options: [
      { literal: 'visual novel bg', label: '背景' },
      { literal: 'visual novel cg', label: 'CG' },
      { literal: 'visual novel sprite', label: '立绘' },
    ],
  },
  {
    id: 'v5-extras',
    title: 'V5 词条',
    kind: 'independent',
    hint: 'V5 新增的几个独立词条,可以叠加。',
    options: [
      { literal: 'depthness', label: '阴影纵深' },
      { literal: 'has alpha', label: 'alpha 通道' },
      { literal: 'alpha transparency', label: '物体半透明' },
      { literal: 'attractive male', label: '帅气男性' },
      { literal: 'location', label: '场景合集' },
    ],
  },
] as const;

/** 表里所有字面量,按长度降序——匹配时先长后短,免得 `has alpha` 被短词吃掉。 */
const ALL_LITERALS: readonly string[] = V5_TOGGLE_GROUPS.flatMap((g) =>
  g.options.map((o) => o.literal),
).sort((a, b) => b.length - a.length);

/** 提示词按逗号切成标签。换行按逗号同等对待——用户经常用换行分组。 */
function splitTags(prompt: string): string[] {
  return prompt.split(/[,，\n]/);
}

/**
 * 一个标签是否就是某个字面量。
 *
 * 刻意只认「干净的裸词」:`high complexity` 命中,`2::high complexity::` 不命中。
 * 这不是偷懒——面板只负责它自己插进去的那些词,用户手写的加权形态属于用户,
 * 我们既不该认领也不该替他删掉。
 */
function tagIsLiteral(tag: string, literal: string): boolean {
  return tag.trim().toLowerCase() === literal.toLowerCase();
}

/** 提示词里当前生效的开关词条(小写字面量集合)。 */
export function activeV5Toggles(prompt: string): Set<string> {
  const tags = splitTags(prompt);
  const active = new Set<string>();
  for (const literal of ALL_LITERALS) {
    if (tags.some((t) => tagIsLiteral(t, literal))) active.add(literal.toLowerCase());
  }
  return active;
}

/** 从提示词里摘掉指定字面量,并把留下的分隔符收拾干净。 */
function removeLiteral(prompt: string, literal: string): string {
  const kept: string[] = [];
  let removed = false;
  // 用带分隔符的切分保留原始排版(换行位置、逗号后的空格习惯)。
  const parts = prompt.split(/([,，\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    const tag = parts[i];
    const sep = parts[i + 1] ?? '';
    if (tagIsLiteral(tag, literal)) {
      removed = true;
      continue;
    }
    kept.push(tag + sep);
  }
  if (!removed) return prompt;
  return tidy(kept.join(''));
}

/** 收掉摘除后留下的空档:连续分隔符、首尾分隔符。 */
function tidy(prompt: string): string {
  return prompt
    .replace(/([,，])\s*(?=[,，])/g, '')
    .replace(/^[\s,，]+/, '')
    .replace(/[\s,，]+$/, '');
}

/** 追加一个字面量到提示词末尾。 */
function appendLiteral(prompt: string, literal: string): string {
  const base = tidy(prompt);
  return base ? `${base}, ${literal}` : literal;
}

/**
 * 切换一个开关词条,返回新的提示词。
 *
 * 已生效 → 摘掉;未生效 → 追加到末尾。exclusive 组会先把同组其它档摘掉,
 * 所以「从高切到极高」是一步,不会两个档同时留在提示词里。
 */
export function toggleV5Word(prompt: string, groupId: string, literal: string): string {
  const group = V5_TOGGLE_GROUPS.find((g) => g.id === groupId);
  if (!group) return prompt;
  if (!group.options.some((o) => o.literal === literal)) return prompt;

  const active = activeV5Toggles(prompt);
  if (active.has(literal.toLowerCase())) return removeLiteral(prompt, literal);

  let next = prompt;
  if (group.kind === 'exclusive') {
    for (const option of group.options) {
      if (active.has(option.literal.toLowerCase())) next = removeLiteral(next, option.literal);
    }
  }
  return appendLiteral(next, literal);
}
