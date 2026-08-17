import React, { useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  Info,
  LogIn,
  LogOut,
  Palette,
  Settings,
  User,
  Wrench,
  X,
} from 'lucide-react';
import packageJson from '../../../../package.json';
import { useAuth } from '../../../contexts/AuthContext';
import {
  getAppSettings,
  saveAppSettings,
  type AppSettings,
} from '../../../services/localLibrary';
import { getGlass, setGlass, type GlassId } from '../../../services/theme';
import { getShellMode, setShellMode, type ShellMode } from '../../../services/shellMode';
import { registerBackHandler } from '../MobileLayout';
import { MobileSettingsPage } from '../MobileSettingsPage';
import { MobileToolsPage } from '../MobileToolsPage';
import { MobileThemeSettingsSection } from '../settings/MobileThemeSettingsSection';

type MineGroup = 'appearance' | 'tools' | 'settings' | 'about' | null;

const GLASS_OPTIONS: { id: GlassId; label: string }[] = [
  { id: 'clear', label: '清透' },
  { id: 'standard', label: '标准' },
  { id: 'tinted', label: '着色' },
  { id: 'solid', label: '实底' },
];

// 界面模式(P7-1):分页壳(默认)/旧标签壳;消费 P3 的 shellMode flag
const SHELL_MODE_OPTIONS: { id: ShellMode; label: string }[] = [
  { id: 'pager', label: '分页' },
  { id: 'tabs', label: '标签' },
];

interface MobileMineSheetProps {
  isOpen: boolean;
  onClose: () => void;
  onLogout?: () => void;
}

// 「我的」sheet(P3):0.92 屏底部 sheet,沿用现有 sheet 动画/圆角/遮罩约定。
// 内容组件全部复用现有:主题 section(P0 皮肤)、MobileToolsPage、MobileSettingsPage;
// 新增仅为:账户状态卡(组装)、玻璃浓度选择器(getGlass/setGlass 四档)、关于卡。
// 返回语义:子页打开 → 先回分组列表,再按一次 → 关 sheet(注册到共享 back 注册表)。
export const MobileMineSheet: React.FC<MobileMineSheetProps> = ({ isOpen, onClose, onLogout }) => {
  const { isAuthenticated, isBotAuthorized, openLoginModal } = useAuth();
  const [activeGroup, setActiveGroup] = useState<MineGroup>(null);
  const [settings, setSettings] = useState<AppSettings>(() => getAppSettings());
  const [glass, setGlassState] = useState<GlassId>(() => getGlass());
  const [shellMode, setShellModeState] = useState<ShellMode>(() => getShellMode());
  const [isReloading, setIsReloading] = useState(false);

  // sheet 每次打开回到分组列表并重读设置/玻璃浓度/界面模式(组件常驻,状态需刷新)
  React.useEffect(() => {
    if (isOpen) {
      setActiveGroup(null);
      setSettings(getAppSettings());
      setGlassState(getGlass());
      setShellModeState(getShellMode());
    }
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(() => {
      if (activeGroup) {
        setActiveGroup(null);
        return true;
      }
      onClose();
      return true;
    });
  }, [isOpen, activeGroup, onClose]);

  if (!isOpen) return null;

  const updateSettingsImmediate = (updates: Partial<AppSettings>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    saveAppSettings(next);
  };

  const handleSelectGlass = (id: GlassId) => {
    setGlass(id);
    setGlassState(id);
  };

  // 界面模式切换:MobileLayout 只在启动时读一次壳模式(services/shellMode.ts 头部约定),
  // 持久化后需整页重载才生效;短暂停留让用户看到「已切换」反馈再 reload
  const handleSelectShellMode = (mode: ShellMode) => {
    if (mode === shellMode || isReloading) return;
    setShellMode(mode);
    setShellModeState(mode);
    setIsReloading(true);
    window.setTimeout(() => window.location.reload(), 600);
  };

  const groups: { id: Exclude<MineGroup, null>; name: string; desc: string; icon: React.FC<{ className?: string }>; color: string }[] = [
    { id: 'appearance', name: '外观', desc: '皮肤与玻璃浓度', icon: Palette, color: 'text-nai-accent' },
    { id: 'tools', name: '工具', desc: '权重换算 / 元数据', icon: Wrench, color: 'text-cyan-400' },
    { id: 'settings', name: '设置', desc: 'AI 与后端 / 预设 / 补全 / 备份等', icon: Settings, color: 'text-green-400' },
    { id: 'about', name: '关于', desc: `v${packageJson.version}`, icon: Info, color: 'text-gray-400' },
  ];

  const renderGroupContent = () => {
    switch (activeGroup) {
      case 'appearance':
        return (
          <div className="wide-touch-column flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            <MobileThemeSettingsSection
              settings={settings}
              updateSettingsImmediate={updateSettingsImmediate}
            />
            <section className="bg-nai-input rounded-xl border border-gray-700/50 p-4">
              <h3 className="text-sm font-medium text-white mb-1">玻璃浓度</h3>
              <p className="text-xs text-gray-500 mb-3">悬浮页栏与头像等玻璃材质的浓度档位</p>
              <div className="grid grid-cols-4 gap-2">
                {GLASS_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => handleSelectGlass(option.id)}
                    className={`py-2 rounded-lg text-sm transition-colors border ${
                      glass === option.id
                        ? 'bg-nai-accent/20 border-nai-accent/50 text-nai-accent'
                        : 'bg-gray-800 border-transparent text-gray-400 active:text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </section>

            {/* 界面模式(P7-1):分页(默认)/标签;切换后自动重新载入生效 */}
            <section className="bg-nai-input rounded-xl border border-gray-700/50 p-4">
              <h3 className="text-sm font-medium text-white mb-1">界面模式</h3>
              <p className="text-xs text-gray-500 mb-3">移动外壳形态,切换后自动重新载入生效</p>
              <div className="grid grid-cols-2 gap-2">
                {SHELL_MODE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    onClick={() => handleSelectShellMode(option.id)}
                    disabled={isReloading}
                    className={`py-2 rounded-lg text-sm transition-colors border ${
                      shellMode === option.id
                        ? 'bg-nai-accent/20 border-nai-accent/50 text-nai-accent'
                        : 'bg-gray-800 border-transparent text-gray-400 active:text-white'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              {isReloading && (
                <p className="text-xs text-nai-accent mt-2">已切换,正在重新载入…</p>
              )}
            </section>
          </div>
        );
      case 'tools':
        return (
          <div className="wide-touch-column flex-1 overflow-hidden flex flex-col">
            <MobileToolsPage />
          </div>
        );
      case 'settings':
        return (
          <div className="wide-touch-column flex-1 overflow-hidden flex flex-col">
            <MobileSettingsPage onLogout={onLogout} />
          </div>
        );
      case 'about':
        return (
          <div className="wide-touch-column flex-1 overflow-y-auto p-4">
            <section className="bg-nai-input rounded-xl border border-gray-700/50 p-4 flex flex-col gap-2">
              <div className="text-sm text-gray-300">Ultimate NovelAI Launcher</div>
              <div className="text-xs text-gray-500">版本 v{packageJson.version}</div>
              <div className="text-xs text-gray-500">移动端分页壳(P3)· vertical-redesign</div>
            </section>
          </div>
        );
      default:
        return null;
    }
  };

  const currentGroup = groups.find((group) => group.id === activeGroup);

  return (
    <>
      {/* 背景遮罩(与现有 sheet 约定一致) */}
      <div className="fixed inset-0 z-50 bg-black/60 animate-fade-in" onClick={onClose} />

      <div
        className="wide-touch-sheet fixed left-0 right-0 bottom-0 z-50 bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom flex flex-col"
        style={{ height: '92vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sheet grabber(P7-1,§4.3「Sheet」行):顶部居中小横条;
            两档 detent/下滑关闭不做,保持现有高度与关闭语义 */}
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-gray-600" />

        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 flex-shrink-0">
          {activeGroup ? (
            <button
              onClick={() => setActiveGroup(null)}
              title="返回分组列表"
              className="p-2 -ml-2 text-gray-400 active:scale-95 transition-all"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-9" />
          )}
          <h1 className="text-base font-bold text-white">{currentGroup ? currentGroup.name : '我的'}</h1>
          <button
            onClick={onClose}
            title="关闭"
            className="p-2 -mr-2 text-gray-400 active:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {activeGroup === null ? (
          <div className="wide-touch-column flex-1 overflow-y-auto p-4 flex flex-col gap-4">
            {/* 账户/后端模式状态卡 */}
            <section className="bg-nai-input rounded-xl border border-gray-700/50 p-4 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-nai-accent/20 border border-nai-accent/50 flex items-center justify-center">
                  <User className="w-5 h-5 text-nai-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white">
                    {isBotAuthorized ? 'Bot 账号已授权' : isAuthenticated ? '已登录' : '未登录'}
                  </div>
                  <div className="text-xs text-gray-500 flex items-center gap-1">
                    <Bot className="w-3 h-3" />
                    后端模式:{settings.loginMode === 'bot' ? 'Bot 云服务' : '本地 sidecar'}
                  </div>
                </div>
              </div>
              <button
                onClick={() => {
                  if (isBotAuthorized) {
                    if (onLogout) onLogout();
                    openLoginModal();
                  } else {
                    openLoginModal();
                  }
                }}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg border text-sm font-medium transition-colors ${
                  isBotAuthorized
                    ? 'bg-red-500/20 text-red-400 border-red-500/50'
                    : 'bg-nai-accent/20 text-nai-accent border-nai-accent/50'
                }`}
              >
                {isBotAuthorized ? <LogOut className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
                {isBotAuthorized ? '退出登录' : '登录'}
              </button>
            </section>

            {/* 分组列表(P7-1:iOS grouped inset list 形态——单圆角容器、
                行分隔线自标题对齐处缩进、行高紧凑;沿用现有类名体系,不引新色) */}
            <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden">
              {groups.map((group, index) => (
                <div key={group.id}>
                  {index > 0 && <div className="h-px bg-gray-700/50 ml-[46px]" />}
                  <button
                    onClick={() => setActiveGroup(group.id)}
                    className="w-full flex items-center justify-between px-3.5 py-3 active:bg-gray-800/50 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <group.icon className={`w-5 h-5 ${group.color}`} />
                      <div className="text-left">
                        <div className="font-medium text-white text-sm">{group.name}</div>
                        <div className="text-xs text-gray-500">{group.desc}</div>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-gray-500" />
                  </button>
                </div>
              ))}
            </div>

            <div className="text-center text-xs text-gray-600 flex items-center justify-center gap-1 pb-2">
              <Check className="w-3 h-3" />
              设置内容即时生效并自动保存
            </div>
          </div>
        ) : (
          renderGroupContent()
        )}
      </div>
    </>
  );
};
