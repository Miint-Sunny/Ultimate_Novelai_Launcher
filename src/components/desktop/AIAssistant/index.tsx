import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  agentService,
  type AgentState,
} from '../../../services/agentService';
import { ChatBody } from './ChatBody';
import { Header } from './Header';
import { HistoryView } from './HistoryView';
import { InputBar } from './InputBar';
import { C, PANEL_H, PANEL_W } from './tokens';
import type { ArchivedSession, VMsg } from './types';
import { useAdaptedMessages } from './useAdaptedMessages';
import { useBlink } from './useBlink';
import { useSessions, buildSessionFromLogs } from './useSessions';

// 保留与原 DraggableAIAssistant 完全一致的对外契约
export interface DraggableAIAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  aiModel: string;
  onAiModelChange: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  onAIGenerate: (request: string, imageBase64?: string) => void;
  onAIRegenerate?: (
    request: string,
    preState: {
      positive: string;
      negative: string;
      characters: { positive: string; negative?: string; name: string }[];
    },
    imageBase64?: string,
  ) => void;
  onRestoreSnapshot?: (snapshot: {
    positive: string;
    negative: string;
    characters: { positive: string; negative?: string; name: string }[];
    vibes: string[];
  }) => void;
  initialRect?: DOMRect | null;
}

/**
 * Plana AI 助手浮窗 V2（重设计版）。
 *
 * 数据流：
 *   agentState.logs → useAdaptedMessages → VMsg[] → <ChatBody>
 *
 * 复刻自 design_handoff_ai_assistant/prototype.jsx，详细 spec 见同目录的 README.md。
 */
export const DraggableAIAssistant: React.FC<DraggableAIAssistantProps> = ({
  isOpen,
  onClose,
  aiModel,
  onAiModelChange,
  agentState,
  isGeneratingPrompt,
  onAIGenerate,
  onAIRegenerate,
  onRestoreSnapshot,
  initialRect,
}) => {
  // ─────────────────────────────
  // 渲染挂载（保留出现/退出动画）
  // ─────────────────────────────
  const [shouldRender, setShouldRender] = useState(isOpen);
  const [isClosing, setIsClosing] = useState(false);
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
    } else if (shouldRender) {
      setIsClosing(true);
      const t = window.setTimeout(() => setShouldRender(false), 220);
      return () => window.clearTimeout(t);
    }
  }, [isOpen, shouldRender]);

  // ─────────────────────────────
  // 位置 / 拖拽
  // ─────────────────────────────
  const [position, setPosition] = useState({
    x: window.innerWidth - PANEL_W - 30,
    y: 80,
  });
  const drag = useRef({ active: false, dx: 0, dy: 0 });

  useEffect(() => {
    if (!isOpen) return;
    if (initialRect) {
      const x = Math.min(initialRect.right + 10, window.innerWidth - PANEL_W - 10);
      const y = Math.max(
        10,
        Math.min(initialRect.top, window.innerHeight - PANEL_H - 10),
      );
      setPosition({ x, y });
    } else {
      // 居中显示
      setPosition({
        x: Math.max(20, (window.innerWidth - PANEL_W) / 2),
        y: Math.max(40, (window.innerHeight - PANEL_H) / 2),
      });
    }
  }, [isOpen, initialRect]);

  const onHeaderDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.no-drag')) return;
    drag.current.active = true;
    drag.current.dx = e.clientX - position.x;
    drag.current.dy = e.clientY - position.y;
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };
  const onHeaderMove = (e: React.PointerEvent) => {
    if (!drag.current.active) return;
    setPosition({
      x: e.clientX - drag.current.dx,
      y: e.clientY - drag.current.dy,
    });
  };
  const onHeaderUp = (e: React.PointerEvent) => {
    drag.current.active = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* noop */
    }
  };

  // ─────────────────────────────
  // 内部状态
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
    if (isOpen) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(t);
    }
  }, [isOpen]);
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
    if (isOpen) scrollBodyToBottom();
  }, [isOpen, shouldRender, msgs.length, isGeneratingPrompt, view, scrollBodyToBottom]);

  // ─────────────────────────────
  // 行为
  // ─────────────────────────────
  const handleSend = useCallback(
    (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      if (!text && !selectedImage) return;
      if (isGeneratingPrompt) return;
      onAIGenerate(text, selectedImage ?? undefined);
      setInput('');
      setSelectedImage(null);
      if (inputRef.current) inputRef.current.style.height = 'auto';
    },
    [input, selectedImage, isGeneratingPrompt, onAIGenerate],
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
    // 在原始 logs 里找到最后一条 success
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

    // 1) 先把 prompt 提示词回滚到生成前的状态
    if (snap && onRestoreSnapshot) {
      onRestoreSnapshot({
        positive: snap.prePositive,
        negative: snap.preNegative,
        characters: snap.preCharacters,
        vibes: snap.vibes,
      });
    }
    // 2) 把对应的 user request 拎出来 + 截掉 user log 及之后
    const payload = agentService.truncateToUserRequest(lastSuccessIdx);
    if (payload?.request) {
      setInput(payload.request);
      if (payload.image) setSelectedImage(payload.image);
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [agentState.logs, onRestoreSnapshot]);

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
      const snap = m.snapshot;
      const payload = agentService.truncateToUserRequest(m.logIndex);
      if (!payload?.request) return;
      if (snap && onAIRegenerate) {
        onAIRegenerate(payload.request, {
          positive: snap.prePositive,
          negative: snap.preNegative,
          characters: snap.preCharacters,
        }, payload.image);
        return;
      }
      if (snap && onRestoreSnapshot) {
        onRestoreSnapshot({
          positive: snap.prePositive,
          negative: snap.preNegative,
          characters: snap.preCharacters,
          vibes: snap.vibes,
        });
      }
      onAIGenerate(payload.request, payload.image);
    },
    [onAIGenerate, onAIRegenerate, onRestoreSnapshot],
  );

  /** 点 + 新对话：归档当前对话 + 清空 logs */
  const handleNewChat = useCallback(() => {
    if (agentState.logs.length === 0) return;
    const ok = archive(agentState.logs);
    agentService.clearLogs();
    if (ok) {
      // 可以做个轻提示，这里保持安静
    }
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

  if (!shouldRender) return null;

  // 进退场动画：复用现有 animate-assistant-popup / popout
  const animClass = isClosing ? 'animate-assistant-popout' : 'animate-assistant-popup';

  return (
    <div
      className={animClass}
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: PANEL_W,
        height: PANEL_H,
        background: C.panel,
        border: `1px solid ${C.border}`,
        borderRadius: 18,
        overflow: 'hidden',
        boxShadow:
          '0 30px 60px -20px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05), 0 0 30px rgba(252, 237, 164, 0.04)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 90,
        touchAction: 'none',
        color: C.text,
      }}
    >
      <Header
        view={view}
        model={aiModel}
        blink={blink}
        sending={isGeneratingPrompt}
        hasMessages={msgs.length > 0}
        onModelChange={onAiModelChange}
        onGoHistory={() => setView('history')}
        onBack={() => setView('chat')}
        onNewChat={handleNewChat}
        onClose={onClose}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
      />
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
            onUndoLast={handleUndoLast}
            onRetry={handleRetry}
          />
          {/* 隐藏 file input */}
          <input
            type="file"
            accept="image/*"
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

