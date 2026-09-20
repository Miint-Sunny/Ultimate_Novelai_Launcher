/**
 * 角色摆位覆盖层:直接在主画布上摆(用户 2026-09-21 拍板)。
 *
 * 三条硬要求,都在这一层:
 *
 * 1. **取景框按「这次要生成的」分辨率画,不贴着显示中的图。** 画布上那张可能是上一张旧图,
 *    比例和当前设定未必一样;贴着它摆,摆完一生成人就全偏了 —— 用户说官方那个「没搞清楚分辨率」
 *    就是这一层。所以框的宽高比来自 targetWidth / targetHeight,框内才是坐标系。
 * 2. **5×5 网格保留,但只做参考,不吸附。** 坐标是连续的(官方 V5 也是),网格只帮眼睛对齐;
 *    V4 系在发送前才吸到格心(services/novelai.ts),存的值不动。
 * 3. **半透明叠在当前画布上**,不遮死图:底下那张仍然看得见,摆的时候能对着构图。
 *
 * 每个角色一个可独立拖动的圆点 —— 旧的弹窗面板里拖任何一个点动的都是「正在设置」的那个,
 * 很容易误操作,搬到画布上之后更明显,所以这里点谁拖谁。
 */

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { X } from 'lucide-react';
import { clampCenter, type CharacterCenter } from '../../services/characterPosition';

export interface PlacementCharacter {
  id: string;
  /** 角色卡上的名字;没有就用序号。 */
  name?: string;
  center: CharacterCenter;
  enabled: boolean;
}

interface CharacterPlacementOverlayProps {
  open: boolean;
  /** 这次要生成的尺寸 —— 取景框按它画,不看显示中的图。 */
  targetWidth: number;
  targetHeight: number;
  characters: readonly PlacementCharacter[];
  activeId: string | null;
  /** false = AI 排版(坐标照发但模型自己构图);拖动时自动切真。 */
  useCoords: boolean;
  onSetUseCoords: (value: boolean) => void;
  onSelect: (id: string) => void;
  onMove: (id: string, center: CharacterCenter) => void;
  onClose: () => void;
}

/** 角色点的配色:和左栏角色卡同一套顺序(蓝在左、红在右是官方的习惯)。 */
const DOT_COLORS = ['#60a5fa', '#f87171', '#34d399', '#fbbf24', '#c084fc', '#f472b6'];

const GRID = 5;

export function CharacterPlacementOverlay({
  open,
  targetWidth,
  targetHeight,
  characters,
  activeId,
  useCoords,
  onSetUseCoords,
  onSelect,
  onMove,
  onClose,
}: CharacterPlacementOverlayProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<string | null>(null);

  const centerFromEvent = useCallback((clientX: number, clientY: number): CharacterCenter | null => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return clampCenter({ x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height });
  }, []);

  const beginDrag = (id: string) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    draggingRef.current = id;
    event.currentTarget.setPointerCapture(event.pointerId);
    onSelect(id);
    // 摆了就该生效:拖动自动切到「用我摆的」,否则摆完没反应(与弹窗面板同口径)。
    if (!useCoords) onSetUseCoords(true);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const id = draggingRef.current;
    if (!id) return;
    const next = centerFromEvent(event.clientX, event.clientY);
    if (next) onMove(id, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    draggingRef.current = null;
  };

  if (!open) return null;

  const visible = characters.filter((c) => c.enabled);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6" data-testid="placement-overlay">
      {/* 底下那张图仍要看得见:只压一层很淡的幕,不做实心背景 */}
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[1px]" onPointerDown={onClose} />

      <div
        ref={frameRef}
        data-testid="placement-frame"
        className="relative max-w-full max-h-full border-2 border-nai-accent/70 rounded-sm shadow-[0_0_0_9999px_rgba(0,0,0,0.18)]"
        // 按目标宽高比自适配:高度先顶满,宽度由比例推出来;推出来太宽再由 maxWidth 夹回去。
        style={{
          aspectRatio: `${targetWidth} / ${targetHeight}`,
          height: '100%',
          width: 'auto',
          maxWidth: '100%',
          maxHeight: '100%',
        }}
        onPointerDown={(event) => {
          // 在框里空白处按一下 = 把当前角色挪过来(和官方一样,点哪去哪)
          if (!activeId) return;
          const next = centerFromEvent(event.clientX, event.clientY);
          if (next) {
            onMove(activeId, next);
            if (!useCoords) onSetUseCoords(true);
          }
        }}
      >
        {/* 5×5 参考网格:只给眼睛对齐,坐标仍是连续的,不吸附 */}
        <div aria-hidden className="absolute inset-0 pointer-events-none">
          {Array.from({ length: GRID - 1 }, (_, i) => (
            <div key={`v${i}`} className="absolute top-0 bottom-0 w-px bg-white/15" style={{ left: `${((i + 1) * 100) / GRID}%` }} />
          ))}
          {Array.from({ length: GRID - 1 }, (_, i) => (
            <div key={`h${i}`} className="absolute left-0 right-0 h-px bg-white/15" style={{ top: `${((i + 1) * 100) / GRID}%` }} />
          ))}
        </div>

        {visible.map((char, index) => {
          const color = DOT_COLORS[index % DOT_COLORS.length];
          const isActive = char.id === activeId;
          return (
            <button
              key={char.id}
              type="button"
              data-placement-dot={char.id}
              aria-label={char.name || `角色 ${index + 1}`}
              title={char.name || `角色 ${index + 1}`}
              onPointerDown={beginDrag(char.id)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center text-[11px] font-bold text-black transition-shadow touch-none ${
                isActive ? 'w-8 h-8 ring-2 ring-white shadow-lg' : 'w-6 h-6 opacity-80 hover:opacity-100'
              }`}
              style={{
                left: `${char.center.x * 100}%`,
                top: `${char.center.y * 100}%`,
                background: color,
                cursor: 'grab',
              }}
            >
              {index + 1}
            </button>
          );
        })}

        {/* 框自己报出这次的尺寸,免得以为是贴着显示中的图摆的 */}
        <div className="absolute -top-7 left-0 flex items-center gap-2 text-[11px]">
          <span className="px-2 py-0.5 rounded bg-black/70 text-gray-200">
            取景框 {targetWidth}×{targetHeight}
          </span>
          {!useCoords && (
            <span className="px-2 py-0.5 rounded bg-black/70 text-amber-300">AI 排版中 · 拖一下就按你摆的来</span>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          title="收起摆位"
          className="absolute -top-7 right-0 w-6 h-6 rounded bg-black/70 text-gray-300 hover:text-white flex items-center justify-center"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
