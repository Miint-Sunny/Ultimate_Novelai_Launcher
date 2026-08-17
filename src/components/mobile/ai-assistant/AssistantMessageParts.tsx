import React, { useState, useEffect } from 'react';

// 打字机效果文本：逐字显示，末尾带闪烁光标。
export const TypewriterText: React.FC<{ text: string }> = ({ text }) => {
  const [displayedText, setDisplayedText] = useState('');

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      setDisplayedText(text.substring(0, index + 1));
      index++;
      if (index > text.length) clearInterval(timer);
    }, 45);
    return () => clearInterval(timer);
  }, [text]);

  return (
    <>
      {displayedText}
      {displayedText.length < text.length && <span className="animate-pulse opacity-70">_</span>}
    </>
  );
};

// 可复制的标签气泡：点击复制 tagText 到剪贴板，短暂显示「已复制」提示。
const TagButton: React.FC<{ tagText: string; isAccentBubble: boolean }> = ({ tagText, isAccentBubble }) => {
  const [copied, setCopied] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(tagText);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className={`inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 rounded cursor-pointer border font-mono text-xs transition-all ${
          isAccentBubble
            ? 'bg-black/10 hover:bg-black/20 border-transparent text-black font-bold shadow-sm'
            : 'bg-nai-panel-2 border-nai-border/80 hover:border-nai-accent/50 hover:bg-nai-surface text-nai-accent shadow-sm'
        }`}
        title="点击复制标签"
      >
        {tagText}
      </button>
      {copied && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-1 bg-black/80 text-green-400 text-[10px] rounded shadow-lg whitespace-nowrap animate-fade-in pointer-events-none z-10 border border-green-500/20">
          已复制!
        </span>
      )}
    </span>
  );
};

// 渲染消息内容：把 TAG[[...]] 标记解析成可复制的 TagButton，其余作为纯文本。
export const renderMessageContent = (content: string, isAccentBubble: boolean = false) => {
  if (!content) return null;
  const parts = content.split(/(TAG\[\[.*?\]\])/g);
  return parts.map((part, i) => {
    if (part.startsWith('TAG[[') && part.endsWith(']]')) {
      const tagText = part.slice(5, -2);
      return <TagButton key={i} tagText={tagText} isAccentBubble={isAccentBubble} />;
    }
    return <span key={i}>{part}</span>;
  });
};
