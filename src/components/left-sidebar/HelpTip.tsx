import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  text?: string;
  title?: string;
  body?: string;
  bright?: boolean;
}

export const HelpTip: React.FC<HelpTipProps> = ({ text, title, body, bright }) => {
  const [show, setShow] = useState(false);
  const iconRef = useRef<SVGSVGElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const updatePos = () => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    const tipW = 260;
    let left = rect.left + rect.width / 2 - tipW / 2;
    if (left < 8) left = 8;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - 8 - tipW;
    setPos({ top: rect.top - 8, left });
  };

  const bodyText = body ?? text ?? '';
  const allLines = bodyText.split('\n').filter(l => l.trim().length > 0);
  const mainLines: string[] = [];
  const tipLines: string[] = [];

  for (const line of allLines) {
    const trimmed = line.trim();
    if (/^(💡|⚠️|⚠)/.test(trimmed)) {
      tipLines.push(trimmed.replace(/^(💡|⚠️|⚠)\s*/, ''));
    } else {
      mainLines.push(line);
    }
  }

  const renderMainLine = (line: string, idx: number) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('·')) {
      const rest = trimmed.slice(1).trim();
      return (
        <div key={idx} className="flex gap-1.5 items-start text-gray-300">
          <span className="text-gray-500 mt-[2px] text-[8px]">●</span>
          <span className="flex-1">{rest}</span>
        </div>
      );
    }
    return <div key={idx} className="text-gray-300">{trimmed}</div>;
  };

  return (
    <span className="relative inline-flex items-center ml-1 shrink-0">
      <HelpCircle
        ref={iconRef}
        className={`w-3 h-3 mt-[1px] ${bright ? 'text-white/80' : 'text-gray-500'} hover:text-nai-accent cursor-help transition-colors`}
        onMouseEnter={() => { updatePos(); setShow(true); }}
        onMouseLeave={() => setShow(false)}
        onClick={(e) => { e.stopPropagation(); updatePos(); setShow(!show); }}
      />
      {show && pos && createPortal(
        <div
          className="fixed w-[260px] px-3 py-2.5 text-[11px] leading-relaxed bg-gray-900/95 backdrop-blur-sm border border-gray-700/80 rounded-lg shadow-2xl ring-1 ring-black/30 z-[9999] pointer-events-none"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-100%)' }}
        >
          {title && (
            <div className="text-[12px] font-semibold text-nai-accent pb-1.5 mb-1.5 border-b border-nai-accent/25">
              {title}
            </div>
          )}
          {mainLines.length > 0 && (
            <div className="space-y-1">
              {mainLines.map(renderMainLine)}
            </div>
          )}
          {tipLines.length > 0 && (
            <div className={`${mainLines.length > 0 ? 'mt-2.5' : ''} px-2 py-1.5 bg-nai-accent/10 border-l-2 border-nai-accent/50 rounded-r`}>
              <div className="flex items-center gap-1 text-[10px] font-semibold text-nai-accent mb-1">
                <span className="leading-none">💡</span>
                <span className="tracking-wide">使用提示</span>
              </div>
              <div className="space-y-0.5">
                {tipLines.map((line, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start text-gray-300/95 leading-snug">
                    <span className="text-nai-accent/50 mt-[2px] text-[8px]">●</span>
                    <span className="flex-1">{line}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </span>
  );
};
