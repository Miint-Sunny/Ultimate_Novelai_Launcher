import { SIDEBAR_TABS, type SidebarTab } from '../../utils/sidebarTabs';

/**
 * 左栏顶部的分段控件(STYLE.md:单选是一颗胶囊分几段,不是几个独立块)。
 * sticky 在滚动区顶上:header 可以滚走,它不走。亮点 = 助手改了那个 tab 里的字段。
 */
export function SidebarTabBar({
  active,
  attention,
  onChange,
}: {
  active: SidebarTab;
  attention: readonly SidebarTab[];
  onChange: (tab: SidebarTab) => void;
}) {
  return (
    <div className="sticky top-0 z-40 bg-nai-panel px-3 pt-3 pb-1 shrink-0" data-testid="sidebar-tabs">
      <div role="tablist" aria-label="左栏分区" className="flex items-center bg-black/40 rounded-full p-1 border border-gray-700/50 select-none">
        {SIDEBAR_TABS.map((tab, index) => {
          const on = tab.id === active;
          const lit = !on && attention.includes(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-tab={tab.id}
              data-attention={lit ? 'true' : undefined}
              title={`${tab.hint}(⌥${index + 1})`}
              onClick={() => onChange(tab.id)}
              className={`relative flex-1 h-8 rounded-full text-[13px] font-bold transition-colors ${
                on ? 'bg-nai-accent text-black shadow-[0_0_8px_rgba(235,213,118,0.35)]' : 'text-gray-400 hover:text-white'
              }`}
            >
              {tab.label}
              {lit && (
                <span aria-label="助手改过这里" className="absolute top-1.5 right-2.5 w-1.5 h-1.5 rounded-full bg-nai-accent" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
