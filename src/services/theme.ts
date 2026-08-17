import { getAppSettings, APP_SETTINGS_CHANGED_EVENT } from './localLibrary';

/**
 * 皮肤应用:把 settings.theme 映射到 <html data-theme="…">。
 * 色值本体全部定义在 src/index.css 的 :root 与 [data-theme='…'] 变量块里;
 * 'default'(石墨)是 :root 基线,不需要属性。
 */
const applyTheme = (themeId: string): void => {
  const root = document.documentElement;
  if (!themeId || themeId === 'default') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = themeId;
  }
};

/** 玻璃浓度档位:data-glass 可选值;'standard' = :root 默认,不挂属性(与 'default' 皮肤同理)。 */
export type GlassId = 'clear' | 'standard' | 'tinted' | 'solid';

/** 持久化键:命名遵循 UI_CONVENTIONS 新键 `nai_` 前缀蛇形规则(theme 本体存在 novelai_app_settings JSON 内,无独立键可对齐)。 */
const GLASS_STORAGE_KEY = 'nai_glass';
const GLASS_IDS: readonly GlassId[] = ['clear', 'standard', 'tinted', 'solid'];

/** 读取持久化的玻璃浓度;无记录或非法值时回退 'standard'。 */
export const getGlass = (): GlassId => {
  const stored = localStorage.getItem(GLASS_STORAGE_KEY);
  return GLASS_IDS.includes(stored as GlassId) ? (stored as GlassId) : 'standard';
};

/** 玻璃浓度应用:映射到 <html data-glass="…">,色值本体在 index.css 的 :root 与 [data-glass='…'] 变量块。 */
const applyGlass = (glassId: GlassId): void => {
  const root = document.documentElement;
  if (glassId === 'standard') {
    delete root.dataset.glass;
  } else {
    root.dataset.glass = glassId;
  }
};

/** 持久化并立即应用玻璃浓度(供后续设置 UI 调用,与 settings.theme 的写链路同模式)。 */
export const setGlass = (glassId: GlassId): void => {
  localStorage.setItem(GLASS_STORAGE_KEY, glassId);
  applyGlass(glassId);
};

/** 启动时调用一次:应用当前皮肤与玻璃浓度,皮肤跟随设置变更。 */
export const initTheme = (): void => {
  applyTheme(getAppSettings().theme);
  applyGlass(getGlass());
  window.addEventListener(APP_SETTINGS_CHANGED_EVENT, () => {
    applyTheme(getAppSettings().theme);
  });
};
