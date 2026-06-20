import React from 'react';
import type { AppSettings } from '../../../services/localLibrary';
import { MobileSettingsToggle } from './MobileSettingsToggle';
import { LlmApiSettings } from '../../settings/LlmApiSettings';

interface MobileAISettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
  updateSettingsLocal: (updates: Partial<AppSettings>) => void;
  saveSettings: () => void;
}

export const MobileAISettingsSection: React.FC<MobileAISettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
  updateSettingsLocal,
  saveSettings,
}) => (
  <div className="p-4 space-y-5">
    <div className="flex items-center justify-between p-4 bg-gray-800 rounded-xl">
      <div>
        <div className="text-sm font-medium text-white">启用队列模式</div>
        <p className="text-xs text-gray-500 mt-1">多用户共享 Token 时按队列顺序生成</p>
      </div>
      <MobileSettingsToggle
        enabled={settings.queueEnabled}
        onChange={() => updateSettingsImmediate({ queueEnabled: !settings.queueEnabled })}
      />
    </div>

    <div>
      <label className="text-xs text-gray-500 uppercase tracking-wider mb-3 block">超分服务</label>
      <div className="rounded-xl border border-gray-700 bg-gray-800 px-4 py-3">
        <p className="text-sm text-white">Sidecar 托管</p>
        <p className="mt-1 text-xs text-gray-500">
          前端不再下载或运行 Real-ESRGAN / ONNX 模型。
        </p>
      </div>
    </div>

    <div>
      <label className="text-xs text-gray-500 uppercase tracking-wider mb-3 block">AI 对话上下文轮数</label>
      <div className="grid grid-cols-5 gap-2">
        {[10, 20, 30, 40, 50].map((option) => (
          <button
            key={option}
            onClick={() => updateSettingsImmediate({ aiMaxContextLength: option })}
            className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${settings.aiMaxContextLength === option
              ? 'bg-nai-accent/20 text-nai-accent border-2 border-nai-accent'
              : 'bg-gray-800 text-gray-400 border-2 border-gray-700'
              }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>

    <div className="flex items-center justify-between p-4 bg-gray-800 rounded-xl">
      <div>
        <div className="text-sm font-medium text-white">启用防截断功能</div>
        <p className="text-xs text-gray-500 mt-1">减少 AI 输出被截断的情况</p>
      </div>
      <MobileSettingsToggle
        enabled={settings.aiPrisonBreakEnabled}
        onChange={() => updateSettingsImmediate({ aiPrisonBreakEnabled: !settings.aiPrisonBreakEnabled })}
      />
    </div>

    <div>
      <label className="text-xs text-gray-500 uppercase tracking-wider mb-3 block">服务端</label>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <button
          onClick={() => updateSettingsImmediate({ serverMode: 'public', backendUrl: '', queueServerUrl: '' })}
          className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors ${settings.serverMode === 'public'
            ? 'bg-nai-accent/20 text-nai-accent border-2 border-nai-accent'
            : 'bg-gray-800 text-gray-400 border-2 border-gray-700'
            }`}
        >
          公共服务端
        </button>
        <button
          onClick={() => updateSettingsImmediate({ serverMode: 'custom' })}
          className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors ${settings.serverMode === 'custom'
            ? 'bg-nai-accent/20 text-nai-accent border-2 border-nai-accent'
            : 'bg-gray-800 text-gray-400 border-2 border-gray-700'
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
            onChange={(event) => updateSettingsLocal({ backendUrl: event.target.value })}
            onBlur={saveSettings}
            placeholder="例如: http://localhost:7860"
            className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none"
          />
          <p className="text-xs text-gray-500 mt-2">数据 API、标签补全、排队、Bot 授权等所有后端服务地址</p>
        </>
      )}
      {settings.serverMode === 'public' && (
        <p className="text-xs text-gray-500">使用当前页面地址作为服务端</p>
      )}
    </div>

    {/* LLM 接口配置（放在最底部） */}
    <LlmApiSettings />
  </div>
);
