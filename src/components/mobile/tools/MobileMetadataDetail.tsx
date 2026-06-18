import React, { useState } from 'react';
import { ArrowLeft, Check, Copy, Users, Download } from 'lucide-react';
import type { ImageMetadata } from '../../../utils/imageMetadata';
import type { MetadataFile } from './types';
import { useCharacterRecognition } from './characterRecognition';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/* ─── 元数据详情面板（全屏覆盖） ─── */

export const MobileMetadataDetail: React.FC<{
  file: MetadataFile;
  onBack: () => void;
  onImport?: (metadata: ImageMetadata) => void;
}> = ({ file, onBack, onImport }) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const m = file.metadata;
  const fullPrompt = m ? [m.prompt, ...(m.characterPrompts?.map(cp => cp.prompt) || [])].filter(Boolean).join(', ') : '';
  const charMatches = useCharacterRecognition(fullPrompt);

  const handleCopy = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const CopyBtn: React.FC<{ text: string; field: string }> = ({ text, field }) => (
    <button onClick={() => handleCopy(text, field)} className="p-1.5 rounded-md text-gray-500 active:text-white active:bg-gray-700/50">
      {copiedField === field ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );

  return (
    <div className="absolute inset-0 z-10 bg-nai-bg flex flex-col">
      {/* 顶栏 */}
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-gray-800">
        <button onClick={onBack} className="p-1.5 rounded-lg active:bg-gray-700"><ArrowLeft className="w-5 h-5" /></button>
        <span className="text-sm font-semibold truncate flex-1">{file.name}</span>
      </div>

      {/* 内容 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 图片 + 基础信息 */}
        <div className="space-y-2">
          {file.dataUrl && <img src={file.dataUrl} alt="" className="w-full max-h-48 object-contain rounded-xl bg-gray-900/60" />}
          <div className="space-y-1 text-xs">
            {[
              { label: '大小', value: file.fileSize > 0 ? formatFileSize(file.fileSize) : '-' },
              { label: '尺寸', value: m ? `${m.width}×${m.height}` : '-' },
              { label: '格式', value: m?.sourceType || '-' },
              { label: '来源', value: m?.source || '未知' },
            ].map(item => (
              <div key={item.label} className="flex items-start gap-2">
                <span className="text-gray-500 shrink-0">{item.label}</span>
                <span className="text-white break-all">{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        {!m ? (
          <div className="flex items-center gap-2 text-gray-400 text-sm bg-gray-900/40 rounded-xl p-3">
            此图片不包含可识别的元数据
          </div>
        ) : (
          <>
            {m.prompt && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">正向提示词</span>
                  <CopyBtn text={m.prompt} field="prompt" />
                </div>
                <div className="text-xs text-gray-200 bg-gray-900/50 rounded-xl p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{m.prompt}</div>
              </div>
            )}
            {m.negativePrompt && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">负向提示词</span>
                  <CopyBtn text={m.negativePrompt} field="negative" />
                </div>
                <div className="text-xs text-gray-200 bg-gray-900/50 rounded-xl p-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">{m.negativePrompt}</div>
              </div>
            )}

            {m.characterPrompts && m.characterPrompts.length > 0 && (
              <div>
                <span className="text-xs font-semibold text-gray-400">角色提示词</span>
                <div className="mt-1.5 space-y-1.5">
                  {m.characterPrompts.map((cp, i) => (
                    <div key={i} className="bg-gray-900/50 rounded-xl p-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-gray-500">角色 {i + 1}{cp.center ? ` (${cp.center.x.toFixed(2)}, ${cp.center.y.toFixed(2)})` : ''}</span>
                        <CopyBtn text={cp.prompt} field={`char_${i}`} />
                      </div>
                      <div className="text-xs text-gray-200 whitespace-pre-wrap break-all">{cp.prompt}</div>
                      {cp.uc && <div className="text-xs text-red-400/70 mt-1 whitespace-pre-wrap break-all">UC: {cp.uc}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 角色识别 */}
            {charMatches.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Users className="w-3 h-3 text-gray-400" />
                  <span className="text-xs font-semibold text-gray-400">角色识别</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {charMatches.map((ch, i) => (
                    <span key={i} className={`inline-flex items-center gap-0.5 rounded-lg px-2 py-1 text-[11px] ${ch.isOC ? 'bg-purple-500/15 text-purple-400' : 'bg-nai-accent/15 text-nai-accent'}`}>
                      {ch.isOC && <span className="text-[8px] font-bold bg-purple-500/30 rounded px-0.5 py-0.5 mr-0.5">OC</span>}
                      <span className="font-medium">{ch.zhName}</span>
                      <span className={`text-[9px] ${ch.isOC ? 'text-purple-400/60' : 'text-nai-accent/60'}`}>[{ch.enTag}]</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div>
              <span className="text-xs font-semibold text-gray-400">生成参数</span>
              <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                {[
                  { label: 'Seed', value: m.seed },
                  { label: 'Steps', value: m.steps },
                  { label: 'CFG', value: m.scale },
                  { label: 'Sampler', value: m.sampler },
                  { label: 'Noise', value: m.noiseSchedule },
                  { label: 'Rescale', value: m.cfgRescale },
                ].filter(p => p.value != null && p.value !== '').map((p) => (
                  <div key={p.label} className="bg-gray-900/50 rounded-lg px-2 py-1.5">
                    <div className="text-[10px] text-gray-500">{p.label}</div>
                    <div className="text-xs text-white truncate">{String(p.value)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* SD 额外参数 */}
            {m.raw?.type === 'stable-diffusion' && m.raw?.settings && (() => {
              const s = m.raw.settings;
              const sdParams = [
                { label: 'Denoising', value: s.denoisingStrength },
                { label: 'Clip Skip', value: s.clipSkip },
                { label: 'Hires', value: s.hiresUpscale },
                { label: 'Upscaler', value: s.hiresUpscaler },
                { label: 'Hash', value: s.modelHash },
                { label: 'Version', value: s.version },
                { label: 'Lora Hash', value: s.loraHashes },
              ].filter(p => p.value !== undefined && p.value !== null && p.value !== '');
              if (sdParams.length === 0) return null;
              return (
                <div>
                  <span className="text-xs font-semibold text-gray-400">SD 参数</span>
                  <div className="grid grid-cols-3 gap-1.5 mt-1.5">
                    {sdParams.map((p) => (
                      <div key={p.label} className="bg-gray-900/50 rounded-lg px-2 py-1.5">
                        <div className="text-[10px] text-gray-500">{p.label}</div>
                        <div className="text-xs text-white truncate">{String(p.value)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {m.raw && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-gray-400">原始数据</span>
                  <CopyBtn text={JSON.stringify(m.raw, null, 2)} field="raw" />
                </div>
                <pre className="text-[10px] text-gray-400 bg-gray-900/50 rounded-xl p-3 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(m.raw, null, 2)}</pre>
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部导入按钮 */}
      {onImport && m && (
        <div className="p-3 border-t border-gray-800 shrink-0">
          <button onClick={() => onImport(m)} className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black font-bold rounded-xl text-sm">
            <Download className="w-4 h-4" />
            导入参数到生成面板
          </button>
        </div>
      )}
    </div>
  );
};
