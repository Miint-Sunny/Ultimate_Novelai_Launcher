import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, LogIn, LogOut, Menu, Settings, User, Users, Wrench } from 'lucide-react';
import { ScrollText } from 'lucide-react';
import { openChangelogAll } from '../ChangelogModal';
import type { AnlasInfo } from '../../services/novelai';
import {
  MODEL_PROVIDERS,
  NAI_MODELS,
  type ModelOption,
  type ModelProvider,
} from '../generation/modelResolutionOptions';

interface SidebarHeaderProps {
  selectedModel: ModelOption;
  onSelectedModelChange: (model: ModelOption) => void;
  anlasInfo: AnlasInfo | null;
  isLoadingAnlas: boolean;
  onRefreshAnlas: () => void;
  onlineCount: number;
  isBotAuthorized: boolean;
  onLogout?: () => void;
  openLoginModal: () => void;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
  onOpenTools: () => void;
}

export function SidebarHeader({
  selectedModel,
  onSelectedModelChange,
  anlasInfo,
  isLoadingAnlas,
  onRefreshAnlas,
  onlineCount,
  isBotAuthorized,
  onLogout,
  openLoginModal,
  onOpenProfile,
  onOpenSettings,
  onOpenTools,
}: SidebarHeaderProps) {
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [modelProvider, setModelProvider] = useState<ModelProvider>('nai');
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isModelDropdownOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isModelDropdownOpen]);

  const handleModelChange = (model: ModelOption) => {
    onSelectedModelChange(model);
    setIsModelDropdownOpen(false);
  };

  const closeMenu = () => setIsMenuOpen(false);

  return (
    <div className="p-3 pb-0 relative z-50 shrink-0 flex gap-2">
      <div className="flex-1 flex gap-2 min-w-0">
        <div className="relative flex-1 min-w-0" ref={modelDropdownRef}>
          <button
            className={`w-full bg-nai-input h-[38px] px-3 rounded flex items-center justify-between text-left group transition-all duration-200 border ${
              isModelDropdownOpen
                ? 'border-nai-accent/50 bg-gray-700/60'
                : 'border-gray-700 hover:border-gray-600 hover:bg-gray-700/60'
            }`}
            onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
          >
            <div className="min-w-0 flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-nai-accent shrink-0" />
              <div className="font-bold text-white text-sm truncate">{selectedModel.name}</div>
            </div>
            <ChevronDown className={`w-4 h-4 text-gray-400 group-hover:text-white transition-transform duration-200 shrink-0 ml-2 ${isModelDropdownOpen ? 'rotate-180 text-nai-accent' : ''}`} />
          </button>

          {isModelDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-1.5 bg-nai-panel/95 backdrop-blur-xl border border-gray-700/70 rounded shadow-2xl shadow-black/50 overflow-hidden z-50 animate-fade-in">
              <div className="flex gap-0.5 p-0.5 mx-1.5 mt-1.5 mb-0.5 bg-black/30 rounded-md">
                {MODEL_PROVIDERS.map((provider) => (
                  <button
                    key={provider.id}
                    disabled={provider.id === 'sd'}
                    className={`flex-1 px-2 py-1 text-[11px] font-semibold rounded whitespace-nowrap transition-all duration-150 ${provider.id === 'sd'
                      ? 'text-gray-600 cursor-not-allowed'
                      : modelProvider === provider.id
                        ? 'bg-nai-accent/15 text-nai-accent'
                        : 'text-gray-400 hover:text-white hover:bg-white/5'
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setModelProvider(provider.id);
                      if (!provider.models.find((model) => model.id === selectedModel.id)) {
                        onSelectedModelChange(provider.models[0]);
                      }
                    }}
                  >
                    {provider.id === 'sd' ? 'SD' : provider.label}
                  </button>
                ))}
              </div>
              <div className="px-1 pb-1">
                {(MODEL_PROVIDERS.find((provider) => provider.id === modelProvider)?.models || NAI_MODELS).map((model, index, list) => {
                  const isSelected = selectedModel.id === model.id;
                  // 分组小标题:官方自 V5 起把 4.5 及以下整体归为 Legacy。
                  // 只在分组变化处插一行,列表本身仍是扁平的。
                  const groupLabel =
                    model.group && model.group !== list[index - 1]?.group
                      ? model.group === 'new'
                        ? '最新'
                        : '旧版'
                      : null;
                  return (
                    <div key={model.id}>
                      {groupLabel && (
                        <div className="px-2 pt-1.5 pb-0.5 text-[10px] text-gray-500 font-bold uppercase tracking-wider">
                          {groupLabel}
                        </div>
                      )}
                    <button
                      className={`relative w-full pl-2.5 pr-2 py-1.5 rounded-md text-left transition-all duration-150 flex items-center justify-between gap-2 ${
                        isSelected
                          ? 'bg-nai-accent/10 text-nai-accent'
                          : 'text-white hover:bg-white/5'
                      }`}
                      onClick={() => handleModelChange(model)}
                    >
                      {isSelected && (
                        <span className="absolute left-0.5 top-1/2 -translate-y-1/2 w-0.5 h-4 bg-nai-accent rounded-full" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold truncate leading-tight">{model.name}</div>
                        <div className={`text-[11px] truncate mt-0.5 leading-tight ${isSelected ? 'text-nai-accent/70' : 'text-gray-400'}`}>
                          {model.desc}
                        </div>
                      </div>
                      {isSelected && <Check className="w-3.5 h-3.5 shrink-0 text-nai-accent" />}
                    </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div
          className="flex items-center gap-3 bg-nai-input hover:bg-gray-700 px-3 rounded border border-gray-700 h-[38px] shrink-0 transition-all group cursor-pointer min-w-[100px] justify-between"
          onClick={onRefreshAnlas}
          title="点击刷新"
        >
          <div className="flex flex-col items-start justify-center h-full">
            <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider leading-none mb-0.5 group-hover:text-yellow-500/70 transition-colors">Anlas</span>
            <span className={`font-mono font-bold text-sm group-hover:text-yellow-400 transition-colors leading-none ${isLoadingAnlas ? 'text-gray-500' : 'text-gray-300'}`}>
              {anlasInfo ? (anlasInfo.fixedTrainingStepsLeft + anlasInfo.purchasedTrainingSteps).toLocaleString() : '—'}
            </span>
          </div>
          <div className="flex items-center justify-center">
            <span className={`text-2xl filter drop-shadow-[0_0_8px_rgba(234,179,8,0.3)] -mt-1.5 inline-block ${isLoadingAnlas ? 'animate-spin' : 'group-hover:scale-110 transition-transform'}`} style={isLoadingAnlas ? { animationDuration: '0.8s' } : undefined}>💎</span>
          </div>
        </div>
      </div>

      <div className="relative">
        <button
          className={`h-full aspect-square bg-nai-input hover:bg-gray-700 rounded flex items-center justify-center transition-colors border border-gray-700 ${isMenuOpen ? 'bg-gray-700 text-white' : 'text-gray-400'}`}
          onClick={() => setIsMenuOpen(!isMenuOpen)}
        >
          <Menu className="w-5 h-5" />
        </button>

        {isMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={closeMenu} />
            <div className="absolute top-full right-0 mt-2 w-48 bg-nai-panel border border-gray-700 rounded-lg shadow-xl overflow-hidden z-50">
              <div className="p-2 border-b border-gray-800">
                <div className="flex items-center justify-between px-2 py-1">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-green-500" />
                    <span className="text-sm text-gray-300">在线人数</span>
                  </div>
                  <span className="font-mono font-bold text-sm text-green-400">{onlineCount}</span>
                </div>
              </div>
              <div className="p-2 border-b border-gray-800">
                <div className="text-xs text-gray-500 font-bold mb-1 px-2">账户</div>
                <button
                  className="w-full text-left px-2 py-1.5 rounded text-sm text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2 transition-colors"
                  onClick={() => { onOpenProfile(); closeMenu(); }}
                >
                  <User className="w-4 h-4" /> 个人中心
                </button>
                <button
                  className="w-full text-left px-2 py-1.5 rounded text-sm text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2 transition-colors"
                  onClick={() => { onOpenSettings(); closeMenu(); }}
                >
                  <Settings className="w-4 h-4" /> 设置
                </button>
                <button
                  className="w-full text-left px-2 py-1.5 rounded text-sm text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2 transition-colors"
                  onClick={() => { onOpenTools(); closeMenu(); }}
                >
                  <Wrench className="w-4 h-4" /> 工具
                </button>
                <button
                  className="w-full text-left px-2 py-1.5 rounded text-sm text-gray-300 hover:bg-gray-800 hover:text-white flex items-center gap-2 transition-colors"
                  onClick={() => { openChangelogAll(); closeMenu(); }}
                >
                  <ScrollText className="w-4 h-4" /> 更新日志
                </button>
              </div>
              <div className="p-2">
                <button
                  className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${isBotAuthorized
                    ? 'text-red-400 hover:bg-red-900/20 hover:text-red-300'
                    : 'text-nai-accent hover:bg-nai-accent/10 hover:text-nai-accent'
                  }`}
                  onClick={() => {
                    closeMenu();
                    if (isBotAuthorized) {
                      onLogout?.();
                    }
                    openLoginModal();
                  }}
                >
                  {isBotAuthorized ? <LogOut className="w-4 h-4" /> : <LogIn className="w-4 h-4" />}
                  {isBotAuthorized ? '退出登录' : '登录'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
