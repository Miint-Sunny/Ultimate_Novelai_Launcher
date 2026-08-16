import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { agentService } from '../../../services/agentService';
import { useAgentModelPresentation } from '../../../hooks/useAgentModelPresentation';
import {
  useAgentDock,
  AGENT_DOCK_MIN_WIDTH,
  AGENT_DOCK_MAX_WIDTH,
} from '../../../contexts/AgentDockContext';
import { ChatBody } from './ChatBody';
import { Header } from './Header';
import { HistoryView } from './HistoryView';
import { InputBar } from './InputBar';
import { C } from './tokens';
import type { ArchivedSession, VMsg } from './types';
import { useAdaptedMessages } from './useAdaptedMessages';
import { useBlink } from './useBlink';
import { useSessions, buildSessionFromLogs } from './useSessions';
import { useAssistantCommands, matchCommand } from './useAssistantCommands';

/**
 * Plana 助手停靠面板（悬浮窗 V2 的停靠形态）。
 *
 * 数据流不变：agentState.logs → useAdaptedMessages → VMsg[] → <ChatBody>。
 * 与旧悬浮窗的区别只有容器：右侧全高、可收起为窄条、左缘拖宽；
 * 提示词写回经 AgentDockContext 由 LeftSidebar 注册的 handlers 完成。
 */
export const AgentDock: React.FC = () => {
  const {
    aiModel,
    setAiModel,
    agentState,
    isGeneratingPrompt,
    agentAvailable,
    agentUnavailableReason,
    isDockOpen,
    setDockOpen,
    dockWidth,
    setDockWidth,
    handlersRef,
  } = useAgentDock();
  const agentModel = useAgentModelPresentation();

  // ─────────────────────────────
  // 内部状态（与悬浮窗一致）
  // ─────────────────────────────
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [input, setInput] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const blink = useBlink();

  const { sessions, archive, remove } = useSessions();
  const msgs = useAdaptedMessages(agentState);
  const { tryRunCommand, importMetadataFromCard, specs } = useAssistantCommands();
  const showPalette = input.startsWith('/');

  // 悬浮 InputBar 的实际高度（消息区底部要据此留出避让，避免被遮）
  const [inputBarOffset, setInputBarOffset] = useState(64);

  // 最后一条 AI（success）VMsg 的下标
  const lastAiVIndex = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'ai') return i;
    }
    return -1;
  }, [msgs]);

  // 焦点 + 自动滚动
  useEffect(() => {
    if (isDockOpen) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(t);
    }
  }, [isDockOpen]);
  const scrollBodyToBottom = useCallback(() => {
    const scroll = () => {
      const el = bodyRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    window.requestAnimationFrame(scroll);
    window.setTimeout(scroll, 60);
    window.setTimeout(scroll, 180);
  }, []);

  useEffect(() => {
    if (isDockOpen) scrollBodyToBottom();
  }, [isDockOpen, msgs.length, isGeneratingPrompt, view, scrollBodyToBottom]);

  // ─────────────────────────────
  // 左缘拖宽
  // ─────────────────────────────
  const resize = useRef({ active: false, startX: 0, startWidth: 0 });
  const onResizeDown = (e: React.PointerEvent) => {
    resize.current = { active: true, startX: e.clientX, startWidth: dockWidth };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!resize.current.active) return;
    setDockWidth(resize.current.startWidth + (resize.current.startX - e.clientX));
  };
  const onResizeUp = (e: React.PointerEvent) => {
    resize.current.active = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  // ─────────────────────────────
  // 行为（与悬浮窗一致，写回走注册 handlers）
  // ─────────────────────────────
  const handleSend = useCallback(
    (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text && !selectedImage) return;
      if (isGeneratingPrompt) return;
      const clearInput = () => {
        setInput('');
        setSelectedImage(null);
        if (inputRef.current) inputRef.current.style.height = 'auto';
      };
      // 固定指令优先：不经 LLM，Agent 未配置也可用
      if (text && matchCommand(text)) {
        const image = selectedImage ?? undefined;
        clearInput();
        void tryRunCommand(text, image);
        return;
      }
      const handlers = handlersRef.current;
      if (!agentAvailable || !handlers) {
        agentService.addLog('card', 'Agent 未启用', {
          card: {
            kind: 'info',
            title: 'Plana 暂不可用',
            body: agentUnavailableReason || '本地 Agent 主模型尚未配置。',
            hint: '固定指令（kkt / 生成图片 / 生成视频）不依赖 LLM，仍然可用。',
          },
        });
        return;
      }
      handlers.generate(text, selectedImage ?? undefined);
      clearInput();
    },
    [input, selectedImage, isGeneratingPrompt, handlersRef, agentAvailable, agentUnavailableReason, tryRunCommand],
  );

  const handlePickImage = () => fileInputRef.current?.click();
  const handleImagePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = ev => setSelectedImage((ev.target?.result as string) ?? null);
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** 撤回最新一条 AI 回复 + 回填用户文本到输入框 */
  const handleUndoLast = useCallback(() => {
    const logs = agentState.logs;
    let lastSuccessIdx = -1;
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].type === 'success' && !logs[i].collapsed) {
        lastSuccessIdx = i;
        break;
      }
    }
    if (lastSuccessIdx < 0) return;
    const snap = logs[lastSuccessIdx].snapshot;

    // 1) 先把提示词回滚到生成前的状态（旧归档快照没有 preVibes：保持现状不动 vibes）
    const handlers = handlersRef.current;
    if (snap && handlers) {
      handlers.restoreSnapshot({
        ...snap,
        positive: snap.prePositive,
        negative: snap.preNegative,
        characters: snap.preCharacters,
        vibes: snap.preVibes ?? snap.vibes,
      });
    }
    // 2) 把对应的 user request 拎出来 + 截掉 user log 及之后
    const payload = agentService.truncateToUserRequest(lastSuccessIdx);
    if (payload?.request) {
      setInput(payload.request);
      if (payload.image) setSelectedImage(payload.image);
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [agentState.logs, handlersRef]);

  /** 复制某条 AI 回复的全部 tag（用 snapshot.positive 准确切） */
  const handleCopyAll = useCallback((m: VMsg) => {
    const tags = m.tags ?? [];
    if (tags.length === 0) return;
    navigator.clipboard?.writeText(tags.join(', '));
  }, []);

  /** 清空当前对话（不归档，直接 reset；用于 InputBar 的垃圾桶） */
  const handleClearChat = useCallback(() => {
    agentService.clearLogs();
  }, []);

  /**
   * 重试这条 AI 回复（或 error）：
   *   1. 如果 AI 有 snapshot，先把提示词回滚到生成前状态（避免叠加）
   *   2. 截掉对应 user log 及之后
   *   3. 用同一句 user request + image 重新发送
   */
  const handleRetry = useCallback(
    (m: VMsg) => {
      const handlers = handlersRef.current;
      if (!handlers) return;
      const snap = m.snapshot;
      const payload = agentService.truncateToUserRequest(m.logIndex);
      if (!payload?.request) return;
      if (snap) {
        handlers.regenerate(payload.request, {
          positive: snap.prePositive,
          negative: snap.preNegative,
          characters: snap.preCharacters,
          vibes: snap.preVibes,
        }, payload.image);
        return;
      }
      handlers.generate(payload.request, payload.image);
    },
    [handlersRef],
  );

  /** 点 + 新对话：归档当前对话 + 清空 logs */
  const handleNewChat = useCallback(() => {
    if (agentState.logs.length === 0) return;
    archive(agentState.logs);
    agentService.clearLogs();
  }, [agentState.logs, archive]);

  /** 历史里点"打开"：当前会话 → 直接回到 chat；归档会话 → 先归档当前再灌回 */
  const handleResumeSession = useCallback(
    (s: ArchivedSession) => {
      if (s.current) {
        setView('chat');
        return;
      }
      if (agentState.logs.length > 0) archive(agentState.logs);
      remove(s.id);
      agentService.loadLogs(s.logs);
      setView('chat');
    },
    [agentState.logs, archive, remove],
  );

  /** 历史里点删除：当前会话 → 清空 logs；归档会话 → 走 remove */
  const handleDeleteSession = useCallback(
    (id: number) => {
      if (id === 0) {
        agentService.clearLogs();
        return;
      }
      remove(id);
    },
    [remove],
  );

  /** 列表 = 当前进行中的会话（如有）+ 已归档会话；当前固定在最前 */
  const displaySessions = useMemo(() => {
    const current = buildSessionFromLogs(agentState.logs, 0);
    if (!current) return sessions;
    return [{ ...current, current: true }, ...sessions];
  }, [agentState.logs, sessions]);

  // ─────────────────────────────
  // 收起态：右缘窄条
  // ─────────────────────────────
  if (!isDockOpen) {
    return (
      <div
        className="shrink-0 flex flex-col items-center bg-nai-panel border-l border-gray-800 z-10"
        style={{ width: 30 }}
      >
        <button
          className={`mt-3 p-1 rounded-lg transition-colors ${isGeneratingPrompt
            ? 'text-nai-accent bg-nai-accent/10'
            : 'text-gray-400 hover:text-white hover:bg-white/10'
            }`}
          onClick={() => setDockOpen(true)}
          title={isGeneratingPrompt ? 'Plana 正在思考，点击展开' : '展开助手栏'}
        >
          <Bot className="w-5 h-5" />
        </button>
        {isGeneratingPrompt && (
          <div className="mt-2 relative w-2 h-2">
            <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
            <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="relative shrink-0 flex flex-col z-10 overflow-hidden"
      style={{
        width: dockWidth,
        minWidth: AGENT_DOCK_MIN_WIDTH,
        maxWidth: AGENT_DOCK_MAX_WIDTH,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        color: C.text,
      }}
    >
      {/* 左缘拖宽把手 */}
      <div
        className="absolute top-0 left-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/10 transition-colors"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        title="拖动调整面板宽度"
      />
      <Header
        view={view}
        model={aiModel}
        localPrimaryModel={agentModel.isLocal ? (agentModel.primaryModel ?? '') : null}
        blink={blink}
        sending={isGeneratingPrompt}
        hasMessages={msgs.length > 0}
        onModelChange={setAiModel}
        onGoHistory={() => setView('history')}
        onBack={() => setView('chat')}
        onNewChat={handleNewChat}
        onClose={() => setDockOpen(false)}
        closeTitle="收起助手栏"
      />
      {!agentAvailable && (
        <div
          className="shrink-0 px-3 py-1.5 text-[11px]"
          style={{ background: 'rgba(252,237,164,0.06)', color: C.textDim, borderBottom: `1px solid ${C.line}` }}
          title={agentUnavailableReason}
        >
          Plana LLM 未配置，仅固定指令可用（kkt / 生成图片 / 生成视频）
        </div>
      )}
      {view === 'chat' ? (
        <>
          <ChatBody
            ref={bodyRef}
            msgs={msgs}
            sending={isGeneratingPrompt}
            progressText={agentState.progress}
            lastAiVIndex={lastAiVIndex}
            inputBarOffset={inputBarOffset}
            onSuggest={t => handleSend(t)}
            onCopyAll={handleCopyAll}
            onImportMetadata={m => { if (m.card) void importMetadataFromCard(m.card); }}
            onUndoLast={handleUndoLast}
            onRetry={handleRetry}
          />
          {/* “/” 指令面板 */}
          {showPalette && (
            <div
              style={{
                position: 'absolute',
                left: 10,
                right: 10,
                bottom: inputBarOffset + 8,
                background: C.panel2,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: 6,
                zIndex: 5,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
            >
              {specs.map(spec => (
                <button
                  key={spec.id}
                  className="aa-btn"
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: 8,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                  title={spec.usage}
                  onClick={() => {
                    setInput(`${spec.keywords[0]} `);
                    window.setTimeout(() => inputRef.current?.focus(), 30);
                  }}
                >
                  <span style={{ color: C.accent, fontSize: 12, fontWeight: 700 }}>{spec.keywords[0]}</span>
                  <span style={{ color: C.textDim, fontSize: 11, marginLeft: 8 }}>{spec.description}</span>
                </button>
              ))}
            </div>
          )}
          {/* 隐藏 file input */}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            ref={fileInputRef}
            onChange={handleImagePicked}
            style={{ display: 'none' }}
          />
          <InputBar
            value={input}
            onChange={setInput}
            onSend={() => handleSend()}
            sending={isGeneratingPrompt}
            inputRef={inputRef}
            selectedImage={selectedImage}
            onPickImage={handlePickImage}
            onClearImage={() => setSelectedImage(null)}
            hasMessages={msgs.length > 0}
            onClearChat={handleClearChat}
            onHeightChange={setInputBarOffset}
          />
        </>
      ) : (
        <HistoryView
          sessions={displaySessions}
          onResume={handleResumeSession}
          onDelete={handleDeleteSession}
        />
      )}
    </div>
  );
};
