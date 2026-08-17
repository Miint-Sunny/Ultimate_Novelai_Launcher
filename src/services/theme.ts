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

/** 启动时调用一次:应用当前皮肤并监听设置变更。 */
export const initTheme = (): void => {
  applyTheme(getAppSettings().theme);
  window.addEventListener(APP_SETTINGS_CHANGED_EVENT, () => {
    applyTheme(getAppSettings().theme);
  });
};
