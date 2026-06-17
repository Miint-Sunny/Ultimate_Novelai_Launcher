import type { Dispatch, SetStateAction } from 'react';
import { Image as ImageIcon, Palette, User } from 'lucide-react';
import { formatUnsupportedSettings, getUnsupportedImportSettings } from '../../utils/generationOptions';
import type { ImageMetadata } from '../../utils/imageMetadata';
import type { MobileImageImportOptions } from './generate/useMobileImageImport';

export function UseAsButtons({
  stacked = false,
  onUseAsVibe,
  onUseAsImg2Img,
  onUseAsCR,
}: {
  stacked?: boolean;
  onUseAsVibe: () => void;
  onUseAsImg2Img: () => void;
  onUseAsCR: () => void;
}) {
  const buttonClass = stacked
    ? 'w-full flex items-center gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-xl'
    : 'flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl';
  const iconClass = stacked ? 'w-5 h-5 text-nai-accent' : 'w-4 h-4 text-nai-accent';
  const textClass = stacked ? 'text-sm text-white' : 'text-xs text-gray-300';

  return (
    <div className={stacked ? 'space-y-3' : 'flex gap-2'}>
      <button onClick={onUseAsVibe} className={buttonClass}>
        <Palette className={iconClass} />
        <span className={textClass}>Vibe{stacked ? ' Transfer' : ''}</span>
      </button>
      <button onClick={onUseAsImg2Img} className={buttonClass}>
        <ImageIcon className={iconClass} />
        <span className={textClass}>{stacked ? 'Image2Image' : 'Img2Img'}</span>
      </button>
      <button onClick={onUseAsCR} className={buttonClass}>
        <User className={iconClass} />
        <span className={textClass}>{stacked ? 'Character Reference' : 'CR'}</span>
      </button>
    </div>
  );
}

export function ImportOption({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
      <input type="checkbox" checked={checked} onChange={onChange} className="w-4 h-4 rounded" />
      {label}
    </label>
  );
}

export function SettingsImportOption({
  metadata,
  checked,
  setImportOptions,
}: {
  metadata: ImageMetadata;
  checked: boolean;
  setImportOptions: Dispatch<SetStateAction<MobileImageImportOptions>>;
}) {
  const settingsIssues = getUnsupportedImportSettings(metadata);
  const settingsDisabled = settingsIssues.length > 0;

  return (
    <label className={`flex items-center gap-2 text-sm ${settingsDisabled ? 'cursor-not-allowed text-gray-500' : 'cursor-pointer text-gray-300'}`}>
      <input
        type="checkbox"
        disabled={settingsDisabled}
        checked={!settingsDisabled && checked}
        onChange={() => {
          if (!settingsDisabled) setImportOptions((prev) => ({ ...prev, settings: !prev.settings }));
        }}
        className="w-4 h-4 rounded disabled:opacity-50"
      />
      生成设置
      {settingsDisabled && <span className="text-[10px] text-amber-500/80">不支持: {formatUnsupportedSettings(settingsIssues)}</span>}
    </label>
  );
}
