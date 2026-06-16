import React, { useState, useEffect, useCallback } from 'react';
import { X, Palette, Bot, ChevronDown, Check, Key, Loader2, CheckCircle, Eye, EyeOff, Copy, Type, Keyboard, HardDrive, Download, Upload, RefreshCw, AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  THEME_OPTIONS,
  getApiToken,
  saveApiToken,
} from '../services/localLibrary';
import { botService, type BotAuthState, type BotTaskState } from '../services/botService';
import { clearTagCache } from '../services/tagAutocomplete';
import { exportBackup, parseAndPreviewBackup, restoreBackup, getDataCounts, DEFAULT_EXPORT_OPTIONS, type BackupData, type BackupSummary, type ExportOptions } from '../services/backupService';
import { sidecarApi } from '../api/sidecar';

type SettingsTab = 'theme' | 'ai' | 'login' | 'autocomplete' | 'shortcut' | 'backup';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const TABS = [
  { id: 'theme' as const, name: '主题设置', icon: Palette },
  { id: 'ai' as const, name: '辅助功能', icon: Bot },
  { id: 'autocomplete' as const, name: '补全设置', icon: Type },
  { id: 'shortcut' as const, name: '快捷键', icon: Keyboard },
  { id: 'login' as const, name: '登录模式', icon: Key },
  { id: 'backup' as const, name: '数据备份', icon: HardDrive },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [activeTab, setActiveTab] = useState<SettingsTab>('theme');
  const [isThemeDropdownOpen, setIsThemeDropdownOpen] = useState(false);
  const [showSaveToast, setShowSaveToast] = useState(false);

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

  // 备份相关状态
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importPreview, setImportPreview] = useState<BackupSummary | null>(null);
  const [importData, setImportData] = useState<BackupData | null>(null);
  const [backupStatus, setBackupStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [exportOptions, setExportOptions] = useState<ExportOptions>({ ...DEFAULT_EXPORT_OPTIONS });
  const [dataCounts, setDataCounts] = useState<{ vibes: number; ocs: number; artists: number; crs: number; presets: number } | null>(null);

  useEffect(() => {
    if (isOpen) {
      const saved = getAppSettings();
      setSettings(saved);
      setBotAuthState(botService.getAuthState());

      // 加载已保存的Token
      const savedToken = getApiToken();
      setToken(savedToken || '');
      setTokenError('');

      // 恢复Bot会话（异步）
      botService.restoreSession().then(() => {
        setBotAuthState(botService.getAuthState());
      });

      // 加载备份数据统计
      getDataCounts().then(setDataCounts);
    }
  }, [isOpen]);

  // 监听Bot服务状态变化
  useEffect(() => {
    const unsubscribe = botService.addEventListener((authState, taskState) => {
      setBotAuthState(authState);
      setBotTaskState(taskState);

      // 授权成功后保存会话
      if (authState.isAuthorized) {
        botService.saveSession();
      }
    });
    return unsubscribe;
  }, []);

  // 授权码倒计时
  useEffect(() => {
    if (botAuthState.authCodeExpires) {
      const updateCountdown = () => {
        const remaining = Math.max(0, Math.floor((botAuthState.authCodeExpires! - Date.now()) / 1000));
        setAuthCodeCountdown(remaining);
        if (remaining <= 0) {
          setBotAuthState(prev => ({ ...prev, authCode: null, authCodeExpires: null }));
        }
      };
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }
  }, [botAuthState.authCodeExpires]);

  // 即时更新状态（不保存）
  const updateSettingsLocal = (updates: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...updates }));
  };

  // 保存设置并显示提示
  const saveSettings = () => {
    saveAppSettings(settings);
    setShowSaveToast(true);
    setTimeout(() => setShowSaveToast(false), 1500);
  };

  // 即时保存（用于开关、选择等）
  const updateSettingsImmediate = (updates: Partial<AppSettings>) => {
    const newSettings = { ...settings, ...updates };
    setSettings(newSettings);
    saveAppSettings(newSettings);
    window.dispatchEvent(new Event('app-settings-changed'));

    // 如果是补全相关设置变更，清除缓存使其立即生效
    const autocompleteKeys = ['autocompleteEnabled', 'autocompleteChineseEnabled', 'autocompleteShowWiki', 'autocompleteSortOrder'];
    if (autocompleteKeys.some(key => key in updates)) {
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
      navigator.clipboard.writeText(`web授权 ${botAuthState.authCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [botAuthState.authCode]);

  // 保存Token
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

  if (!isOpen) return null;

  const selectedTheme = THEME_OPTIONS.find((t) => t.id === settings.theme) || THEME_OPTIONS[0];

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      {/* 保存成功提示 */}
      {showSaveToast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[300] bg-green-600 text-white px-4 py-2 rounded-lg shadow-lg flex items-center gap-2 animate-fade-in">
          <Check className="w-4 h-4" />
          <span className="text-sm">已保存</span>
        </div>
      )}

      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[700px] h-[480px] flex overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <div className="w-44 bg-nai-dark/80 border-r border-gray-800 flex flex-col">
          <div className="p-4 border-b border-gray-800/50">
            <h3 className="text-base font-bold text-white">设置</h3>
          </div>
          <div className="flex-1 p-2 space-y-1 overflow-y-auto">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-all flex items-center gap-2.5 ${activeTab === tab.id
                  ? 'bg-nai-accent/15 text-nai-accent'
                  : 'text-gray-400 hover:bg-gray-800/60 hover:text-white'
                  }`}
                onClick={() => setActiveTab(tab.id)}
              >
                <tab.icon className="w-4 h-4" />
                <span className="text-sm">{tab.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 右侧内容区域 */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center justify-between p-4 border-b border-gray-700">
            <h3 className="text-white font-bold flex items-center gap-2">
              {activeTab === 'theme' && <Palette className="w-4 h-4" />}
              {activeTab === 'ai' && <Bot className="w-4 h-4" />}
              {activeTab === 'autocomplete' && <Type className="w-4 h-4" />}
              {activeTab === 'shortcut' && <Keyboard className="w-4 h-4" />}
              {activeTab === 'login' && <Key className="w-4 h-4" />}
              {activeTab === 'backup' && <HardDrive className="w-4 h-4" />}
              {TABS.find((t) => t.id === activeTab)?.name}
            </h3>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {activeTab === 'theme' && (
              <div className="space-y-4">
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    当前主题
                  </label>
                  <div className="relative">
                    <button
                      className="w-full bg-gray-900 hover:bg-gray-800 px-4 py-3 rounded-lg flex items-center justify-between text-left transition-colors border border-gray-700"
                      onClick={() => setIsThemeDropdownOpen(!isThemeDropdownOpen)}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className="w-6 h-6 rounded-full border-2 border-gray-600 shadow-lg"
                          style={{ backgroundColor: selectedTheme.color }}
                        />
                        <span className="text-white">{selectedTheme.name}</span>
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 text-gray-400 transition-transform ${isThemeDropdownOpen ? 'rotate-180' : ''}`}
                      />
                    </button>

                    {isThemeDropdownOpen && (
                      <div className="absolute top-full left-0 right-0 mt-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-50">
                        {THEME_OPTIONS.map((theme) => (
                          <button
                            key={theme.id}
                            className={`w-full px-4 py-3 text-left hover:bg-gray-800 transition-colors flex items-center justify-between ${settings.theme === theme.id ? 'bg-gray-800' : ''
                              }`}
                            onClick={() => {
                              updateSettingsImmediate({ theme: theme.id });
                              setIsThemeDropdownOpen(false);
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <div
                                className="w-6 h-6 rounded-full border-2 border-gray-600"
                                style={{ backgroundColor: theme.color }}
                              />
                              <span className="text-white">{theme.name}</span>
                            </div>
                            {settings.theme === theme.id && (
                              <Check className="w-4 h-4 text-nai-accent" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-3">更多主题即将推出...</p>
                </div>
              </div>
            )}

            {activeTab === 'ai' && (
              <div className="space-y-4">
                {/* 队列设置 - 放在最上面 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-xs text-gray-400 uppercase tracking-wider">
                      启用队列模式
                    </label>
                    <button
                      onClick={() => updateSettingsImmediate({ queueEnabled: !settings.queueEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.queueEnabled ? 'bg-emerald-500' : 'bg-gray-600'
                        }`}
                    >
                      <div
                        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.queueEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                      />
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">
                    启用后，多个用户共享同一Token时将按队列顺序生成图片，避免并发冲突
                  </p>
                </div>

                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    AI 接口
                  </label>
                  <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
                    <div>
                      <p className="text-sm text-white">Sidecar 托管</p>
                      <p className="mt-1 text-xs text-gray-500">
                        LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
                      </p>
                    </div>
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                      本地安全配置
                    </span>
                  </div>
                </div>

                {/* 超分服务 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    超分服务
                  </label>
                  <div className="rounded-lg border border-gray-700 bg-gray-900 px-4 py-3">
                    <p className="text-sm text-white">Sidecar 托管</p>
                    <p className="mt-1 text-xs text-gray-500">
                      前端不再下载或运行 Real-ESRGAN / ONNX 模型；超分请求统一交给 sidecar。
                    </p>
                  </div>
                </div>

                {/* AI Agent 最大上下文长度 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    AI 对话最大上下文轮数
                  </label>
                  <div className="grid grid-cols-5 gap-2">
                    {[10, 20, 30, 40, 50].map((option) => (
                      <button
                        key={option}
                        onClick={() => updateSettingsImmediate({ aiMaxContextLength: option })}
                        className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.aiMaxContextLength === option
                          ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                          : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
                          }`}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    AI 辅助生成时保留的历史对话轮数，超过后自动清理最早的对话
                  </p>
                </div>

                {/* AI 防截断功能 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-white">启用防截断功能</div>
                      <p className="text-xs text-gray-500 mt-1">
                        添加 prison_break 提示词，减少 AI 输出被截断的情况
                      </p>
                    </div>
                    <button
                      onClick={() => updateSettingsImmediate({ aiPrisonBreakEnabled: !settings.aiPrisonBreakEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.aiPrisonBreakEnabled ? 'bg-emerald-500' : 'bg-gray-600'
                        }`}
                    >
                      <div
                        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.aiPrisonBreakEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                      />
                    </button>
                  </div>
                </div>

                {/* 服务端设置 - 放在最下面 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    服务端
                  </label>
                  <div className="flex gap-3 mb-3">
                    <button
                      onClick={() => updateSettingsImmediate({ serverMode: 'public', backendUrl: '', queueServerUrl: '' })}
                      className={`flex-1 py-2.5 px-4 rounded-lg border transition-all text-sm font-medium ${settings.serverMode === 'public'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                    >
                      公共服务端
                    </button>
                    <button
                      onClick={() => updateSettingsImmediate({ serverMode: 'custom' })}
                      className={`flex-1 py-2.5 px-4 rounded-lg border transition-all text-sm font-medium ${settings.serverMode === 'custom'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                    >
                      自定义
                    </button>
                  </div>
                  {settings.serverMode === 'custom' && (
                    <>
                      <input
                        type="text"
                        value={settings.backendUrl}
                        onChange={(e) => updateSettingsLocal({ backendUrl: e.target.value })}
                        onBlur={saveSettings}
                        placeholder="例如: http://localhost:7860"
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none transition-colors"
                      />
                      <p className="text-xs text-gray-500 mt-2">
                        数据 API、标签补全、排队、Bot 授权等所有后端服务地址
                      </p>
                    </>
                  )}
                  {settings.serverMode === 'public' && (
                    <p className="text-xs text-gray-500">
                      使用当前页面地址作为服务端（{window.location.origin}）
                    </p>
                  )}
                </div>

                {/* KKT 收集服务端 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    KKT 收集服务端
                  </label>
                  <div className="flex gap-3 mb-3">
                    <button
                      onClick={() => updateSettingsImmediate({ kktServerMode: 'public', kktServerUrl: 'https://nai.sora214.top' })}
                      className={`flex-1 py-2.5 px-4 rounded-lg border transition-all text-sm font-medium ${settings.kktServerMode === 'public'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                    >
                      公共服务端
                    </button>
                    <button
                      onClick={() => updateSettingsImmediate({ kktServerMode: 'custom' })}
                      className={`flex-1 py-2.5 px-4 rounded-lg border transition-all text-sm font-medium ${settings.kktServerMode === 'custom'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:text-white hover:border-gray-500'
                        }`}
                    >
                      自定义
                    </button>
                  </div>
                  {settings.kktServerMode === 'custom' && (
                    <>
                      <input
                        type="text"
                        value={settings.kktServerUrl}
                        onChange={(e) => updateSettingsLocal({ kktServerUrl: e.target.value })}
                        onBlur={saveSettings}
                        placeholder="例如: http://127.0.0.1:38176"
                        className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none transition-colors"
                      />
                      <p className="text-xs text-gray-500 mt-2">
                        KKT 收集数据库和图片所在服务器的 API 地址
                      </p>
                    </>
                  )}
                  {settings.kktServerMode === 'public' && (
                    <p className="text-xs text-gray-500">
                      使用公共 KKT 服务端
                    </p>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'login' && (
              <div className="space-y-4">
                {/* Bot 授权区域 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    Bot 授权状态
                  </label>

                  {botAuthState.isAuthorized ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-green-400">
                        <CheckCircle className="w-5 h-5" />
                        <span className="font-medium">已授权</span>
                      </div>
                      <div className="text-sm text-gray-400">
                        Bot用户: {botAuthState.botUserId || '未知'}
                      </div>
                      <button
                        onClick={handleBotLogout}
                        className="px-4 py-2 bg-red-900/50 text-red-400 rounded-lg hover:bg-red-900/70 text-sm transition-colors"
                      >
                        退出登录
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {botAuthState.authCode ? (
                        <div className="space-y-3">
                          <div className="bg-gray-900 rounded-lg p-4 text-center">
                            <div className="text-xl font-mono font-bold text-nai-accent tracking-widest flex items-center justify-center gap-3">
                              <span>web授权 {botAuthState.authCode}</span>
                              <button
                                onClick={handleCopyCommand}
                                className="p-1.5 hover:bg-gray-700 rounded transition-colors"
                                title="复制指令"
                              >
                                {copied ? (
                                  <Check className="w-5 h-5 text-green-400" />
                                ) : (
                                  <Copy className="w-5 h-5 text-gray-400 hover:text-white" />
                                )}
                              </button>
                            </div>
                            <div className="text-xs text-gray-500 mt-2">
                              {authCodeCountdown > 0 ? (
                                <>剩余 {Math.floor(authCodeCountdown / 60)}:{(authCodeCountdown % 60).toString().padStart(2, '0')}</>
                              ) : (
                                '已过期'
                              )}
                            </div>
                          </div>
                          <div className="flex items-center justify-center gap-2 text-xs text-gray-500">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            向Bot发送上方指令完成授权
                          </div>
                        </div>
                      ) : (
                        <button
                          onClick={handleGenerateAuthCode}
                          disabled={isGeneratingCode}
                          className="w-full py-3 bg-nai-accent text-black font-bold rounded-lg hover:bg-[#ebd576] disabled:opacity-50 flex items-center justify-center gap-2 transition-colors"
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
                    说明：Bot 授权用于校验用户身份，授权后才可访问公共 OC、Vibe、画师及 KKT 收集等相关公共内容。
                  </p>
                </div>

                {/* 生成方式选择 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    图像生成方式
                  </label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => updateSettingsImmediate({ loginMode: 'bot' })}
                      className={`flex-1 py-3 px-4 rounded-lg border transition-all ${settings.loginMode === 'bot'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                        }`}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <Bot className="w-4 h-4" />
                        <span className="text-sm font-medium">Bot 共享账号</span>
                      </div>
                      <p className="text-xs mt-1 opacity-70">使用排队系统生成</p>
                    </button>
                    <button
                      onClick={() => updateSettingsImmediate({ loginMode: 'token' })}
                      className={`flex-1 py-3 px-4 rounded-lg border transition-all ${settings.loginMode === 'token'
                        ? 'bg-nai-accent/20 border-nai-accent text-nai-accent'
                        : 'bg-gray-900 border-gray-700 text-gray-400 hover:border-gray-600'
                        }`}
                    >
                      <div className="flex items-center justify-center gap-2">
                        <Key className="w-4 h-4" />
                        <span className="text-sm font-medium">API Token</span>
                      </div>
                      <p className="text-xs mt-1 opacity-70">直接使用 NovelAI 接口</p>
                    </button>
                  </div>
                </div>

                {/* API Token 配置 */}
                <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 transition-opacity ${settings.loginMode !== 'token' ? 'opacity-60' : ''}`}>
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    API Token 配置
                  </label>
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
                      className={`w-full bg-gray-900 border rounded-lg px-4 py-3 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none transition-colors ${tokenError ? 'border-red-500' : 'border-gray-700 focus:border-nai-accent/50'
                        }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                    >
                      {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  {tokenError && <p className="text-red-400 text-xs mt-2">{tokenError}</p>}
                  {token && !tokenError && (
                    <div className="flex items-center gap-1.5 text-green-400 text-xs mt-2">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Token 已保存</span>
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-2">
                    通过抓包或者 NovelAI 网站获取你的 API Token。在此处填入即可直接使用个人账号跑图。
                  </p>
                </div>
              </div>
            )}

            {activeTab === 'autocomplete' && (
              <div className="space-y-4">
                {/* 启用补全 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-white">启用标签补全</div>
                      <p className="text-xs text-gray-500 mt-1">
                        输入时自动显示标签建议
                      </p>
                    </div>
                    <button
                      onClick={() => updateSettingsImmediate({ autocompleteEnabled: !settings.autocompleteEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteEnabled ? 'bg-emerald-500' : 'bg-gray-600'
                        }`}
                    >
                      <div
                        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                      />
                    </button>
                  </div>
                </div>

                {/* 中文补全 */}
                <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-white">中文输入补全</div>
                      <p className="text-xs text-gray-500 mt-1">
                        支持输入中文搜索标签（仅角色匹配）
                      </p>
                    </div>
                    <button
                      onClick={() => updateSettingsImmediate({ autocompleteChineseEnabled: !settings.autocompleteChineseEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteChineseEnabled ? 'bg-emerald-500' : 'bg-gray-600'
                        }`}
                    >
                      <div
                        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteChineseEnabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                      />
                    </button>
                  </div>
                </div>

                {/* 显示 Wiki 翻译 */}
                <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-white">显示 Wiki 翻译</div>
                      <p className="text-xs text-gray-500 mt-1">
                        在补全列表中显示标签的中文翻译
                      </p>
                    </div>
                    <button
                      onClick={() => updateSettingsImmediate({ autocompleteShowWiki: !settings.autocompleteShowWiki })}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteShowWiki ? 'bg-emerald-500' : 'bg-gray-600'
                        }`}
                    >
                      <div
                        className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteShowWiki ? 'translate-x-5' : 'translate-x-0'
                          }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Danbooru 结果排序（仅英文查询生效） */}
                <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                  <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">
                    Danbooru 结果排序
                  </label>
                  <p className="text-[10px] text-gray-500 mb-3">仅影响英文查询时 Danbooru 标签的内部顺序</p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { id: 'prefix-first', name: '首字母匹配优先' },
                      { id: 'count', name: '引用数量排序' },
                    ].map((option) => (
                      <button
                        key={option.id}
                        onClick={() => updateSettingsImmediate({ autocompleteSortOrder: option.id as AppSettings['autocompleteSortOrder'] })}
                        className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.autocompleteSortOrder === option.id
                          ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                          : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
                          }`}
                      >
                        {option.name}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {settings.autocompleteSortOrder === 'prefix-first' && '优先显示以输入内容开头的标签'}
                    {settings.autocompleteSortOrder === 'count' && '按标签引用次数从高到低排序'}
                  </p>
                </div>

                {/* 数据源自定义入口 Beta24 起暂时关闭，统一使用内置默认配置；保留旧 localStorage，待功能成熟后再开放 */}
              </div>
            )}

            {activeTab === 'shortcut' && (
              <div className="space-y-4">
                {/* 回车键行为 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
                    回车键行为
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => updateSettingsImmediate({ enterBehavior: 'default' })}
                      className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.enterBehavior === 'default'
                        ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                        : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
                        }`}
                    >
                      确认 / 换行
                    </button>
                    <button
                      onClick={() => updateSettingsImmediate({ enterBehavior: 'generate' })}
                      className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.enterBehavior === 'generate'
                        ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                        : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
                        }`}
                    >
                      生成图片
                    </button>
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    {settings.enterBehavior === 'generate' && '按回车直接生成图片，换行按 Shift+回车。此模式全局有效，可防止误触焦点组件。'}
                    {settings.enterBehavior === 'default' && '当焦点在按钮时，按回车会点击它，在文本框内则为换行。这是默认的浏览器行为。'}
                  </p>
                </div>

                {/* 标签权重预设 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-xs text-gray-400 uppercase tracking-wider">
                      标签权重预设
                    </label>
                    <button
                      onClick={() => updateSettingsImmediate({ weightPresets: [-1, 0.5, 0.8, 1.5, 2.0] })}
                      className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
                    >恢复默认</button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).map((w, i) => {
                      const color = w > 1 ? 'orange' : w < 1 ? 'blue' : 'gray';
                      const colorMap = {
                        orange: { bg: 'bg-orange-500/15', border: 'border-orange-400/30', text: 'text-orange-200', hover: 'hover:border-orange-400/50', xHover: 'hover:text-orange-100 hover:bg-orange-500/30' },
                        blue: { bg: 'bg-blue-500/15', border: 'border-blue-400/30', text: 'text-blue-200', hover: 'hover:border-blue-400/50', xHover: 'hover:text-blue-100 hover:bg-blue-500/30' },
                        gray: { bg: 'bg-gray-700/40', border: 'border-gray-600/50', text: 'text-gray-300', hover: 'hover:border-gray-500', xHover: 'hover:text-gray-100 hover:bg-gray-600/50' },
                      };
                      const c = colorMap[color];
                      return (
                        <div key={i} className={`group inline-flex items-center gap-0.5 rounded-md border ${c.bg} ${c.border} ${c.hover} transition-colors`}>
                          <input
                            type="number"
                            step="0.1"
                            min="-10"
                            max="10"
                            value={w}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              if (isNaN(val)) return;
                              const p = [...(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0])];
                              p[i] = Math.round(val * 100) / 100;
                              updateSettingsImmediate({ weightPresets: p });
                            }}
                            className={`w-12 bg-transparent text-center text-xs font-mono py-1 pl-1.5 pr-0 outline-none ${c.text} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                          />
                          <button
                            onClick={() => updateSettingsImmediate({ weightPresets: (settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).filter((_, idx) => idx !== i) })}
                            className={`w-5 h-full flex items-center justify-center rounded-r-[5px] text-gray-500 ${c.xHover} transition-colors`}
                          ><X className="w-2.5 h-2.5" /></button>
                        </div>
                      );
                    })}
                    {(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).length < 6 && (
                      <button
                        onClick={() => updateSettingsImmediate({ weightPresets: [...(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]), 1.0] })}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-dashed border-gray-600 text-[11px] text-gray-500 hover:border-gray-400 hover:text-gray-300 transition-colors"
                      ><Plus className="w-3 h-3" />添加</button>
                    )}
                  </div>
                  <p className="text-[11px] text-gray-600 mt-2.5">点击芯片面板中的预设按钮可快速设置标签权重</p>
                </div>
              </div>
            )}

            {activeTab === 'backup' && (
              <div className="space-y-4">
                {/* 状态提示 */}
                {backupStatus && (
                  <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                    backupStatus.type === 'success'
                      ? 'bg-green-900/30 text-green-400 border border-green-800/50'
                      : 'bg-red-900/30 text-red-400 border border-red-800/50'
                  }`}>
                    {backupStatus.type === 'success' ? <CheckCircle className="w-4 h-4 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 flex-shrink-0" />}
                    <span>{backupStatus.text}</span>
                  </div>
                )}

                {/* 导出区 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">导出备份</label>
                  <div className="space-y-1.5 mb-3">
                    {([
                      { key: 'settings' as const, label: '应用设置 & 生成参数' },
                      { key: 'presets' as const, label: '提示词预设', count: dataCounts?.presets },
                      { key: 'vibes' as const, label: 'Vibe', count: dataCounts?.vibes },
                      { key: 'ocs' as const, label: 'OC (原创角色)', count: dataCounts?.ocs },
                      { key: 'artists' as const, label: '画师', count: dataCounts?.artists },
                      { key: 'crs' as const, label: '精准参考', count: dataCounts?.crs },
                    ]).map(({ key, label, count }) => (
                      <label key={key} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-700/30 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={exportOptions[key]}
                          onChange={() => setExportOptions(prev => ({ ...prev, [key]: !prev[key] }))}
                          className="w-3.5 h-3.5 rounded accent-nai-accent"
                        />
                        <span className="text-gray-300 flex-1">{label}</span>
                        {count !== undefined && <span className="text-gray-600 text-xs">{count}</span>}
                      </label>
                    ))}
                  </div>
                  <button
                    onClick={async () => {
                      setIsExporting(true);
                      setBackupStatus(null);
                      try {
                        await exportBackup(exportOptions);
                        setBackupStatus({ type: 'success', text: '备份文件已导出' });
                      } catch (e) {
                        setBackupStatus({ type: 'error', text: `导出失败: ${e}` });
                      } finally {
                        setIsExporting(false);
                      }
                    }}
                    disabled={isExporting || !Object.values(exportOptions).some(Boolean)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors bg-nai-accent/20 text-nai-accent border border-nai-accent/50 hover:bg-nai-accent/30 disabled:opacity-50"
                  >
                    {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    {isExporting ? '正在导出...' : '导出数据'}
                  </button>
                </div>

                {/* 导入区 */}
                <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                  <label className="block text-xs text-gray-400 mb-2 uppercase tracking-wider">导入备份</label>
                  <p className="text-xs text-gray-500 mb-3">
                    从备份文件恢复数据。相同 ID 的项目将被覆盖，其余保留。
                  </p>

                  {!importPreview ? (
                    <label className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors bg-gray-900 text-gray-300 border border-gray-700 hover:bg-gray-800 cursor-pointer">
                      <Upload className="w-4 h-4" />
                      选择备份文件
                      <input
                        type="file"
                        accept=".json"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          setBackupStatus(null);
                          try {
                            const { summary, data } = await parseAndPreviewBackup(file);
                            setImportPreview(summary);
                            setImportData(data);
                          } catch (err) {
                            setBackupStatus({ type: 'error', text: `${err instanceof Error ? err.message : err}` });
                          }
                          e.target.value = '';
                        }}
                      />
                    </label>
                  ) : (
                    <div className="space-y-3">
                      <div className="bg-gray-900/50 rounded-lg p-3 text-xs space-y-1.5">
                        <div className="text-gray-400">
                          <span className="text-gray-500">备份时间：</span>
                          {new Date(importPreview.createdAt).toLocaleString()}
                        </div>
                        <div className="text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
                          {importPreview.localStorageKeyCount > 0 && <span>设置 {importPreview.localStorageKeyCount} 项</span>}
                          {importPreview.vibeCount > 0 && <span>Vibe {importPreview.vibeCount} 个</span>}
                          {importPreview.ocCount > 0 && <span>OC {importPreview.ocCount} 个</span>}
                          {importPreview.artistCount > 0 && <span>画师 {importPreview.artistCount} 个</span>}
                          {importPreview.crCount > 0 && <span>精准参考 {importPreview.crCount} 个</span>}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setImportPreview(null); setImportData(null); setBackupStatus(null); }}
                          className="flex-1 px-4 py-2 rounded-lg text-sm text-gray-400 bg-gray-900 border border-gray-700 hover:bg-gray-800"
                        >
                          取消
                        </button>
                        <button
                          onClick={async () => {
                            if (!importData) return;
                            setIsImporting(true);
                            setBackupStatus(null);
                            try {
                              const result = await restoreBackup(importData);
                              const parts = [];
                              if (result.restored.localStorageKeys > 0) parts.push(`设置 ${result.restored.localStorageKeys} 项`);
                              if (result.restored.vibes > 0) parts.push(`Vibe ${result.restored.vibes} 个`);
                              if (result.restored.ocs > 0) parts.push(`OC ${result.restored.ocs} 个`);
                              if (result.restored.artists > 0) parts.push(`画师 ${result.restored.artists} 个`);
                              if (result.restored.crs > 0) parts.push(`精准参考 ${result.restored.crs} 个`);
                              const msg = `已恢复：${parts.join('、')}`;
                              if (result.errors.length > 0) {
                                setBackupStatus({ type: 'error', text: `${msg}（${result.errors.length} 项失败）` });
                              } else {
                                setBackupStatus({ type: 'success', text: msg });
                              }
                            } catch (e) {
                              setBackupStatus({ type: 'error', text: `导入失败: ${e}` });
                            } finally {
                              setIsImporting(false);
                              setImportPreview(null);
                              setImportData(null);
                            }
                          }}
                          disabled={isImporting}
                          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-nai-accent/20 text-nai-accent border border-nai-accent/50 hover:bg-nai-accent/30 disabled:opacity-50"
                        >
                          {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                          {isImporting ? '正在导入...' : '确认导入'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 导入后刷新提示 */}
                {backupStatus?.type === 'success' && backupStatus.text.startsWith('已恢复') && (
                  <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
                    <p className="text-xs text-gray-500 mb-2">导入完成后建议刷新页面以使所有更改生效。</p>
                    <button
                      onClick={() => window.location.reload()}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm text-gray-300 bg-gray-900 border border-gray-700 hover:bg-gray-800"
                    >
                      <RefreshCw className="w-4 h-4" />
                      刷新页面
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
