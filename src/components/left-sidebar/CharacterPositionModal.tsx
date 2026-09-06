import { useCallback, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { AlertTriangle, Grid3x3, MapPin, Sparkles, X } from 'lucide-react';
import type { CharacterPrompt } from './types';
import {
  centerToLegacyCell,
  clampCenter,
  crowdedCharacterIndices,
  resolveCharacterCenters,
  snapCenterToGrid,
  type CharacterCenter,
} from '../../services/characterPosition';

interface CharacterPositionModalProps {
  editingPositionId: string;
  characterPrompts: CharacterPrompt[];
  /** 画布按出图比例显示,免得在方框里摆好的构图到了竖图上全变形。 */
  aspectRatio?: number;
  /**
   * 当前模型是否支持自由浮点定位(`modelCapabilities().freeformCharacterPosition`)。
   * 假值(V4 系)时落点一律吸附到 5×5 网格中心——那是 V4 的定位口径,
   * 放开了发出去也不是用户看到的那张。
   */
  freeform?: boolean;
  /** 官方位置区块的全局二选一:false = AI's Choice,true = Custom(use_coords)。 */
  useCoords: boolean;
  onSetUseCoords: (useCoords: boolean) => void;
  onClose: () => void;
  onUpdateCenter: (id: string, center: CharacterCenter | null) => void;
}

/** 键盘微调步长。按住 Shift 走大步。 */
const NUDGE = 0.01;
const NUDGE_COARSE = 0.05;

export const CharacterPositionModal: React.FC<CharacterPositionModalProps> = ({
  editingPositionId,
  characterPrompts,
  aspectRatio = 832 / 1216,
  freeform = true,
  useCoords,
  onSetUseCoords,
  onClose,
  onUpdateCenter,
}) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const activeIndex = characterPrompts.findIndex((p) => p.id === editingPositionId);
  const activeCharacter = characterPrompts[activeIndex];

  // 画布上画的点必须跟真正发出去的 centers 是同一份计算,否则「看到的」和
  // 「发出的」会分叉——这正是把这套规则收进 characterPosition 的原因。
  const centers = useMemo(() => resolveCharacterCenters(characterPrompts), [characterPrompts]);
  const crowded = useMemo(() => new Set(crowdedCharacterIndices(centers)), [centers]);

  // 官方没有「每角色 AUTO」:角色都有坐标,只有全局的 AI 排版 / 用我摆的。
  const aiChoice = !useCoords;
  const activeCenter = centers[activeIndex] ?? { x: 0.5, y: 0.5 };

  /** 摆位自动切回「用我摆的」——摆了却不生效,没人会想要。 */
  const place = useCallback(
    (center: CharacterCenter) => {
      onUpdateCenter(editingPositionId, freeform ? center : snapCenterToGrid(center));
      if (!useCoords) onSetUseCoords(true);
    },
    [editingPositionId, freeform, onSetUseCoords, onUpdateCenter, useCoords],
  );

  const placeFromPointer = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      place(clampCenter({
        x: (clientX - rect.left) / rect.width,
        y: (clientY - rect.top) / rect.height,
      }));
    },
    [place],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    place(clampCenter({ x: activeCenter.x + move[0], y: activeCenter.y + move[1] }));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl p-4 w-[340px] animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex justify-between items-center mb-3">
          <h3 className="font-bold text-white flex items-center gap-2">
            <MapPin className="w-4 h-4 text-nai-accent" />
            角色位置
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div
          ref={canvasRef}
          role="application"
          tabIndex={0}
          aria-label={`拖动设置 Char ${activeIndex + 1} 的位置,方向键微调`}
          style={{ aspectRatio: String(aspectRatio) }}
          className={`relative w-full rounded-lg border bg-black/30 overflow-hidden select-none touch-none cursor-crosshair outline-none transition-colors ${
            isDragging ? 'border-nai-accent' : 'border-gray-700 focus-visible:border-nai-accent'
          }`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setIsDragging(true);
            placeFromPointer(event.clientX, event.clientY);
          }}
          onPointerMove={(event) => {
            if (!isDragging) return;
            placeFromPointer(event.clientX, event.clientY);
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            setIsDragging(false);
          }}
          onKeyDown={handleKeyDown}
        >
          {/* 旧的 5×5 只留作参考线,不再是可选的格子 */}
          <div className="absolute inset-0 pointer-events-none">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={`v${i}`}
                className="absolute top-0 bottom-0 border-l border-white/5"
                style={{ left: `${i * 20}%` }}
              />
            ))}
            {[1, 2, 3, 4].map((i) => (
              <div
                key={`h${i}`}
                className="absolute left-0 right-0 border-t border-white/5"
                style={{ top: `${i * 20}%` }}
              />
            ))}
          </div>

          {characterPrompts.map((char, index) => {
            const center = centers[index];
            const isActive = char.id === editingPositionId;
            const isCrowded = crowded.has(index);
            return (
              <div
                key={char.id}
                className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                style={{ left: `${center.x * 100}%`, top: `${center.y * 100}%` }}
                title={char.name || `Char ${index + 1}`}
              >
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shadow-lg transition-all ${
                    isActive
                      ? 'bg-nai-accent text-black ring-2 ring-white scale-110'
                      : isCrowded
                        ? 'bg-amber-500/80 text-black ring-1 ring-amber-300'
                        : 'bg-gray-600/90 text-white ring-1 ring-black/40'
                  }`}
                >
                  {index + 1}
                </div>
              </div>
            );
          })}

          {aiChoice && (
            <div className="absolute inset-x-0 bottom-0 py-1 text-center text-[10px] text-gray-400 bg-black/50 pointer-events-none">
              AI 排版 · 点位仅为预览,实际构图交给模型;拖动即切到「用我摆的」
            </div>
          )}
        </div>

        {/* 纵轴是景深,不是单纯的上下——不写清楚没人猜得到 */}
        <div className="mt-2 flex items-center justify-between text-[10px] text-gray-500">
          <span>上 = 远(缩小)</span>
          <span className="font-mono text-gray-400">
            {`${Math.round(activeCenter.x * 100)} · ${Math.round(activeCenter.y * 100)} (${centerToLegacyCell(activeCenter)})`}
          </span>
          <span>下 = 近(占画幅大)</span>
        </div>

        {crowded.size > 0 && (
          <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber-400/90">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>角色贴得太近容易坏图,建议拉开。完全重合不算——那是 cosplay 的正规用法。</span>
          </div>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            onClick={() => onSetUseCoords(!useCoords)}
            className={`py-2 rounded text-xs font-bold border transition-all flex items-center justify-center gap-1.5 ${
              aiChoice
                ? 'bg-nai-accent text-black border-nai-accent'
                : 'bg-black/20 text-gray-400 border-gray-700 hover:text-white hover:border-gray-500'
            }`}
            title={aiChoice ? '当前交给模型构图(use_coords false);点击改为按坐标出图' : '当前按坐标出图;点击交给模型构图(全体角色)'}
          >
            <Sparkles className="w-3 h-3" />
            {aiChoice ? 'AI 排版中' : '交给 AI 排版'}
          </button>
          <button
            onClick={() => onUpdateCenter(editingPositionId, snapCenterToGrid(activeCenter))}
            disabled={!freeform}
            className="py-2 rounded text-xs font-bold border bg-black/20 text-gray-400 border-gray-700 enabled:hover:text-white enabled:hover:border-gray-500 disabled:opacity-40 transition-all flex items-center justify-center gap-1.5"
            title={freeform ? '吸附到 5×5 网格中心(旧版手感)' : '当前模型本来就只认网格'}
          >
            <Grid3x3 className="w-3 h-3" />
            吸附网格
          </button>
        </div>

        <div className="text-xs text-gray-500 text-center mt-3">
          正在设置 Char {activeIndex + 1} · 拖动画布或用方向键
          {!freeform && ' · 当前模型只认 5×5 网格,落点自动吸附'}
        </div>
      </div>
    </div>
  );
};
