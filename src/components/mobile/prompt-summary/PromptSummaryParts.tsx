import type { ReactNode } from 'react';
import {
  NEWLINE_SENTINEL,
  parseCollapsibleMarker,
  splitPromptToTags,
} from '../../../utils/promptTags';
import { getMarkerVisual } from '../../tag-manager/markerVisual';

// 把 prompt 渲染为单行摘要：折叠标记展开为 [类型·名称]，换行哨兵过滤掉。
export function renderPromptSummary(prompt: string) {
  return splitPromptToTags(prompt)
    .filter((tag) => tag !== NEWLINE_SENTINEL)
    .map((tag) => {
      const marker = parseCollapsibleMarker(tag);
      return marker ? `[${getMarkerVisual(marker.type).label}·${marker.name}]` : tag;
    })
    .join(', ');
}

export interface PromptToolButtonProps {
  label: string;
  tone: 'purple' | 'amber' | 'pink' | 'cyan';
  icon: ReactNode;
  onClick: () => void;
}

// 提示词摘要卡底部的工具按钮（AI助手/画师串/灵感/OC），按 tone 着色。
export function PromptToolButton({ label, tone, icon, onClick }: PromptToolButtonProps) {
  const toneClass = {
    purple: 'bg-purple-500/15 text-purple-400 active:bg-purple-500/25',
    amber: 'bg-amber-500/15 text-amber-400 active:bg-amber-500/25',
    pink: 'bg-pink-500/15 text-pink-400 active:bg-pink-500/25',
    cyan: 'bg-cyan-500/15 text-cyan-400 active:bg-cyan-500/25',
  }[tone];

  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-colors ${toneClass}`}
    >
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}
