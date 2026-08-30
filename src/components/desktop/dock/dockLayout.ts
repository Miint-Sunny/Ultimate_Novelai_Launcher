// 右侧停靠区的布局模型 —— 纯函数,无 React / DOM,可被 node 直接加载做校验。
//
// 形态参考 Claude Desktop:右侧不是一块整板,而是**若干可拼凑的面板**——
// 用顶部那排图标或「⋮」菜单勾选要哪几块,它们竖着摞起来,面板之间可以拖着分高度,
// 也可以整块上下换位或折叠成一条标题栏。布局整份持久化。
//
// 为什么单独抽一层:这套状态的错法都是「不报错但布局烂掉」——
// 顺序数组里混进重复 id、权重被拖成 0 让面板永远消失、
// 存量用户升级后原本开着的助手栏变成空白右栏。所以模型层跟渲染层分开,单独钉住。

export type DockPanelId = 'assistant' | 'sessions';

/** 全部面板的规范顺序;新开的面板按这个顺序插入,而不是一律追加到末尾。 */
export const DOCK_PANEL_ORDER: readonly DockPanelId[] = ['assistant', 'sessions'];

export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 720;
export const DOCK_DEFAULT_WIDTH = 400;

/** 权重下限不取 0:拖到 0 的面板会永远看不见,用户也就找不回来了。 */
export const DOCK_MIN_WEIGHT = 0.2;
export const DOCK_MAX_WEIGHT = 8;

/** 折叠态只留标题栏的高度(px),与 DockPanelFrame 的标题栏同高。 */
export const DOCK_HEADER_HEIGHT = 34;

export interface DockLayout {
  width: number;
  /** 打开的面板;**数组顺序就是从上到下的排列**。 */
  open: DockPanelId[];
  /** 折叠成只剩标题栏的面板(仍算打开)。 */
  collapsed: DockPanelId[];
  /** 各面板的高度权重(flex-grow);缺省 1。 */
  weights: Partial<Record<DockPanelId, number>>;
}

export const DEFAULT_DOCK_LAYOUT: DockLayout = {
  width: DOCK_DEFAULT_WIDTH,
  open: ['assistant'],
  collapsed: [],
  weights: {},
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isPanelId = (value: unknown): value is DockPanelId =>
  typeof value === 'string' && (DOCK_PANEL_ORDER as readonly string[]).includes(value);

/** 去重并只保留已知 id,顺序按输入。 */
function sanitizeIds(raw: unknown): DockPanelId[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<DockPanelId>();
  const out: DockPanelId[] = [];
  for (const item of raw) {
    if (!isPanelId(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * 把任意来源(localStorage、旧版本、手改坏的 JSON)整成一个能渲染的布局。
 * 坏数据一律退回默认值而不是抛错 —— 布局坏掉不该让整个右栏白屏。
 */
export function normalizeDockLayout(raw: unknown): DockLayout {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_DOCK_LAYOUT };
  const source = raw as Partial<DockLayout>;

  const width = Number(source.width);
  const open = sanitizeIds(source.open);
  // collapsed 只在 open 里的才算数:关掉又打开的面板不该记得自己曾经是折叠的
  const openSet = new Set(open);
  const collapsed = sanitizeIds(source.collapsed).filter((id) => openSet.has(id));

  const weights: Partial<Record<DockPanelId, number>> = {};
  const rawWeights = (source.weights ?? {}) as Record<string, unknown>;
  for (const id of DOCK_PANEL_ORDER) {
    const value = Number(rawWeights[id]);
    if (Number.isFinite(value)) weights[id] = clamp(value, DOCK_MIN_WEIGHT, DOCK_MAX_WEIGHT);
  }

  return {
    width: Number.isFinite(width) ? clamp(Math.round(width), DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) : DOCK_DEFAULT_WIDTH,
    open,
    collapsed,
    weights,
  };
}

export const isPanelOpen = (layout: DockLayout, id: DockPanelId): boolean => layout.open.includes(id);

export const isPanelCollapsed = (layout: DockLayout, id: DockPanelId): boolean =>
  layout.collapsed.includes(id);

export const panelWeight = (layout: DockLayout, id: DockPanelId): number => layout.weights[id] ?? 1;

/**
 * 开/关一个面板。新开的面板按 DOCK_PANEL_ORDER 插到该在的位置,
 * 而不是一律追加到最下面 —— 否则关掉再打开,面板就会自己跑到底部去。
 */
export function togglePanel(layout: DockLayout, id: DockPanelId): DockLayout {
  if (isPanelOpen(layout, id)) {
    return {
      ...layout,
      open: layout.open.filter((item) => item !== id),
      collapsed: layout.collapsed.filter((item) => item !== id),
    };
  }
  const rank = (panel: DockPanelId) => DOCK_PANEL_ORDER.indexOf(panel);
  const next = [...layout.open];
  const at = next.findIndex((item) => rank(item) > rank(id));
  if (at < 0) next.push(id);
  else next.splice(at, 0, id);
  return { ...layout, open: next };
}

export function setPanelCollapsed(layout: DockLayout, id: DockPanelId, collapsed: boolean): DockLayout {
  if (!isPanelOpen(layout, id)) return layout;
  const without = layout.collapsed.filter((item) => item !== id);
  return { ...layout, collapsed: collapsed ? [...without, id] : without };
}

/** 整块上下换位。delta = -1 上移、+1 下移;到头就原样返回。 */
export function movePanel(layout: DockLayout, id: DockPanelId, delta: number): DockLayout {
  const from = layout.open.indexOf(id);
  if (from < 0) return layout;
  const to = from + delta;
  if (to < 0 || to >= layout.open.length) return layout;
  const open = [...layout.open];
  [open[from], open[to]] = [open[to], open[from]];
  return { ...layout, open };
}

/**
 * 拖动两块之间的分隔线:把这一对的权重按比例重分,**总权重保持不变**,
 * 这样拖动只影响这两块,别的面板高度不动。
 */
export function resizeAdjacent(
  layout: DockLayout,
  aboveId: DockPanelId,
  belowId: DockPanelId,
  aboveRatio: number,
): DockLayout {
  if (!isPanelOpen(layout, aboveId) || !isPanelOpen(layout, belowId)) return layout;
  const total = panelWeight(layout, aboveId) + panelWeight(layout, belowId);
  const ratio = clamp(aboveRatio, 0, 1);
  // 下面这块**先按下限兜住**再回推上面那块,而不是直接用 total - above:
  // 权重不是二进制精确数(默认两块各 1,total 2,拖到底 above=1.8,
  // 而 2 - 1.8 在浮点里是 0.19999999999999996 —— 比下限小,面板就被拖没了)。
  // 「两块都不小于下限」是用户看得见的不变量,「总权重恰好不变」只是好看,
  // 所以让后者承受这点浮点误差。
  const below = Math.max(DOCK_MIN_WEIGHT, total - clamp(total * ratio, DOCK_MIN_WEIGHT, total - DOCK_MIN_WEIGHT));
  const above = Math.max(DOCK_MIN_WEIGHT, total - below);
  return {
    ...layout,
    weights: { ...layout.weights, [aboveId]: above, [belowId]: below },
  };
}

export function setDockWidth(layout: DockLayout, width: number): DockLayout {
  return { ...layout, width: clamp(Math.round(width), DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) };
}

// ─────────────────────────────
// 持久化(含从旧的两个单面板键迁移)
// ─────────────────────────────

export const DOCK_LAYOUT_KEY = 'nai_right_dock_layout';
/** 旧键:单面板时代的「助手栏开着吗」与「助手栏多宽」。 */
export const LEGACY_DOCK_OPEN_KEY = 'nai_agent_dock_open';
export const LEGACY_DOCK_WIDTH_KEY = 'nai_agent_dock_width';

/**
 * 从旧的两个单面板键推出一份布局。
 *
 * 存量用户升级后必须原样看到自己那块助手栏:开着就还开着、宽度还是那个宽度。
 * 只有这两个旧键**都不存在**时才算全新用户,走默认布局。
 */
export function migrateLegacyDockLayout(open: string | null, width: string | null): DockLayout | null {
  if (open === null && width === null) return null;
  const parsedWidth = Number(width);
  return normalizeDockLayout({
    // 旧口径:只有显式存了 '0' 才算收起,其余(含没存过)都算开着
    open: open === '0' ? [] : ['assistant'],
    collapsed: [],
    weights: {},
    width: Number.isFinite(parsedWidth) && parsedWidth > 0 ? parsedWidth : DOCK_DEFAULT_WIDTH,
  });
}
