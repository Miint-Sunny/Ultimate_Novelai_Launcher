import React, { useState, useEffect, useCallback } from 'react';
import {
  Key,
  Bot,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Copy,
  Check,
  Users,
  Sparkles,
  HelpCircle,
  X,
  FlaskConical,
} from 'lucide-react';
import {
  saveApiToken,
  saveUserId,
  saveAppSettings,
  getAppSettings,
} from '../services/localLibrary';
import { copyToClipboard } from '../utils/clipboard';
import { generateSecureUserId } from '../utils/security';
import { sidecarApi } from '../api/sidecar';
import { botService, type BotAuthState } from '../services/botService';

interface LoginProps {
  onLogin: () => void;
}

export const Login: React.FC<LoginProps> = ({ onLogin }) => {
  const [mode, setMode] = useState<'select' | 'token' | 'bot'>('select');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [queueEnabled, setQueueEnabled] = useState(false);

  // 授权成功动画状态
  const [showSuccessAnimation, setShowSuccessAnimation] = useState(false);

  // 视频教程弹窗状态
  const [showTutorialVideo, setShowTutorialVideo] = useState(false);

  // Bot授权状态
  const [botAuthState, setBotAuthState] = useState<BotAuthState>(
    botService.getAuthState()
  );
  const [authCodeCountdown, setAuthCodeCountdown] = useState(0);
  const [isGeneratingCode, setIsGeneratingCode] = useState(false);
  const [copied, setCopied] = useState(false);

  // 测试后门点击计数
  const [devClickCount, setDevClickCount] = useState(0);

  // 加载排队模式设置
  useEffect(() => {
    const settings = getAppSettings();
    setQueueEnabled(settings.queueEnabled);
  }, []);

  // 触发成功动画并延迟跳转
  const triggerSuccessAnimation = useCallback(() => {
    setShowSuccessAnimation(true);
    setTimeout(() => {
      onLogin();
    }, 1500);
  }, [onLogin]);

  // 测试后门：快速点击5次进入
  const handleDevClick = useCallback(() => {
    const newCount = devClickCount + 1;
    setDevClickCount(newCount);

    if (newCount >= 5) {
      // 保存测试模式设置
      const settings = getAppSettings();
      saveAppSettings({ ...settings, loginMode: 'token', queueEnabled: false });
      saveApiToken('configured');
      saveUserId('dev-test-user');
      triggerSuccessAnimation();
    }

    // 3秒后重置计数
    setTimeout(() => {
      setDevClickCount(0);
    }, 3000);
  }, [devClickCount, triggerSuccessAnimation]);

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
        saveApiToken(trimmedToken);

        const userId = await generateSecureUserId(trimmedToken);
        saveUserId(userId);

        const settings = getAppSettings();
        saveAppSettings({ ...settings, loginMode: 'token', queueEnabled });

        triggerSuccessAnimation();
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

      if (authState.isAuthorized) {
        botService.saveSession();
        const settings = getAppSettings();
        saveAppSettings({ ...settings, loginMode: 'bot', queueEnabled: true });
        triggerSuccessAnimation();
      }
    });
    return unsubscribe;
  }, [triggerSuccessAnimation]);

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

  return (
    <div className="relative flex items-center justify-center min-h-screen h-screen bg-nai-bg text-white overflow-hidden px-4 py-6 sm:px-6 sm:py-8">
      {/* 动态背景效果 */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute top-1/4 -left-32 w-64 sm:w-96 h-64 sm:h-96 bg-nai-accent/10 rounded-full blur-3xl animate-float-slow" />
        <div className="absolute bottom-1/4 -right-32 w-56 sm:w-80 h-56 sm:h-80 bg-purple-500/10 rounded-full blur-3xl animate-float-slow-reverse" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] sm:w-[600px] h-[400px] sm:h-[600px] bg-gradient-radial from-nai-accent/5 to-transparent rounded-full" />
        <div className="absolute inset-0 bg-grid-pattern opacity-[0.02]" />
        <div className="absolute top-20 left-1/4 w-1 h-1 bg-nai-accent/40 rounded-full animate-particle-1" />
        <div className="absolute top-1/3 right-1/4 w-1.5 h-1.5 bg-purple-400/30 rounded-full animate-particle-2" />
        <div className="absolute bottom-1/3 left-1/3 w-1 h-1 bg-nai-accent/30 rounded-full animate-particle-3" />
        <div className="absolute top-2/3 right-1/3 w-0.5 h-0.5 bg-white/20 rounded-full animate-particle-4" />
      </div>

      {/* 成功动画遮罩层 */}
      {showSuccessAnimation && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-nai-bg animate-fade-in">
          <div className="flex flex-col items-center animate-success-bounce">
            <div className="relative">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center animate-success-scale shadow-lg shadow-green-500/30">
                <CheckCircle2 className="w-10 h-10 sm:w-12 sm:h-12 text-white animate-check-draw" />
              </div>
              <div className="absolute inset-0 w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-green-400/20 animate-ping-slow" />
              <Sparkles className="absolute -top-2 -right-2 w-5 h-5 sm:w-6 sm:h-6 text-yellow-400 animate-sparkle-1" />
              <Sparkles className="absolute -bottom-1 -left-3 w-4 h-4 sm:w-5 sm:h-5 text-yellow-300 animate-sparkle-2" />
              <Sparkles className="absolute top-1/2 -right-4 w-3 h-3 sm:w-4 sm:h-4 text-yellow-400 animate-sparkle-3" />
            </div>
            <div className="mt-5 sm:mt-6 text-center animate-fade-in-up">
              <h2 className="text-xl sm:text-2xl font-bold text-white mb-2">
                登录成功
              </h2>
              <p className="text-gray-400 text-sm">正在进入主页...</p>
            </div>
            <div className="mt-5 sm:mt-6 w-40 sm:w-48 h-1 bg-gray-700 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 rounded-full animate-progress-bar" />
            </div>
          </div>
        </div>
      )}

      {/* 主登录卡片 */}
      <div
        className={`relative z-10 w-full max-w-md p-5 sm:p-8 bg-nai-panel/80 backdrop-blur-xl rounded-2xl border border-gray-600/50 shadow-2xl shadow-black/50 transition-all duration-500 ${showSuccessAnimation ? 'opacity-0 scale-95' : 'opacity-100 scale-100'
          }`}
      >
        <div className="absolute -top-px left-1/2 -translate-x-1/2 w-1/2 h-px bg-gradient-to-r from-transparent via-nai-accent/50 to-transparent" />

        {/* 标题 - 可点击触发测试后门 */}
        <h1
          onClick={handleDevClick}
          className="text-2xl sm:text-3xl font-bold text-center mb-6 sm:mb-8 text-nai-accent flex items-center justify-center gap-2 select-none cursor-default"
        >
          NovelAI Web UI
          <span className="text-[10px] sm:text-xs font-bold bg-nai-accent/20 text-nai-accent px-1.5 sm:px-2 py-0.5 rounded-full border border-nai-accent/30 uppercase tracking-wider animate-pulse-subtle">
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

        {mode === 'select' ? (
          <div className="space-y-3 sm:space-y-4">
            <button
              onClick={() => setMode('token')}
              className="group relative w-full flex items-center justify-between p-3.5 sm:p-4 bg-gray-800/50 hover:bg-gray-700/50 active:bg-gray-600/50 rounded-xl transition-all duration-300 border border-gray-600/50 hover:border-nai-accent/50 hover:shadow-lg hover:shadow-nai-accent/10 overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-nai-accent/0 via-nai-accent/5 to-nai-accent/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
              <div className="relative flex items-center space-x-3">
                <div className="p-2 sm:p-2.5 bg-gray-700/50 rounded-xl group-hover:bg-nai-accent/20 transition-colors duration-300">
                  <Key className="w-5 h-5 text-nai-accent" />
                </div>
                <div className="text-left">
                  <span className="font-medium block text-sm sm:text-base">
                    API Token 登录
                  </span>
                  <span className="text-xs text-gray-500">
                    使用您的 NovelAI Token
                  </span>
                </div>
              </div>
              <ArrowLeft className="w-4 h-4 text-gray-500 rotate-180 group-hover:text-nai-accent group-hover:translate-x-1 transition-all duration-300" />
            </button>

            <button
              onClick={() => setMode('bot')}
              className="group relative w-full flex items-center justify-between p-3.5 sm:p-4 bg-gray-800/50 hover:bg-gray-700/50 active:bg-gray-600/50 rounded-xl transition-all duration-300 border border-gray-600/50 hover:border-nai-accent/50 hover:shadow-lg hover:shadow-nai-accent/10 overflow-hidden"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-nai-accent/0 via-nai-accent/5 to-nai-accent/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700" />
              <div className="relative flex items-center space-x-3">
                <div className="p-2 sm:p-2.5 bg-gray-700/50 rounded-xl group-hover:bg-nai-accent/20 transition-colors duration-300">
                  <Bot className="w-5 h-5 text-nai-accent" />
                </div>
                <div className="text-left">
                  <span className="font-medium block text-sm sm:text-base">
                    BOT 授权登录
                  </span>
                  <span className="text-xs text-gray-500">
                    通过 Bot 指令授权
                  </span>
                </div>
              </div>
              <ArrowLeft className="w-4 h-4 text-gray-500 rotate-180 group-hover:text-nai-accent group-hover:translate-x-1 transition-all duration-300" />
            </button>
          </div>
        ) : mode === 'token' ? (
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
              className="group relative w-full py-3 sm:py-3.5 bg-gradient-to-r from-nai-accent to-nai-accent/90 hover:from-nai-accent hover:to-nai-accent disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-xl font-medium transition-all duration-300 flex items-center justify-center text-black overflow-hidden shadow-lg shadow-nai-accent/20 hover:shadow-nai-accent/30 disabled:shadow-none active:scale-[0.98]"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin mr-2" />
                  处理中...
                </>
              ) : (
                <span className="relative">登录</span>
              )}
            </button>

            <button
              onClick={() => setMode('select')}
              className="group flex items-center text-sm text-gray-400 hover:text-white transition-colors duration-300"
            >
              <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform duration-300" />
              返回选择
            </button>
          </div>
        ) : (

          <div className="space-y-5 sm:space-y-6">
            <div className="space-y-4">
              <div className="text-center">
                <div className="inline-flex p-3 sm:p-4 bg-gray-800/50 rounded-2xl mb-3 sm:mb-4">
                  <Bot className="w-8 h-8 sm:w-10 sm:h-10 text-nai-accent" />
                </div>
                <h2 className="text-base sm:text-lg font-medium mb-1">
                  BOT 授权登录
                </h2>
                <p className="text-xs sm:text-sm text-gray-400">
                  生成授权码后，向Bot发送指令完成授权
                </p>
              </div>

              {error && (
                <p className="text-red-400 text-sm text-center">{error}</p>
              )}

              {botAuthState.authCode ? (
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
                    向Bot发送上方指令完成授权
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleGenerateAuthCode}
                  disabled={isGeneratingCode}
                  className="group relative w-full py-3 sm:py-3.5 bg-gradient-to-r from-nai-accent to-nai-accent/90 hover:from-nai-accent hover:to-nai-accent disabled:from-gray-700 disabled:to-gray-700 disabled:text-gray-500 rounded-xl font-medium transition-all duration-300 flex items-center justify-center text-black overflow-hidden shadow-lg shadow-nai-accent/20 hover:shadow-nai-accent/30 disabled:shadow-none active:scale-[0.98]"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-500" />
                  {isGeneratingCode ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      生成中...
                    </>
                  ) : (
                    <span className="relative">生成授权码</span>
                  )}
                </button>
              )}
            </div>

            <button
              onClick={() => {
                setMode('select');
                setError('');
              }}
              className="group flex items-center text-sm text-gray-400 hover:text-white transition-colors duration-300"
            >
              <ArrowLeft className="w-4 h-4 mr-1 group-hover:-translate-x-1 transition-transform duration-300" />
              返回选择
            </button>
          </div>
        )}
      </div>

      {/* 视频教程弹窗 - 移动端全屏，桌面端侧边 */}
      {showTutorialVideo && (
        <>
          {/* 移动端：底部弹出 */}
          <div className="sm:hidden fixed inset-0 z-50 bg-black/60 flex items-end animate-fade-in">
            <div
              className="absolute inset-0"
              onClick={() => setShowTutorialVideo(false)}
            />
            <div className="relative w-full bg-nai-panel rounded-t-2xl overflow-hidden animate-slide-in-from-bottom safe-area-bottom">
              <div className="flex items-center justify-between px-4 py-3 bg-gray-800/50 border-b border-gray-700/50">
                <span className="text-sm font-medium text-white flex items-center gap-1.5">
                  <HelpCircle className="w-4 h-4 text-nai-accent" />
                  如何获取Token
                </span>
                <button
                  onClick={() => setShowTutorialVideo(false)}
                  className="p-1.5 hover:bg-gray-700/50 rounded-md transition-colors duration-200"
                >
                  <X className="w-5 h-5 text-gray-400 hover:text-white" />
                </button>
              </div>
              <div className="p-3">
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

          {/* 桌面端：侧边小窗口 */}
          <div className="hidden sm:block absolute left-1/2 top-1/2 -translate-y-1/2 ml-[240px] z-20 w-72 bg-nai-panel/95 backdrop-blur-xl rounded-xl border border-gray-600/50 shadow-2xl shadow-black/50 overflow-hidden animate-fade-in">
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
        </>
      )}
    </div>
  );
};
