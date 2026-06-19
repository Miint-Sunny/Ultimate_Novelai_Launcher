import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogEntry } from '../../../services/agentService';

const SUGGESTIONS = [
  "帮我画一只白发红瞳的傲娇猫娘",
  "给我抽一个好看的画师串",
  "帮我查一下足交的Tag",
  "随机画一个蔚蓝档案的角色",
  "包含Chen Bin的画师串有哪些呢",
  "优化一下当前的Tag",
];

const THINKING_TEXTS = [
  '努力思考喵...',
  '脑电波链接中喵~',
  '整理魔法词汇喵~',
  '思考中...喵呜？',
  '灵感加载中喵✨',
];

interface UseMobileAssistantSheetStateParams {
  isOpen: boolean;
  isGeneratingPrompt: boolean;
  logs: LogEntry[];
}

export function useMobileAssistantSheetState({
  isOpen,
  isGeneratingPrompt,
  logs,
}: UseMobileAssistantSheetStateParams) {
  const [aiInput, setAiInput] = useState('');
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [randomSuggestions, setRandomSuggestions] = useState<string[]>([]);
  const [thinkingIndex, setThinkingIndex] = useState(0);
  const aiLogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) {
      setRandomSuggestions([...SUGGESTIONS].sort(() => 0.5 - Math.random()).slice(0, 3));
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isGeneratingPrompt) {
      setThinkingIndex(0);
      return;
    }

    const timer = setInterval(() => {
      setThinkingIndex(prev => prev + 1);
    }, 4000);

    return () => clearInterval(timer);
  }, [isGeneratingPrompt]);

  const thinkingText = useMemo(
    () => THINKING_TEXTS[thinkingIndex % THINKING_TEXTS.length],
    [thinkingIndex],
  );

  useEffect(() => {
    if (!isOpen) return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      setViewportHeight(viewport.height);
    };

    handleResize();
    viewport.addEventListener('resize', handleResize);

    return () => {
      viewport.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  useEffect(() => {
    if (aiLogRef.current) {
      aiLogRef.current.scrollTop = aiLogRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  return {
    aiInput,
    setAiInput,
    viewportHeight,
    aiLogRef,
    inputRef,
    randomSuggestions,
    thinkingText,
  };
}
