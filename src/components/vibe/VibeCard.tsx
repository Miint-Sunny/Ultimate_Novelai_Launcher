import React from 'react';
import { File } from 'lucide-react';
import { type VibeFile, MODEL_MAP, MODEL_TO_ENCODING_KEY, formatModelLabel } from './types';

interface VibeCardProps {
  file: VibeFile;
  isSelected: boolean;
  isPinned?: boolean;
  selectedModelId: string;
  onClick: () => void;
  /** Optional prefix before model tags (e.g. cloud icon) */
  tagPrefix?: React.ReactNode;
  /** Action buttons on the right side */
  actions: React.ReactNode;
}

/** Thumbnail with hover preview */
const VibeThumbnail: React.FC<{ preview?: string; name: string }> = ({ preview, name }) => {
  if (!preview) {
    return (
      <div className="w-8 h-8 flex items-center justify-center">
        <File className="w-5 h-5" />
      </div>
    );
  }

  return (
    <div className="relative group/list-preview">
      <img
        src={preview}
        alt={name}
        className="w-8 h-8 rounded object-cover"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
          const fallback = e.currentTarget.nextElementSibling;
          if (fallback) fallback.classList.remove('hidden');
          e.currentTarget.parentElement?.classList.remove('group/list-preview');
        }}
      />
      <div className="w-8 h-8 flex items-center justify-center hidden">
        <File className="w-5 h-5" />
      </div>
      {/* Hover Preview */}
      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 max-w-48 bg-nai-panel border border-gray-600 rounded-lg shadow-xl opacity-0 group-hover/list-preview:opacity-100 pointer-events-none transition-opacity z-50 overflow-hidden hidden group-hover/list-preview:block">
        <img
          src={preview}
          alt={name}
          className="max-w-48 max-h-64 object-contain"
        />
      </div>
    </div>
  );
};

/** Model compatibility tags */
const VibeModelTags: React.FC<{
  supportedModels?: string[];
  selectedModelId: string;
  prefix?: React.ReactNode;
}> = ({ supportedModels, selectedModelId, prefix }) => {
  const hasModels = supportedModels && supportedModels.length > 0;
  if (!hasModels && !prefix) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {prefix}
      {hasModels && supportedModels.map(model => {
        const currentModelApi = MODEL_MAP[selectedModelId] || 'nai-diffusion-4-5-full';
        const currentEncodingKey = MODEL_TO_ENCODING_KEY[currentModelApi];
        const isCurrentModel = model === currentEncodingKey ||
          (currentModelApi === 'nai-diffusion-4-5-full' && model === 'v4full') ||
          (currentModelApi === 'nai-diffusion-4-5-curated' && model === 'v4curated');
        return (
          <span
            key={model}
            className={`px-1.5 py-0.5 text-[10px] font-bold rounded ${isCurrentModel
              ? 'bg-nai-accent text-black'
              : 'bg-gray-700 text-gray-300'
              }`}
            title={`支持 ${model}`}
          >
            {formatModelLabel(model)}
          </span>
        );
      })}
    </div>
  );
};

export const VibeCard: React.FC<VibeCardProps> = ({
  file,
  isSelected,
  isPinned = false,
  selectedModelId,
  onClick,
  tagPrefix,
  actions,
}) => {
  return (
    <div
      className={`p-3 rounded border cursor-pointer flex items-center justify-between group transition-colors ${isSelected
          ? 'bg-nai-accent/10 border-nai-accent'
          : isPinned
            ? 'bg-nai-accent/5 border-nai-accent/30 hover:border-nai-accent/50'
            : 'bg-nai-input border-gray-800 hover:border-gray-600'
        }`}
      onClick={onClick}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={`p-1 rounded shrink-0 ${isSelected ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400'}`}>
          <VibeThumbnail preview={file.preview} name={file.name} />
        </div>
        <div className="flex-1 min-w-0">
          <div className={`font-bold text-sm truncate ${isSelected ? 'text-nai-accent' : 'text-white'}`} title={file.name}>
            {file.name}
          </div>
          <VibeModelTags
            supportedModels={file.supportedModels}
            selectedModelId={selectedModelId}
            prefix={tagPrefix}
          />
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {actions}
      </div>
    </div>
  );
};

export { VibeThumbnail, VibeModelTags };
