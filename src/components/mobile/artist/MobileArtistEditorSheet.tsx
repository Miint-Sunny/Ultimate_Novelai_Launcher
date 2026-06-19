import React from 'react';
import {
  ArrowLeft,
  Copy,
  Edit2,
  Globe,
  HardDrive,
  Loader2,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { UseArtistManagerReturn } from '../../artist/types';

interface MobileArtistEditorSheetProps {
  manager: UseArtistManagerReturn;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export const MobileArtistEditorSheet: React.FC<MobileArtistEditorSheetProps> = ({
  manager: m,
  fileInputRef,
  onFileUpload,
}) => {
  if (!m.isCreatingArtist) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-nai-panel flex flex-col animate-fade-in safe-area-bottom">
      <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700 bg-nai-panel z-10">
        <div className="flex items-center gap-2">
          <button
            onClick={() => m.setIsCreatingArtist(false)}
            className="flex items-center gap-1.5 px-2 py-1.5 -ml-2 text-gray-300 active:text-white rounded-lg active:bg-white/10 transition-colors hit-area"
          >
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm font-medium">返回</span>
          </button>
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            {m.editingArtistId ? <Edit2 className="w-4 h-4 text-amber-500" /> : <Plus className="w-4 h-4 text-amber-500" />}
            {m.editingArtistId ? '编辑画师串' : '新建画师串'}
          </h3>
        </div>
        {m.editingArtistId && (
          <button
            onClick={() => m.handleDeleteArtist(m.editingArtistId!)}
            className="flex items-center gap-1.5 px-2 py-1.5 -mr-2 text-red-400 rounded-lg active:bg-red-500/15 transition-colors hit-area"
          >
            <Trash2 className="w-4.5 h-4.5" />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scrollbar">
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-xs text-gray-400 font-bold block mb-1.5 uppercase tracking-wider">画师串名称</label>
            <input
              type="text"
              value={m.newArtistName}
              onChange={(e) => m.setNewArtistName(e.target.value)}
              className="w-full bg-gray-800/80 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm focus:border-amber-500 outline-none font-bold transition-colors"
              placeholder="输入容易辨识的名称..."
            />
          </div>

          <div className="flex flex-col flex-1 min-h-[160px]">
            <div className="flex justify-between items-end mb-1.5">
              <label className="text-xs text-gray-400 font-bold uppercase tracking-wider">提示词内容</label>
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text) m.handleArtistPromptChange(text);
                  } catch (e) {
                    alert('无法读取剪贴板');
                  }
                }}
                className="text-[11px] bg-gray-800 hover:bg-gray-700 text-gray-300 px-2.5 py-1 rounded-md flex items-center gap-1 active:scale-95 transition-all outline outline-1 outline-gray-700"
              >
                <Copy className="w-3 h-3" /> 粘贴
              </button>
            </div>
            <textarea
              value={m.newArtistPrompt}
              onChange={(e) => m.handleArtistPromptChange(e.target.value)}
              className="flex-1 w-full bg-gray-800/80 border border-gray-700 rounded-xl p-3 text-sm text-white focus:border-amber-500 outline-none resize-none font-mono leading-relaxed transition-colors"
              placeholder="在此粘贴画师或风格词串..."
            />
          </div>
        </div>

        <div className="h-px bg-gray-800/80" />

        <div>
          <div className="flex justify-between items-end mb-2">
            <label className="text-xs text-gray-400 font-bold uppercase tracking-wider">画师效果图 ({m.newArtistPreviews.length}/4)</label>
          </div>

          <input
            type="file"
            multiple
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            onChange={onFileUpload}
          />

          <div className="grid grid-cols-2 gap-2 aspect-square">
            {[0, 1, 2, 3].map((idx) => {
              const preview = m.newArtistPreviews[idx];
              const isCover = m.selectedArtistCoverIndex === idx;
              const isGeneratingThis = m.isGeneratingArtistPreviews && m.artistPreviewProgress?.current === idx + 1;

              return (
                <div
                  key={idx}
                  className={`relative rounded-xl overflow-hidden bg-gray-800/40 border-2 transition-all ${
                    preview
                      ? (isCover ? 'border-amber-500' : 'border-gray-700')
                      : 'border-dashed border-gray-700/50 active:bg-gray-800/80'
                  }`}
                  onClick={() => preview ? m.setSelectedArtistCoverIndex(idx) : (!m.isGeneratingArtistPreviews && fileInputRef.current?.click())}
                >
                  {isGeneratingThis && (
                    <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-20 backdrop-blur-[2px]">
                      <Loader2 className="w-6 h-6 text-amber-500 animate-spin mb-2" />
                      <span className="text-[10px] text-amber-400 font-bold">生成中...</span>
                    </div>
                  )}

                  {preview ? (
                    <>
                      <img src={preview} alt="" className="w-full h-full object-cover" />
                      <div className="absolute top-1.5 left-1.5 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded backdrop-blur-md">
                        #{idx + 1}
                      </div>
                      {isCover && (
                        <div className="absolute top-1.5 right-1.5 bg-amber-500 text-black text-[10px] px-1.5 py-0.5 rounded font-bold shadow-md">
                          封面
                        </div>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          m.setNewArtistPreviews(prev => prev.filter((_, i) => i !== idx));
                        }}
                        className="absolute bottom-1.5 right-1.5 w-9 h-9 bg-red-500/80 backdrop-blur-md text-white rounded-xl flex items-center justify-center active:scale-90"
                      >
                        <X className="w-4 h-4 stroke-2" />
                      </button>
                      {m.newArtistPrompt && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            m.handleRegenerateArtistPreviewAt(idx);
                          }}
                          disabled={m.isGeneratingArtistPreviews}
                          className="absolute bottom-1.5 right-12 w-9 h-9 bg-black/60 backdrop-blur-md text-white rounded-xl flex items-center justify-center active:scale-90 disabled:opacity-50"
                        >
                          <RefreshCw className="w-4 h-4" />
                        </button>
                      )}
                    </>
                  ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-gray-500 gap-1 opacity-60">
                      <Plus className="w-6 h-6" />
                      <span className="text-[10px] font-medium tracking-wide">上传或生成</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {m.newArtistPreviews.length < 4 && (
            <button
              onClick={m.handleGenerateSingleArtistPreview}
              disabled={!m.newArtistPrompt || m.isGeneratingArtistPreviews}
              className="w-full mt-3 py-3 bg-gray-800 text-amber-500 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-40 disabled:active:scale-100 flex items-center justify-center gap-2 border border-gray-700/50"
            >
              {m.isGeneratingArtistPreviews ? <Loader2 className="w-4 h-4 animate-spin" /> : <Palette className="w-4 h-4" />}
              使用预设生成一张
            </button>
          )}
        </div>
      </div>

      <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel shadow-[0_-10px_20px_rgba(0,0,0,0.3)]">
        {m.editingArtistId ? (
          <button
            onClick={() => m.handleSaveArtist()}
            disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
            className="w-full py-3.5 bg-amber-500 text-black font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            保存修改
          </button>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={() => m.handleSaveArtist('public')}
              disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
              className="flex-[4] py-3.5 bg-gray-800 text-white border border-gray-700 font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <Globe className="w-5 h-5 text-gray-400" />}
              公开
            </button>
            <button
              onClick={() => m.handleSaveArtist('local')}
              disabled={!m.newArtistName || m.newArtistPreviews.length === 0 || m.isSavingArtist}
              className="flex-[6] py-3.5 bg-amber-500 text-black font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-[0_0_15px_rgba(245,158,11,0.2)]"
            >
              {m.isSavingArtist ? <Loader2 className="w-5 h-5 animate-spin" /> : <HardDrive className="w-5 h-5" />}
              保存至本地
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
