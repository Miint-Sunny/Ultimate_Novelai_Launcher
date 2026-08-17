import React, { useCallback, useEffect, useRef, useState } from 'react';
import { User } from 'lucide-react';
import { useGeneration } from '../../../contexts/GenerationContext';
import { dispatchBackHandlers } from '../MobileLayout';
import { MobileGeneratePage } from '../MobileGeneratePage';
import { MobileGalleryPage } from '../MobileImagePage';
import { MobileAIPage } from './MobileAIPage';
import { MobileMineSheet } from './MobileMineSheet';
import { MobilePageBar } from './MobilePageBar';
import { MobileStudioPage } from './MobileStudioPage';
import { usePagerPanGesture } from './usePagerPanGesture';

const PAGE_COUNT = 4;
const DEFAULT_PAGE = 1; // 生图
const GALLERY_PAGE = 3;

interface MobilePagerShellProps {
  onLogout?: () => void;
}

// P3 分页壳:横向 4 页 [0 AI][1 生图(默认)][2 创作室][3 图库] + 悬浮页栏 + 「我的」sheet。
// 手势分层:图库页永不出让、覆盖物打开期间手势失效、屏幕左右 20px 边缘豁免
// (见 usePagerPanGesture 头部注释);BackHandler 注册表/popstate 链语义与 tabs 壳对齐:
// 覆盖物 → sheet 栈 → 页内历史 → 兜底回页 1(生图),AI 页按返回 = 回生图。
export const MobilePagerShell: React.FC<MobilePagerShellProps> = ({ onLogout }) => {
  const [activePage, setActivePage] = useState(DEFAULT_PAGE);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isMineOpen, setIsMineOpen] = useState(false);
  const [isStudioOverlayOpen, setIsStudioOverlayOpen] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight);

  const { isGenerating, isQueuing } = useGeneration();

  // 页历史(与 tabs 壳 tabHistoryRef 同语义)
  const pageHistoryRef = useRef<number[]>([DEFAULT_PAGE]);

  // 监听视口高度变化(处理移动端浏览器地址栏显示/隐藏)
  useEffect(() => {
    const updateHeight = () => {
      setViewportHeight(window.innerHeight);
    };

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

  // 切页时更新历史并推入 history state
  const navigate = useCallback((page: number) => {
    if (page !== activePage) {
      const history = pageHistoryRef.current;
      if (history[history.length - 1] !== page) {
        history.push(page);
        if (history.length > 10) {
          history.shift();
        }
      }
      setActivePage(page);
      window.history.pushState({ page }, '');
    }
  }, [activePage]);

  // 浏览器返回键拦截:覆盖物(注册表)→ 编辑器 → 页历史 → 兜底回生图
  useEffect(() => {
    window.history.pushState({ page: DEFAULT_PAGE, initial: true }, '');

    const handlePopState = () => {
      // 子组件返回逻辑(mine sheet / 图库栈 / 生图页各 sheet / 创作室覆盖物)
      if (dispatchBackHandlers()) {
        window.history.pushState({ handled: true }, '');
        return;
      }

      if (isEditorOpen) {
        window.dispatchEvent(new CustomEvent('mobile-back-pressed'));
        window.history.pushState({ editor: true }, '');
        return;
      }

      const history = pageHistoryRef.current;
      if (history.length > 1) {
        history.pop();
        const prevPage = history[history.length - 1];
        setActivePage(prevPage);
        window.history.pushState({ page: prevPage }, '');
        return;
      }

      // AI 页(或任何非默认页)按返回 = 回生图,不退出
      if (activePage !== DEFAULT_PAGE) {
        setActivePage(DEFAULT_PAGE);
        pageHistoryRef.current = [DEFAULT_PAGE];
        window.history.pushState({ page: DEFAULT_PAGE }, '');
        return;
      }

      // 已在生图页且历史见底:让浏览器处理(允许退出)
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [activePage, isEditorOpen]);

  // 开始生成时自动跳图库(页 3),只在 false→true 边沿触发一次
  const prevGeneratingRef = useRef(false);
  useEffect(() => {
    const wasGenerating = prevGeneratingRef.current;
    const nowGenerating = isGenerating || isQueuing;

    if (!wasGenerating && nowGenerating) {
      navigate(GALLERY_PAGE);
    }

    prevGeneratingRef.current = nowGenerating;
  }, [isGenerating, isQueuing, navigate]);

  // window 事件桥:既有事件映射为页导航;pager-navigate 为壳内导航事件
  useEffect(() => {
    const toGallery = () => navigate(GALLERY_PAGE);
    const toGenerate = () => navigate(DEFAULT_PAGE);
    const onPagerNavigate = (event: Event) => {
      const page = (event as CustomEvent).detail?.page;
      if (typeof page === 'number' && page >= 0 && page < PAGE_COUNT) {
        navigate(page);
      }
    };

    window.addEventListener('open-inpaint-mode', toGallery);
    window.addEventListener('switch-to-generate', toGenerate);
    window.addEventListener('open-image-import', toGenerate);
    window.addEventListener('pager-navigate', onPagerNavigate);
    return () => {
      window.removeEventListener('open-inpaint-mode', toGallery);
      window.removeEventListener('switch-to-generate', toGenerate);
      window.removeEventListener('open-image-import', toGenerate);
      window.removeEventListener('pager-navigate', onPagerNavigate);
    };
  }, [navigate]);

  // 手势分层:图库页永不出让;覆盖物(mine sheet / 创作室 inpaint·upscale / 编辑器)打开期间失效
  const gestureEnabled =
    activePage !== GALLERY_PAGE && !isMineOpen && !isStudioOverlayOpen && !isEditorOpen;
  const { dragOffset, containerProps } = usePagerPanGesture({
    activePage,
    pageCount: PAGE_COUNT,
    enabled: gestureEnabled,
    onNavigate: navigate,
  });

  // 图库工具条「重绘/放大」:带当前图跳创作室(页 2)并触发对应操作卡
  const handleStudioTool = useCallback((tool: 'inpaint' | 'upscale') => {
    navigate(2);
    window.dispatchEvent(new CustomEvent('studio-open-tool', { detail: { tool } }));
  }, [navigate]);

  return (
    <div
      className="flex flex-col bg-nai-bg text-white overflow-hidden"
      style={{ height: viewportHeight }}
    >
      <div className="flex-1 overflow-hidden relative">
        <div
          className="absolute inset-0"
          style={{ touchAction: 'pan-y' }}
          {...containerProps}
        >
          <div
            className="h-full flex"
            style={{
              width: `${PAGE_COUNT * 100}%`,
              transform: `translateX(calc(${(-activePage * 100) / PAGE_COUNT}% + ${dragOffset ?? 0}px))`,
              // P7-1:松手后的归位过渡用 iOS 弹性曲线(拖动中无过渡,跟手)
              transition: dragOffset === null ? 'transform 300ms var(--ease-spring)' : 'none',
            }}
          >
            <div className="h-full shrink-0 overflow-hidden" style={{ width: `${100 / PAGE_COUNT}%` }}>
              <MobileAIPage onOpenMine={() => setIsMineOpen(true)} />
            </div>
            <div className="h-full shrink-0 overflow-hidden" style={{ width: `${100 / PAGE_COUNT}%` }}>
              <MobileGeneratePage onEditorStateChange={setIsEditorOpen} aiAssistantAsPage />
            </div>
            <div className="h-full shrink-0 overflow-hidden" style={{ width: `${100 / PAGE_COUNT}%` }}>
              <MobileStudioPage onOverlayStateChange={setIsStudioOverlayOpen} />
            </div>
            <div className="h-full shrink-0 overflow-hidden" style={{ width: `${100 / PAGE_COUNT}%` }}>
              <MobileGalleryPage onStudioTool={handleStudioTool} />
            </div>
          </div>
        </div>
      </div>

      {/* 悬浮页栏:编辑器全屏打开时隐藏(与旧底栏行为一致) */}
      {!isEditorOpen && (
        <MobilePageBar activePage={activePage} onNavigate={navigate} />
      )}

      {/* 头像钮:各页常驻右上角;覆盖物/编辑器打开时让位。
          不用 .glass:常驻页栏 + scrolled 页头已占满同屏 ≤2 层实时模糊预算(§4.2),
          头像钮用纯色近似档 */}
      {!isEditorOpen && !isStudioOverlayOpen && (
        <button
          onClick={() => setIsMineOpen(true)}
          title="我的"
          className="fixed z-30 w-9 h-9 rounded-full flex items-center justify-center bg-nai-panel/90 border border-white/10 text-gray-300 active:text-white transition-colors"
          style={{
            top: 'calc(env(safe-area-inset-top, 0px) + 8px)',
            right: 12,
          }}
        >
          <User className="w-4 h-4" />
        </button>
      )}

      <MobileMineSheet
        isOpen={isMineOpen}
        onClose={() => setIsMineOpen(false)}
        onLogout={onLogout}
      />
    </div>
  );
};
