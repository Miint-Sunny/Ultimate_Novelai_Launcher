import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Move } from 'lucide-react';
import { APP_SETTINGS_CHANGED_EVENT, getAppSettings, saveAppSettings } from '../../services/localLibrary/appSettings';
import { decodeImageUrlToRgba, loadWatermarkImage } from '../../services/watermark/browser.ts';
import { WATERMARK_LIMITS, resolveWatermarkPlacement, type RawRgbaImage, type WatermarkConfig, type WatermarkPlacement } from '../../services/watermark/index.ts';
import { setWatermarkOverlayMode } from './overlayMode';

/**
 * 画板 2D 定位(照他的 watermark_position_overlay):在当前大图上叠一层,拖矩形改
 * posX / posY,拖右下角改 scalePercent,滚轮微调;落点与尺寸直接调 resolveWatermarkPlacement,
 * 与导出同一公式。松手才写设置,拖动过程只动本地草稿。
 */

interface Props {
  imageRef: React.RefObject<HTMLImageElement | null>;
  imageUrl: string;
}

const POSITION_PRESETS: { label: string; x: number; y: number }[] = [
  { label: '左上', x: 0, y: 0 }, { label: '右上', x: 1, y: 0 }, { label: '居中', x: 0.5, y: 0.5 },
  { label: '左下', x: 0, y: 1 }, { label: '右下', x: 1, y: 1 },
];

function commit(next: WatermarkConfig) {
  saveAppSettings({ ...getAppSettings(), watermark: next });
  window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
}

export const WatermarkPlacementOverlay: React.FC<Props> = ({ imageRef, imageUrl }) => {
  const [config, setConfig] = useState<WatermarkConfig>(() => getAppSettings().watermark);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [logo, setLogo] = useState<{ width: number; height: number } | null>(null);
  const [base, setBase] = useState<RawRgbaImage | null>(null);
  const drag = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; origin: WatermarkPlacement; config: WatermarkConfig } | null>(null);

  // 图片在屏幕上的框:缩放 / 拖动 / 窗口变化都会动,轮询比订阅所有来源简单可靠。
  useEffect(() => {
    const tick = () => {
      const el = imageRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((prev) => (prev && prev.left === r.left && prev.top === r.top && prev.width === r.width && prev.height === r.height ? prev : r));
      if (el.naturalWidth > 0) setNatural((prev) => (prev && prev.width === el.naturalWidth && prev.height === el.naturalHeight ? prev : { width: el.naturalWidth, height: el.naturalHeight }));
    };
    tick();
    const timer = window.setInterval(tick, 200);
    window.addEventListener('resize', tick);
    return () => { window.clearInterval(timer); window.removeEventListener('resize', tick); };
  }, [imageRef, imageUrl]);

  useEffect(() => {
    let alive = true;
    if (!config.imageDataUrl) { setLogo(null); return; }
    loadWatermarkImage(config.imageDataUrl).then((img) => { if (alive) setLogo({ width: img.width, height: img.height }); }).catch(() => { if (alive) setLogo(null); });
    return () => { alive = false; };
  }, [config.imageDataUrl]);

  // 智能选位要看像素;手动摆位只要尺寸。
  useEffect(() => {
    let alive = true;
    if (!config.autoPosition) { setBase(null); return; }
    decodeImageUrlToRgba(imageUrl).then((img) => { if (alive) setBase(img); }).catch(() => { if (alive) setBase(null); });
    return () => { alive = false; };
  }, [config.autoPosition, imageUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setWatermarkOverlayMode(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const placement = useMemo<WatermarkPlacement | null>(() => {
    if (!natural || !logo) return null;
    const source: RawRgbaImage = config.autoPosition && base ? base : { width: natural.width, height: natural.height, rgba: new Uint8Array(0) };
    if (config.autoPosition && !base) return null;
    return resolveWatermarkPlacement(source, logo.width, logo.height, config);
  }, [base, config, logo, natural]);

  const scaleToScreen = rect && natural ? rect.width / natural.width : 1;

  const apply = useCallback((next: WatermarkConfig, persist: boolean) => {
    setConfig(next);
    if (persist) commit(next);
  }, []);

  const onPointerDown = (kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!placement) return;
    e.preventDefault();
    e.stopPropagation();
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 合成事件 / 老浏览器没有捕获也能拖 */ }
    // 一动手就是手动摆位:智能选位关掉,否则拖了也白拖。
    const startConfig = config.autoPosition ? { ...config, autoPosition: false, posX: placement.posX, posY: placement.posY } : config;
    drag.current = { kind, startX: e.clientX, startY: e.clientY, origin: placement, config: startConfig };
    if (startConfig !== config) setConfig(startConfig);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !natural || !logo) return;
    const dx = (e.clientX - d.startX) / scaleToScreen;
    const dy = (e.clientY - d.startY) / scaleToScreen;
    if (d.kind === 'move') {
      const availW = Math.max(0, natural.width - 2 * d.origin.marginPx - d.origin.width);
      const availH = Math.max(0, natural.height - 2 * d.origin.marginPx - d.origin.height);
      const posX = availW > 0 ? Math.min(1, Math.max(0, (d.origin.x + dx - d.origin.marginPx) / availW)) : d.config.posX;
      const posY = availH > 0 ? Math.min(1, Math.max(0, (d.origin.y + dy - d.origin.marginPx) / availH)) : d.config.posY;
      apply({ ...d.config, posX, posY }, false);
    } else {
      const shortSide = Math.min(natural.width, natural.height);
      const width = Math.max(1, d.origin.width + dx);
      const scalePercent = Math.min(WATERMARK_LIMITS.scalePercent.max, Math.max(WATERMARK_LIMITS.scalePercent.min, (width / shortSide) * 100));
      apply({ ...d.config, scalePercent }, false);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* 同上 */ }
    drag.current = null;
    commit(config);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const step = e.shiftKey ? 5 : 1;
    const scalePercent = Math.min(WATERMARK_LIMITS.scalePercent.max, Math.max(WATERMARK_LIMITS.scalePercent.min, config.scalePercent + (e.deltaY < 0 ? step : -step)));
    apply({ ...config, scalePercent }, true);
  };

  if (!rect) return null;

  const toolbar = (
    <div
      className="fixed z-[130] flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/80 border border-white/10 text-xs text-gray-200 shadow-xl backdrop-blur"
      style={{ left: rect.left + rect.width / 2, top: Math.max(8, rect.top + 8), transform: 'translateX(-50%)' }}
    >
      <Move className="w-3.5 h-3.5 text-nai-accent" />
      <span>水印位置</span>
      <span className="text-gray-500">拖动移动 · 拖右下角改大小 · 滚轮微调</span>
      <span className="w-px h-4 bg-white/10" />
      {POSITION_PRESETS.map((p) => {
        const on = Math.abs(config.posX - p.x) < 0.001 && Math.abs(config.posY - p.y) < 0.001 && !config.autoPosition;
        return (
          <button key={p.label} onClick={() => apply({ ...config, autoPosition: false, posX: p.x, posY: p.y }, true)}
            className={`px-2 py-0.5 rounded-full transition-colors ${on ? 'bg-nai-accent text-black font-bold' : 'text-gray-300 hover:text-white hover:bg-white/10'}`}>{p.label}</button>
        );
      })}
      <span className="font-mono text-gray-400">{Math.round(config.posX * 100)},{Math.round(config.posY * 100)}% · {Math.round(config.scalePercent)}%</span>
      <button onClick={() => setWatermarkOverlayMode(false)} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-nai-accent text-black font-bold"><Check className="w-3 h-3" />完成</button>
    </div>
  );

  const body = !logo || !config.imageDataUrl
    ? (
      <div className="fixed z-[129] flex items-center justify-center text-xs text-gray-300 bg-black/40" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
        先在设置 → 水印导出里选一个 logo,再来这里摆位。
      </div>
    )
    : placement && (
      <div className="fixed z-[129]" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, cursor: 'default' }}>
        {config.autoPosition && (
          <div className="absolute left-2 top-2 px-2 py-0.5 rounded bg-black/70 text-[10px] text-amber-300">智能选位开着:这是算法在这张图上选的位置;拖动会改成手动。</div>
        )}
        <div
          className="absolute border border-nai-accent/90 shadow-[0_0_0_1px_rgba(0,0,0,0.6)] cursor-move"
          style={{ left: placement.x * scaleToScreen, top: placement.y * scaleToScreen, width: placement.width * scaleToScreen, height: placement.height * scaleToScreen, touchAction: 'none' }}
          onPointerDown={onPointerDown('move')} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}
        >
          <img src={config.imageDataUrl} alt="" draggable={false} className="w-full h-full object-fill pointer-events-none select-none" style={{ opacity: config.opacity }} />
          <div
            className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-nai-accent border border-black cursor-nwse-resize"
            style={{ touchAction: 'none' }}
            onPointerDown={onPointerDown('resize')} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          />
        </div>
      </div>
    );

  return createPortal(<>{body}{toolbar}</>, document.body);
};
