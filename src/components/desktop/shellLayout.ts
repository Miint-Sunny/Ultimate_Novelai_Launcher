// 桌面外壳的宽度分配(纯模块:无 React、无 DOM,check:shell-layout 在 node 里跑)。
//
// 单位是「设计 px」:根字号 16px 时的像素。渲染时一律换成 rem(宽 / 16),所以大屏上根字号
// 放大到 17 / 19 / 22px(src/index.css)时,左右栏跟着文字等比放大;视口宽度也先折算成设计 px
// 再分。以前两栏写死 px:4K 下文字放大了 1.375 倍,栏宽却没动,里面挤成一团。
//
// 分配规则:画布至少留 CANVAS_MIN_WIDTH。不够时先收右栏(收到它的最小宽),再收左栏(收到它的
// 最小宽);两栏都收到最小还放不下,右栏改成**浮在画布右侧**,不再占位 —— 开关状态不变,
// 用户随时能关。以前两栏定宽互不相让,1024 宽时画布只剩 194px,900 宽时只剩 70px。

import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH } from './dock/dockLayout';

export const ROOT_FONT_PX = 16;
export const SIDEBAR_MIN_WIDTH = 400;
export const SIDEBAR_MAX_WIDTH = 680;
export const SIDEBAR_DEFAULT_WIDTH = 430;
export const CANVAS_MIN_WIDTH = 480;

/** 右栏怎么摆:没开 / 占位排在画布右边 / 浮在画布上。 */
export type DockPlacement = 'closed' | 'inline' | 'overlay';

export interface ShellRequest {
  /** window.innerWidth,CSS px。 */
  viewportPx: number;
  /** <html> 的计算字号,px。 */
  rootFontPx: number;
  /** 用户要的左栏宽,设计 px。 */
  sidebar: number;
  /** 用户要的右栏宽,设计 px。 */
  dock: number;
  dockOpen: boolean;
}

export interface ShellWidths {
  /** 设计 px。 */
  sidebar: number;
  /** 设计 px;没开时为 0。 */
  dock: number;
  dockPlacement: DockPlacement;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 根字号相对 16px 的倍数:1 / 1.0625 / 1.1875 / 1.375。 */
export function shellScale(rootFontPx: number): number {
  return Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx / ROOT_FONT_PX : 1;
}

/** 设计 px → CSS 长度。 */
export const designPxToRem = (designPx: number) => `${designPx / ROOT_FONT_PX}rem`;

export function clampSidebarWidth(width: number): number {
  return Number.isFinite(width) ? Math.round(clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)) : SIDEBAR_DEFAULT_WIDTH;
}

export function resolveShellWidths(request: ShellRequest): ShellWidths {
  const available = request.viewportPx / shellScale(request.rootFontPx);
  const wantSidebar = clampSidebarWidth(request.sidebar);
  const wantDock = Number.isFinite(request.dock) ? clamp(request.dock, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH) : DOCK_MIN_WIDTH;
  // 左栏自己也不能把画布挤到最小以下,除非它已经收到最小。
  const sidebarAlone = Math.max(SIDEBAR_MIN_WIDTH, Math.min(wantSidebar, available - CANVAS_MIN_WIDTH));

  if (!request.dockOpen) {
    return { sidebar: Math.round(sidebarAlone), dock: 0, dockPlacement: 'closed' };
  }

  const dockRoom = available - wantSidebar - CANVAS_MIN_WIDTH;
  if (dockRoom >= DOCK_MIN_WIDTH) {
    return { sidebar: wantSidebar, dock: Math.round(Math.min(wantDock, dockRoom)), dockPlacement: 'inline' };
  }

  const sidebarRoom = available - DOCK_MIN_WIDTH - CANVAS_MIN_WIDTH;
  if (sidebarRoom >= SIDEBAR_MIN_WIDTH) {
    return { sidebar: Math.round(sidebarRoom), dock: DOCK_MIN_WIDTH, dockPlacement: 'inline' };
  }

  const overlayDock = Math.max(DOCK_MIN_WIDTH, Math.min(wantDock, available - sidebarAlone));
  return { sidebar: Math.round(sidebarAlone), dock: Math.round(overlayDock), dockPlacement: 'overlay' };
}
