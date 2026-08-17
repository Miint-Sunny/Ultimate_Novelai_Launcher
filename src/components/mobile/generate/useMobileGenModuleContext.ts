import { useEffect, useMemo, useState } from 'react';
import {
  APP_SETTINGS_CHANGED_EVENT,
  getAppSettings,
} from '../../../services/localLibrary/appSettings';
import type { GenModuleContext } from '../../generation/genModules';

// 模块注册表谓词输入(当前模型 × 后端模式 × 登录态)的响应式组装:
// serverMode 跟随 APP_SETTINGS_CHANGED_EVENT / 跨标签 storage 即时刷新
// (与 useAgentModelPresentation 同一事件口径)。当前静态矩阵只按模型家族分档,
// serverMode/isAuthenticated 预留(待后端评审 #1 确认权威矩阵后启用行级判定)。
export function useMobileGenModuleContext(
  model: string,
  isAuthenticated: boolean,
): GenModuleContext {
  const [serverMode, setServerMode] = useState<'public' | 'custom'>(
    () => getAppSettings().serverMode,
  );

  useEffect(() => {
    const refresh = () => setServerMode(getAppSettings().serverMode);
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  return useMemo(
    () => ({ model, serverMode, isAuthenticated }),
    [model, serverMode, isAuthenticated],
  );
}
