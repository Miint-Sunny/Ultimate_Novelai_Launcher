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
import { getBackendUrl } from './utils/apiConfig';

// Desktop and mobile layouts are split into separate chunks so each device only
// downloads/parses the UI tree it actually renders.
const AppContent = lazy(() => import('./AppContent'));
const MobileAppContent = lazy(() => import('./MobileAppContent'));

// 检测是否为移动设备
const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
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
        const res = await fetch(`${getBackendUrl()}/api/billing/settlement?session_id=${sessionId}`);
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
