import React, { useState } from 'react';
import { C, MONO } from './tokens';

type Diff = 'add' | 'rem' | undefined;

interface Props {
  children: React.ReactNode;
  diff?: Diff;
  /** 覆盖默认要复制的文本（默认用 children 的文本去掉 +/− 前缀） */
  copyText?: string;
  /** 可选：chip 下方另起一行的小字（如 tag 中文翻译） */
  subText?: string;
}

/**
 * Tag 胶囊。点击复制单个 tag + 显示 toast。
 * 三态：默认（accent 黄） / add（绿） / rem（红删除线）。
 */
export const TagChip: React.FC<Props> = ({ children, diff, copyText, subText }) => {
  const [copied, setCopied] = useState(false);
  const [hovering, setHovering] = useState(false);
  const text = (copyText ?? String(children)).replace(/^[+−]\s*/, '');

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const color =
    diff === 'add' ? C.ok : diff === 'rem' ? C.err : copied ? C.bgDeep : C.accent;
  const bg =
    diff === 'add'
      ? C.diffAddBg
      : diff === 'rem'
      ? C.diffRemBg
      : copied
      ? C.accent
      : C.accentSoft;
  const borderColor =
    diff === 'add'
      ? C.diffAddBorder
      : diff === 'rem'
      ? C.diffRemBorder
      : C.accentLine;

  const showTip = !copied && hovering && !!subText;

  return (
    <span style={{ position: 'relative', display: 'inline-block' }}>
      <span
        className="no-drag"
        onClick={handleCopy}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 7px',
          margin: '1px 2px',
          fontFamily: MONO,
          fontSize: 11,
          color,
          background: bg,
          border: '1px solid',
          borderColor,
          borderRadius: 999,
          cursor: 'pointer',
          textDecoration: diff === 'rem' ? 'line-through' : 'none',
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
          userSelect: 'none',
        }}
      >
        <span>{children}</span>
      </span>
      {(copied || showTip) && (
        <span
          className="aa-toast-in"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '2px 8px',
            fontSize: 10.5,
            fontWeight: copied ? 700 : 500,
            color: copied ? C.ok : C.text,
            background: 'rgba(0,0,0,0.88)',
            border: `1px solid ${copied ? 'rgba(124,220,165,0.4)' : C.borderStrong}`,
            borderRadius: 4,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 99,
          }}
        >
          {copied ? '已复制' : subText}
        </span>
      )}
    </span>
  );
};

/**
 * 把含 TAG[[xxx]] 的文本切成 React 节点（chip + 普通文本混排）。
 * diffMap：tag → 'add' / 'rem'，让某些 chip 显示 diff 色。
 */
export function renderTagContent(
  content: string,
  diffMap?: Record<string, Diff>,
): React.ReactNode {
  if (!content) return null;
  const parts = content.split(/(TAG\[\[.*?\]\])/g);
  return parts.map((part, i) => {
    if (part.startsWith('TAG[[') && part.endsWith(']]')) {
      const tag = part.slice(5, -2).trim();
      const d = diffMap?.[tag];
      return (
        <TagChip key={i} diff={d}>
          {tag}
        </TagChip>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

/** 从 TAG[[xxx]] 文本里提取 tag 列表（兼容用于已有 thinking 文案的 diff 计算） */
export function extractTagMarkers(content: string): string[] {
  if (!content) return [];
  const tags: string[] = [];
  const re = /TAG\[\[(.*?)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) tags.push(m[1].trim());
  return tags;
}
