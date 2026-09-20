import React from 'react';
import { Bot, Key, CheckCircle, AlertTriangle, Info, Loader2, Copy, Check, Eye, EyeOff } from 'lucide-react';
import { type AppSettings } from '../../services/localLibrary';
import { type BotAuthState } from '../../services/botService';
import { type TokenStatus } from '../../api/sidecar';

type StatusTone = 'ok' | 'warn' | 'muted';

export interface TokenStatusView {
  tone: StatusTone;
  title: string;
  detail: string;
  /** 只有存在凭据库里的 Token 才能从这里清;环境变量的清不掉,没配置的没得清。 */
  canClear: boolean;
}

const TONE_TEXT: Record<StatusTone, string> = { ok: 'text-green-400', warn: 'text-amber-400', muted: 'text-gray-400' };

/** 把 sidecar 的 token 状态翻成一行能读的话。环境变量优先于凭据库(sidecar/config.py)。 */
export function describeTokenStatus(status: TokenStatus | null, unreachable: boolean): TokenStatusView {
  if (unreachable) return { tone: 'muted', title: '无法读取 Token 状态', detail: '本地服务未连接;连上后重新打开设置。', canClear: false };
  if (!status) return { tone: 'muted', title: '读取中…', detail: '正在向本地服务查询 Token 状态。', canClear: false };
  const mock = status.mock_generation ? ';当前开着模拟出图,不会真的请求 NovelAI' : '';
  if (status.configured && status.source === 'environment') {
    return { tone: 'ok', title: '已配置 · 环境变量', detail: `来自 NAI_TOKEN 环境变量,优先于凭据库,在这里填写不会生效${mock}。`, canClear: false };
  }
  if (status.configured) {
    return { tone: 'ok', title: '已配置 · 系统凭据库', detail: `Token 存在系统凭据库里,前端不保存明文${mock}。`, canClear: true };
  }
  if (status.mock_generation) {
    return { tone: 'warn', title: '未配置 · 模拟出图', detail: '当前开着模拟出图,不会真的请求 NovelAI;填入 Token 也不会用到。', canClear: false };
  }
  return { tone: 'muted', title: '未配置', detail: '填入 Token 后会写进系统凭据库。', canClear: false };
}

const StatusIcon: React.FC<{ tone: StatusTone }> = ({ tone }) => {
  const cls = `w-4 h-4 mt-0.5 shrink-0 ${TONE_TEXT[tone]}`;
  if (tone === 'ok') return <CheckCircle className={cls} />;
  if (tone === 'warn') return <AlertTriangle className={cls} />;
  return <Info className={cls} />;
};

interface LoginSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
  botAuthState: BotAuthState;
  authCodeCountdown: number;
  isGeneratingCode: boolean;
  copied: boolean;
  handleGenerateAuthCode: () => void;
  handleBotLogout: () => void;
  handleCopyCommand: () => void;
  token: string;
  setToken: (value: string) => void;
  showToken: boolean;
  setShowToken: (value: boolean) => void;
  tokenError: string;
  setTokenError: (value: string) => void;
  handleSaveToken: () => void;
  tokenStatus: TokenStatus | null;
  tokenStatusUnreachable: boolean;
  handleClearToken: () => void;
}

export const LoginSettingsSection: React.FC<LoginSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
  botAuthState,
  authCodeCountdown,
  isGeneratingCode,
  copied,
  handleGenerateAuthCode,
  handleBotLogout,
  handleCopyCommand,
  token,
  setToken,
  showToken,
  setShowToken,
  tokenError,
  setTokenError,
  handleSaveToken,
  tokenStatus,
  tokenStatusUnreachable,
  handleClearToken,
}) => {
  const tokenView = describeTokenStatus(tokenStatus, tokenStatusUnreachable);
  return (
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
        <div className="flex items-start justify-between gap-3 mb-3" data-testid="token-status" data-tone={tokenView.tone}>
          <div className="flex items-start gap-2 min-w-0">
            <StatusIcon tone={tokenView.tone} />
            <div className="min-w-0">
              <div className={`text-sm font-medium ${TONE_TEXT[tokenView.tone]}`}>{tokenView.title}</div>
              <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{tokenView.detail}</div>
            </div>
          </div>
          {tokenView.canClear && (
            <button
              type="button"
              onClick={handleClearToken}
              className="shrink-0 px-3 py-1.5 bg-red-900/50 text-red-400 rounded-lg hover:bg-red-900/70 text-xs transition-colors"
            >
              清除 Token
            </button>
          )}
        </div>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setTokenError('');
            }}
            onBlur={handleSaveToken}
            placeholder={tokenStatus?.configured ? '已配置;输入新 Token 可替换' : 'pst-...'}
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
        <p className="text-xs text-gray-500 mt-2">
          通过抓包或者 NovelAI 网站获取你的 API Token。填入后会存进系统凭据库,前端不保存明文;留空不会清除已存的 Token。
        </p>
      </div>
    </div>
  );
};
