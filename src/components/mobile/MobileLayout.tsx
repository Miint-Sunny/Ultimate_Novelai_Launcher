import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sparkles, Image as ImageIcon, Settings, Wrench } from 'lucide-react';
import { MobileGeneratePage } from './MobileGeneratePage';
import { MobileGalleryPage } from './MobileImagePage';
import { MobileSettingsPage } from './MobileSettingsPage';
import { MobileToolsPage } from './MobileToolsPage';
import { MobilePagerShell } from './pager/MobilePagerShell';
import { getShellMode } from '../../services/shellMode';
import { useGeneration } from '../../contexts/GenerationContext';

type TabType = 'generate' | 'gallery' | 'tools' | 'settings';

interface TabConfig {
  id: TabType;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabConfig[] = [
  { id: 'generate', label: '生成', icon: <Sparkles className="w-5 h-5" /> },
  { id: 'gallery', label: '图库', icon: <ImageIcon className="w-5 h-5" /> },
  { id: 'tools', label: '工具', icon: <Wrench className="w-5 h-5" /> },
  { id: 'settings', label: '设置', icon: <Settings className="w-5 h-5" /> },
];

interface MobileLayoutProps {
  onLogout?: () => void;
}

// 返回处理器注册表 - 用于子组件注册自己的返回处理逻辑
type BackHandler = () => boolean; // 返回 true 表示已处理，false 表示未处理
const backHandlers = new Set<BackHandler>();

export const registerBackHandler = (handler: BackHandler): (() => void) => {
  backHandlers.add(handler);
  return () => { backHandlers.delete(handler); };
};

// P3 pager 壳专用:迭代已注册的返回处理器(与下方 tabs 壳 popstate 里的内联迭代同语义;
// tabs 路径保持原样不改,pager 壳经此导出复用同一注册表)。
export const dispatchBackHandlers = (): boolean => {
  for (const handler of backHandlers) {
    if (handler()) {
      return true;
    }
  }
  return false;
};

const MobileTabsLayout: React.FC<MobileLayoutProps> = ({ onLogout }) => {
  const [activeTab, setActiveTab] = useState<TabType>('generate');
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);

  const { isGenerating, isQueuing } = useGeneration();

  // 用于追踪 tab 历史
  const tabHistoryRef = useRef<TabType[]>(['generate']);

  // 监听视口高度变化（处理移动端浏览器地址栏显示/隐藏）
  useEffect(() => {
    const updateHeight = () => {
      setViewportHeight(window.innerHeight);
    };

    // 使用 visualViewport API（更准确）
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateHeight);
    }
    window.addEventListener('resize', updateHeight);

    return () => {
      if (window.visualViewport) {
        window.visualViewport.removeEventListener('resize', updateHeight);
      }
      window.removeEventListener('resize', updateHeight);
    };
  }, []);

  // 切换 tab 时更新历史
  const handleTabChange = useCallback((newTab: TabType) => {
    if (newTab !== activeTab) {
      // 添加到历史（避免重复）
      const history = tabHistoryRef.current;
      if (history[history.length - 1] !== newTab) {
        history.push(newTab);
        // 限制历史长度
        if (history.length > 10) {
          history.shift();
        }
      }
      setActiveTab(newTab);
      // 推入一个新的 history state
      window.history.pushState({ tab: newTab }, '');
    }
  }, [activeTab]);

  // 浏览器返回键拦截
  useEffect(() => {
    // 初始化时推入一个 state，防止第一次返回就退出
    window.history.pushState({ tab: 'generate', initial: true }, '');

    const handlePopState = (event: PopStateEvent) => {
      // 首先检查子组件是否有需要处理的返回逻辑（如关闭 modal）
      for (const handler of backHandlers) {
        if (handler()) {
          // 子组件已处理，重新推入 state 保持拦截
          window.history.pushState({ handled: true }, '');
          return;
        }
      }

      // 检查编辑器是否打开
      if (isEditorOpen) {
        // 编辑器打开时，通过事件通知关闭
        window.dispatchEvent(new CustomEvent('mobile-back-pressed'));
        window.history.pushState({ editor: true }, '');
        return;
      }

      // 如果不在默认 tab，返回到上一个 tab
      const history = tabHistoryRef.current;
      if (history.length > 1) {
        history.pop(); // 移除当前
        const prevTab = history[history.length - 1];
        setActiveTab(prevTab);
        window.history.pushState({ tab: prevTab }, '');
        return;
      }

      // 已经在初始状态，允许退出（不阻止）
      // 但为了防止意外退出，再给一次机会
      if (activeTab !== 'generate') {
        setActiveTab('generate');
        tabHistoryRef.current = ['generate'];
        window.history.pushState({ tab: 'generate' }, '');
        return;
      }

      // 真正要退出了，不做任何操作让浏览器处理
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [activeTab, isEditorOpen]);

  // 当开始生成时自动切换到图库页（只在状态从 false 变为 true 时触发一次）
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    const wasGenerating = prevGeneratingRef.current;
    const nowGenerating = isGenerating || isQueuing;

    // 只在从非生成状态变为生成状态时切换
    if (!wasGenerating && nowGenerating) {
      handleTabChange('gallery');
    }

    prevGeneratingRef.current = nowGenerating;
  }, [isGenerating, isQueuing, handleTabChange]);

  // 监听打开重绘模式事件，自动切换到图库页
  useEffect(() => {
    const handler = () => handleTabChange('gallery');
    window.addEventListener('open-inpaint-mode', handler);
    return () => window.removeEventListener('open-inpaint-mode', handler);
  }, [handleTabChange]);

  // 监听切换到生成页事件（从工具页导入提示词后触发）
  useEffect(() => {
    const handler = () => handleTabChange('generate');
    window.addEventListener('switch-to-generate', handler);
    return () => window.removeEventListener('switch-to-generate', handler);
  }, [handleTabChange]);

  // 监听从图库页发来的导入元数据事件，切换到生成页显示导入面板
  useEffect(() => {
    const handler = () => handleTabChange('generate');
    window.addEventListener('open-image-import', handler);
    return () => window.removeEventListener('open-image-import', handler);
  }, [handleTabChange]);

  return (
    <div
      className="flex flex-col bg-nai-bg text-white overflow-hidden"
      style={{ height: viewportHeight }}
    >
      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden relative">
        {/* 生成页 */}
        <div
          className={`absolute inset-0 transition-transform duration-300 ease-out ${activeTab === 'generate' ? 'translate-x-0' : '-translate-x-full'
            }`}
        >
          <MobileGeneratePage onEditorStateChange={setIsEditorOpen} />
        </div>

        {/* 图库页 */}
        <div
          className={`absolute inset-0 transition-transform duration-300 ease-out ${activeTab === 'gallery'
              ? 'translate-x-0'
              : activeTab === 'generate'
                ? 'translate-x-full'
                : '-translate-x-full'
            }`}
        >
          <MobileGalleryPage />
        </div>

        {/* 工具页 */}
        <div
          className={`absolute inset-0 transition-transform duration-300 ease-out ${activeTab === 'tools'
              ? 'translate-x-0'
              : (['generate', 'gallery'] as TabType[]).includes(activeTab)
                ? 'translate-x-full'
                : '-translate-x-full'
            }`}
        >
          <MobileToolsPage />
        </div>

        {/* 设置页 */}
        <div
          className={`absolute inset-0 transition-transform duration-300 ease-out ${activeTab === 'settings' ? 'translate-x-0' : 'translate-x-full'
            }`}
        >
          <MobileSettingsPage onLogout={onLogout} />
        </div>
      </div>

      {/* 底部导航栏 - 编辑器打开时隐藏 */}
      {!isEditorOpen && (
        <nav className="flex-shrink-0 bg-nai-panel border-t border-gray-800">
          <div className="flex items-center justify-around h-14">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`flex flex-col items-center justify-center flex-1 h-full transition-colors ${activeTab === tab.id
                    ? 'text-nai-accent'
                    : 'text-gray-500 active:text-gray-300'
                  }`}
              >
                {tab.icon}
                <span className="text-xs mt-0.5">{tab.label}</span>
              </button>
            ))}
          </div>
          {/* 底部安全区域填充 */}
          <div className="safe-area-bottom bg-nai-panel" />
        </nav>
      )}
    </div>
  );
};

// P3 feature flag 分叉:nai_shell_mode = 'tabs' 走上方旧壳(实现原样,一行未动);
// 默认 'pager' 走新分页壳(src/components/mobile/pager/)。运行期不切换,启动读一次。
export const MobileLayout: React.FC<MobileLayoutProps> = ({ onLogout }) => {
  const [shellMode] = useState(getShellMode);
  if (shellMode === 'tabs') {
    return <MobileTabsLayout onLogout={onLogout} />;
  }
  return <MobilePagerShell onLogout={onLogout} />;
};
