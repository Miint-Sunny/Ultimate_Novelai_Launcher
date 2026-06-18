import React, { useState, useEffect, useCallback } from 'react';
import {
  Palette,
  Bot,
  ChevronRight,
  Check,
  Key,
  Loader2,
  CheckCircle,
  Eye,
  EyeOff,
  Copy,
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
  THEME_OPTIONS,
  getApiToken,
  saveApiToken,
} from '../../services/localLibrary';
import { copyToClipboard } from '../../utils/clipboard';
import { botService, onlineService, type BotAuthState, type BotTaskState } from '../../services/botService';
import { clearTagCache } from '../../services/tagAutocomplete';
import { useAuth } from '../../contexts/AuthContext';
import { sidecarApi } from '../../api/sidecar';
import { MobileAISettingsSection } from './settings/MobileAISettingsSection';
import { MobileBackupSettingsSection } from './settings/MobileBackupSettingsSection';
import { MobileProfileSettingsSection } from './settings/MobileProfileSettingsSection';
import { MobilePresetSettingsSection } from './settings/MobilePresetSettingsSection';
import { MobileSettingsToggle as Toggle } from './settings/MobileSettingsToggle';

type SettingsSection = 'profile' | 'theme' | 'ai' | 'autocomplete' | 'login' | 'presets' | 'backup' | null;

interface MobileSettingsPageProps {
  onLogout?: () => void;
}

const SECTIONS: { id: Exclude<SettingsSection, null>; name: string; icon: React.FC<{ className?: string }>; color: string }[] = [
  { id: 'profile', name: '个人中心', icon: User, color: 'text-blue-400' },
  { id: 'theme', name: '主题设置', icon: Palette, color: 'text-purple-400' },
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
        saveApiToken(trimmedToken);
        setToken('');
      } else {
        await sidecarApi.clearToken();
        saveApiToken('');
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
          <div className="p-4 space-y-4">
            <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">选择主题</div>
            <div className="grid grid-cols-2 gap-3">
              {THEME_OPTIONS.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => updateSettingsImmediate({ theme: theme.id })}
                  className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${settings.theme === theme.id
                    ? 'bg-nai-accent/20 border-nai-accent'
                    : 'bg-gray-800 border-gray-700 active:bg-gray-700'
                    }`}
                >
                  <div
                    className="w-6 h-6 rounded-full border-2 border-gray-500 shadow-lg"
                    style={{ backgroundColor: theme.color }}
                  />
                  <span className={`text-sm font-medium ${settings.theme === theme.id ? 'text-nai-accent' : 'text-gray-300'}`}>
                    {theme.name}
                  </span>
                  {settings.theme === theme.id && <Check className="w-4 h-4 text-nai-accent ml-auto" />}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-4">更多主题即将推出...</p>
          </div>
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
          <div className="p-4 space-y-4">
            <div className="flex items-center justify-between p-4 bg-gray-800 rounded-xl">
              <div>
                <div className="text-sm font-medium text-white">启用标签补全</div>
                <p className="text-xs text-gray-500 mt-1">输入时自动显示标签建议</p>
              </div>
              <Toggle
                enabled={settings.autocompleteEnabled}
                onChange={() => updateSettingsImmediate({ autocompleteEnabled: !settings.autocompleteEnabled })}
              />
            </div>
            <div className={`flex items-center justify-between p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
              <div>
                <div className="text-sm font-medium text-white">中文输入补全</div>
                <p className="text-xs text-gray-500 mt-1">支持输入中文搜索标签</p>
              </div>
              <Toggle
                enabled={settings.autocompleteChineseEnabled}
                onChange={() => updateSettingsImmediate({ autocompleteChineseEnabled: !settings.autocompleteChineseEnabled })}
                disabled={!settings.autocompleteEnabled}
              />
            </div>
            <div className={`flex items-center justify-between p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
              <div>
                <div className="text-sm font-medium text-white">显示 Wiki 翻译</div>
                <p className="text-xs text-gray-500 mt-1">显示标签的中文翻译</p>
              </div>
              <Toggle
                enabled={settings.autocompleteShowWiki}
                onChange={() => updateSettingsImmediate({ autocompleteShowWiki: !settings.autocompleteShowWiki })}
                disabled={!settings.autocompleteEnabled}
              />
            </div>
            <div className={`p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
              <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Danbooru 结果排序</label>
              <p className="text-[10px] text-gray-500 mb-3">仅影响英文查询时 Danbooru 标签的内部顺序</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'prefix-first', name: '首字母优先' },
                  { id: 'count', name: '引用数排序' },
                ].map((option) => (
                  <button
                    key={option.id}
                    onClick={() => settings.autocompleteEnabled && updateSettingsImmediate({ autocompleteSortOrder: option.id as AppSettings['autocompleteSortOrder'] })}
                    className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors ${settings.autocompleteSortOrder === option.id
                      ? 'bg-nai-accent/20 text-nai-accent border-2 border-nai-accent'
                      : 'bg-gray-700 text-gray-400 border-2 border-gray-600'
                      }`}
                  >
                    {option.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
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
          <div className="p-4 space-y-4">
            {/* Bot 授权 */}
            <div className="p-4 bg-gray-800 rounded-xl space-y-4 border border-gray-700">
              <div className="text-xs text-gray-500 uppercase tracking-wider">Bot 授权状态</div>
              {botAuthState.isAuthorized ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-400">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-medium">已授权</span>
                  </div>
                  <div className="text-sm text-gray-400">Bot用户: {botAuthState.botUserId || '未知'}</div>
                  <button
                    onClick={handleBotLogout}
                    className="w-full py-3 bg-red-900/50 text-red-400 rounded-xl text-sm font-medium transition-colors"
                  >
                    退出登录
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {botAuthState.authCode ? (
                    <>
                      <div className="bg-gray-900 rounded-xl p-4 text-center">
                        <div className="text-lg font-mono font-bold text-nai-accent tracking-wider flex items-center justify-center gap-2">
                          <span>web授权 {botAuthState.authCode}</span>
                          <button onClick={handleCopyCommand} className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors">
                            {copied ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5 text-gray-400" />}
                          </button>
                        </div>
                        <div className="text-xs text-gray-500 mt-2">
                          {authCodeCountdown > 0
                            ? `剩余 ${Math.floor(authCodeCountdown / 60)}:${(authCodeCountdown % 60).toString().padStart(2, '0')}`
                            : '已过期'}
                        </div>
                      </div>
                      <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        向 Bot 发送上方指令完成授权
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={handleGenerateAuthCode}
                      disabled={isGeneratingCode}
                      className="w-full py-3.5 bg-nai-accent text-black font-bold rounded-xl disabled:opacity-50 flex items-center justify-center gap-2 transition-colors active:scale-[0.98]"
                    >
                      {isGeneratingCode ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          生成中...
                        </>
                      ) : (
                        '生成授权码'
                      )}
                    </button>
                  )}
                </div>
              )}
              <p className="text-xs text-gray-500 mt-4 leading-relaxed">
                说明：Bot 授权用于校验身份，授权后才可访问公共 OC、Vibe、画师及 KKT 收集等相关公共内容。
              </p>
            </div>

            {/* 图像生成方式选择 */}
            <div className="p-4 bg-gray-800 rounded-xl space-y-4 border border-gray-700">
              <div className="text-xs text-gray-500 uppercase tracking-wider">图像生成方式</div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => updateSettingsImmediate({ loginMode: 'bot' })}
                  className={`py-4 px-2 rounded-xl border-2 transition-all ${settings.loginMode === 'bot'
                    ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                    : 'bg-gray-800 border-gray-700 text-gray-400'
                    }`}
                >
                  <Bot className="w-6 h-6 mx-auto mb-2" />
                  <div className="text-sm font-medium">Bot 共享账号</div>
                  <p className="text-xs mt-1 opacity-70">使用排队系统</p>
                </button>
                <button
                  onClick={() => updateSettingsImmediate({ loginMode: 'token' })}
                  className={`py-4 px-2 rounded-xl border-2 transition-all ${settings.loginMode === 'token'
                    ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                    : 'bg-gray-800 border-gray-700 text-gray-400'
                    }`}
                >
                  <Key className="w-6 h-6 mx-auto mb-2" />
                  <div className="text-sm font-medium">API Token</div>
                  <p className="text-xs mt-1 opacity-70">直接使用接口</p>
                </button>
              </div>
            </div>

            {/* Token 配置 */}
            <div className={`p-4 bg-gray-800 rounded-xl space-y-3 border border-gray-700 transition-opacity ${settings.loginMode !== 'token' ? 'opacity-60' : ''}`}>
              <div className="text-xs text-gray-500 uppercase tracking-wider">API Token 配置</div>
              <div className="relative">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={token}
                  onChange={(e) => {
                    setToken(e.target.value);
                    setTokenError('');
                  }}
                  onBlur={handleSaveToken}
                  placeholder="pst-..."
                  className={`w-full bg-gray-900 border rounded-xl px-4 py-3.5 pr-12 text-sm text-white placeholder-gray-500 focus:outline-none transition-colors ${tokenError ? 'border-red-500' : 'border-gray-700 focus:border-nai-accent/50'
                    }`}
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 p-2"
                >
                  {showToken ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
              {tokenError && <p className="text-red-400 text-xs">{tokenError}</p>}
              {token && !tokenError && (
                <div className="flex items-center gap-1.5 text-green-400 text-xs mt-2">
                  <CheckCircle className="w-3.5 h-3.5" />
                  <span>Token 已保存</span>
                </div>
              )}
              <p className="text-xs text-gray-500 mt-2">
                在此填入你的个人 Token 即可直接跑图。
              </p>
            </div>
          </div>
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
