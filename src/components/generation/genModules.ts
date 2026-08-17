// 生图页功能模块注册表(纯模块:无 React、无 Tauri、无服务门面导入)
// 移植 Plana gen_modules.dart 的机制(见 main reference/,思想对齐、不照抄代码):
//   - 注册表定死可管理的模块,每张卡声明 key/标题/图标/能力谓词;
//   - 唯一可见性谓词 isGenModuleVisible,三处消费不分叉:
//       a. 卡片渲染(不满足 = 整卡不渲染,无置灰占位);
//       b. 生成载荷剥离(stripInvisibleModuleData,只剥本次快照、不动工作区状态,
//          入库快照即剥离后状态;「重生成」复跑入库快照,剥离幂等、无需二次剥离);
//       c. token 计数(与剥离同口径,不可见模块的内容不计);
//   - 桌面壳策略 = 全部可见(不调用本模块的剥离),桌面载荷零变化;
//     移动壳按谓词 → 移动端有意的行为修复(如 v3 不再误发精确参考/角色提示词载荷)。
// 图标在注册表中以字符串 token 声明(lucide 组件名小写),纯文件不 import React,
// 以便 node --experimental-strip-types 直接加载做 parity 校验(同 P1 装配层约定);
// 各卡头部实际渲染的图标以卡组件为准,此处声明供后续「模块管理」界面与拖拽提示消费。

import { MODEL_MAP, MODEL_TO_ENCODING_KEY } from './modelResolutionOptions.ts';

export type GenModuleKey =
  | 'prompt-summary'
  | 'character'
  | 'vibe'
  | 'precise-reference'
  | 'img2img';

/** 提示词摘要卡始终居顶、不参与排序;其余四张可拖拽调序。 */
export type SortableGenModuleKey = Exclude<GenModuleKey, 'prompt-summary'>;

export type NaiModelFamily = 'nai-4.5' | 'nai-4' | 'nai-3' | 'nai-legacy' | 'other';

/** 归一化模型判定:UI 模型 id(经 MODEL_MAP)与后端模型名均可,兼容 -inpainting 变体。 */
export function modelFamilyOf(model: string): NaiModelFamily {
  const backendId = MODEL_MAP[model] ?? model;
  if (backendId.startsWith('nai-diffusion-4-5')) return 'nai-4.5';
  if (backendId.startsWith('nai-diffusion-4')) return 'nai-4';
  if (backendId.startsWith('nai-diffusion-3')) return 'nai-3';
  if (backendId.startsWith('nai-diffusion')) return 'nai-legacy';
  return 'other';
}

function backendModelId(model: string): string {
  const backendId = MODEL_MAP[model] ?? model;
  // inpainting 变体与基座共享 vibe 编码键(vibeTypes 同此约定)
  return backendId.replace(/-inpainting$/, '');
}

/** 谓词输入 = 当前模型 × 后端模式 × 登录态。 */
export interface GenModuleContext {
  model: string;
  serverMode: 'public' | 'custom';
  isAuthenticated: boolean;
}

export interface GenModuleDef {
  key: GenModuleKey;
  title: string;
  /** lucide 图标名 token(纯声明,见文件头注释)。 */
  icon: string;
  /** true = 居顶固定卡,不参与排序、不可隐藏。 */
  pinned?: boolean;
  /** 能力谓词;唯一可见性判定,渲染/载荷剥离/token 计数共用。 */
  supports: (ctx: GenModuleContext) => boolean;
}

// ⚠️ 能力矩阵为前端已知的静态表,【待后端评审 #1 确认权威矩阵】:
//   - 当前行只按模型家族分档;serverMode / isAuthenticated 暂不参与任何行的判定
//     (预留进 GenModuleContext,后端确认后在此补行,三处消费自动跟随);
//   - precise-reference(精确参考/CR)仅 nai-4.5 系:沿用移动端原卡内判定
//     (v4-full / v4-curated-preview 此前显示「V4 模型不支持」占位,现整卡不渲染);
//   - character(角色提示词)仅 v4 及以上:charCaptions 是 v4 系载荷格式;
//   - vibe 按 MODEL_TO_ENCODING_KEY 数据驱动(前端已知可编码的型号才可见);
//   - img2img 全 NAI 型号;inpaint 是其卡内子模式,载荷层会为各 NAI 基座自动派生
//     -inpainting 变体(buildRequestPayload),故不单独建行;
//   - 非 NAI / 未知型号:仅提示词摘要卡(安全兜底)。
const isNaiFamily = (family: NaiModelFamily) => family.startsWith('nai-');

export const GEN_MODULE_DEFS: readonly GenModuleDef[] = [
  {
    key: 'prompt-summary',
    title: '提示词',
    icon: 'sparkles',
    pinned: true,
    supports: () => true,
  },
  {
    key: 'character',
    title: '角色提示词',
    icon: 'users',
    supports: (ctx) => {
      const family = modelFamilyOf(ctx.model);
      return family === 'nai-4.5' || family === 'nai-4';
    },
  },
  {
    key: 'vibe',
    title: 'Vibes',
    icon: 'palette',
    supports: (ctx) =>
      isNaiFamily(modelFamilyOf(ctx.model)) &&
      MODEL_TO_ENCODING_KEY[backendModelId(ctx.model)] !== undefined,
  },
  {
    key: 'precise-reference',
    title: '精确参考',
    icon: 'user',
    supports: (ctx) => modelFamilyOf(ctx.model) === 'nai-4.5',
  },
  {
    key: 'img2img',
    title: '图生图',
    icon: 'image',
    supports: (ctx) => isNaiFamily(modelFamilyOf(ctx.model)),
  },
];

export function genModuleDef(key: GenModuleKey): GenModuleDef {
  const def = GEN_MODULE_DEFS.find((item) => item.key === key);
  if (!def) throw new Error(`未知生图模块: ${key}`);
  return def;
}

/** 唯一可见性谓词。渲染、载荷剥离、token 计数只允许走这里。 */
export function isGenModuleVisible(key: GenModuleKey, ctx: GenModuleContext): boolean {
  return genModuleDef(key).supports(ctx);
}

/** 可排序模块的默认顺序 = 注册表顺序(去掉居顶固定卡)。 */
export const GEN_MODULE_SORTABLE_DEFAULT_ORDER: SortableGenModuleKey[] = GEN_MODULE_DEFS.filter(
  (def) => !def.pinned,
).map((def) => def.key as SortableGenModuleKey);

const SORTABLE_KEY_SET = new Set<string>(GEN_MODULE_SORTABLE_DEFAULT_ORDER);

function isSortableKey(value: unknown): value is SortableGenModuleKey {
  return typeof value === 'string' && SORTABLE_KEY_SET.has(value);
}

/**
 * 排序读取容错(对齐 Plana GenModuleSettings.fromJson):
 * 以默认序为骨架 —— 过滤未知 key、去重,注册表新增模块补到组尾。
 * 非法输入(null/对象/坏 JSON 解析结果)整体回落默认序。
 */
export function normalizeGenModuleOrder(raw: unknown): SortableGenModuleKey[] {
  const out: SortableGenModuleKey[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isSortableKey(item) && !out.includes(item)) out.push(item);
    }
  }
  for (const key of GEN_MODULE_SORTABLE_DEFAULT_ORDER) {
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** 当前上下文里的可见可排序序列:按持久化顺序过滤。 */
export function orderedVisibleGenModuleKeys(
  ctx: GenModuleContext,
  order: SortableGenModuleKey[] = GEN_MODULE_SORTABLE_DEFAULT_ORDER,
): SortableGenModuleKey[] {
  return order.filter((key) => isGenModuleVisible(key, ctx));
}

/**
 * 可见序列内的拖拽调序映射回完整 order:不可见模块原槽位不动
 * (对齐 Plana generate_page._moveVisible;隐藏只影响可见性,不丢位置)。
 */
export function moveVisibleGenModule(
  order: SortableGenModuleKey[],
  visibleKeys: SortableGenModuleKey[],
  from: number,
  to: number,
): SortableGenModuleKey[] {
  if (
    from === to ||
    from < 0 ||
    from >= visibleKeys.length ||
    to < 0 ||
    to >= visibleKeys.length
  ) {
    return order;
  }
  const moved = [...visibleKeys];
  const [item] = moved.splice(from, 1);
  moved.splice(to, 0, item);
  const visibleSet = new Set<GenModuleKey>(visibleKeys);
  let j = 0;
  return order.map((key) => (visibleSet.has(key) ? moved[j++] : key));
}

/** 生成快照里按模块归属的数据(剥离的输入/输出形状)。 */
export interface GenModuleDataSnapshot {
  characterPrompts: unknown[];
  activePreciseRefs: unknown[];
  activeVibes: unknown[];
  img2imgImage: string | null;
}

/**
 * 面板发起的生成前调用:清掉当前不可见模块的数据(型号不支持/不属当前模型家族),
 * 只影响本次快照,不动工作区状态(条件恢复卡回来数据还在);入库的即此剥离后快照。
 * 幂等:对已剥离快照再次调用结果不变 —— 「重生成」复跑入库快照天然跳过二次剥离。
 */
export function stripInvisibleModuleData<S extends GenModuleDataSnapshot>(
  snapshot: S,
  ctx: GenModuleContext,
): S {
  const out: GenModuleDataSnapshot = { ...snapshot };
  if (!isGenModuleVisible('character', ctx) && out.characterPrompts.length > 0) {
    out.characterPrompts = [];
  }
  if (!isGenModuleVisible('precise-reference', ctx) && out.activePreciseRefs.length > 0) {
    out.activePreciseRefs = [];
  }
  if (!isGenModuleVisible('vibe', ctx) && out.activeVibes.length > 0) {
    out.activeVibes = [];
  }
  if (!isGenModuleVisible('img2img', ctx) && out.img2imgImage !== null) {
    out.img2imgImage = null;
  }
  return out as S;
}

/** 模块顺序持久化键(UI_CONVENTIONS §9:nai_ 前缀)。读写 IO 在移动端 hook 内。 */
export const GEN_MODULE_ORDER_STORAGE_KEY = 'nai_module_order';
