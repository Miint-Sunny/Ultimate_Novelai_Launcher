import { ChevronDown, RefreshCw } from 'lucide-react';
import type { AnlasInfo } from '../../services/novelai';
import { MODELS } from '../generation/modelResolutionOptions';
import { MobilePageHeader } from './pager/MobilePageHeader';

interface MobileGenerateHeaderProps {
  model: string;
  setModel: (model: string) => void;
  showModelDropdown: boolean;
  setShowModelDropdown: (show: boolean) => void;
  anlasInfo: AnlasInfo | null;
  isLoadingAnlas: boolean;
  fetchAnlas: () => void;
  /** useScrollEdge 的输出(P7-1):卡片列滚离顶部 → 页头转均匀玻璃材质 */
  scrolled: boolean;
}

// 生图页头(P7-1):共享 MobilePageHeader 大标题形态,页级操作(模型选择 / Anlas 余额)
// 收进 trailing slot;dropdown 展开/收起交互与既有实现一致。
export function MobileGenerateHeader({
  model,
  setModel,
  showModelDropdown,
  setShowModelDropdown,
  anlasInfo,
  isLoadingAnlas,
  fetchAnlas,
  scrolled,
}: MobileGenerateHeaderProps) {
  return (
    <MobilePageHeader
      title="生图"
      scrolled={scrolled}
      trailing={
        <>
          <div className="relative max-w-[180px]">
            <button
              onClick={() => setShowModelDropdown(!showModelDropdown)}
              className="w-full flex items-center justify-between px-3 py-1.5 bg-gray-800/80 border border-gray-700/50 rounded-lg text-sm active:scale-[0.98]"
            >
              <span className="font-medium text-white truncate">{MODELS.find((item) => item.id === model)?.name}</span>
              <ChevronDown className={`w-4 h-4 ml-1.5 shrink-0 text-gray-400 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
            </button>
            {showModelDropdown && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
                <div className="absolute right-0 z-50 w-56 mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden animate-fade-in">
                  {MODELS.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setModel(item.id);
                        setShowModelDropdown(false);
                      }}
                      className={`w-full px-3 py-2.5 text-left text-sm ${model === item.id ? 'bg-gray-700 text-nai-accent' : 'active:bg-gray-700'}`}
                    >
                      <div className="font-medium">{item.name}</div>
                      <div className="text-xs text-gray-500">{item.desc}</div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={fetchAnlas}
            disabled={isLoadingAnlas}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800/80 border border-gray-700/50 rounded-lg active:scale-[0.98]"
          >
            <span className="text-base">💎</span>
            <span className="text-sm font-mono text-nai-accent min-w-[32px]">
              {isLoadingAnlas
                ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                : anlasInfo
                  ? anlasInfo.fixedTrainingStepsLeft + anlasInfo.purchasedTrainingSteps
                  : '—'}
            </span>
          </button>
        </>
      }
    />
  );
}
