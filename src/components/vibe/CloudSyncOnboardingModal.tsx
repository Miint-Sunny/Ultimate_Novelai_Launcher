import React, { useState } from 'react';
import { Cloud, X, Loader2, Check } from 'lucide-react';

export interface OnboardingChoices {
  uploadLocalVibes: boolean;
  uploadLocalTags: boolean;
  pullCloudVibes: boolean;
}

interface CloudSyncOnboardingModalProps {
  isOpen: boolean;
  /** 当前账号本地 vibe 总数 */
  localVibeCount: number;
  /** 当前账号本地标签数 */
  localTagCount: number;
  onSkip: () => void;
  onConfirm: (choices: OnboardingChoices) => Promise<void> | void;
}

/**
 * Vibe 云同步首次启用引导弹窗
 *
 * 用户在这里选择首次同步的范围：上传本地 / 上传标签 / 拉取云端
 */
export const CloudSyncOnboardingModal: React.FC<CloudSyncOnboardingModalProps> = ({
  isOpen,
  localVibeCount,
  localTagCount,
  onSkip,
  onConfirm,
}) => {
  const [choices, setChoices] = useState<OnboardingChoices>({
    uploadLocalVibes: true,
    uploadLocalTags: true,
    pullCloudVibes: false,
  });
  const [running, setRunning] = useState(false);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    setRunning(true);
    try {
      await onConfirm(choices);
    } finally {
      setRunning(false);
    }
  };

  const toggle = (key: keyof OnboardingChoices) => {
    if (running) return;
    setChoices(prev => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <Cloud className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">启用 Vibe 云同步</span>
          </div>
          <button
            onClick={onSkip}
            disabled={running}
            className="text-gray-400 hover:text-white transition-colors disabled:opacity-30"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-5 space-y-4">
          <div className="text-sm text-gray-300 leading-relaxed">
            检测到你还没有启用云同步。
            当前本地有 <span className="font-bold text-nai-accent">{localVibeCount}</span> 个 Vibe、
            <span className="font-bold text-nai-accent"> {localTagCount}</span> 个标签。
          </div>

          <div className="space-y-2.5">
            <label
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                choices.uploadLocalVibes
                  ? 'bg-nai-accent/5 border-nai-accent/40'
                  : 'bg-nai-dark/40 border-gray-700 hover:border-gray-600'
              } ${running ? 'opacity-60 cursor-not-allowed' : ''}`}
              onClick={() => toggle('uploadLocalVibes')}
            >
              <input
                type="checkbox"
                checked={choices.uploadLocalVibes}
                onChange={() => toggle('uploadLocalVibes')}
                disabled={running}
                className="mt-1 accent-nai-accent shrink-0"
              />
              <div className="flex-1">
                <div className="text-sm font-bold text-white">上传所有本地 Vibe 到云端</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  把本地 {localVibeCount} 个 Vibe 推送到云端，方便在其它设备使用
                </div>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                choices.uploadLocalTags
                  ? 'bg-nai-accent/5 border-nai-accent/40'
                  : 'bg-nai-dark/40 border-gray-700 hover:border-gray-600'
              } ${running ? 'opacity-60 cursor-not-allowed' : ''}`}
              onClick={() => toggle('uploadLocalTags')}
            >
              <input
                type="checkbox"
                checked={choices.uploadLocalTags}
                onChange={() => toggle('uploadLocalTags')}
                disabled={running}
                className="mt-1 accent-nai-accent shrink-0"
              />
              <div className="flex-1">
                <div className="text-sm font-bold text-white">上传所有标签</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  把本地 {localTagCount} 个标签同步到云端
                </div>
              </div>
            </label>

            <label
              className={`flex items-start gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                choices.pullCloudVibes
                  ? 'bg-nai-accent/5 border-nai-accent/40'
                  : 'bg-nai-dark/40 border-gray-700 hover:border-gray-600'
              } ${running ? 'opacity-60 cursor-not-allowed' : ''}`}
              onClick={() => toggle('pullCloudVibes')}
            >
              <input
                type="checkbox"
                checked={choices.pullCloudVibes}
                onChange={() => toggle('pullCloudVibes')}
                disabled={running}
                className="mt-1 accent-nai-accent shrink-0"
              />
              <div className="flex-1">
                <div className="text-sm font-bold text-white">拉取云端已有的 Vibe</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  如果你之前在其它设备上传过，这里可以一并拉下来
                </div>
              </div>
            </label>
          </div>

          <div className="text-xs text-gray-500 bg-nai-dark/40 border border-gray-800 rounded-md px-3 py-2">
            ⓘ 启用后，本地的修改和删除会自动同步到云端，无需手动操作。
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-800 flex items-center justify-end gap-3 bg-nai-dark/50">
          <button
            onClick={onSkip}
            disabled={running}
            className="px-4 py-2 text-sm font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors disabled:opacity-30"
          >
            跳过
          </button>
          <button
            onClick={handleConfirm}
            disabled={running}
            className="px-4 py-2 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded-md transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                同步中...
              </>
            ) : (
              <>
                <Check className="w-4 h-4" />
                开始同步
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
