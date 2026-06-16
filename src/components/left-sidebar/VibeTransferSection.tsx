import type { ChangeEvent, HTMLAttributes, RefObject } from 'react';
import { Ban, Check, Download, File, Loader2, Palette, Power, Settings2, Upload, X } from 'lucide-react';
import { VibeNumberInput, type ActiveVibe } from '../vibe';
import { HelpTip } from './HelpTip';

type ActiveVibeField = 'referenceStrength' | 'informationExtracted' | 'enabled';

interface VibeTransferSectionProps {
  inputRef: RefObject<HTMLInputElement | null>;
  dropZoneHandlers: HTMLAttributes<HTMLDivElement>;
  vibeDropActive: boolean;
  activeVibes: ActiveVibe[];
  loadingVibeIds: Set<string>;
  exportingVibeId: string | null;
  normalizeVibeStrength: boolean;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenManager: () => void;
  onToggleNormalize: () => void;
  onUpdateActiveVibe: <K extends ActiveVibeField>(id: string, key: K, value: ActiveVibe[K]) => void;
  onRemoveActiveVibe: (id: string) => void;
  onExportVibe: (vibe: ActiveVibe) => void;
  isActiveVibeCompatible: (vibe: { supportedModels?: string[]; image?: string }) => boolean;
}

export function VibeTransferSection({
  inputRef,
  dropZoneHandlers,
  vibeDropActive,
  activeVibes,
  loadingVibeIds,
  exportingVibeId,
  normalizeVibeStrength,
  onUpload,
  onOpenManager,
  onToggleNormalize,
  onUpdateActiveVibe,
  onRemoveActiveVibe,
  onExportVibe,
  isActiveVibeCompatible,
}: VibeTransferSectionProps) {
  return (
    <div
      id="drop-zone-vibe"
      className={`bg-nai-input/50 rounded p-2.5 border transition-all relative ${vibeDropActive
        ? 'border-nai-accent bg-nai-accent/20 ring-2 ring-nai-accent/50 scale-[1.02]'
        : 'border-gray-800/50'
      }`}
      {...dropZoneHandlers}
    >
      {vibeDropActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-nai-accent/10 rounded pointer-events-none z-10">
          <div className="text-nai-accent text-xs font-medium px-2 py-1 bg-nai-accent/20 rounded">
            松开以添加 Vibe
          </div>
        </div>
      )}
      <div className={`flex items-center justify-between ${vibeDropActive ? 'pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 flex items-center justify-center transition-colors ${vibeDropActive ? 'text-nai-accent' : 'text-gray-300'}`}>
            <Palette className="w-5 h-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Vibe Transfer</div>
            <div className="text-xs text-gray-400">
              氛围转移，改变图片风格
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="file"
            ref={inputRef}
            className="hidden"
            onChange={onUpload}
            accept="image/*,.naiv4vibe,.naiv4vibebundle"
          />
          <button
            className="p-1.5 hover:bg-gray-700 rounded border border-gray-600"
            onClick={() => inputRef.current?.click()}
            title="快速上传"
          >
            <Upload className="w-3.5 h-3.5 text-gray-300" />
          </button>
          <button
            className="p-1.5 hover:bg-gray-700 rounded border border-gray-600"
            onClick={onOpenManager}
            title="管理"
          >
            <Settings2 className="w-3.5 h-3.5 text-gray-300" />
          </button>
        </div>
      </div>

      {activeVibes.length > 1 && (
        <div className="mt-2 pt-2 border-t border-gray-700/50 flex items-center justify-between px-1">
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-gray-400">均衡强度</span>
            <HelpTip title="均衡强度 (Normalize)" body={"开启 → 所有 Vibe 的强度按比例缩小，合计强度 ≤ 1\n关闭 → 每个 Vibe 的强度独立相加"} />
          </div>
          <button
            onClick={onToggleNormalize}
            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${normalizeVibeStrength ? 'bg-nai-accent border-nai-accent' : 'bg-transparent border-gray-500 hover:border-gray-400'}`}
          >
            {normalizeVibeStrength && <Check className="w-3 h-3 text-gray-900" />}
          </button>
        </div>
      )}

      {activeVibes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700/50">
          <div className="flex items-center gap-2 mb-2 px-1 text-[10px] text-gray-500 font-bold uppercase tracking-wider">
            <div className="w-6" />
            <div className="flex-1">Active Vibes</div>
            <div className="w-16 text-center flex items-center justify-center">强度<HelpTip title="风格强度 (Reference Strength)" body={"控制 Vibe 风格对画面的影响力度。\n· 值越高 → 越接近参考图的风格、配色等视觉线索\n· 值越低 → 仅作轻微风格指引\n💡 多个 Vibe 同时使用时，强度总和建议 ≤ 1\n💡 过高时 AI 会开始忽略文字 prompt"} /></div>
            <div className="w-16 text-center flex items-center justify-center">信息<HelpTip title="信息提取 (Information Extracted)" body={"从原图中提取的信息量。\n· 值越低 → 先丢失高频细节（纹理、风格），优先保留构图\n· 值越高 → 同时保留构图与纹理 / 风格细节\n💡 设置为新值时扣 2 点数，使用历史值时免费\n💡 无原图时无法重设该值"} /></div>
            <div className="w-12" />
          </div>

          <div className="space-y-1">
            {activeVibes.map((vibe) => (
              <ActiveVibeRow
                key={vibe.id}
                vibe={vibe}
                isCompatible={isActiveVibeCompatible(vibe)}
                isLoading={loadingVibeIds.has(vibe.id)}
                isExporting={exportingVibeId === vibe.id}
                onUpdate={onUpdateActiveVibe}
                onRemove={onRemoveActiveVibe}
                onExport={onExportVibe}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface ActiveVibeRowProps {
  vibe: ActiveVibe;
  isCompatible: boolean;
  isLoading: boolean;
  isExporting: boolean;
  onUpdate: <K extends ActiveVibeField>(id: string, key: K, value: ActiveVibe[K]) => void;
  onRemove: (id: string) => void;
  onExport: (vibe: ActiveVibe) => void;
}

function ActiveVibeRow({ vibe, isCompatible, isLoading, isExporting, onUpdate, onRemove, onExport }: ActiveVibeRowProps) {
  const hasOriginalImage = !!vibe.image;

  return (
    <div
      className={`group rounded p-1.5 border transition-colors flex items-center gap-2 ${!isCompatible
        ? 'bg-red-950/30 border-red-800/40'
        : !vibe.enabled
          ? 'bg-gray-900/50 border-gray-800/50'
          : 'bg-nai-dark/30 hover:bg-nai-dark/50 border-gray-800'
      }`}
    >
      <button
        onClick={() => onUpdate(vibe.id, 'enabled', !vibe.enabled)}
        className={`shrink-0 p-1 rounded transition-colors ${!isCompatible
          ? 'text-red-500/50 cursor-not-allowed'
          : vibe.enabled
            ? 'text-nai-accent hover:bg-nai-accent/20'
            : 'text-gray-600 hover:bg-gray-700 hover:text-gray-400'
        }`}
        title={!isCompatible ? '模型不兼容' : vibe.enabled ? '点击禁用此 Vibe' : '点击启用此 Vibe'}
        disabled={!isCompatible}
      >
        <Power className="w-3.5 h-3.5" />
      </button>

      <div className={`flex-1 min-w-0 flex items-center gap-2 ${!isCompatible ? 'opacity-50' : !vibe.enabled ? 'opacity-40' : ''}`}>
        <VibePreview vibe={vibe} isCompatible={isCompatible} isLoading={isLoading} />
        <div className="flex-1 min-w-0">
          <span className={`text-xs font-medium truncate block max-w-[120px] ${!isCompatible ? 'text-red-300/70 line-through' : !vibe.enabled ? 'text-gray-500 line-through' : 'text-gray-300'}`} title={vibe.name}>{vibe.name}</span>
          {!isCompatible && (
            <div className="flex items-center gap-1 mt-0.5">
              <Ban className="w-3 h-3 text-red-400 shrink-0" />
              <span className="text-[9px] text-red-400/80 truncate">不兼容当前模型</span>
            </div>
          )}
          {isCompatible && !vibe.enabled && (
            <span className="text-[9px] text-gray-600">已禁用</span>
          )}
        </div>
      </div>

      <VibeValueInput
        value={vibe.referenceStrength}
        isCompatible={isCompatible}
        isEnabled={vibe.enabled}
        onChange={(value) => onUpdate(vibe.id, 'referenceStrength', value)}
        title={isCompatible ? '强度 (Strength)' : '不支持当前模型'}
      />

      <div className={`w-16 flex justify-center ${!vibe.enabled ? 'opacity-40' : ''}`}>
        {hasOriginalImage ? (
          <VibeValueInput
            value={vibe.informationExtracted}
            isCompatible={isCompatible}
            isEnabled={vibe.enabled}
            onChange={(value) => onUpdate(vibe.id, 'informationExtracted', value)}
            title={isCompatible ? '信息提取 (Info Extracted)' : '不支持当前模型'}
          />
        ) : (
          <div
            className="w-full border rounded px-1 py-1 text-[10px] text-center bg-gray-800/50 border-gray-700 text-gray-500 cursor-not-allowed"
            title="此 Vibe 只有编码数据，无法调整信息提取值"
          >
            {vibe.informationExtracted.toFixed(2)}
          </div>
        )}
      </div>

      <button
        onClick={() => onExport(vibe)}
        disabled={isExporting}
        className={`w-5 h-5 flex items-center justify-center transition-colors rounded hover:bg-white/5 ${isExporting
          ? 'text-yellow-400 animate-pulse cursor-wait'
          : 'text-gray-500 hover:text-blue-400'
        }`}
        title={isExporting ? '正在编码...' : '导出为 .naiv4vibe 文件'}
      >
        {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>

      <button
        onClick={() => onRemove(vibe.id)}
        className="w-5 h-5 flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors rounded hover:bg-white/5"
        title="Remove Vibe"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function VibePreview({ vibe, isCompatible, isLoading }: { vibe: ActiveVibe; isCompatible: boolean; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="w-8 h-8 rounded flex items-center justify-center border shrink-0 bg-gray-800 border-gray-700">
        <Loader2 className="w-4 h-4 text-nai-accent animate-spin" />
      </div>
    );
  }

  if (!vibe.preview) {
    return (
      <div className={`w-8 h-8 rounded flex items-center justify-center border shrink-0 ${isCompatible ? 'bg-gray-800 border-gray-700' : 'bg-red-900/30 border-red-700/50'}`}>
        <File className={`w-4 h-4 ${isCompatible ? 'text-nai-accent' : 'text-red-400'}`} />
      </div>
    );
  }

  return (
    <div className="relative group/preview shrink-0">
      <img
        src={vibe.preview}
        alt={vibe.name}
        className={`w-8 h-8 rounded object-cover border ${isCompatible ? 'border-gray-700' : 'border-red-700/50 grayscale'}`}
      />
      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 max-w-48 bg-nai-panel border border-gray-600 rounded-lg shadow-xl opacity-0 group-hover/preview:opacity-100 pointer-events-none transition-opacity z-50 overflow-hidden hidden group-hover/preview:block">
        <img src={vibe.preview} alt={vibe.name} className="max-w-48 max-h-64 object-contain" />
      </div>
    </div>
  );
}

function VibeValueInput({ value, isCompatible, isEnabled, onChange, title }: {
  value: number;
  isCompatible: boolean;
  isEnabled: boolean;
  onChange: (value: number) => void;
  title: string;
}) {
  return (
    <div className={`w-16 flex justify-center ${!isEnabled ? 'opacity-40' : ''}`}>
      <VibeNumberInput
        value={value}
        onChange={onChange}
        style={{
          backgroundImage: isCompatible
            ? `linear-gradient(to right, rgba(252, 237, 164, 0.5) ${value * 100}%, rgba(0, 0, 0, 0.2) ${value * 100}%)`
            : `linear-gradient(to right, rgba(239, 68, 68, 0.3) ${value * 100}%, rgba(0, 0, 0, 0.2) ${value * 100}%)`
        }}
        className={`w-full border rounded px-1 py-1 text-[10px] text-center focus:border-nai-accent outline-none appearance-none ${isCompatible
          ? 'bg-black/20 border-gray-700 text-white cursor-ew-resize'
          : 'bg-red-900/20 border-red-700/50 text-red-300 cursor-not-allowed'
        }`}
        title={title}
      />
    </div>
  );
}
