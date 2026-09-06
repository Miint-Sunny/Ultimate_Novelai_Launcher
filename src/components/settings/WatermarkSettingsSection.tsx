import React, { useRef, useState } from 'react';
import { Crosshair, ImagePlus, Move, Trash2 } from 'lucide-react';
import { type AppSettings } from '../../services/localLibrary';
import { computeSmartWatermarkPosition } from '../../services/watermark/browser.ts';
import { WATERMARK_LIMITS, hasVisibleWatermark, type WatermarkConfig } from '../../services/watermark/index.ts';
import { setWatermarkOverlayMode, useCanvasImageUrl } from '../watermark/overlayMode';

/**
 * 水印导出设置(照他的 watermark_pad_picker):可见水印 + 盲水印两组。字段与默认值和引擎
 * 同名,改动即时保存;导出时 processImageForSave 会按这里的设置走管道。
 */

interface Props {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
  /** 「在画板上调整」要关掉设置弹窗。 */
  onClose: () => void;
}

const POSITION_PRESETS: { label: string; x: number; y: number }[] = [
  { label: '左上', x: 0, y: 0 }, { label: '右上', x: 1, y: 0 }, { label: '居中', x: 0.5, y: 0.5 },
  { label: '左下', x: 0, y: 1 }, { label: '右下', x: 1, y: 1 },
];

function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} className={`relative w-11 h-6 rounded-full transition-colors duration-200 shrink-0 ${on ? 'bg-emerald-500' : 'bg-gray-600'}`}>
      <div className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${on ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}

function Slider({ label, value, min, max, step, display, onChange }: { label: string; value: number; min: number; max: number; step: number; display: string; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 text-xs text-gray-400 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="flex-1 accent-nai-accent" />
      <span className="w-12 text-right text-xs font-mono text-gray-300">{display}</span>
    </div>
  );
}

export const WatermarkSettingsSection: React.FC<Props> = ({ settings, updateSettingsImmediate, onClose }) => {
  const wm = settings.watermark;
  const canvasImageUrl = useCanvasImageUrl();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [logoNote, setLogoNote] = useState<string | null>(null);
  const [smartNote, setSmartNote] = useState<string | null>(null);

  const update = (patch: Partial<WatermarkConfig>) => updateSettingsImmediate({ watermark: { ...wm, ...patch } });

  const pickLogo = async (file: File) => {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
      reader.readAsDataURL(file);
    });
    if (!dataUrl.startsWith('data:image/')) { setLogoNote('只支持 png / jpg / webp 图片'); return; }
    if (dataUrl.length > WATERMARK_LIMITS.imageDataUrlChars) { setLogoNote(`图片太大(${Math.round(dataUrl.length / 1024)} KB),请压缩到约 1.5 MB 以内再选`); return; }
    setLogoNote(null);
    update({ imageDataUrl: dataUrl });
  };

  const pickSmart = async () => {
    if (!canvasImageUrl) { setSmartNote('画板上没有图'); return; }
    setSmartNote('计算中…');
    try {
      const pos = await computeSmartWatermarkPosition(canvasImageUrl, wm);
      update({ posX: pos.x, posY: pos.y, autoPosition: false });
      setSmartNote(`已按当前图选位:${Math.round(pos.x * 100)},${Math.round(pos.y * 100)}%`);
    } catch (error) {
      setSmartNote(`选位失败:${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const visibleReady = hasVisibleWatermark(wm);

  return (
    <div className="space-y-4">
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">可见水印</div>
            <p className="text-xs text-gray-500 mt-1">保存 / 复制 / 打包时把 logo 合成到图上;开着时 PNG 原图也会重新编码。</p>
          </div>
          <Toggle on={wm.enabled} onChange={(v) => update({ enabled: v })} />
        </div>

        <div className={`space-y-4 ${wm.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded border border-gray-700 bg-[repeating-conic-gradient(#333_0_25%,#222_0_50%)] bg-[length:12px_12px] flex items-center justify-center overflow-hidden shrink-0">
              {wm.imageDataUrl ? <img src={wm.imageDataUrl} alt="logo" className="max-w-full max-h-full object-contain" /> : <ImagePlus className="w-5 h-5 text-gray-600" />}
            </div>
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="flex gap-2">
                <button onClick={() => fileRef.current?.click()} className="px-2.5 py-1 rounded text-xs border border-gray-700 bg-gray-800 text-gray-200 hover:text-white hover:border-gray-500">选择 logo</button>
                {wm.imageDataUrl && (
                  <button onClick={() => update({ imageDataUrl: null })} className="px-2 py-1 rounded text-xs border border-gray-700 bg-gray-800 text-gray-400 hover:text-red-300 hover:border-red-500/50 flex items-center gap-1"><Trash2 className="w-3 h-3" />清除</button>
                )}
              </div>
              <p className="text-[11px] text-gray-500">png / jpg / webp,带透明通道效果最好;存在设置里,约 1.5 MB 以内。</p>
              {logoNote && <p className="text-[11px] text-amber-400">{logoNote}</p>}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickLogo(f); if (fileRef.current) fileRef.current.value = ''; }} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="w-16 text-xs text-gray-400 shrink-0">位置</span>
            <div className="flex flex-wrap gap-1.5">
              {POSITION_PRESETS.map((p) => {
                const on = !wm.autoPosition && Math.abs(wm.posX - p.x) < 0.001 && Math.abs(wm.posY - p.y) < 0.001;
                return (
                  <button key={p.label} onClick={() => update({ posX: p.x, posY: p.y, autoPosition: false })}
                    className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${on ? 'bg-nai-accent text-black border-nai-accent font-bold' : 'border-gray-700 text-gray-300 hover:text-white hover:border-gray-500'}`}>{p.label}</button>
                );
              })}
              <span className="px-2 py-0.5 text-xs font-mono text-gray-400">{Math.round(wm.posX * 100)},{Math.round(wm.posY * 100)}%</span>
              <button onClick={() => { setWatermarkOverlayMode(true); onClose(); }} disabled={!visibleReady}
                className="px-2 py-0.5 rounded-full text-xs border border-gray-700 text-gray-200 hover:text-white hover:border-gray-500 disabled:opacity-50 flex items-center gap-1"
                title={visibleReady ? '到画板上拖动矩形摆位、拖角改大小' : '先开启可见水印并选好 logo'}>
                <Move className="w-3 h-3" />在画板上调整
              </button>
            </div>
          </div>

          <Slider label="缩放" value={wm.scalePercent} min={WATERMARK_LIMITS.scalePercent.min} max={WATERMARK_LIMITS.scalePercent.max} step={1} display={`${Math.round(wm.scalePercent)}%`} onChange={(v) => update({ scalePercent: v })} />
          <Slider label="不透明度" value={Math.round(wm.opacity * 100)} min={0} max={100} step={1} display={`${Math.round(wm.opacity * 100)}%`} onChange={(v) => update({ opacity: v / 100 })} />
          <Slider label="边距" value={wm.marginPercent} min={WATERMARK_LIMITS.marginPercent.min} max={WATERMARK_LIMITS.marginPercent.max} step={0.5} display={`${wm.marginPercent}%`} onChange={(v) => update({ marginPercent: v })} />

          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-200">自动对比度</div>
              <p className="text-[11px] text-gray-500">按水印下方背景的亮度把 logo 压暗或提亮</p>
            </div>
            <Toggle on={wm.autoContrast} onChange={(v) => update({ autoContrast: v })} />
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-gray-200">智能选位</div>
              <p className="text-[11px] text-gray-500">每次导出时找画面里信息量最低的位置放,忽略上面的固定位置</p>
              {smartNote && <p className="text-[11px] text-amber-300 mt-0.5">{smartNote}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={pickSmart} className="px-2 py-1 rounded text-xs border border-gray-700 bg-gray-800 text-gray-200 hover:text-white hover:border-gray-500 flex items-center gap-1" title="用当前画板上的图算一次,把结果写进固定位置">
                <Crosshair className="w-3 h-3" />在当前图上选一次
              </button>
              <Toggle on={wm.autoPosition} onChange={(v) => update({ autoPosition: v })} />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">盲水印</div>
            <p className="text-xs text-gray-500 mt-1">DCT 频域隐形水印,肉眼不可见;元数据弹窗里可以提取,与 Novelai-harness 互通。</p>
          </div>
          <Toggle on={wm.blindEnabled} onChange={(v) => update({ blindEnabled: v })} />
        </div>
        <div className={`space-y-3 ${wm.blindEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="flex items-center gap-3">
            <span className="w-16 text-xs text-gray-400 shrink-0">载荷文本</span>
            <input value={wm.blindText} onChange={(e) => update({ blindText: e.target.value })} placeholder="签名 / 版权信息"
              className="flex-1 px-2.5 py-1.5 rounded bg-black/30 border border-gray-700 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-nai-accent" />
          </div>
          <Slider label="强度" value={wm.blindStrength} min={WATERMARK_LIMITS.blindStrength.min} max={WATERMARK_LIMITS.blindStrength.max} step={1} display={String(wm.blindStrength)} onChange={(v) => update({ blindStrength: v })} />
          <p className="text-[11px] text-gray-500">越高越抗压缩,画质扰动略增;jpg 导出时一律按 5 嵌。</p>
        </div>
      </div>
    </div>
  );
};
