// 提示词加权操作纯函数 —— 双端 chip 编辑器共享（DesktopChipEditor / mobile FullscreenEditor）
// 从 useDesktopTagActions / useDesktopPanelActions / useFullscreenTagActions 抽取的近复制逻辑,
// 行为与抽取前逐字节等价。解析原语复用 promptTags,不重复实现。
// 纯函数、不可变(返回新数组)、无 React/DOM 依赖,node --experimental-strip-types 可加载。
// 注意:toggleHide/deleteTag 在三处的下标解析策略本就不同(移动端组展开/桌面多选原样/
// 桌面面板组展开),该差异留在各 hook 侧,本模块只收编给定下标后的纯操作。

import { cleanTagName, convertSDToNAI, isSDWeightFormat, type TagGroupInfo } from './promptTags.ts';

// 选区 → 目标下标(升序):单选落在权重组上时展开为全组下标,否则原样返回
export const resolveTargetIndices = (selected: Set<number> | number[], groups: TagGroupInfo[]): number[] => {
  const arr = Array.from(selected).sort((a, b) => a - b);
  if (arr.length === 0) return [];
  if (arr.length === 1) {
    const g = groups[arr[0]];
    if (g && g.groupId !== -1) {
      return groups.map((tg, idx) => tg.groupId === g.groupId ? idx : -1).filter(x => x >= 0);
    }
  }
  return arr;
};

// 连段分组:[0,1,3] → [[0,1],[3]](入参须升序)
export const groupContinuousIndices = (indices: number[]): number[][] => {
  if (indices.length === 0) return [];
  const groups: number[][] = [];
  let currentGroup = [indices[0]];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) {
      currentGroup.push(indices[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [indices[i]];
    }
  }
  groups.push(currentGroup);
  return groups;
};

// 加 {}:每个连续段首标签前加 {、尾标签后加 }
export const applyBrace = (tags: string[], indices: number[]): string[] => {
  const t = [...tags];
  for (const group of groupContinuousIndices(indices)) {
    const first = group[0], last = group[group.length - 1];
    t[first] = `{${t[first]}`;
    t[last] = `${t[last]}}`;
  }
  return t;
};

// 加 []:每个连续段首标签前加 [、尾标签后加 ]
export const applyBracket = (tags: string[], indices: number[]): string[] => {
  const t = [...tags];
  for (const group of groupContinuousIndices(indices)) {
    const first = group[0], last = group[group.length - 1];
    t[first] = `[${t[first]}`;
    t[last] = `${t[last]}]`;
  }
  return t;
};

// 数值权重:单标签(或段长 1)直接 w::tag::(空格转下划线);
// 多标签连续段先清洗段内权重符号,再首加 w::、尾加 ::
export const applyNumericWeight = (tags: string[], indices: number[], weight: number): string[] => {
  const t = [...tags];
  for (const group of groupContinuousIndices(indices)) {
    if (group.length === 1) {
      const cleaned = cleanTagName(t[group[0]]).replace(/ /g, '_');
      t[group[0]] = `${weight}::${cleaned}::`;
    } else {
      const first = group[0], last = group[group.length - 1];
      for (const i of group) {
        t[i] = cleanTagName(t[i]);
      }
      t[first] = `${weight}::${t[first]}`;
      t[last] = `${t[last]}::`;
    }
  }
  return t;
};

// 清除权重:下标落在权重组上时连带全组一起清洗为纯标签名(groups 缺省则不展开)
export const clearWeights = (tags: string[], indices: number[], groups: TagGroupInfo[] = []): string[] => {
  const t = [...tags];
  const toClear = new Set<number>(indices);
  for (const i of indices) {
    const g = groups[i];
    if (g && g.groupId !== -1) {
      groups.forEach((tg, idx) => {
        if (tg.groupId === g.groupId) toClear.add(idx);
      });
    }
  }
  for (const i of toClear) {
    t[i] = cleanTagName(t[i]);
  }
  return t;
};

// SD 格式 → NAI 格式:仅转换识别为 SD 权重的标签
// (convertSDToNAI 对非 SD 输入原样返回,与桌面面板不加守卫直接转换的历史行为等价)
export const convertSDWeights = (tags: string[], indices: number[]): string[] => {
  const t = [...tags];
  for (const i of indices) {
    if (isSDWeightFormat(t[i])) {
      t[i] = convertSDToNAI(t[i]);
    }
  }
  return t;
};

// ~隐藏~ 切换:以 anchorIndex(缺省为首下标)判定当前是否隐藏,统一加 ~ 或去 ~
export const toggleHidden = (tags: string[], indices: number[], anchorIndex?: number): string[] => {
  const t = [...tags];
  const isHidden = t[anchorIndex ?? indices[0]]?.trim().startsWith('~');
  for (const i of indices) {
    if (isHidden) t[i] = t[i].replace(/^(\s*)~/, '$1');
    else t[i] = t[i].replace(/^(\s*)/, '$1~');
  }
  return t;
};
