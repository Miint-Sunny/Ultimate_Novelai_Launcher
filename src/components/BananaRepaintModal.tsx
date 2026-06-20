import { useState, useEffect, useRef } from 'react';
import { Send, Clock, Banana } from 'lucide-react';

// 自动追加的提示词 - 保持原图比例
const AUTO_APPEND_PROMPT = '，必须保持原图比例';

interface BananaInputBarProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (prompt: string) => void;
  estimatedSeconds: number;
  failureRate?: number; // 0.0-1.0
  initialPrompt?: string; // 编辑时的初始提示词
}

// 根据失败率获取状态颜色
const getStatusColor = (rate: number) => {
  if (rate <= 0.2) return { bg: 'bg-green-500', text: 'text-green-400', label: '良好' };
  if (rate <= 0.5) return { bg: 'bg-yellow-500', text: 'text-yellow-400', label: '一般' };
  return { bg: 'bg-red-500', text: 'text-red-400', label: '不稳定' };
};

export const BananaInputBar: React.FC<BananaInputBarProps> = ({
  isOpen,
  onClose,
  onSubmit,
  estimatedSeconds,
  failureRate = 0,
  initialPrompt,
}) => {
  const [prompt, setPrompt] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      // 如果有初始提示词，设置它
      setPrompt(initialPrompt || '');
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setPrompt('');
    }
  }, [isOpen, initialPrompt]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSubmit = () => {
    if (!prompt.trim()) return;
    // 自动追加保持比例的提示词
    const finalPrompt = prompt.trim() + AUTO_APPEND_PROMPT;
    onSubmit(finalPrompt);
    setPrompt('');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // 自动调整文本框高度
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 80), 200) + 'px';
    }
  }, [prompt]);

  return (
    <>
      {/* 透明遮罩层 - 点击关闭 */}
      <div
        className={`absolute inset-0 z-20 ${isOpen ? '' : 'pointer-events-none'}`}
        onClick={onClose}
      />

      <div
        className={`absolute bottom-16 left-1/2 -translate-x-1/2 z-30 transition-opacity duration-150 ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none invisible'
        }`}
      >
        <div
          ref={containerRef}
          className="bg-gray-900/80 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl w-[480px] p-4"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 输入区域 */}
          <div className="flex gap-3">
            <div className="shrink-0 w-9 h-9 rounded-lg bg-nai-accent/20 flex items-center justify-center">
              <Banana className="w-4 h-4 text-nai-accent" />
            </div>
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述修改效果..."
              rows={3}
              className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-sm placeholder-gray-500 resize-none outline-none focus:border-nai-accent/40 transition-all"
              style={{ minHeight: '80px' }}
            />
          </div>

          {/* 底部栏 */}
          <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
            <div className="flex items-center gap-3 text-xs text-gray-500">
              {/* 状态指示器 */}
              <div className="flex items-center gap-1.5" title={`近期失败率: ${Math.round(failureRate * 100)}%`}>
                <div className={`w-2 h-2 rounded-full ${getStatusColor(failureRate).bg}`} />
                <span className={getStatusColor(failureRate).text}>{getStatusColor(failureRate).label}</span>
              </div>
              <span className="text-gray-600">·</span>
              <div className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <span>~{estimatedSeconds}s</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="h-8 px-3 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-white/5 transition-all"
              >
                取消
              </button>
              <button
                onClick={handleSubmit}
                disabled={!prompt.trim()}
                className={`h-8 flex items-center gap-1.5 px-4 rounded-lg text-xs font-medium transition-all ${
                  prompt.trim()
                    ? 'bg-nai-accent hover:bg-nai-accent/90 text-black'
                    : 'bg-white/10 text-gray-500 cursor-not-allowed'
                }`}
              >
                <Send className="w-3.5 h-3.5" />
                提交
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
