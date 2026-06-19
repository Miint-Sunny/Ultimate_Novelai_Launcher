import React, { type RefObject } from 'react';

interface FullscreenRawTextEditorProps {
  type: 'prompt' | 'undesired';
  value: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSaveValue: (value: string) => void;
  onTriggerAutocomplete: (text: string) => void;
}

export const FullscreenRawTextEditor: React.FC<FullscreenRawTextEditorProps> = ({
  type,
  value,
  textareaRef,
  onSaveValue,
  onTriggerAutocomplete,
}) => (
  <div className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-2">
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => {
        onSaveValue(event.target.value);
        const pos = event.target.selectionStart;
        const before = event.target.value.slice(0, pos);
        const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
        const current = before.slice(lastComma + 1).trim();
        onTriggerAutocomplete(current);
      }}
      placeholder={type === 'prompt' ? '输入提示词，逗号分隔...' : '输入排除标签...'}
      className="w-full h-full bg-transparent text-white text-[13px] font-mono outline-none placeholder-gray-600 resize-none leading-relaxed"
      autoFocus
    />
  </div>
);
