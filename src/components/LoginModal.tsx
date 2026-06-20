import React, { useState, useEffect, useCallback } from 'react';
import {
  Key,
  Bot,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Users,
  HelpCircle,
  X,
  FlaskConical,
  Lock,
  Database,
  Palette,
  Image,
  Sparkles,
} from 'lucide-react';
import {
  markApiTokenConfigured,
  saveUserId,
  saveAppSettings,
  getAppSettings,
} from '../services/localLibrary';
import { copyToClipboard } from '../utils/clipboard';
import { generateSecureUserId } from '../utils/security';
import { botService, type BotAuthState } from '../services/botService';
import { sidecarApi } from '../api/sidecar';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLogin: () => void;
  forced?: boolean;  // 强制登录模式：不可关闭
}

/**
 * 登录流程：
 * Step 1: Bot 授权（必选入口，提示不授权的后果）
 * Step 2: 选择生成方式（API Token / Bot 生成）
 */
export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onLogin, forced = false }) => {
  // 'bot-auth': 第一步 Bot 授权
  // 'select-gen': 第二步 选择生成方式
  // 'token-input': 输入 API Token
  const [step, setStep] = useState<'bot-auth' | 'select-gen' | 'token-input'>('bot-auth');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);

  // 轻量成功提示状态
  const [showSuccess, setShowSuccess] = useState(false);

  // 视频教程弹窗状态
  const [showTutorialVideo, setShowTutorialVideo] = useState(false);

  // Bot授权状态
  const [botAuthState, setBotAuthState] = useState<BotAuthState>(
    botService.getAuthState()
  );
  const [authCodeCountdown, setAuthCodeCountdown] = useState(0);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);

  // Bot 授权已完成标记（用于流程推进）
  const [botAuthorized, setBotAuthorized] = useState(false);

  // 是否可关闭：非强制模式下可关闭
  const canClose = !forced;

  // 测试后门点击计数
  const [devClickCount, setDevClickCount] = useState(0);

  // 加载排队模式设置
  useEffect(() => {
    const settings = getAppSettings();
    setQueueEnabled(settings.queueEnabled);
  }, []);

  // 重置状态当弹窗打开时
  useEffect(() => {
    if (isOpen) {
      setStep('bot-auth');
      setToken('');
      setError('');
      setIsProcessing(false);
      setShowSuccess(false);
      setShowTutorialVideo(false);
      setBotAuthorized(false);
    }
  }, [isOpen]);

  // 显示成功提示后快速关闭
  const handleSuccess = useCallback(() => {
    setShowSuccess(true);
    setTimeout(() => {
      onLogin();
    }, 600);
  }, [onLogin]);

  // 测试后门：快速点击5次进入
  const handleDevClick = useCallback(() => {
    const newCount = devClickCount + 1;
    setDevClickCount(newCount);

    if (newCount >= 5) {
      // 保存测试模式设置
      const settings = getAppSettings();
      saveAppSettings({ ...settings, loginMode: 'token', queueEnabled: false });
      markApiTokenConfigured(true);
      saveUserId('dev-test-user');
      handleSuccess();
    }

    // 3秒后重置计数
    setTimeout(() => {
      setDevClickCount(0);
    }, 3000);
  }, [devClickCount, handleSuccess]);

  const handleTokenLogin = async () => {
    const trimmedToken = token.trim();
    if (trimmedToken) {
      if (!trimmedToken.startsWith('pst-')) {
        setError('Token 格式不正确 (应以 pst- 开头)');
        return;
      }

      try {
        setIsProcessing(true);
        await sidecarApi.saveToken(trimmedToken);
        markApiTokenConfigured(true);

        const userId = await generateSecureUserId(trimmedToken);
        saveUserId(userId);

        const settings = getAppSettings();
        saveAppSettings({ ...settings, loginMode: 'token', queueEnabled });

        handleSuccess();
      } catch (err) {
        console.error('Login error:', err);
        setError(`登录处理失败：${err instanceof Error ? err.message : String(err)}`);
        setIsProcessing(false);
      }
    }
  };

  // 监听Bot服务状态变化
  useEffect(() => {
    const unsubscribe = botService.addEventListener((authState) => {
      setBotAuthState(authState);

      if (authState.isAuthorized && !botAuthorized) {
        setBotAuthorized(true);
        botService.saveSession();
        // Bot 授权成功后自动进入第二步
        setStep('select-gen');
        setError('');
      }
    });
    return unsubscribe;
  }, [botAuthorized]);

  // 授权码倒计时
  useEffect(() => {
    if (botAuthState.authCodeExpires) {
      const updateCountdown = () => {
        const remaining = Math.max(
          0,
          Math.floor((botAuthState.authCodeExpires! - Date.now()) / 1000)
        );
        setAuthCodeCountdown(remaining);
        if (remaining <= 0) {
          setBotAuthState((prev) => ({
            ...prev,
            authCode: null,
            authCodeExpires: null,
          }));
        }
      };
      updateCountdown();
      const interval = setInterval(updateCountdown, 1000);
      return () => clearInterval(interval);
    }
  }, [botAuthState.authCodeExpires]);

  const handleGenerateAuthCode = useCallback(async () => {
    setIsGeneratingCode(true);
    setError('');
    const code = await botService.generateAuthCode();
    if (!code) {
      setError('无法连接到服务器，请确保后端服务已启动');
    }
    setIsGeneratingCode(false);
  }, []);

  const handleCopyCommand = useCallback(() => {
    if (botAuthState.authCode) {
      copyToClipboard(`web授权 ${botAuthState.authCode}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [botAuthState.authCode]);

  // 选择 Bot 生成方式
  const handleSelectBotGen = useCallback(() => {
    const settings = getAppSettings();
    saveAppSettings({ ...settings, loginMode: 'bot', queueEnabled: true });
    handleSuccess();
  }, [handleSuccess]);

  // 处理关闭
  const handleClose = useCallback(() => {
    if (canClose) {
      onClose();
    }
  }, [canClose, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in px-4">
      {/* 背景点击：仅在可关闭时响应 */}
      {canClose && <div className="absolute inset-0" onClick={handleClose} />}

      {/* 主登录卡片 */}
      <div
        className="relative z-10 w-full max-w-md p-5 sm:p-8 bg-nai-panel/95 backdrop-blur-xl rounded-2xl border border-gray-600/50 shadow-2xl shadow-black/50"
      >
        {/* 卡片内成功提示 */}
        {showSuccess && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-nai-panel/95 rounded-2xl animate-fade-in">
            <div className="flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center shadow-lg shadow-green-500/30 animate-success-scale">
                <CheckCircle2 className="w-8 h-8 text-white" />
              </div>
              <p className="mt-3 text-base font-medium text-white">登录成功</p>
            </div>
          </div>
        )}

        {/* 关闭按钮：仅在可关闭时显示 */}
        {canClose && (
          <button
            onClick={handleClose}
            className="absolute top-4 right-4 p-1.5 hover:bg-gray-700/50 rounded-lg transition-colors duration-200"
          >
            <X className="w-5 h-5 text-gray-400 hover:text-white" />
          </button>
        )}

        <div className="absolute -top-px left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-nai-accent/50 to-transparent" />

        {/* 标题 */}
        <h1
          onClick={handleDevClick}
          className="text-2xl sm:text-3xl font-bold text-center mb-1 text-nai-accent flex items-center justify-center gap-2 select-none cursor-default"
        >
          NovelAI Web UI
          <span className="text-[10px] sm:text-xs font-bold bg-nai-accent/20 text-nai-accent px-1.5 sm:px-2 py-0.5 rounded-full border border-nai-accent/30 uppercase tracking-wider leading-none">
            Beta
          </span>
          {/* 测试后门提示 */}
          {devClickCount > 0 && devClickCount < 5 && (
            <span className="absolute -top-2 right-4 text-[10px] text-gray-500 animate-fade-in">
              <FlaskConical className="w-3 h-3 inline mr-0.5" />
              {5 - devClickCount}
            </span>
          )}
        </h1>

        {/* 步骤指示器 */}
        <div className="flex items-center justify-center gap-2 mb-6 sm:mb-8">
          <div className={`flex items-center gap-1.5 text-xs ${step === 'bot-auth' ? 'text-nai-accent' : botAuthorized ? 'text-green-400' : 'text-gray-500'}`}>
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border ${step === 'bot-auth' ? 'border-nai-accent bg-nai-accent/20' : botAuthorized ? 'border-green-400 bg-green-400/20' : 'border-gray-600'
              }`}>
              {botAuthorized ? <Check className="w-3 h-3" /> : '1'}
            </div>
            <span className="hidden sm:inline">Bot 授权</span>
          </div>
          <div className={`w-6 h-px ${botAuthorized ? 'bg-green-400/50' : 'bg-gray-600'}`} />
          <div className={`flex items-center gap-1.5 text-xs ${step === 'select-gen' || step === 'token-input' ? 'text-nai-accent' : 'text-gray-500'}`}>
            <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border ${step === 'select-gen' || step === 'token-input' ? 'border-nai-accent bg-nai-accent/20' : 'border-gray-600'
              }`}>
              2
            </div>
            <span className="hidden sm:inline">生成方式</span>
          </div>
        </div>

        {/* ============= Step 1: Bot 授权 ============= */}
        {step === 'bot-auth' && (
          <div className="space-y-4 sm:space-y-5">
            {/* Bot 授权区域 */}
            <div className="space-y-4">
              <div className="text-center">
                <div className="inline-flex p-3 sm:p-4 bg-gray-800/50 rounded-2xl mb-3 sm:mb-4">
                  <Bot className="w-8 h-8 sm:w-10 sm:h-10 text-nai-accent" />
                </div>
                <h2 className="text-base sm:text-lg font-medium mb-1">
                  Bot 授权
                </h2>
                <p className="text-xs sm:text-sm text-gray-400">
                  生成授权码后，向 Bot 发送指令完成授权
                </p>
              </div>

              {error && (
                <p className="text-red-400 text-sm text-center">{error}</p>
              )}

              {botAuthState.authCode ? (
                /* 授权码已生成：显示授权码区域（替换警告提示） */
                <div className="space-y-4">
                  <div className="bg-gray-800/50 rounded-xl p-4 sm:p-6 text-center border border-gray-700/50">
                    <div className="text-base sm:text-xl font-mono font-bold text-nai-accent tracking-wider flex items-center justify-center gap-2 sm:gap-3 mb-2 flex-wrap">
                      <span className="bg-gray-900/50 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-sm sm:text-base">
                        web授权 {botAuthState.authCode}
                      </span>
                      <button
                        onClick={handleCopyCommand}
                        className="p-1.5 sm:p-2 hover:bg-gray-700/50 rounded-lg transition-all duration-300 hover:scale-105 active:scale-95"
                        title="复制指令"
                      >
                        {copied ? (
                          <Check className="w-4 h-4 sm:w-5 sm:h-5 text-green-400" />
                        ) : (
                          <Copy className="w-4 h-4 sm:w-5 sm:h-5 text-gray-400 hover:text-white" />
                        )}
                      </button>
                    </div>
                    <div className="text-xs text-gray-500">
                      {authCodeCountdown > 0 ? (
                        <>
                          剩余 {Math.floor(authCodeCountdown / 60)}:
                          {(authCodeCountdown % 60).toString().padStart(2, '0')}
                        </>
                      ) : (
                        '已过期'
                      )}
                    </div>
                  </div>

                  <div className="flex items-center justify-center gap-2 text-xs sm:text-sm text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin text-nai-accent" />
                    向 Bot 发送上方指令完成授权
                  </div>
                </div>
              ) : (
                /* 未生成授权码：显示警告提示 + 生成按钮 */
                <div className="space-y-4">
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-3 sm:p-3.5">
                    <div className="flex items-start gap-2 mb-2">
                      <Lock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                      <p className="text-xs sm:text-sm text-amber-200/90 font-medium">未授权将无法使用以下功能：</p>
                    </div>
                    <div className="space-y-1.5 pl-6">
                      <div className="flex items-center gap-2 text-[11px] sm:text-xs text-gray-400">
                        <Database className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                        <span>公共 OC 角色库</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] sm:text-xs text-gray-400">
                        <Palette className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                        <span>公共画师串库</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] sm:text-xs text-gray-400">
                        <Image className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                        <span>公共 Vibe 库</span>
                      </div>
                      <div className="flex items-center gap-2 text-[11px] sm:text-xs text-gray-400">
                        <Sparkles className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                        <span>Bot 代理生成图片</span>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleGenerateAuthCode}
                    disabled={isGeneratingCode}
                    className="w-full py-3 sm:py-3.5 bg-nai-accent hover:bg-nai-accent/90 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-medium transition-all duration-300 flex items-center justify-center text-black active:scale-[0.98]"
                  >
                    {isGeneratingCode ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        生成中...
                      </>
                    ) : (
                      <span>生成授权码</span>
                    )}
                  </button>
                </div>
              )}
            </div>

            {/* 跳过按钮 - 仅在未授权时可跳过到API Token */}
            {!botAuthorized && (
              <button
                onClick={() => {
                  setStep('token-input');
                  setError('');
                }}
                className="group w-full flex items-center justify-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors duration-300 pt-1"
              >
                <span>跳过授权登录</span>
                <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform duration-300" />
              </button>
            )}
          </div>
        )}

        {/* ============= Step 2: 选择生成方式 ============= */}
        {step === 'select-gen' && (
          <div className="space-y-4 sm:space-y-5">
            {/* 授权成功提示 */}
            <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3">
              <CheckCircle2 className="w-5 h-5 text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-green-300">Bot 授权成功</p>
                <p className="text-[11px] text-green-400/60">公共库访问权限已解锁</p>
              </div>
            </div>

            <p className="text-sm text-gray-400 text-center">
              请选择图片生成方式
            </p>

            <div className="space-y-3">
              {/* Bot 生成 */}
              <button
                onClick={handleSelectBotGen}
                className="group relative w-full flex items-center justify-between p-3.5 sm:p-4 bg-gray-800/50 hover:bg-gray-700/50 active:bg-gray-600/50 rounded-xl transition-all duration-300 border border-gray-600/50 hover:border-nai-accent/50"
              >
                <div className="relative flex items-center space-x-3">
                  <div className="p-2 sm:p-2.5 bg-gray-700/50 rounded-xl group-hover:bg-nai-accent/20 transition-colors duration-300">
                    <Bot className="w-5 h-5 text-nai-accent" />
                  </div>
                  <div className="text-left">
                    <span className="font-medium block text-sm sm:text-base">
                      Bot 共享账户
                    </span>
                    <span className="text-xs text-gray-500">
                      使用 Bot 共享账户生成图片，无需NovelAI账户
                    </span>
                  </div>
                </div>
                <ArrowLeft className="w-4 h-4 text-gray-500 rotate-180 group-hover:text-nai-accent group-hover:translate-x-1 transition-all duration-300" />
              </button>

              {/* API Token 生成 */}
              <button
                onClick={() => {
                  setStep('token-input');
                  setError('');
                }}
                className="group relative w-full flex items-center justify-between p-3.5 sm:p-4 bg-gray-800/50 hover:bg-gray-700/50 active:bg-gray-600/50 rounded-xl transition-all duration-300 border border-gray-600/50 hover:border-nai-accent/50"
              >
                <div className="relative flex items-center space-x-3">
                  <div className="p-2 sm:p-2.5 bg-gray-700/50 rounded-xl group-hover:bg-nai-accent/20 transition-colors duration-300">
                    <Key className="w-5 h-5 text-nai-accent" />
                  </div>
                  <div className="text-left">
                    <span className="font-medium block text-sm sm:text-base">
                      NovelAI API 生成
                    </span>
                    <span className="text-xs text-gray-500">
                      使用您自己的 NovelAI 账户 API
                    </span>
                  </div>
                </div>
                <ArrowLeft className="w-4 h-4 text-gray-500 rotate-180 group-hover:text-nai-accent group-hover:translate-x-1 transition-all duration-300" />
              </button>
            </div>
          </div>
        )}

        {/* ============= Token 输入页 ============= */}
        {step === 'token-input' && (
          <div className="space-y-5 sm:space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <label className="text-sm text-gray-400">
                  请输入您的 API Token
                </label>
                <button
                  onClick={() => setShowTutorialVideo(true)}
                  className="flex items-center gap-1 text-xs text-nai-accent hover:text-nai-accent/80 transition-colors duration-300"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  如何获取Token?
                </button>
              </div>
              <input
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setError('');
                }}
                className={`w-full bg-gray-800/50 border ${error ? 'border-red-500/50' : 'border-gray-600/50'
                  } rounded-xl p-3 sm:p-3.5 text-white focus:outline-none focus:border-nai-accent/50 focus:bg-gray-800/70 focus:shadow-lg focus:shadow-nai-accent/5 transition-all duration-300 placeholder:text-gray-600`}
                placeholder="pst-Ss1Dhd..."
              />
              {error && <p className="text-red-400 text-sm">{error}</p>}

              {/* 未 Bot 授权时显示警告 */}
              {!botAuthorized && (
                <div className="flex items-start gap-2 mt-2 bg-amber-500/5 border border-amber-500/20 rounded-lg p-2.5">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <p className="text-[11px] sm:text-xs text-amber-200/80 leading-relaxed">
                    未完成 Bot 授权，将无法访问公共 OC / Vibe / 画师串库，也无法使用 Bot 代理生成
                  </p>
                </div>
              )}

              <div className="text-xs space-y-2.5 sm:space-y-3 mt-3 sm:mt-4 px-1">
                <div className="flex items-start gap-2 sm:gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                  <p className="text-gray-300 leading-relaxed text-[11px] sm:text-xs">
                    通过代理服务器转发至NovelAI，不会存储您的Token
                  </p>
                </div>
              </div>
            </div>

            {/* 排队模式开关 */}
            <div className="bg-gray-800/30 rounded-xl p-3.5 sm:p-4 border border-gray-700/50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-300">队列模式</span>
                </div>
                <button
                  onClick={() => setQueueEnabled(!queueEnabled)}
                  className={`relative w-11 h-6 rounded-full transition-all duration-300 ${queueEnabled
                    ? 'bg-green-500 shadow-lg shadow-green-500/30'
                    : 'bg-gray-600'
                    }`}
                >
                  <div
                    className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-md transition-transform duration-300 ${queueEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                  />
                </button>
              </div>
              <p className="text-[11px] sm:text-xs text-gray-500 mt-2">
                同一Token有多人使用该面板时启用，避免并发冲突
              </p>
            </div>

            <button
              onClick={handleTokenLogin}
              disabled={!token.trim() || isProcessing}
              className="w-full py-3 sm:py-3.5 bg-nai-accent hover:bg-nai-accent/90 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-medium transition-all duration-300 flex items-center justify-center text-black active:scale-[0.98]"
            >
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2" />
                  处理中...
                </>
              ) : (
                <span>登录</span>
              )}
            </button>

            <button
              onClick={() => {
                setStep(botAuthorized ? 'select-gen' : 'bot-auth');
                setError('');
              }}
              className="group flex items-center text-sm text-gray-400 hover:text-white transition-colors duration-300"
            >
              <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform duration-300" />
              {botAuthorized ? '返回选择' : '返回 Bot 授权'}
            </button>
          </div>
        )}
      </div>

      {/* 视频教程弹窗 */}
      {showTutorialVideo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 animate-fade-in">
          <div
            className="absolute inset-0"
            onClick={() => setShowTutorialVideo(false)}
          />
          <div className="relative w-full max-w-sm mx-4 bg-nai-panel/95 backdrop-blur-xl rounded-xl border border-gray-600/50 shadow-2xl shadow-black/50 overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-800/50 border-b border-gray-700/50">
              <span className="text-sm font-medium text-white flex items-center gap-1.5">
                <HelpCircle className="w-4 h-4 text-nai-accent" />
                如何获取Token
              </span>
              <button
                onClick={() => setShowTutorialVideo(false)}
                className="p-1 hover:bg-gray-700/50 rounded-md transition-colors duration-200"
              >
                <X className="w-4 h-4 text-gray-400 hover:text-white" />
              </button>
            </div>
            <div className="p-2">
              <video
                className="w-full rounded-lg"
                autoPlay
                loop
                muted
                playsInline
                src="/data/test.mp4"
              >
                您的浏览器不支持视频播放
              </video>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
