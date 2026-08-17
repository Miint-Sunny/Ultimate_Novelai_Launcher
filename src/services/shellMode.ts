/**
 * 移动端外壳模式(P3):'pager' = 横向 PageView 新壳(默认),'tabs' = 旧底栏壳。
 * 读取模式与 P0 的 nai_glass(theme.ts getGlass)一致:localStorage 单键、常量兜底、
 * 不换键不加事件;启动时读一次,运行期切换需刷新页面。
 */
export type ShellMode = 'pager' | 'tabs';

const SHELL_MODE_STORAGE_KEY = 'nai_shell_mode';
const SHELL_MODES: readonly ShellMode[] = ['pager', 'tabs'];

/** 读取持久化的外壳模式;无记录或非法值时回退 'pager'(新壳为默认)。 */
export const getShellMode = (): ShellMode => {
  const stored = localStorage.getItem(SHELL_MODE_STORAGE_KEY);
  return SHELL_MODES.includes(stored as ShellMode) ? (stored as ShellMode) : 'pager';
};

/** 持久化外壳模式(供后续设置 UI 调用;本次 P3 不接 UI,仅备用)。 */
export const setShellMode = (mode: ShellMode): void => {
  localStorage.setItem(SHELL_MODE_STORAGE_KEY, mode);
};
