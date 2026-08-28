// 提示词标签解析与权重工具 —— 双端共享（DesktopChipEditor / mobile FullscreenEditor）
// 折叠标记格式 <<type:name:content>> 与 services/novelai.ts 的 cleanPromptMarkers 保持一致

// splitPromptToTags 会把换行保留为该哨兵标签，使用方自行决定渲染或过滤
export const NEWLINE_SENTINEL = '\n';

// 画师串标记：<<artist:名称:内容>>
const ARTIST_MARKER_RE = /^<<artist:(.+?):(.+)>>$/s;
// type 通用匹配 (artist/codex/oc/scene/other/自定义 subtype)
const COLLAPSIBLE_MARKER_RE = /^<<([\w-]+):([^:]+):((?:.|\n)*?)>>$/s;
// 标记开头检测 (splitPromptToTags 用)：<<任意type:
const COLLAPSIBLE_MARKER_PREFIX_RE = /^<<[\w-]+:/;

export const isArtistMarker = (tag: string): boolean => ARTIST_MARKER_RE.test(tag.trim());
export const parseArtistMarker = (tag: string): { name: string; content: string } | null => {
  const m = tag.trim().match(ARTIST_MARKER_RE);
  return m ? { name: m[1], content: m[2] } : null;
};
export const makeArtistMarker = (name: string, content: string): string => `<<artist:${name}:${content}>>`;

export const isCollapsibleMarker = (tag: string): boolean => COLLAPSIBLE_MARKER_RE.test(tag.trim());
export const parseCollapsibleMarker = (tag: string): { type: string; name: string; content: string } | null => {
  const m = tag.trim().match(COLLAPSIBLE_MARKER_RE);
  return m ? { type: m[1], name: m[2], content: m[3] } : null;
};

// 智能分割 prompt 为标签数组：保护 <<type:...>> 折叠标记与 weight::content:: 权重语法不被逗号拆散，
// 换行保留为 NEWLINE_SENTINEL 标签
export const splitPromptToTags = (value: string): string[] => {
  if (!value.trim()) return [];
  const tags: string[] = [];
  let remaining = value;

  while (remaining.length > 0) {
    // 先处理换行符：保留为特殊标记（每个 \n 一个，保留多行间距）
    const nlMatch = remaining.match(/^[ \t,，]*\n/);
    if (nlMatch) {
      if (tags.length > 0) {
        tags.push(NEWLINE_SENTINEL);
      }
      remaining = remaining.slice(nlMatch[0].length);
      continue;
    }
    const leadTrimmed = remaining.replace(/^[ \t,，]+/, '');
    if (!leadTrimmed) break;
    remaining = leadTrimmed;

    // 处理 collapsible marker (artist/codex/oc/scene/other/自定义 subtype)
    if (COLLAPSIBLE_MARKER_PREFIX_RE.test(remaining)) {
      const endIdx = remaining.indexOf('>>');
      if (endIdx !== -1) {
        tags.push(remaining.slice(0, endIdx + 2).trim());
        remaining = remaining.slice(endIdx + 2);
        continue;
      }
    }

    // 普通标签（含数字权重前缀），按逗号分割
    // 数字权重 weight::content:: 会被按逗号拆成多个标签（如 "1.2::tag_a", "tag_b", "tag_c::"），
    // 再由 analyzeTagGroups 识别为一个权重组，与 {} 的分组方式一致
    // 匹配: 前置管道符 + 非逗号管道符内容 + 后置管道符, 或孤立的管道符序列
    const match = remaining.match(/^(\|*[^|,，\n]+\|*|^\|+)/);
    if (match) {
      const t = match[1].trim();
      if (t) tags.push(t);
      remaining = remaining.slice(match[1].length);
    } else {
      const commaIdx = remaining.search(/[,，]/);
      if (commaIdx === -1) {
        const t = remaining.trim();
        if (t) tags.push(t);
        break;
      }
      const t = remaining.slice(0, commaIdx).trim();
      if (t) tags.push(t);
      remaining = remaining.slice(commaIdx + 1);
    }
  }

  // 后处理：合并孤立的权重前缀和收尾标记（均不跨换行哨兵合并，避免吞换行/跨行拼接出畸形 tag）
  // 1. 孤立的收尾 :: → 合并到前一个 tag（如 ["tag_a", "::"] → ["tag_a::"]）
  for (let i = tags.length - 1; i >= 1; i--) {
    if (tags[i] === '::' && tags[i - 1] !== NEWLINE_SENTINEL) {
      tags[i - 1] = tags[i - 1] + '::';
      tags.splice(i, 1);
    }
  }
  // 2. 孤立的权重前缀 N:: → 合并到下一个 tag（如 ["2::", "tag_a"] → ["2::tag_a"]）
  for (let i = 0; i < tags.length - 1; i++) {
    if (/^-?\d+(?:\.\d+)?::$/.test(tags[i].trim()) && tags[i + 1] !== NEWLINE_SENTINEL) {
      tags[i] = tags[i].trim() + tags[i + 1].trimStart();
      tags.splice(i + 1, 1);
      i--; // 重新检查当前位置
    }
  }

  return tags;
};

// 剔除 ~ 开头的禁用标签（生成与 token 计数共用，保持一致）
// 按行处理：避免 "tag_a\n~hidden" 这类紧跟换行的禁用标签因不在片段开头而漏过滤
export const filterHiddenTags = (prompt: string): string =>
  prompt.split('\n').map(line =>
    line.split(/[,，]/).map(t => t.trim()).filter(t => t && !t.startsWith('~')).join(', ')
  ).join('\n');

// 清理标签权重符号，返回纯标签名（折叠标记原样保留）
export const cleanTagName = (raw: string): string => {
  if (isCollapsibleMarker(raw)) return raw;
  let c = raw.replace(/^~/, ''); // 去除禁用前缀
  c = c.replace(/^\|+|\|+$/g, ''); // 去除边缘管道符
  c = c.replace(/^\{+|\}+$/g, '').replace(/^\[+|\]+$/g, '');
  c = c.replace(/^-?\d+(?:\.\d+)?::(.+?)(?:::)?$/, '$1');
  c = c.replace(/::+$/, '');
  return c.replace(/_/g, ' ').trim();
};

// 检测单个标签的权重（仅首尾配对的括号）
export const getTagWeightInfo = (raw: string): { type: 'none' | 'brace' | 'bracket' | 'numeric'; level: number; numericValue?: number } => {
  const trimmed = raw.trim();
  const numMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)::/);
  if (numMatch) return { type: 'numeric', level: 0, numericValue: parseFloat(numMatch[1]) };
  const braceMatch = trimmed.match(/^(\{+)/);
  const braceEnd = trimmed.match(/(\}+)$/);
  if (braceMatch && braceEnd) return { type: 'brace', level: Math.min(braceMatch[1].length, braceEnd[1].length) };
  const bracketMatch = trimmed.match(/^(\[+)/);
  const bracketEnd = trimmed.match(/(\]+)$/);
  if (bracketMatch && bracketEnd) return { type: 'bracket', level: Math.min(bracketMatch[1].length, bracketEnd[1].length) };
  return { type: 'none', level: 0 };
};

// 词字符：字母 / 数字 / 下划线，含中日韩表意文字与假名（\p{L}\p{N} 覆盖全部 Unicode 文字）
// 「数字紧贴词字符」= 名字尾巴（如 na_tarapisu153 的 153），
// 而合法权重 1.2::tag:: 的 1.2 前面是字符串开头或分隔符（{、[、空格等），不紧贴词字符
const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

export type AbnormalWeightReason = 'attached-to-word' | 'large-number';

export interface AbnormalWeightWarning {
  /** 被误读风险点的数字串，如 "153" */
  token: string;
  /** attached-to-word: 数字紧贴词字符(名字尾); large-number: :: 前 ≥10 的可疑大数字(旧信号) */
  reason: AbnormalWeightReason;
  /** 给用户看的一句话说明 */
  message: string;
  /** 可执行的修正建议(仅提示，不自动改写)；两类信号目前都有确定建议，不为 null */
  suggestion: string | null;
}

// 悬浮提示用的完整文案（说明 + 建议一行拼齐，双端 chip 共用，避免组件各拼一份）
export const formatAbnormalWeightTip = (w: AbnormalWeightWarning): string =>
  w.suggestion ? `${w.message} ${w.suggestion}` : w.message;

// 检测异常权重：数字紧跟 "::" 会被 NAI 服务端吃成权重，画师名以数字结尾时
// （na_tarapisu153:: → 权重 153）出图直接烧掉。两类信号合并为带 reason 的单一结果：
//   1. attached-to-word（主信号）：数字紧贴词字符（含中日文），是名字尾巴被吃 —— 个位数同样命中
//   2. large-number（旧信号保留）：非词字符紧贴但数值 ≥10 的可疑大数字（如 "b 12::"）
// 标签开头的合法权重前缀（含负号与小数，同 getTagWeightInfo）跳过不计。
export const detectAbnormalWeight = (rawTag: string): AbnormalWeightWarning | null => {
  const trimmed = rawTag.trim();
  // 开头的合法权重前缀 span（"-12::" 里的 "12::" 起点在 span 内，一并跳过）
  const leading = trimmed.match(/^-?(\d+(?:\.\d+)?)::/);
  const leadingEnd = leading ? leading[0].length : 0;
  const regex = /(\d+(?:\.\d+)?)::/g;
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    if (match.index < leadingEnd) continue; // 合法权重前缀本身
    const prevChar = match.index > 0 ? trimmed[match.index - 1] : '';
    const token = match[1];
    if (WORD_CHAR_RE.test(prevChar)) {
      // 数字后面是否只剩冒号（决定能否给出具体改写）
      const restIsColons = /^:*$/.test(trimmed.slice(match.index + match[0].length));
      const suggestion = restIsColons
        ? `去掉尾部的 "::"（写成 ${trimmed.replace(/:+$/, '')}）；若该 "::" 是权重组收尾，请挪到不以数字结尾的标签上`
        : `去掉或挪开紧贴 "${token}" 的 "::"，不要让数字与 "::" 相邻`;
      return { token, reason: 'attached-to-word', message: `"${token}" 是名字尾部的数字，紧跟 "::" 会被服务端误读为权重`, suggestion };
    }
    if (parseFloat(token) >= 10) {
      return { token, reason: 'large-number', message: `"${token}" 可能被误识别为权重`, suggestion: `确认 "${token}" 是否确为权重；若是名字/编号的一部分，请去掉紧贴它的 "::"` };
    }
  }
  return null;
};

// SD WebUI 格式的权重标签: (tag:weight) 或 (tag)
const SD_WEIGHT_RE = /^\((.+?)(?::(\d+(?:\.\d+)?))?\)$/;
export const isSDWeightFormat = (raw: string): boolean => SD_WEIGHT_RE.test(raw.trim());
export const parseSDWeight = (raw: string): { tag: string; weight: number | null } | null => {
  const m = raw.trim().match(SD_WEIGHT_RE);
  if (!m) return null;
  return { tag: m[1], weight: m[2] ? parseFloat(m[2]) : null }; // null 表示没有指定权重，使用 {} 格式
};
// 将 SD 格式转换为 NAI 格式（与 bot 逻辑一致）
export const convertSDToNAI = (raw: string): string => {
  const parsed = parseSDWeight(raw);
  if (!parsed) return raw;
  const { tag, weight } = parsed;
  const cleanTag = tag.replace(/ /g, '_');
  if (weight === null) {
    // (tag) 没有权重 → {tag}
    return `{${cleanTag}}`;
  }
  if (Math.abs(weight - 1.0) < 0.01) return cleanTag;
  // (tag:weight) → weight::tag::
  return `${weight}::${cleanTag}::`;
};

export interface TagGroupInfo {
  groupId: number;           // 同组标签共享同一个 groupId
  position: 'solo' | 'first' | 'middle' | 'last'; // 在组内的位置
  groupType: 'none' | 'brace' | 'bracket'; // 组的括号类型
  groupLevel: number;        // 组的括号层级
}

// 解析标签的权重组关系（追踪未闭合的括号组与跨标签数值权重组）
export const analyzeTagGroups = (tags: string[]): TagGroupInfo[] => {
  const result: TagGroupInfo[] = tags.map(() => ({ groupId: -1, position: 'solo', groupType: 'none', groupLevel: 0 }));
  let groupCounter = 0;
  const braceStack: { startIdx: number; level: number }[] = [];
  const bracketStack: { startIdx: number; level: number }[] = [];
  let numericStart: number | null = null;
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i].trim();

    // 检测数值权重组
    const numOpen = t.match(/^-?\d+(?:\.\d+)?::/);
    const numClose = /::$/.test(t) && !numOpen;
    if (numOpen && /::$/.test(t.slice(numOpen[0].length))) {
      // solo w::tag:: — 先隐式关闭上一个未闭合的组
      if (numericStart !== null && numericStart < i) {
        const prevEnd = i - 1;
        const gid = groupCounter++;
        for (let j = numericStart; j <= prevEnd; j++) {
          result[j] = { groupId: gid, groupType: 'brace', groupLevel: 0, position: j === numericStart ? 'first' : j === prevEnd ? 'last' : 'middle' };
        }
      }
      numericStart = null;
    } else if (numOpen) {
      // 遇到新权重头：先隐式关闭上一个未闭合的组
      if (numericStart !== null && numericStart < i) {
        const prevEnd = i - 1;
        const gid = groupCounter++;
        for (let j = numericStart; j <= prevEnd; j++) {
          result[j] = { groupId: gid, groupType: 'brace', groupLevel: 0, position: j === numericStart ? 'first' : j === prevEnd ? 'last' : 'middle' };
        }
      }
      numericStart = i;
    }
    if (numClose && numericStart !== null) {
      const gid = groupCounter++;
      for (let j = numericStart; j <= i; j++) {
        result[j] = { groupId: gid, groupType: 'brace', groupLevel: 0, position: j === numericStart ? 'first' : j === i ? 'last' : 'middle' };
      }
      numericStart = null;
    }

    const braceOpen = t.match(/^(\{+)/);
    const bracketOpen = t.match(/^(\[+)/);
    const braceClose = t.match(/(\}+)$/);
    const bracketClose = t.match(/(\]+)$/);
    if (braceOpen && !braceClose) braceStack.push({ startIdx: i, level: braceOpen[1].length });
    if (bracketOpen && !bracketClose) bracketStack.push({ startIdx: i, level: bracketOpen[1].length });
    if (braceClose && !braceOpen && braceStack.length > 0) {
      const group = braceStack.pop()!;
      const gid = groupCounter++;
      for (let j = group.startIdx; j <= i; j++) {
        result[j] = { groupId: gid, groupType: 'brace', groupLevel: group.level, position: j === group.startIdx ? 'first' : j === i ? 'last' : 'middle' };
      }
    }
    if (bracketClose && !bracketOpen && bracketStack.length > 0) {
      const group = bracketStack.pop()!;
      const gid = groupCounter++;
      for (let j = group.startIdx; j <= i; j++) {
        result[j] = { groupId: gid, groupType: 'bracket', groupLevel: group.level, position: j === group.startIdx ? 'first' : j === i ? 'last' : 'middle' };
      }
    }
  }
  // 循环结束后，关闭仍未闭合的数值权重组（没有收尾 :: 也没有下一个权重头）
  if (numericStart !== null && numericStart < tags.length - 1) {
    const lastIdx = tags.length - 1;
    const gid = groupCounter++;
    for (let j = numericStart; j <= lastIdx; j++) {
      result[j] = { groupId: gid, groupType: 'brace', groupLevel: 0, position: j === numericStart ? 'first' : j === lastIdx ? 'last' : 'middle' };
    }
  }
  return result;
};

// 计算标签的有效权重乘数（用于颜色深度映射）
export const getEffectiveWeight = (rawTag: string, group: TagGroupInfo, allTags: string[], allGroups: TagGroupInfo[]): number => {
  const wi = getTagWeightInfo(rawTag.trim());
  // 自包含权重
  if (wi.type === 'numeric') return wi.numericValue ?? 1.0;
  if (wi.type === 'brace') return Math.pow(1.05, wi.level);
  if (wi.type === 'bracket') return Math.pow(1 / 1.05, wi.level);
  // 组内继承：查找组的权重值
  if (group.groupId !== -1) {
    const firstIdx = allGroups.findIndex(g => g.groupId === group.groupId && g.position === 'first');
    if (firstIdx !== -1) {
      const firstWi = getTagWeightInfo(allTags[firstIdx].trim());
      if (firstWi.type === 'numeric') return firstWi.numericValue ?? 1.0;
    }
    if (group.groupType === 'brace') return Math.pow(1.05, Math.max(group.groupLevel, 1));
    if (group.groupType === 'bracket') return Math.pow(1 / 1.05, Math.max(group.groupLevel, 1));
  }
  return 1.0;
};

export interface WeightStyle {
  backgroundColor: string;
  borderColor: string;
}

// 根据权重值返回动态颜色样式（权重越高/低颜色越深）
// neutral: weight=1 时的中性色，桌面与移动端底色不同（移动端全屏黑底需要更亮）
export const getWeightStyle = (
  weight: number,
  neutral: WeightStyle = { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderColor: 'rgba(255, 255, 255, 0.15)' },
): WeightStyle => {
  if (weight > 1) {
    // 增强权重：橙色，weight 1.05 → 很浅，weight 2.0+ → 很深
    const intensity = Math.min(1, (weight - 1) / 1.5);
    return {
      backgroundColor: `rgba(116, 39, 13, ${(0.15 + intensity * 0.50).toFixed(2)})`,
      borderColor: `rgba(251, 146, 60, ${(0.20 + intensity * 0.40).toFixed(2)})`,
    };
  }
  if (weight < 1) {
    // 降低权重：蓝色，weight 0.95 → 很浅，weight 0.2- → 很深
    const intensity = Math.min(1, (1 - weight) / 0.7);
    return {
      backgroundColor: `rgba(59, 130, 246, ${(0.10 + intensity * 0.40).toFixed(2)})`,
      borderColor: `rgba(96, 165, 250, ${(0.20 + intensity * 0.40).toFixed(2)})`,
    };
  }
  return neutral;
};

// 从标签列表中提取指定索引的标签，正确处理数值权重组的拆分
// 返回 { extracted: 提取出的标签（带独立权重）, remaining: 剩余标签（权重保持完整） }
export const extractTagsFromList = (
  tags: string[],
  extractIndices: Set<number>,
  groups: TagGroupInfo[]
): { extracted: string[]; remaining: string[] } => {
  const extracted: string[] = [];
  const remaining: string[] = [];
  // 找出所有被部分提取的数值权重组，记录其权重值
  const groupWeights = new Map<number, number>();
  for (let i = 0; i < tags.length; i++) {
    const g = groups[i];
    if (g.groupId === -1) continue;
    if (groupWeights.has(g.groupId)) continue;
    // 从组的第一个标签提取权重值
    const firstInGroup = tags.find((_, idx) => groups[idx].groupId === g.groupId && groups[idx].position === 'first');
    if (firstInGroup) {
      const m = firstInGroup.match(/^(-?\d+(?:\.\d+)?)::/);
      if (m) groupWeights.set(g.groupId, parseFloat(m[1]));
    }
  }

  // 检查哪些组被部分提取（组内有些被提取，有些保留）
  const partialGroups = new Set<number>();
  for (let i = 0; i < tags.length; i++) {
    const g = groups[i];
    if (g.groupId === -1 || g.groupType !== 'brace' || !groupWeights.has(g.groupId)) continue;
    const groupMembers = tags.map((_, idx) => idx).filter(idx => groups[idx].groupId === g.groupId);
    const someExtracted = groupMembers.some(idx => extractIndices.has(idx));
    const someRemaining = groupMembers.some(idx => !extractIndices.has(idx));
    if (someExtracted && someRemaining) partialGroups.add(g.groupId);
  }

  for (let i = 0; i < tags.length; i++) {
    const g = groups[i];
    const w = g.groupId !== -1 ? groupWeights.get(g.groupId) : undefined;
    const isPartial = g.groupId !== -1 && partialGroups.has(g.groupId);

    if (extractIndices.has(i)) {
      if (isPartial && w !== undefined) {
        // 从部分提取的数值权重组中提取：生成独立的 w::tag:: 格式
        extracted.push(`${w}::${cleanTagName(tags[i]).replace(/ /g, '_')}::`);
      } else {
        extracted.push(tags[i]);
      }
    } else {
      if (isPartial && w !== undefined) {
        // 部分提取的数值权重组中的剩余标签：需要重新包裹
        remaining.push(cleanTagName(tags[i]));
      } else {
        remaining.push(tags[i]);
      }
    }
  }

  // 对剩余标签中属于被部分提取组的连续标签重新包裹权重
  if (partialGroups.size > 0) {
    // 重建剩余标签的组关系：找出需要重新包裹的连续段
    const remainingOrigIndices = tags.map((_, i) => i).filter(i => !extractIndices.has(i));
    for (const gid of partialGroups) {
      const w = groupWeights.get(gid);
      if (w === undefined) continue;
      const indicesInRemaining = remainingOrigIndices
        .map((origIdx, remIdx) => ({ origIdx, remIdx }))
        .filter(({ origIdx }) => groups[origIdx].groupId === gid);
      if (indicesInRemaining.length === 0) continue;
      if (indicesInRemaining.length === 1) {
        const ri = indicesInRemaining[0].remIdx;
        remaining[ri] = `${w}::${remaining[ri].replace(/ /g, '_')}::`;
      } else {
        const first = indicesInRemaining[0].remIdx;
        const last = indicesInRemaining[indicesInRemaining.length - 1].remIdx;
        remaining[first] = `${w}::${remaining[first]}`;
        remaining[last] = `${remaining[last]}::`;
      }
    }
  }

  return { extracted, remaining };
};

// 数值权重步进（0.1 一档，避免浮点误差）
export const stepNumericWeight = (weight: number, delta: number): number => Math.round((weight + delta) * 10) / 10;
