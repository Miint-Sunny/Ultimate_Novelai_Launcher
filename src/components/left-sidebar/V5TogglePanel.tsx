import { useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  V5_TOGGLE_GROUPS,
  activeV5Toggles,
  toggleV5Word,
} from '../../services/naiV5Toggles';

interface V5TogglePanelProps {
  prompt: string;
  onPromptChange: (value: string) => void;
  /** 触屏档:点击区放大到能用手指点。桌面端不传。 */
  touch?: boolean;
}

/**
 * V5 开关词条快捷面板。
 *
 * 默认折叠。提示词框的高度是用户可拖的、寸土寸金,常驻一排词条会把它挤掉;
 * 折叠态只占一行,并把「已开几项」显示在标题上,所以收起来也不瞎。
 *
 * 词表与增删逻辑都在 services/naiV5Toggles.ts,这里只管呈现——两端(桌面/移动)
 * 共用同一份表,不要在组件里各写一份。
 */
export function V5TogglePanel({ prompt, onPromptChange, touch = false }: V5TogglePanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const active = useMemo(() => activeV5Toggles(prompt), [prompt]);
  // 触屏下按钮要够大:桌面 20px 高的胶囊在手指下是点不准的。
  const optionSize = touch ? 'px-3 py-1.5 text-xs' : 'px-2 py-0.5 text-[11px]';

  return (
    <div className="px-2 pb-1.5">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title="V5 专有词条:写进提示词即生效,拼错不会报错,所以从这里点"
        className="w-full flex items-center justify-between text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          V5 词条
          {active.size > 0 && (
            <span className="px-1 rounded bg-nai-accent/20 text-nai-accent">{active.size}</span>
          )}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
      </button>

      {isOpen && (
        <div className="mt-1.5 space-y-2 animate-in slide-in-from-top-1 duration-150">
          {V5_TOGGLE_GROUPS.map((group) => (
            <div key={group.id}>
              <div className="text-[10px] text-gray-500 mb-1" title={group.hint}>
                {group.title}
              </div>
              <div className="flex flex-wrap gap-1">
                {group.options.map((option) => {
                  const isActive = active.has(option.literal.toLowerCase());
                  return (
                    <button
                      key={option.literal}
                      type="button"
                      onClick={() => onPromptChange(toggleV5Word(prompt, group.id, option.literal))}
                      title={`${option.literal}${isActive ? '(已在提示词中,点击移除)' : ''}`}
                      className={`${optionSize} rounded border transition-colors ${
                        isActive
                          ? 'bg-nai-accent/20 text-nai-accent border-nai-accent'
                          : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white hover:border-gray-600'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
