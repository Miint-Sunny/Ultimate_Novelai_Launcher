import React from 'react';
import { type AppSettings } from '../../services/localLibrary';
import { LlmApiSettings } from './LlmApiSettings';

interface AISettingsSectionProps {
  settings: AppSettings;
  updateSettingsLocal: (updates: Partial<AppSettings>) => void;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
  saveSettings: () => void;
}

export const AISettingsSection: React.FC<AISettingsSectionProps> = ({
  settings,
  updateSettingsLocal,
  updateSettingsImmediate,
  saveSettings,
}) => {
  return (
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

      {/* 浏览器直连 sidecar —— 为将来上云 / 局域网,也方便在浏览器里调试 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
          浏览器直连 sidecar
        </label>
        <input
          type="text"
          value={settings.sidecarUrl}
          onChange={(e) => updateSettingsLocal({ sidecarUrl: e.target.value })}
          onBlur={saveSettings}
          placeholder="留空 = 用默认端口；例如 http://127.0.0.1:62017"
          className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none transition-colors"
        />
        <p className="text-xs text-gray-500 mt-2">
          只对<strong className="text-gray-400">浏览器</strong>生效：桌面 app 从 Tauri 握手拿端点，不看这一项。
          sidecar 每次启动都换端口，填上它浏览器才找得到。
        </p>
        <p className="text-xs text-gray-500 mt-1">
          填了仍然要输 sidecar 终端显示的 6 位配对码 —— 这一项只解决「找得到」，
          不会绕开鉴权。sidecar 也只监听本机回环，填局域网地址连不上。
        </p>
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

      {/* LLM 接口配置（放在最底部） */}
      <LlmApiSettings />
    </div>
  );
};
