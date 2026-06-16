// 字母索引滚动条 - 复刻旧 ArtistManagerModal 的拖拽气泡, 可配置位置
//
// 用法:
//   <AlphabetRail
//     letters={availableLettersSet}      // 当前数据集里实际存在的首字母
//     activeLetter={activeLetter}         // 当前视口顶部对应字母 (panel 监听滚动后传入)
//     onJump={(letter) => scrollToLetter(letter)}
//     side="right"                       // 'left' | 'right'
//   />
import React, { useCallback, useRef, useState } from 'react';
import { pinyin } from 'pinyin-pro';

const ALPHABET = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

export function getLetterForName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '#';
  const first = trimmed.charAt(0);
  const upper = first.toUpperCase();
  if (/[A-Z]/.test(upper)) return upper;
  // 中文/其它字符 → 取拼音首字母 (失败回退到 #)
  try {
    const py = pinyin(first, { pattern: 'first', toneType: 'none', type: 'string', nonZh: 'consecutive' });
    const ch = (py || '').charAt(0).toUpperCase();
    return /[A-Z]/.test(ch) ? ch : '#';
  } catch {
    return '#';
  }
}

interface Props {
  letters: Set<string>;
  activeLetter: string | null;
  onJump: (letter: string) => void;
  side?: 'left' | 'right';
}

export const AlphabetRail: React.FC<Props> = ({
  letters, activeLetter, onJump, side = 'right',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragLetter, setDragLetter] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const letterFromY = useCallback((clientY: number): string | null => {
    const bar = barRef.current;
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const idx = Math.min(Math.floor(ratio * ALPHABET.length), ALPHABET.length - 1);
    return ALPHABET[idx];
  }, []);

  // 跳到指定字母 (没数据则向相邻字母 fallback)
  const resolveJump = useCallback((letter: string) => {
    if (letters.has(letter)) return letter;
    const idx = ALPHABET.indexOf(letter);
    for (let i = idx + 1; i < ALPHABET.length; i++) {
      if (letters.has(ALPHABET[i])) return ALPHABET[i];
    }
    for (let i = idx - 1; i >= 0; i--) {
      if (letters.has(ALPHABET[i])) return ALPHABET[i];
    }
    return null;
  }, [letters]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    const l = letterFromY(e.clientY);
    if (!l) return;
    const target = resolveJump(l);
    if (target) {
      setDragLetter(target);
      onJump(target);
    }
  }, [letterFromY, resolveJump, onJump]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;
    e.preventDefault();
    const l = letterFromY(e.clientY);
    if (!l) return;
    const target = resolveJump(l);
    if (target) {
      setDragLetter(target);
      onJump(target);
    }
  }, [isDragging, letterFromY, resolveJump, onJump]);

  const handlePointerUp = useCallback(() => {
    setIsDragging(false);
    setTimeout(() => setDragLetter(null), 400);
  }, []);

  return (
    <div className={`relative shrink-0 ${side === 'left' ? 'order-first' : 'order-last'}`}>
      <div
        ref={barRef}
        className={`w-7 h-full flex flex-col items-center py-1.5 select-none touch-none transition-colors ${
          side === 'left' ? 'border-r' : 'border-l'
        } ${
          isDragging
            ? 'bg-nai-accent/10 border-nai-accent/30'
            : 'bg-nai-dark/40 border-gray-800/50'
        }`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {ALPHABET.map(letter => {
          const isAvailable = letters.has(letter);
          const isActive = activeLetter === letter;
          return (
            <div
              key={letter}
              className={`w-full flex items-center justify-center cursor-pointer transition-all duration-100 ${
                isActive
                  ? 'text-nai-accent font-black text-[12px]'
                  : isAvailable
                    ? 'text-gray-300 font-bold text-[10px]'
                    : 'text-gray-700/40 text-[9px]'
              }`}
              style={{ flex: '1 1 0', minHeight: 0 }}
            >
              {letter}
            </div>
          );
        })}
      </div>
      {isDragging && dragLetter && (
        <div
          className={`absolute pointer-events-none z-30 ${side === 'left' ? 'left-9' : 'right-9'}`}
          style={{
            top: `${(ALPHABET.indexOf(dragLetter) / (ALPHABET.length - 1)) * 100}%`,
            transform: 'translateY(-50%)',
          }}
        >
          <div className="w-11 h-11 rounded-xl bg-nai-accent text-[#1a1410] font-black text-xl flex items-center justify-center shadow-[0_4px_20px_rgba(252,237,164,0.4)]">
            {dragLetter}
          </div>
        </div>
      )}
    </div>
  );
};
