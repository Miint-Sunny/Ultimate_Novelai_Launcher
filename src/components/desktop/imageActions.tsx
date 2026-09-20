/**
 * 「对当前这张图动手」的三个动作:重绘 / 放大 / 编辑。
 *
 * 为什么要这么一层:按钮住在**顶栏**(外壳重排第 2 步,
 * docs_and_plan/2026-09-21-shell-rearrange-and-director-tools.md §3.2),
 * 而开法与它们的状态(重绘覆盖层、放大弹窗、工坊输入条)住在 `MainContent` 里,
 * 两者是兄弟节点。可选的三条路:
 *
 *   1. 把那几个 state 提到外面 —— 重绘那套状态刚按官方对齐过,牵它风险最大;
 *   2. 再加几个 window CustomEvent —— 「编辑」今天就是这么做的,但事件是无类型的
 *      隐式耦合,多加几条以后没人说得清谁在监听;
 *   3. 一个 ref 注册台:状态留在原地,只把**开法**交上来。
 *
 * 取 3。这和左栏 `workbenchBridge` 把左栏状态交给 Agent 工具是同一套做法:
 * 桥不持有状态,只持有每次渲染都刷新的 ref,调用方拿到的永远是活的闭包。
 *
 * `hasImage` 是状态(顶栏要按它禁用按钮),所以它走 useState;三个开法走 ref。
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  GenerateOutcome,
  InpaintRegionOptions,
  InpaintRegionQuote,
  NormalizedBox,
} from '../../services/agentHarness/workbench';

export interface ImageActionHandlers {
  /** 进重绘覆盖层(清掉上一次的蒙版与裁切信息)。 */
  openInpaint: () => void;
  /** 开放大对话框。 */
  openUpscale: () => void;
  /** 开图像编辑(工坊)的紧凑输入条。 */
  openEditor: () => void;
  /** 开导演工具的紧凑条(线稿 / 去背 / 上色…)。 */
  openDirector: () => void;
  /**
   * 助手的 `inpaint_region`:不开覆盖层,直接按归一化的框重绘一块。
   * 走的是 `handleInpaintGenerate` —— 与手动重绘**同一条**路径,不是另一套发送。
   */
  inpaintQuote: (box: NormalizedBox, opts?: InpaintRegionOptions) => InpaintRegionQuote;
  inpaintRegion: (box: NormalizedBox, opts?: InpaintRegionOptions) => Promise<GenerateOutcome>;
}

interface ImageActionsValue {
  /** 当前画布上有没有一张能动手的图(生成中、重绘中、工坊开着时为 false)。 */
  hasImage: boolean;
  /** 供 MainContent 每次渲染同步。 */
  setHasImage: (value: boolean) => void;
  /** 供 MainContent 注册三个开法。 */
  register: (handlers: ImageActionHandlers) => void;
  /** 顶栏用:没注册或没有图时是 no-op,不会炸。 */
  actions: ImageActionHandlers;
}

const ImageActionsContext = createContext<ImageActionsValue | null>(null);

export function ImageActionsProvider({ children }: { children: ReactNode }) {
  const [hasImage, setHasImageState] = useState(false);
  const handlersRef = useRef<ImageActionHandlers | null>(null);

  const register = useCallback((handlers: ImageActionHandlers) => {
    handlersRef.current = handlers;
  }, []);

  // setState 直接暴露会让 MainContent 每次渲染都写一次;这里挡一道,值没变就不写。
  const setHasImage = useCallback((value: boolean) => {
    setHasImageState((prev) => (prev === value ? prev : value));
  }, []);

  const actions = useMemo<ImageActionHandlers>(() => ({
    openInpaint: () => handlersRef.current?.openInpaint(),
    openUpscale: () => handlersRef.current?.openUpscale(),
    openEditor: () => handlersRef.current?.openEditor(),
    openDirector: () => handlersRef.current?.openDirector(),
    // 这两条是计费路径的入口:没挂载就如实说,绝不静默当成功。
    inpaintQuote: (box, opts) => handlersRef.current?.inpaintQuote(box, opts) ?? NOT_MOUNTED,
    inpaintRegion: async (box, opts) => handlersRef.current?.inpaintRegion(box, opts) ?? { ok: false, message: NOT_MOUNTED.reason },
  }), []);

  const value = useMemo<ImageActionsValue>(
    () => ({ hasImage, setHasImage, register, actions }),
    [hasImage, setHasImage, register, actions],
  );

  return <ImageActionsContext.Provider value={value}>{children}</ImageActionsContext.Provider>;
}

/**
 * 没有 Provider 时返回一个静默的空壳(顶栏在别处被单独挂起来时不该炸)。
 * 真正的消费方都在 Provider 里面,拿到的是活的。
 */
const NOT_MOUNTED = { ok: false, reason: '画布还没有挂载,现在没法重绘。' } as const;

const INERT: ImageActionsValue = {
  hasImage: false,
  setHasImage: () => {},
  register: () => {},
  actions: {
    openInpaint: () => {}, openUpscale: () => {}, openEditor: () => {}, openDirector: () => {},
    inpaintQuote: () => NOT_MOUNTED,
    inpaintRegion: async () => ({ ok: false, message: NOT_MOUNTED.reason }),
  },
};

export function useImageActions(): ImageActionsValue {
  return useContext(ImageActionsContext) ?? INERT;
}
