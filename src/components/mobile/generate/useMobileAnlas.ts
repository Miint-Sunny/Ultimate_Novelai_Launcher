import { useEffect, useRef } from 'react';
import { useSharedAnlasStatus } from '../../../hooks/useSharedAnlasStatus';

// 薄壳:查询逻辑在 src/hooks/useSharedAnlasStatus.ts;
// 这里只保留移动端既有差异:生成完成(true→false)后自动刷新余额。
export function useMobileAnlas(isGenerating: boolean) {
  const { anlasInfo, isLoadingAnlas, fetchAnlas } = useSharedAnlasStatus();
  const wasGeneratingRef = useRef(false);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      void fetchAnlas();
    }
    wasGeneratingRef.current = isGenerating;
  }, [fetchAnlas, isGenerating]);

  return {
    anlasInfo,
    isLoadingAnlas,
    fetchAnlas,
  };
}
