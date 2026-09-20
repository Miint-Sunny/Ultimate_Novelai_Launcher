import type { ChangeEvent, HTMLAttributes, RefObject } from 'react';
import { Power, Settings2, Upload, X } from 'lucide-react';
import type { ActivePreciseRef } from '../cr/types';
import { VibeNumberInput } from '../vibe';
import { HelpTip } from './HelpTip';

interface PreciseReferenceSectionProps {
  disabled: boolean;
  /** 停用时的副标题。缺省是 V4 基座那句;V5 传的是「官方还在训练」。 */
  disabledNote?: string;
  /** 停用时的第二行说明,只有「暂时没有」的型号才需要(照 Vibe 那张卡的写法)。 */
  disabledDetail?: string;
  inputRef: RefObject<HTMLInputElement | null>;
  dropZoneHandlers: HTMLAttributes<HTMLDivElement>;
  crDropActive: boolean;
  activePreciseRefs: ActivePreciseRef[];
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenManager: () => void;
  onUpdatePreciseRef: (id: string, updates: Partial<ActivePreciseRef>) => void;
  onRemovePreciseRef: (id: string) => void;
}

export function PreciseReferenceSection({
  disabled,
  disabledNote,
  disabledDetail,
  inputRef,
  dropZoneHandlers,
  crDropActive,
  activePreciseRefs,
  onUpload,
  onOpenManager,
  onUpdatePreciseRef,
  onRemovePreciseRef,
}: PreciseReferenceSectionProps) {
  if (disabled) {
    return (
      <div className="bg-nai-input/50 rounded p-2.5 border border-gray-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 flex items-center justify-center text-gray-500">
            <PreciseReferenceIcon />
          </div>
          <div>
            <div className="text-sm font-bold text-gray-500">Precise Reference</div>
            <div className="text-xs text-gray-600">{disabledNote ?? 'V4 模型不支持此功能'}</div>
          </div>
        </div>
        {disabledDetail && (
          <p className="mt-1 text-[11px] leading-4 text-gray-500">{disabledDetail}</p>
        )}
      </div>
    );
  }

  return (
    <div
      id="drop-zone-cr"
      className={`bg-nai-input/50 rounded p-2.5 border transition-all relative ${crDropActive
        ? 'border-nai-accent bg-nai-accent/20 ring-2 ring-nai-accent/50 scale-[1.02]'
        : 'border-gray-800/50'
      }`}
      {...dropZoneHandlers}
    >
      {crDropActive && (
        <div className="absolute inset-0 flex items-center justify-center bg-nai-accent/10 rounded pointer-events-none z-10">
          <div className="text-nai-accent text-xs font-medium px-2 py-1 bg-nai-accent/20 rounded">
            松开以添加精确参考
          </div>
        </div>
      )}
      <div className={`flex items-center justify-between ${crDropActive ? 'pointer-events-none' : ''}`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 flex items-center justify-center transition-colors ${crDropActive ? 'text-nai-accent' : 'text-gray-300'}`}>
            <PreciseReferenceIcon />
          </div>
          <div>
            <div className="text-sm font-bold text-white">Precise Reference</div>
            <div className="text-xs text-gray-400">
              精确参考，添加参考图片以参考角色或画风
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <input
            type="file"
            ref={inputRef}
            className="hidden"
            onChange={onUpload}
            accept="image/*"
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

      {activePreciseRefs.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-700/50">
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <div className="w-6" />
            <div className="flex-1 text-[10px] text-gray-500 font-medium">名称</div>
            <div className="w-16 text-[10px] text-gray-500 font-medium text-center flex items-center justify-center">Strength<HelpTip title="参考强度 (Strength)" body={"控制角色 / 风格参考对画面的整体影响力。\n· 值越高 → 越严格还原参考图特征\n· 值越低 → 参考图仅作弱引导\n💡 每张图额外消耗 5 Anlas，多个 PR 累加\n💡 过高时面部表情 / 角度 / 姿势会过度贴近参考图\n💡 点击数字框可输入负值（用作反向参考）"} /></div>
            <div className="w-16 text-[10px] text-gray-500 font-medium text-center flex items-center justify-center">Fidelity<HelpTip title="还原度 (Fidelity)" body={"控制 prompt 能否压过参考图。\n· 值越高 → 参考图占主导，prompt 难以改变它\n· 值越低 → prompt 占主导，更易调整画面\n💡 实际效果可能因图而异，建议多尝试\n💡 点击数字框可输入负值"} /></div>
            <div className="w-6" />
          </div>

          <div className="space-y-1">
            {activePreciseRefs.map((reference) => (
              <PreciseReferenceRow
                key={reference.id}
                reference={reference}
                onUpdate={onUpdatePreciseRef}
                onRemove={onRemovePreciseRef}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PreciseReferenceRow({
  reference,
  onUpdate,
  onRemove,
}: {
  reference: ActivePreciseRef;
  onUpdate: (id: string, updates: Partial<ActivePreciseRef>) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className={`group rounded-lg p-2 border transition-colors flex items-center gap-2 ${reference.enabled ? 'bg-nai-dark/30 hover:bg-nai-dark/50 border-gray-800' : 'bg-gray-800/20 border-gray-800/50 opacity-60'}`}>
      <button
        onClick={() => onUpdate(reference.id, { enabled: !reference.enabled })}
        className={`shrink-0 p-1 rounded transition-colors ${reference.enabled ? 'text-nai-accent hover:bg-nai-accent/20' : 'text-gray-500 hover:bg-gray-700'}`}
        title={reference.enabled ? '点击禁用' : '点击启用'}
      >
        <Power className="w-3.5 h-3.5" />
      </button>

      <div className={`flex-1 min-w-0 flex items-center gap-2 ${!reference.enabled ? 'opacity-40' : ''}`}>
        <div className="relative group/preview shrink-0">
          <img
            src={reference.preview}
            alt={reference.name}
            className="w-10 h-10 rounded object-cover border border-gray-700"
          />
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 max-w-48 bg-nai-panel border border-gray-600 rounded-lg shadow-xl opacity-0 group-hover/preview:opacity-100 pointer-events-none transition-opacity z-50 overflow-hidden hidden group-hover/preview:block">
            <img src={reference.preview} alt={reference.name} className="max-w-48 max-h-64 object-contain" />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <span className="text-xs font-medium truncate block max-w-[100px] text-gray-300" title={reference.name}>{reference.name}</span>
          <select
            value={reference.mode}
            onChange={(event) => onUpdate(reference.id, { mode: event.target.value as ActivePreciseRef['mode'] })}
            className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-300 focus:border-nai-accent outline-none cursor-pointer appearance-none"
            style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', paddingRight: '20px' }}
          >
            <option value="character&style">Char & Style</option>
            <option value="character">Character</option>
            <option value="style">Style</option>
          </select>
        </div>
      </div>

      <PreciseValueInput
        value={reference.strength}
        enabled={reference.enabled}
        onChange={(value) => onUpdate(reference.id, { strength: value })}
        title="Strength"
      />
      <PreciseValueInput
        value={reference.informationExtracted}
        enabled={reference.enabled}
        onChange={(value) => onUpdate(reference.id, { informationExtracted: value })}
        title="Fidelity"
      />

      <button
        onClick={() => onRemove(reference.id)}
        className="shrink-0 p-1 text-gray-500 hover:text-red-400 transition-colors"
        title="删除"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function PreciseValueInput({
  value,
  enabled,
  onChange,
  title,
}: {
  value: number;
  enabled: boolean;
  onChange: (value: number) => void;
  title: string;
}) {
  return (
    <div className={`w-16 flex justify-center ${!enabled ? 'opacity-40' : ''}`}>
      <VibeNumberInput
        value={value}
        onChange={onChange}
        style={{
          backgroundImage: `linear-gradient(to right, rgba(252, 237, 164, 0.5) ${value * 100}%, rgba(0, 0, 0, 0.2) ${value * 100}%)`
        }}
        className="w-full bg-black/20 border border-gray-700 rounded px-1 py-1 text-[10px] text-center text-white focus:border-nai-accent outline-none appearance-none cursor-ew-resize"
        title={title}
      />
    </div>
  );
}

function PreciseReferenceIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  );
}
