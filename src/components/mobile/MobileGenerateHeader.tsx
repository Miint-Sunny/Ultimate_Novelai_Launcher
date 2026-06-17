import { ChevronDown, RefreshCw } from 'lucide-react';
import type { AnlasInfo } from '../../services/novelai';
import { MODELS } from '../generation/modelResolutionOptions';

interface MobileGenerateHeaderProps {
  model: string;
  setModel: (model: string) => void;
  showModelDropdown: boolean;
  setShowModelDropdown: (show: boolean) => void;
  anlasInfo: AnlasInfo | null;
  isLoadingAnlas: boolean;
  fetchAnlas: () => void;
}

export function MobileGenerateHeader({
  model,
  setModel,
  showModelDropdown,
  setShowModelDropdown,
  anlasInfo,
  isLoadingAnlas,
  fetchAnlas,
}: MobileGenerateHeaderProps) {
  return (
    <header className="flex-shrink-0 flex items-center justify-between px-3 py-2 bg-nai-panel border-b border-gray-800">
      <div className="relative flex-1 max-w-[220px]">
        <button
          onClick={() => setShowModelDropdown(!showModelDropdown)}
          className="w-full flex items-center justify-between px-3 py-1.5 bg-gray-800/80 border border-gray-700/50 rounded-lg text-sm active:scale-[0.98]"
        >
          <span className="font-medium text-white">{MODELS.find((item) => item.id === model)?.name}</span>
          <ChevronDown className={`w-4 h-4 ml-1.5 text-gray-400 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
        </button>
        {showModelDropdown && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
            <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden animate-fade-in">
              {MODELS.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setModel(item.id);
                    setShowModelDropdown(false);
                  }}
                  className={`w-full px-3 py-2.5 text-left text-sm ${model === item.id ? 'bg-gray-700 text-nai-accent' : 'hover:bg-gray-700'}`}
                >
                  <div className="font-medium">{item.name}</div>
                  <div className="text-xs text-gray-500">{item.desc}</div>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
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
      </div>
    </header>
  );
}
