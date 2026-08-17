import React, { useState, useEffect, lazy, Suspense } from 'react';
import { GenerationProvider } from './contexts/GenerationContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { DragDropProvider } from './contexts/DragDropContext';
import { ChangelogModal } from './components/ChangelogModal';
import { WhatsNewModal } from './components/WhatsNewModal';
import { BillingSettlementModal } from './components/BillingSettlementModal';
import { NaiStatusBanner } from './components/NaiStatusBanner';
import { UpdateAvailableBanner } from './components/UpdateAvailableBanner';
import { botService } from './services/botService';
import { appBackendApi } from './api/appBackendApi';
import { initTheme } from './services/theme';
import { MOBILE_BREAKPOINT_PX } from './constants';

// Layout is chosen by WINDOW WIDTH, not device type: a wide tablet gets the
// desktop layout, and a narrowed desktop window gets the narrow ("mobile")
// layout. Both are split into separate chunks and lazy-loaded so startup only
// parses the current width's tree. The inactive layout is prefetched during
// idle (see App) so resizing across the 900px breakpoint switches instantly
// with no Suspense flash.
const AppContent = lazy(() => import('./AppContent'));
const MobileAppContent = lazy(() => import('./MobileAppContent'));

// Warm both layout chunks so a runtime width switch never blocks on a fetch.
function prefetchLayouts() {
  import('./AppContent');
  import('./MobileAppContent');
}

// 检测是否为移动设备(窄窗口)
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < MOBILE_BREAKPOINT_PX);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT_PX);
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  return isMobile;
};

// 结算弹窗自动检查：登录后每次进入网页检查是否有未支付账单
const BillingSettlementCheck: React.FC = () => {
  const { isAuthenticated } = useAuth();
  const [showSettlement, setShowSettlement] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    const sessionId = botService.getAuthState().sessionId;
    if (!sessionId) return;

    let cancelled = false;
    const check = async () => {
      try {
        const res = await appBackendApi.request('/api/billing/settlement', undefined, {
          session_id: sessionId,
        });
        if (cancelled || !res.ok) return;
        const data = await res.json();
        // 未支付且有金额 → 自动弹出
        if (data.payment_status === 'unpaid' && data.current_user?.total_fee > 0) {
          setShowSettlement(true);
        }
      } catch { /* ignore */ }
    };
    check();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  return (
    <BillingSettlementModal isOpen={showSettlement} onClose={() => setShowSettlement(false)} />
  );
};

function App() {
  const isMobile = useIsMobile();

  // 皮肤:启动时应用 settings.theme 并跟随设置变更(见 services/theme.ts)
  useEffect(() => {
    initTheme();
  }, []);

  // After first paint, prefetch the inactive layout during idle time so
  // resizing across the 900px breakpoint (or a tablet rotating) switches
  // instantly. The active layout is already loading via <Suspense> below.
  useEffect(() => {
    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(prefetchLayouts);
      return () => w.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(prefetchLayouts, 1500);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <AuthProvider>
      <GenerationProvider>
        <DragDropProvider>
          <Suspense fallback={<div className="h-screen bg-nai-bg" />}>
            {isMobile ? <MobileAppContent /> : <AppContent />}
          </Suspense>
          <NaiStatusBanner />
          <UpdateAvailableBanner />
          <WhatsNewModal />
          <ChangelogModal />
          <BillingSettlementCheck />
        </DragDropProvider>
      </GenerationProvider>
    </AuthProvider>
  );
}

export default App;
