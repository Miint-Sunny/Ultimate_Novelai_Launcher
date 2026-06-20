import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { clearApiToken, getAppSettings } from '../services/localLibrary';
import { botService } from '../services/botService';
import { preloadAutocompleteData } from '../services/tagAutocomplete';
import { sidecarApi } from '../api/sidecar';

interface AuthContextType {
  isAuthenticated: boolean;
  isBotAuthorized: boolean;
  showLoginModal: boolean;
  openLoginModal: () => void;
  closeLoginModal: () => void;
  login: () => void;
  logout: () => void;
  requireAuth: (callback: () => void) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // 后端是基于 last_active 的滑动窗口，本地 expiresAt 只是上次同步的快照，
  // 长期不刷新会先于服务端到期。初始化时只要本地存有 bot_session 就乐观地认为已登录，
  // 由 useEffect 里的 validate 异步纠正；这样既能避免首帧闪登录框，也不会把活跃但
  // 本地缓存"过期"的会话误踢。
  const hasLocalBotSession = (): boolean => {
    const settings = getAppSettings();
    if (settings.loginMode !== 'bot') return false;
    const saved = localStorage.getItem('bot_session');
    if (!saved) return false;
    try {
      const data = JSON.parse(saved);
      return Boolean(data?.sessionId);
    } catch {
      return false;
    }
  };

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return hasLocalBotSession();
  });

  // Bot 授权状态：独立于 isAuthenticated，仅通过 bot session 判断
  const [isBotAuthorized, setIsBotAuthorized] = useState<boolean>(() => hasLocalBotSession());

  // 未登录时默认弹出登录弹窗（强制登录）
  const [showLoginModal, setShowLoginModal] = useState<boolean>(() => {
    if (hasLocalBotSession()) return false;
    return true;
  });
  const [pendingCallback, setPendingCallback] = useState<(() => void) | null>(null);

  // 后台静默验证Bot session：失败则登出并弹登录框，成功则确保登录态正确（覆盖
  // 初始化时的乐观值，并避免活跃用户被本地缓存误判踢出后无法恢复）
  useEffect(() => {
    sidecarApi.tokenStatus().then((status) => {
      if (status.configured || status.mock_generation) {
        setIsAuthenticated(true);
        setShowLoginModal(false);
      }
    }).catch(() => {
      // Sidecar may not be running yet; keep the existing login prompt.
    });

    const settings = getAppSettings();
    if (settings.loginMode === 'bot' && localStorage.getItem('bot_session')) {
      botService.restoreSession().then(restored => {
        if (restored) {
          setIsAuthenticated(true);
          setIsBotAuthorized(true);
          setShowLoginModal(false);
        } else {
          setIsAuthenticated(false);
          setIsBotAuthorized(false);
          setShowLoginModal(true);
        }
      });
    }
  }, []);

  // 监听 botService 授权状态变化，同步 isBotAuthorized
  const preloadedRef = useRef(false);
  useEffect(() => {
    const unsubscribe = botService.addEventListener((authState) => {
      setIsBotAuthorized(authState.isAuthorized);
      // Bot 授权成功后，立即预加载画师串/OC/角色标签数据，无需等面板打开
      if (authState.isAuthorized && !preloadedRef.current) {
        preloadedRef.current = true;
        preloadAutocompleteData();
      }
    });
    return unsubscribe;
  }, []);

  const openLoginModal = useCallback(() => {
    setShowLoginModal(true);
  }, []);

  const closeLoginModal = useCallback(() => {
    // 只有已登录状态才允许关闭弹窗
    if (isAuthenticated) {
      setShowLoginModal(false);
      setPendingCallback(null);
    }
    // 未登录时不允许关闭（强制登录）
  }, [isAuthenticated]);

  const login = useCallback(() => {
    setIsAuthenticated(true);
    // 检查当前 bot 授权状态
    const authState = botService.getAuthState();
    setIsBotAuthorized(authState.isAuthorized);
    setShowLoginModal(false);
    // 执行待处理的回调
    if (pendingCallback) {
      pendingCallback();
      setPendingCallback(null);
    }
  }, [pendingCallback]);

  const logout = useCallback(() => {
    clearApiToken();
    sidecarApi.clearToken().catch(() => undefined);
    botService.logout();
    localStorage.removeItem('bot_session');
    setIsAuthenticated(false);
    setIsBotAuthorized(false);
    // 登出后自动弹出登录框（强制登录）
    setShowLoginModal(true);
  }, []);

  // 需要认证时调用，如果未登录则弹出登录框
  const requireAuth = useCallback((callback: () => void) => {
    if (isAuthenticated) {
      callback();
    } else {
      setPendingCallback(() => callback);
      setShowLoginModal(true);
    }
  }, [isAuthenticated]);

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      isBotAuthorized,
      showLoginModal,
      openLoginModal,
      closeLoginModal,
      login,
      logout,
      requireAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
