import React, { useState, useEffect, useCallback } from 'react';
import {
  Palette,
  Bot,
  ChevronRight,
  Check,
  Key,
  Type,
  ArrowLeft,
  LogOut,
  LogIn,
  Settings,
  User,
  HardDrive,
} from 'lucide-react';
import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  getApiToken,
  markApiTokenConfigured,
} from '../../services/localLibrary';
import { copyToClipboard } from '../../utils/clipboard';
import { botService, onlineService, type BotAuthState, type BotTaskState } from '../../services/botService';
import { clearTagCache } from '../../services/tagAutocomplete';
import { useAuth } from '../../contexts/AuthContext';
import { sidecarApi } from '../../api/sidecar';
import { MobileAISettingsSection } from './settings/MobileAISettingsSection';
import { MobileAutocompleteSettingsSection } from './settings/MobileAutocompleteSettingsSection';
import { MobileBackupSettingsSection } from './settings/MobileBackupSettingsSection';
import { MobileLoginSettingsSection } from './settings/MobileLoginSettingsSection';
import { MobilePresetSettingsSection } from './settings/MobilePresetSettingsSection';
import { MobileProfileSettingsSection } from './settings/MobileProfileSettingsSection';
import { MobileThemeSettingsSection } from './settings/MobileThemeSettingsSection';

type SettingsSection = 'profile' | 'theme' | 'ai' | 'autocomplete' | 'login' | 'presets' | 'backup' | null;

interface MobileSettingsPageProps {
  onLogout?: () => void;
}

const SECTIONS: { id: Exclude<SettingsSection, null>; name: string; icon: React.FC<{ className?: string }>; color: string }[] = [
  { id: 'profile', name: '个人中心', icon: User, color: 'text-blue-400' },
  { id: 'theme', name: '主题设置', icon: Palette, color: 'text-nai-accent' },
  { id: 'presets', name: '提示词预设', icon: Settings, color: 'text-nai-accent' },
  { id: 'ai', name: '辅助功能', icon: Bot, color: 'text-green-400' },
  { id: 'autocomplete', name: '补全设置', icon: Type, color: 'text-yellow-400' },
  { id: 'login', name: '登录模式', icon: Key, color: 'text-orange-400' },
  { id: 'backup', name: '数据备份', icon: HardDrive, color: 'text-cyan-400' },
];

export const MobileSettingsPage: React.FC<MobileSettingsPageProps> = ({ onLogout }) => {
  const { isAuthenticated, isBotAuthorized, openLoginModal } = useAuth();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [activeSection, setActiveSection] = useState<SettingsSection>(null);
  const [showSaveToast, setShowSaveToast] = useState(false);

  // 在线人数
  const [onlineCount, setOnlineCount] = useState(0);

  // Token状态
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [tokenError, setTokenError] = useState('');

  // Bot授权状态
  const [botAuthState, setBotAuthState] = useState<BotAuthState>(botService.getAuthState());
  const [, setBotTaskState] = useState<BotTaskState>(botService.getTaskState());
  const [authCodeCountdown, setAuthCodeCountdown] = useState(0);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);

  // 加载设置
  useEffect(() => {
    const saved = getAppSettings();
    setSettings(saved);
    setBotAuthState(botService.getAuthState());

    const savedToken = getApiToken();
    setToken(savedToken || '');
    setTokenError('');

    botService.restoreSession().then(() => {
      setBotAuthState(botService.getAuthState());
    });
  }, []);

  // 在线人数服务
  useEffect(() => {
    onlineService.start();
    const unsubscribe = onlineService.addEventListener(setOnlineCount);
    return () => {
      unsubscribe();
      onlineService.stop();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = botService.addEventListener((authState, taskState) => {
      setBotAuthState(authState);
      setBotTaskState(taskState);
      if (authState.isAuthorized) {
        botService.saveSession();
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (botAuthState.authCodeExpires) {
      const updateCountdown = () => {
        const remaining = Math.max(0, Math.floor((botAuthState.authCodeExpires! - Date.now()) / 1000));
        setAuthCodeCountdown(remaining);
        if (remaining <= 0) {
          setBotAuthState((prev) => ({ ...prev, authCode: null, authCodeExpires: null }));
        }
      };
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }
  }, [botAuthState.authCodeExpires]);

  const updateSettingsLocal = (updates: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  };

  const saveSettings = () => {
    saveAppSettings(settings);
    setShowSaveToast(true);
    setTimeout(() => setShowSaveToast(false), 1500);
  };

  const updateSettingsImmediate = (updates: Partial<AppSettings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    saveAppSettings(newSettings);

    const autocompleteKeys = ['autocompleteEnabled', 'autocompleteChineseEnabled', 'autocompleteShowWiki', 'autocompleteSortOrder'];
    if (autocompleteKeys.some((key) => key in updates)) {
      clearTagCache();
    }

    setShowSaveToast(true);
    setTimeout(() => setShowSaveToast(false), 1500);
  };

  const handleGenerateAuthCode = useCallback(async () => {
    setIsGeneratingCode(true);
    await botService.generateAuthCode();
    setIsGeneratingCode(false);
  }, []);

  const handleBotLogout = useCallback(() => {
    botService.logout();
    localStorage.removeItem('bot_session');
  }, []);

  const handleCopyCommand = useCallback(() => {
    if (botAuthState.authCode) {
      copyToClipboard(`web授权 ${botAuthState.authCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [botAuthState.authCode]);

  const handleSaveToken = useCallback(async () => {
    const trimmedToken = token.trim();
    if (trimmedToken && !trimmedToken.startsWith('pst-')) {
      setTokenError('Token 格式不正确 (应以 pst- 开头)');
      return;
    }
    setTokenError('');
    try {
      if (trimmedToken) {
        await sidecarApi.saveToken(trimmedToken);
        markApiTokenConfigured(true);
        setToken('');
      } else {
        await sidecarApi.clearToken();
        markApiTokenConfigured(false);
      }
      setShowSaveToast(true);
      setTimeout(() => setShowSaveToast(false), 1500);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : 'Token 保存失败');
    }
  }, [token]);

  const currentSectionInfo = SECTIONS.find((s) => s.id === activeSection);

  // 子页面内容渲染
  const renderSectionContent = () => {
    switch (activeSection) {
      case 'profile':
        return <MobileProfileSettingsSection />;

      case 'theme':
        return (
          <MobileThemeSettingsSection
            settings={settings}
            updateSettingsImmediate={updateSettingsImmediate}
          />
        );

      case 'ai':
        return (
          <MobileAISettingsSection
            settings={settings}
            updateSettingsImmediate={updateSettingsImmediate}
            updateSettingsLocal={updateSettingsLocal}
            saveSettings={saveSettings}
          />
        );

      case 'autocomplete':
        return (
          <MobileAutocompleteSettingsSection
            settings={settings}
            updateSettingsImmediate={updateSettingsImmediate}
          />
        );

      case 'presets':
        return (
          <MobilePresetSettingsSection
            onSaved={() => {
              setShowSaveToast(true);
              setTimeout(() => setShowSaveToast(false), 1500);
            }}
          />
        );

      case 'login':
        return (
          <MobileLoginSettingsSection
            settings={settings}
            updateSettingsImmediate={updateSettingsImmediate}
            botAuthState={botAuthState}
            authCodeCountdown={authCodeCountdown}
            isGeneratingCode={isGeneratingCode}
            copied={copied}
            onGenerateAuthCode={handleGenerateAuthCode}
            onBotLogout={handleBotLogout}
            onCopyCommand={handleCopyCommand}
            token={token}
            setToken={setToken}
            tokenError={tokenError}
            setTokenError={setTokenError}
            showToken={showToken}
            setShowToken={setShowToken}
            onSaveToken={handleSaveToken}
          />
        );

      case 'backup':
        return <MobileBackupSettingsSection />;

      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-full bg-nai-bg">
      {/* 保存成功提示 */}
      {showSaveToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
          <Check className="w-4 h-4" />
          <span className="text-sm">已保存</span>
        </div>
      )}

      {/* 顶部栏 */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-nai-panel border-b border-gray-800">
        {activeSection ? (
          <button onClick={() => setActiveSection(null)} className="p-2 -ml-2 text-gray-400 active:scale-95 transition-all">
            <ArrowLeft className="w-6 h-6" />
          </button>
        ) : (
          <div className="w-10" />
        )}
        <h1 className="text-lg font-bold text-white">
          {activeSection ? currentSectionInfo?.name : '设置'}
        </h1>
        {/* 在线人数 - 只在主页面显示 */}
        {activeSection === null ? (
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <div className="absolute inset-0 bg-green-500 rounded-full animate-ping opacity-75" />
            </div>
            <span className="text-sm font-mono font-bold text-green-400">{onlineCount}</span>
          </div>
        ) : (
          <div className="w-10" />
        )}
      </header>

      {/* 内容区域 */}
      <div className="flex-1 overflow-y-auto">
        {activeSection === null ? (
          // 主列表
          <div className="p-4 space-y-2">
            {/* 设置分类 */}
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className="w-full flex items-center justify-between p-4 bg-nai-input rounded-xl border border-gray-700/50 active:bg-gray-800/50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <section.icon className={`w-5 h-5 ${section.color}`} />
                  <span className="font-medium text-white">{section.name}</span>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-500" />
              </button>
            ))}

            {/* 登录/退出登录 */}
            <button
              onClick={() => {
                if (isBotAuthorized) {
                  // 已Bot授权：退出并弹出登录窗口
                  if (onLogout) onLogout();
                  openLoginModal();
                } else {
                  // 未Bot授权：弹出登录窗口
                  openLoginModal();
                }
              }}
              className={`w-full flex items-center justify-between p-4 rounded-xl border active:opacity-80 transition-colors mt-6 ${isBotAuthorized
                ? 'bg-red-900/20 border-red-900/50'
                : 'bg-nai-accent/10 border-nai-accent/30'
                }`}
            >
              <div className="flex items-center gap-3">
                {isBotAuthorized ? (
                  <LogOut className="w-5 h-5 text-red-400" />
                ) : (
                  <LogIn className="w-5 h-5 text-nai-accent" />
                )}
                <span className={`font-medium ${isBotAuthorized ? 'text-red-400' : 'text-nai-accent'}`}>
                  {isBotAuthorized ? '退出登录' : '登录'}
                </span>
              </div>
            </button>
          </div>
        ) : (
          // 子页面内容
          renderSectionContent()
        )}
      </div>
    </div>
  );
};

export default MobileSettingsPage;
