import React from 'react';
import {
  Bot,
  Check,
  CheckCircle,
  Copy,
  Eye,
  EyeOff,
  Key,
  Loader2,
} from 'lucide-react';
import type { AppSettings } from '../../../services/localLibrary';
import type { BotAuthState } from '../../../services/botService';

interface MobileLoginSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
  botAuthState: BotAuthState;
  authCodeCountdown: number;
  isGeneratingCode: boolean;
  copied: boolean;
  onGenerateAuthCode: () => void;
  onBotLogout: () => void;
  onCopyCommand: () => void;
  token: string;
  setToken: (token: string) => void;
  tokenError: string;
  setTokenError: (error: string) => void;
  showToken: boolean;
  setShowToken: (show: boolean) => void;
  onSaveToken: () => void;
}

export const MobileLoginSettingsSection: React.FC<MobileLoginSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
  botAuthState,
  authCodeCountdown,
  isGeneratingCode,
  copied,
  onGenerateAuthCode,
  onBotLogout,
  onCopyCommand,
  token,
  setToken,
  tokenError,
  setTokenError,
  showToken,
  setShowToken,
  onSaveToken,
}) => (
  <div className="p-4 space-y-4">
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
            onClick={onBotLogout}
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
                  <button onClick={onCopyCommand} className="p-2 hover:bg-gray-700/50 rounded-lg transition-colors">
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
              onClick={onGenerateAuthCode}
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
          onBlur={onSaveToken}
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
