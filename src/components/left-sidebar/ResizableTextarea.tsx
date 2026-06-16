import React, { useEffect, useRef, useState } from 'react';
import PromptEditor from '../PromptEditor';

interface ResizableTextareaProps {
  minHeight?: number;
  maxHeight?: number;
  autoExpand?: boolean;
  paddingBottom?: number;
  disableHighlight?: boolean;
  enableHoverTranslate?: boolean;
  enableAutocomplete?: boolean;
  onValueChange?: (newValue: string) => void;
  value?: string;
  className?: string;
  style?: React.CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  children?: React.ReactNode;
  onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

export const ResizableTextarea: React.FC<ResizableTextareaProps> = ({
  minHeight = 80,
  maxHeight = 400,
  autoExpand = false,
  paddingBottom = 0,
  className,
  children,
  style,
  disableHighlight,
  onValueChange,
  value,
  placeholder,
  disabled,
  onChange,
}) => {
  const [height, setHeight] = useState(minHeight);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerMeasureRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  useEffect(() => {
    if (!autoExpand || manualHeight !== null) return;

    const measureDiv = document.createElement('div');
    measureDiv.style.cssText = `
      position: absolute;
      visibility: hidden;
      white-space: pre-wrap;
      word-wrap: break-word;
      width: ${containerMeasureRef.current?.offsetWidth || textareaRef.current?.offsetWidth || 300}px;
      font-size: 14px;
      font-family: monospace;
      padding: 8px;
      line-height: 1.5;
    `;
    measureDiv.textContent = String(value || '');
    document.body.appendChild(measureDiv);

    const contentHeight = measureDiv.scrollHeight + paddingBottom;
    document.body.removeChild(measureDiv);

    const newHeight = Math.min(Math.max(minHeight, contentHeight), maxHeight);
    setHeight(newHeight);
  }, [value, autoExpand, minHeight, maxHeight, paddingBottom, manualHeight]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const deltaY = e.clientY - startY.current;
      const newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight.current + deltaY));
      setHeight(newHeight);
      setManualHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minHeight, maxHeight]);

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    startY.current = e.clientY;
    startHeight.current = height;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  };

  return (
    <div ref={containerMeasureRef} className="relative w-full group/input">
      {disableHighlight ? (
        <textarea
          ref={textareaRef}
          style={{ ...style, height: `${height}px`, paddingBottom: paddingBottom > 0 ? `${paddingBottom}px` : undefined }}
          className={`${className} resize-none`}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={onChange}
        />
      ) : (
        <PromptEditor
          disableCollapsibleTags
          style={{ ...style, height: `${height}px`, paddingBottom: paddingBottom > 0 ? `${paddingBottom}px` : undefined }}
          containerClassName="w-full"
          className={`${className} resize-none`}
          value={String(value || '')}
          onChange={(text) => onValueChange?.(text)}
          placeholder={placeholder}
        >
          {children}
        </PromptEditor>
      )}
      <div
        className="absolute bottom-0 left-0 right-0 h-1.5 cursor-ns-resize z-20 hover:bg-white/20 transition-colors"
        onMouseDown={handleMouseDown}
        title="Drag to resize"
      />
      {!disableHighlight && children}
    </div>
  );
};
