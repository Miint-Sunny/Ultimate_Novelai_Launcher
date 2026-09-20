import type { ReactNode } from 'react';
import { LIBRARY_PANES, type LibraryPane } from '../../utils/sidebarTabs';

/**
 * 「库」tab 的壳:二级分段控件(标签 / 片段 / 预设)+ 内容区。
 * 内容由父级喂——三个管理器的内嵌形态(同一套组件,只是没有弹窗外壳);
 * 每个管理器自己的头上有「在弹窗里打开」(外置)和关闭,关闭 = 回到进库前的 tab。
 * 照 fork 的做法占满整栏;来路的记忆在 utils/sidebarTabs.ts。
 */
export function LibraryTabView({
  pane,
  onPaneChange,
  children,
}: {
  pane: LibraryPane;
  onPaneChange: (pane: LibraryPane) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="library-tab">
      <div className="flex items-center px-3 pt-2 pb-2 shrink-0">
        <div role="tablist" aria-label="库" className="flex items-center bg-black/40 rounded-full p-0.5 border border-gray-700/50 select-none">
          {LIBRARY_PANES.map((item) => {
            const on = pane === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={on}
                data-pane={item.id}
                onClick={() => onPaneChange(item.id)}
                className={`px-3 h-7 rounded-full text-[12px] font-bold transition-colors ${on ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white'}`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 border-t border-gray-800">{children}</div>
    </div>
  );
}
