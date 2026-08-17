import { useEffect, useState } from 'react';
import { onlineService } from '../../services/botService';
import { useSharedAnlasStatus } from '../../hooks/useSharedAnlasStatus';

// 薄壳:查询逻辑在 src/hooks/useSharedAnlasStatus.ts(500ms 最短 loading);
// 这里保留桌面专属的在线人数订阅与挂载即查,行为与原实现一致。
export function useAnlasStatus() {
  const { anlasInfo, isLoadingAnlas, fetchAnlas } = useSharedAnlasStatus({
    minLoadingDurationMs: 500,
  });
  const [onlineCount, setOnlineCount] = useState(0);

  useEffect(() => {
    void fetchAnlas();
  }, [fetchAnlas]);

  useEffect(() => {
    onlineService.start();
    const unsubscribe = onlineService.addEventListener(setOnlineCount);
    return () => {
      unsubscribe();
      onlineService.stop();
    };
  }, []);

  return {
    anlasInfo,
    isLoadingAnlas,
    onlineCount,
    fetchAnlas,
  };
}
