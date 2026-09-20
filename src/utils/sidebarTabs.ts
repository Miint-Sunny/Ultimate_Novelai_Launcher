/**
 * 左栏分 tab 的纯逻辑(用户 2026-09-20 拍板 A 方案,方案与取舍见
 * docs_and_plan/2026-09-20-left-sidebar-tabs-proposal.md):提示词 / 参数 / 参考 / 库。
 *
 * 库照 fork 的做法记住来路、关掉回原处;助手改了不在当前 tab 里的字段,那个 tab 亮一个点。
 * 这里只算状态,不碰 DOM,校验在 scripts/check-sidebar-tabs.mjs。
 */

export type SidebarTab = 'prompt' | 'params' | 'reference' | 'library';
/** 提示词排法:分页(提示 / 排除切换)或堆叠(两栏同时可见)。和芯片 / 文本编辑器正交,合起来四种。 */
export type PromptLayout = 'tabbed' | 'stacked';
export type LibraryPane = 'tags' | 'chunks' | 'presets';

export interface SidebarTabSpec {
  id: SidebarTab;
  label: string;
  hint: string;
}

export const SIDEBAR_TABS: readonly SidebarTabSpec[] = [
  { id: 'prompt', label: '提示词', hint: '主提示词、排除、角色' },
  { id: 'params', label: '参数', hint: '步数、CFG、采样器、种子' },
  { id: 'reference', label: '参考', hint: '图生图、精确参考、Vibe' },
  { id: 'library', label: '库', hint: 'Tag 管理器、提示词片段、预设' },
];

export const LIBRARY_PANES: readonly { id: LibraryPane; label: string }[] = [
  { id: 'tags', label: '标签' },
  { id: 'chunks', label: '片段' },
  { id: 'presets', label: '预设' },
];

export const DEFAULT_SIDEBAR_TAB: SidebarTab = 'prompt';

const TAB_IDS = new Set<string>(SIDEBAR_TABS.map((tab) => tab.id));

export function isSidebarTab(raw: unknown): raw is SidebarTab {
  return typeof raw === 'string' && TAB_IDS.has(raw);
}

/** 读档:库不还原(来路已经丢了,一开就落在库里只会莫名其妙),坏值回默认。 */
export function restoreSidebarTab(raw: unknown): SidebarTab {
  return isSidebarTab(raw) && raw !== 'library' ? raw : DEFAULT_SIDEBAR_TAB;
}

export function normalizePromptLayout(raw: unknown): PromptLayout {
  return raw === 'stacked' ? 'stacked' : 'tabbed';
}

export function normalizeLibraryPane(raw: unknown): LibraryPane {
  return raw === 'chunks' || raw === 'presets' ? raw : 'tags';
}

export interface SidebarTabState {
  active: SidebarTab;
  /** 进库之前所在的 tab;关库回这里。永远不是库自己。 */
  previous: SidebarTab;
  /** 亮点的 tab(助手改了里面的字段而用户不在看)。按 SIDEBAR_TABS 顺序,不含 active。 */
  attention: readonly SidebarTab[];
}

export function initialTabState(active: SidebarTab = DEFAULT_SIDEBAR_TAB): SidebarTabState {
  return { active, previous: active === 'library' ? DEFAULT_SIDEBAR_TAB : active, attention: [] };
}

export function switchTab(state: SidebarTabState, next: SidebarTab): SidebarTabState {
  if (next === state.active) return state;
  return {
    active: next,
    previous: state.active === 'library' ? state.previous : state.active,
    attention: state.attention.filter((tab) => tab !== next),
  };
}

/** 关库 = 回来路;不在库里就什么都不做(同一个对象,省一次渲染)。 */
export function leaveLibrary(state: SidebarTabState): SidebarTabState {
  return state.active === 'library' ? switchTab(state, state.previous) : state;
}

/**
 * 工作台字段 → 所在 tab。header / 底栏常驻的(模型、分辨率)不算,改了用户本来就看得见。
 * quality_preset 落在库 → 预设。
 */
const FIELD_TAB: Readonly<Record<string, SidebarTab>> = {
  prompt: 'prompt',
  negative_prompt: 'prompt',
  character: 'prompt',
  character_ai_position: 'prompt',
  steps: 'params',
  scale: 'params',
  cfg_rescale: 'params',
  sampler: 'params',
  noise_schedule: 'params',
  seed: 'params',
  quality_preset: 'library',
};

export function tabForField(field: string): SidebarTab | null {
  return FIELD_TAB[field] ?? null;
}

/** 助手写了这些字段:不在当前 tab 的亮点;没有新点就原样返回。 */
export function noteWrites(state: SidebarTabState, fields: readonly string[]): SidebarTabState {
  const lit = new Set(state.attention);
  for (const field of fields) {
    const tab = tabForField(field);
    if (tab && tab !== state.active) lit.add(tab);
  }
  if (lit.size === state.attention.length) return state;
  return { ...state, attention: SIDEBAR_TABS.map((tab) => tab.id).filter((id) => lit.has(id)) };
}

/**
 * ⌥1–4 / Alt+1–4 切 tab。用 code 而不是 key:Mac 上 Option+数字打出来的是「¡™£¢」。
 * 不用 Cmd/Ctrl+数字——浏览器里那是切标签页,页面拦不下来,桌面壳和网页行为会不一样。
 */
export function tabForShortcut(ev: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }): SidebarTab | null {
  if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return null;
  const match = /^Digit([1-4])$/.exec(ev.code);
  return match ? SIDEBAR_TABS[Number(match[1]) - 1].id : null;
}
