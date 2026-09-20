import React, { useState, useEffect, useCallback } from 'react';
import { X, Palette, Bot, Check, Key, Type, Keyboard, HardDrive, Stamp } from 'lucide-react';
import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
  DEFAULT_APP_SETTINGS,
  getApiToken,
  markApiTokenConfigured,
} from '../services/localLibrary';
import { botService, type BotAuthState, type BotTaskState } from '../services/botService';
import { clearTagCache } from '../services/tagAutocomplete';
import { getDataCounts, DEFAULT_EXPORT_OPTIONS, type BackupData, type BackupSummary, type ExportOptions } from '../services/backupService';
import { sidecarApi, type TokenStatus } from '../api/sidecar';
import { ThemeSettingsSection } from './settings/ThemeSettingsSection';
import { AISettingsSection } from './settings/AISettingsSection';
import { AutocompleteSettingsSection } from './settings/AutocompleteSettingsSection';
import { ShortcutSettingsSection } from './settings/ShortcutSettingsSection';
import { LoginSettingsSection } from './settings/LoginSettingsSection';
import { BackupSettingsSection } from './settings/BackupSettingsSection';
import { WatermarkSettingsSection } from './settings/WatermarkSettingsSection';

type SettingsTab = 'theme' | 'ai' | 'login' | 'autocomplete' | 'shortcut' | 'watermark' | 'backup';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const TABS = [
  { id: 'theme' as const, name: '主题设置', icon: Palette },
  { id: 'ai' as const, name: '辅助功能', icon: Bot },
  { id: 'autocomplete' as const, name: '补全设置', icon: Type },
  { id: 'shortcut' as const, name: '快捷键', icon: Keyboard },
  { id: 'watermark' as const, name: '水印导出', icon: Stamp },
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
  // Token 状态从 sidecar 读(是否已配置 / 来源 / 是否模拟出图);前端永远拿不到明文。
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [tokenStatusUnreachable, setTokenStatusUnreachable] = useState(false);

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
      setTokenStatus(null);
      setTokenStatusUnreachable(false);
      sidecarApi.tokenStatus()
        .then((status) => { setTokenStatus(status); setTokenStatusUnreachable(false); })
        .catch(() => { setTokenStatusUnreachable(true); });

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
    const autocompleteKeys = ['autocompleteEnabled', 'autocompleteChineseEnabled', 'autocompleteShowWiki', 'autocompleteSortOrder', 'tagSuggestSource'];
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

  // 保存Token。输入框打开时永远是空的(前端读不到 Token),所以空输入必须是 no-op:
  // 以前点进去再点出去就把凭据库里的 Token 删了。清除走显式按钮。
  const handleSaveToken = useCallback(async () => {
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      setTokenError('');
      return;
    }
    if (!trimmedToken.startsWith('pst-')) {
      setTokenError('Token 格式不正确 (应以 pst- 开头)');
      return;
    }
    setTokenError('');
    try {
      // POST 回的就是最新状态,不用再查一次。
      const status = await sidecarApi.saveToken(trimmedToken);
      markApiTokenConfigured(true);
      setToken('');
      setTokenStatus(status);
      setTokenStatusUnreachable(false);
      setShowSaveToast(true);
      setTimeout(() => setShowSaveToast(false), 1500);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : 'Token 保存失败');
    }
  }, [token]);

  const handleClearToken = useCallback(async () => {
    setTokenError('');
    try {
      const status = await sidecarApi.clearToken();
      markApiTokenConfigured(false);
      setToken('');
      setTokenStatus(status);
      setTokenStatusUnreachable(false);
      setShowSaveToast(true);
      setTimeout(() => setShowSaveToast(false), 1500);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : 'Token 清除失败');
    }
  }, []);

  if (!isOpen) return null;


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
              {activeTab === 'watermark' && <Stamp className="w-4 h-4" />}
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
              <ThemeSettingsSection
                settings={settings}
                isThemeDropdownOpen={isThemeDropdownOpen}
                setIsThemeDropdownOpen={setIsThemeDropdownOpen}
                updateSettingsImmediate={updateSettingsImmediate}
              />
            )}
            {activeTab === 'ai' && (
              <AISettingsSection
                settings={settings}
                updateSettingsLocal={updateSettingsLocal}
                updateSettingsImmediate={updateSettingsImmediate}
                saveSettings={saveSettings}
              />
            )}
            {activeTab === 'autocomplete' && (
              <AutocompleteSettingsSection
                settings={settings}
                updateSettingsImmediate={updateSettingsImmediate}
              />
            )}
            {activeTab === 'shortcut' && (
              <ShortcutSettingsSection
                settings={settings}
                updateSettingsImmediate={updateSettingsImmediate}
              />
            )}
            {activeTab === 'login' && (
              <LoginSettingsSection
                settings={settings}
                updateSettingsImmediate={updateSettingsImmediate}
                botAuthState={botAuthState}
                authCodeCountdown={authCodeCountdown}
                isGeneratingCode={isGeneratingCode}
                copied={copied}
                handleGenerateAuthCode={handleGenerateAuthCode}
                handleBotLogout={handleBotLogout}
                handleCopyCommand={handleCopyCommand}
                token={token}
                setToken={setToken}
                showToken={showToken}
                setShowToken={setShowToken}
                tokenError={tokenError}
                setTokenError={setTokenError}
                handleSaveToken={handleSaveToken}
                tokenStatus={tokenStatus}
                tokenStatusUnreachable={tokenStatusUnreachable}
                handleClearToken={handleClearToken}
              />
            )}
            {activeTab === 'watermark' && (
              <WatermarkSettingsSection
                settings={settings}
                updateSettingsImmediate={updateSettingsImmediate}
                onClose={onClose}
              />
            )}
            {activeTab === 'backup' && (
              <BackupSettingsSection
                backupStatus={backupStatus}
                setBackupStatus={setBackupStatus}
                dataCounts={dataCounts}
                exportOptions={exportOptions}
                setExportOptions={setExportOptions}
                isExporting={isExporting}
                setIsExporting={setIsExporting}
                isImporting={isImporting}
                setIsImporting={setIsImporting}
                importPreview={importPreview}
                setImportPreview={setImportPreview}
                importData={importData}
                setImportData={setImportData}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
