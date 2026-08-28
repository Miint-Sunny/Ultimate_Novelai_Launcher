/**
 * NAI Diffusion V5 的「开关词条」表。
 *
 * 这批词不是普通的 danbooru tag——它们写进提示词就整体改变出图取向,而且拼错了
 * **不报错**,只是悄悄不生效。用户靠记忆手打的成本就在这里:`depthness` 少一个 s、
 * `ultra complexity` 写成 `ultra complex`,出图看着"就是没开",没有任何反馈。
 * 所以这张表的价值不在省几次按键,而在**把字面量从记忆里搬到代码里**。
 *
 * 出处:用户自己的方法论仓 nai5-prompting,**当前正本是 `NAI5_All_Prompting.md`
 * (1690 行,GitHub main)**。注意本机 `~/Downloads/nai5-prompting/` 里那份
 * `nai5-prompting-skill.md`(292 行)是**旧版**,词表已经变过,别拿它当准。
 *
 * 三条刻意的缺席,别当成遗漏:
 *   - `res_mult:Nx` —— 我们自己的 V5 方案 P7 里列过它,但在 nai5-prompting 全文
 *     零命中,没有任何出处。没依据的词条放进面板就是"开了没用",比不放更糟。
 *   - `transparent background` —— 它已经有专门的 UI 开关(AISettingsPanel /
 *     MobileAdvancedSettingsSheet),而且那个开关除了插词还会发
 *     `tag_hint_transparent_background`。再做一个入口只会让两边打架。
 *   - `location` —— 旧版文档里有(indoors/outdoors 合集),**当前正本里 0 命中**,
 *     连同 `indoors`/`outdoors` 一起被移除了;现在的等价处置是
 *     `-1::simple background::` 加上把场景写明。它曾经短暂进过这张表,是我照旧版
 *     抄的,已摘除。
 */

/**
 * 组内是否互斥。exclusive = 分档单选,independent = 各自独立的开关。
 *
 * 注意:complexity 与 visual novel 的「互斥」是**我们的产品决定**,不是文档规定的。
 * nai5-prompting 有一张正式的互斥组表(视线/景别/背景形态/姿态/机位/版式),
 * 这两组并不在其中。做成单选是因为它们读起来就是一个档位旋钮,同时开两档没有意义;
 * 但用户手写出两档并存是合法的,所以检测层必须如实报告两个都在(见 activeV5Toggles)。
 */
export type V5ToggleGroupKind = 'exclusive' | 'independent';

export interface V5ToggleOption {
  /** 发给服务端的字面量,逐字,不要「顺手」改大小写或加连字符。 */
  literal: string;
  /** 中文显示名。 */
  label: string;
  /**
   * 只参与检测,不给点击。
   *
   * 目前只有 `transparent background`:它属于「背景形态」这个互斥组,所以撞车检测
   * 必须看得见它;但插词这件事已经有专门的 UI 开关在做(那个开关还会连带发
   * `tag_hint_transparent_background`),再给一个可点入口就是两边打架。
   */
  detectOnly?: boolean;
  /**
   * 允许与之并存的同组字面量。
   *
   * 目前只有 `comic`:文档明说它可以和**格数词**(`4koma` 等)叠——注意是格数词,
   * 不是同组任意值,所以 `comic + sticker` 仍然算撞车。写成明确配对而不是
   * 「自由叠加」布尔,就是为了不把这个区别抹掉。
   */
  stacksWith?: readonly string[];
}

export interface V5ToggleGroup {
  id: string;
  /** 面板上的分组标题。 */
  title: string;
  kind: V5ToggleGroupKind;
  /** 一句话说明,用于 HelpTip / title 属性。 */
  hint: string;
  /** 只在 V5 家族出现(§3.10 的专有开关);其余组对所有模型都适用。 */
  v5Only?: boolean;
  options: V5ToggleOption[];
}

export const V5_TOGGLE_GROUPS: readonly V5ToggleGroup[] = [
  {
    id: 'complexity',
    title: '内容复杂度',
    kind: 'exclusive',
    v5Only: true,
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
    v5Only: true,
    hint: '视觉小说素材的五种形态。背景图可配「高复杂度 + 阴影纵深」;立绘与 Q 版建议配透明背景。',
    options: [
      { literal: 'visual novel art', label: '整体风格' },
      { literal: 'visual novel bg', label: '背景' },
      { literal: 'visual novel cg', label: '剧情 CG' },
      { literal: 'visual novel sprite', label: '立绘' },
      { literal: 'visual novel chibi', label: 'Q 版' },
    ],
  },
  {
    id: 'v5-extras',
    title: 'V5 词条',
    kind: 'independent',
    v5Only: true,
    hint: 'V5 新增的几个独立词条,可以叠加。`has alpha` 官方建议写在光效/粒子词条之后。',
    options: [
      { literal: 'depthness', label: '阴影纵深' },
      { literal: 'has alpha', label: 'alpha 通道' },
      { literal: 'alpha transparency', label: '物体半透明' },
      { literal: 'attractive male', label: '帅气男性' },
    ],
  },
  // ↓ 以下六组来自 §3.9「互斥组:这几类各只能挑一个」。它们不是 V5 专有,
  //   对所有模型都适用,所以没有 v5Only。
  //
  //   文档给了实测数据说明为什么值得做:254 条有视线词的提示词里 **20% 写了不止
  //   一个方向**,415 条有取景词的里 **22% 写了不止一个距离**。同组写两个时模型会
  //   在矛盾指令之间摇摆,通常两个都做不准——而服务端一样不报错。
  {
    id: 'gaze',
    title: '视线方向',
    kind: 'exclusive',
    hint: '只能挑一个。`looking back`(回头)与 `closed eyes`(闭眼)不是方向,可以另外叠。多角色互看只写 `looking at another` 一个,高低差交给句子。',
    options: [
      { literal: 'looking at viewer', label: '看镜头' },
      { literal: 'looking to the side', label: '看侧面' },
      { literal: 'looking up', label: '向上看' },
      { literal: 'looking down', label: '向下看' },
      { literal: 'looking away', label: '看别处' },
      { literal: 'looking at another', label: '看向他人' },
    ],
  },
  {
    id: 'framing',
    title: '取景距离',
    kind: 'exclusive',
    hint: '只能挑一个。`wide shot` 说的是镜头退多远,不在这一组,可以和 `full body` 叠。',
    options: [
      { literal: 'close-up', label: '特写' },
      { literal: 'portrait', label: '肖像' },
      { literal: 'upper body', label: '半身' },
      { literal: 'cowboy shot', label: '七分身' },
      { literal: 'full body', label: '全身' },
    ],
  },
  {
    id: 'background-form',
    title: '背景形态',
    kind: 'exclusive',
    hint: '只能挑一个。透明背景另有专门开关(它还会连带发 tag_hint),这里只参与撞车检测。',
    options: [
      { literal: 'simple background', label: '简单' },
      { literal: 'blurry background', label: '虚化' },
      { literal: 'white background', label: '纯白' },
      { literal: 'detailed background', label: '细节' },
      { literal: 'dark background', label: '暗背景' },
      { literal: 'transparent background', label: '透明', detectOnly: true },
    ],
  },
  {
    id: 'posture',
    title: '体位',
    kind: 'exclusive',
    hint: '只能挑一个。多角色是例外——一人站一人蹲时两个都要写,靠句子说清谁是谁。',
    options: [
      { literal: 'standing', label: '站' },
      { literal: 'sitting', label: '坐' },
      { literal: 'lying', label: '躺' },
      { literal: 'kneeling', label: '跪' },
      { literal: 'squatting', label: '蹲' },
    ],
  },
  {
    id: 'camera-horizontal',
    title: '水平机位',
    kind: 'exclusive',
    hint: '只能挑一个,但可以和垂直机位叠一个:`from below, from side` 合法,`from behind, from side` 不合法。',
    options: [
      { literal: 'straight on', label: '正面' },
      { literal: 'from side', label: '侧面' },
      { literal: 'from behind', label: '背面' },
    ],
  },
  {
    id: 'camera-vertical',
    title: '垂直机位',
    kind: 'exclusive',
    hint: '两者互斥,但可以和水平机位各叠一个。',
    options: [
      { literal: 'from below', label: '仰拍' },
      { literal: 'from above', label: '俯拍' },
    ],
  },
  {
    id: 'layout',
    title: '版式',
    kind: 'exclusive',
    hint: '只能挑一个。`comic` 可以和格数词(`4koma` 等)叠;格数排布说不了的用句子写,不要自造 `vertical` 这类 tag。',
    options: [
      { literal: 'comic', label: '漫画', stacksWith: ['4koma'] },
      { literal: '4koma', label: '四格' },
      { literal: 'multiple views', label: '多视图' },
      { literal: 'reference sheet', label: '设定图' },
      { literal: 'sticker', label: '贴纸' },
    ],
  },
] as const;

/** 表里所有字面量。 */
const ALL_LITERALS: readonly string[] = V5_TOGGLE_GROUPS.flatMap((g) =>
  g.options.map((o) => o.literal),
);

/** 一个被扫描出来的标签,连同它在权重语法下的实际处境。 */
interface ScannedTag {
  /** 在 splitWithSeparators 结果里的下标(偶数位)。 */
  index: number;
  /** 剥掉权重记号后的裸内容,小写。 */
  body: string;
  /** 生效权重;null 表示没有权重。 */
  weight: number | null;
  /** 自己带了开权重前缀 `N::`。 */
  opens: boolean;
  /** 自己带了收尾 `::`。 */
  closes: boolean;
}

const WEIGHT_PREFIX = /^(-?\d+(?:\.\d+)?)::/;

/**
 * 按分隔符切开但把分隔符留在数组里,这样重建时能保住用户的排版习惯。
 *
 * 顿号「、」也算:中文输入法下它和逗号一样容易打出来,实测的提示词里确实混着用。
 */
function splitWithSeparators(prompt: string): string[] {
  return prompt.split(/([,，、\n])/);
}

/**
 * 扫描提示词,解出每个标签的裸内容与生效权重。
 *
 * 权重是**跨标签**的:`1.5::a, b::` 里 a 和 b 都在 1.5 的作用域内。更要命的是
 * 漏写收尾 `::` 时权重会一直吃到结尾——这是文档专门警告过的坑,所以这里按
 * 「开括号未闭合则继续生效」如实建模,而不是只看单个标签。
 */
function scanTags(prompt: string): ScannedTag[] {
  const parts = splitWithSeparators(prompt);
  const tags: ScannedTag[] = [];
  let openWeight: number | null = null;

  for (let index = 0; index < parts.length; index += 2) {
    const trimmed = parts[index].trim();
    const open = trimmed.match(WEIGHT_PREFIX);
    const weight: number | null = open ? Number.parseFloat(open[1]) : openWeight;
    // 句末标点要先剥:这套方法论里 tag 常常跟在自然语句后面,`ultra complexity.`
    // 和 `0.6::attractive male::.` 都是真实写法,不剥就整条匹配不上。
    const afterPrefix = trimmed.replace(WEIGHT_PREFIX, '').replace(/[.。\s]+$/, '');
    const closes = /::+$/.test(afterPrefix);
    tags.push({
      index,
      body: afterPrefix
        .replace(/::+$/, '')
        .replace(/[.。\s]+$/, '')
        .trim()
        .toLowerCase(),
      weight,
      opens: Boolean(open),
      closes,
    });
    if (closes) openWeight = null;
    else if (open) openWeight = weight;
  }
  return tags;
}

/**
 * 一个标签算不算「这个词条已开」。
 *
 * 负权重**不算开**——`-1::ultra complexity::` 是文档里记载的反向用法
 * (complexity 有画面固化倾向,负权重反而更好),用户要的是它的反面,把按钮点亮
 * 会让人再点一次去"关",结果反而把那条负权重删了。0~1 的小数是**减弱不是反转**,
 * 仍然算开。
 */
function tagCounts(tag: ScannedTag, literal: string): boolean {
  if (tag.body !== literal.toLowerCase()) return false;
  return tag.weight === null || tag.weight > 0;
}

/** 提示词里当前生效的开关词条(小写字面量集合)。 */
export function activeV5Toggles(prompt: string): Set<string> {
  const tags = scanTags(prompt);
  const active = new Set<string>();
  for (const literal of ALL_LITERALS) {
    if (tags.some((t) => tagCounts(t, literal))) active.add(literal.toLowerCase());
  }
  return active;
}

/** 收掉摘除后留下的空档:连续分隔符、首尾分隔符。 */
function tidy(prompt: string): string {
  return prompt
    .replace(/([,，、])\s*(?=[,，、])/g, '')
    .replace(/^[\s,，、]+/, '')
    .replace(/[\s,，、]+$/, '');
}

/**
 * 摘掉一个字面量的所有生效实例,并修补被拆开的权重段。
 *
 * 修补是必须的:`1.5::high complexity, detailed background::` 里摘掉前者,
 * 如果只是删标签,`1.5::` 这个开括号就跟着没了,剩下的 `detailed background::`
 * 变成一个孤零零的收尾符——那会把它之前的**别的**权重段错误闭合。
 */
function removeLiteral(prompt: string, literal: string): string {
  const parts = splitWithSeparators(prompt);
  const tags = scanTags(prompt);
  const doomed = tags.filter((t) => tagCounts(t, literal));
  if (doomed.length === 0) return prompt;

  for (const tag of doomed) {
    const sameSpan = tags.filter(
      (t) => t.index !== tag.index && parts[t.index] !== null && spanOf(tags, t) === spanOf(tags, tag),
    );
    // 开括号要传给同段的下一个标签,收尾符要交给同段的上一个标签。
    if (tag.opens && !tag.closes) {
      const next = sameSpan.find((t) => t.index > tag.index);
      if (next) parts[next.index] = ` ${tag.weight}::${parts[next.index].trim()}`;
    }
    if (tag.closes && !tag.opens) {
      const prev = [...sameSpan].reverse().find((t) => t.index < tag.index);
      if (prev) parts[prev.index] = `${parts[prev.index].replace(/\s+$/, '')}::`;
    }
    parts[tag.index] = '';
    if (tag.index + 1 < parts.length) parts[tag.index + 1] = '';
  }
  return tidy(parts.join(''));
}

/** 同一个权重段的编号:从最近一个未闭合的开括号算起。 */
function spanOf(tags: ScannedTag[], target: ScannedTag): number {
  let span = -1;
  let counter = 0;
  let open = false;
  for (const tag of tags) {
    if (tag.opens && !open) {
      open = true;
      counter += 1;
    }
    if (tag.index === target.index) span = open ? counter : 0;
    if (tag.closes) open = false;
  }
  return span;
}

/** 追加一个字面量到提示词末尾。 */
function appendLiteral(prompt: string, literal: string): string {
  const base = tidy(prompt);
  return base ? `${base}, ${literal}` : literal;
}

/** 同一互斥组里同时生效了两个以上的值——文档说这时模型会在矛盾指令之间摇摆。 */
export interface V5GroupConflict {
  groupId: string;
  title: string;
  /** 撞在一起的字面量,按表内顺序。 */
  literals: string[];
  /** 给用户看的一句话。 */
  message: string;
}

/**
 * 找出互斥组里的撞车。
 *
 * 这是这张表真正值钱的地方:文档实测 254 条有视线词的提示词里 20% 写了不止一个
 * 方向,415 条有取景词的里 22% 写了不止一个距离——而服务端对此不报错,出图只是
 * 「不太对」。同组写两个不是风格选择,是失误。
 *
 * 体位组有一条**故意不处理**的例外:多角色时一人站一人蹲,两个都要写是对的。
 * 我们分不出提示词里有几个角色,所以照报不误,但话술上说成「确认是不是多角色」
 * 而不是断言写错。
 */
export function detectV5GroupConflicts(prompt: string): V5GroupConflict[] {
  const active = activeV5Toggles(prompt);
  const conflicts: V5GroupConflict[] = [];
  for (const group of V5_TOGGLE_GROUPS) {
    if (group.kind !== 'exclusive') continue;
    const hit = group.options.filter((o) => active.has(o.literal.toLowerCase()));
    if (hit.length < 2) continue;
    // 一对值合法当且仅当其中一方在自己的 stacksWith 里点了另一方。
    const allowed = (a: V5ToggleOption, b: V5ToggleOption): boolean =>
      (a.stacksWith ?? []).includes(b.literal) || (b.stacksWith ?? []).includes(a.literal);
    const clashing = hit.filter((a) => hit.some((b) => b !== a && !allowed(a, b)));
    if (clashing.length < 2) continue;
    const literals = clashing.map((o) => o.literal);
    conflicts.push({
      groupId: group.id,
      title: group.title,
      literals,
      message:
        group.id === 'posture'
          ? `体位写了 ${literals.join(' / ')} ——多角色时这是对的,单角色时模型会摇摆`
          : `${group.title}只能挑一个,现在写了 ${literals.join(' / ')}`,
    });
  }
  return conflicts;
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
  const option = group.options.find((o) => o.literal === literal);
  if (!option) return prompt;
  // detectOnly 的值只参与撞车检测,不接受点击——它的插词入口在别处。
  if (option.detectOnly) return prompt;

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
