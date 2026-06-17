import { Check, Copy, Loader2, Sparkles, Trash2, User, X } from 'lucide-react';
import type { useMobileOCManager } from './generate/useMobileOCManager';

type MobileOCManager = ReturnType<typeof useMobileOCManager>;

interface MobileOCEditorSheetProps {
  isOpen: boolean;
  manager: MobileOCManager;
}

export function MobileOCEditorSheet({ isOpen, manager }: MobileOCEditorSheetProps) {
  if (!isOpen || !manager.ocEditorMode) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-black/80 flex items-end animate-fade-in">
      <div className="absolute inset-0" onClick={manager.closeOCEditor} />
      <div className="relative w-full max-h-[85vh] overflow-y-auto bg-nai-panel rounded-t-2xl border-t border-gray-700 p-4 safe-area-bottom">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h4 className="text-lg font-bold text-white">{manager.ocEditorMode === 'create' ? '添加我的 OC' : '编辑我的 OC'}</h4>
          </div>
          <button onClick={manager.closeOCEditor} className="p-2 -mr-2 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="w-24 shrink-0">
              <div className="aspect-[832/1216] overflow-hidden rounded-xl border border-gray-700 bg-black/20 flex items-center justify-center relative">
                {manager.ocDraftPreview ? (
                  <img src={manager.ocDraftPreview} alt="OC preview" className="h-full w-full object-cover" />
                ) : (
                  <User className="w-8 h-8 text-gray-600" />
                )}
                {manager.isGeneratingOCPreview && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Loader2 className="w-5 h-5 animate-spin text-cyan-300" />
                  </div>
                )}
              </div>
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">名称</label>
                <input
                  value={manager.ocDraftName}
                  onChange={(event) => manager.setOcDraftName(event.target.value)}
                  placeholder="OC 名称..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm font-bold focus:outline-none focus:border-cyan-500"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">别名（逗号分隔）</label>
                <input
                  value={manager.ocDraftAliases}
                  onChange={(event) => manager.setOcDraftAliases(event.target.value)}
                  placeholder="小名, 昵称, ..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-cyan-500"
                />
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="block text-xs text-gray-400">提示词</label>
                <button type="button" onClick={manager.handlePasteOCPrompt} className="text-xs text-gray-300 hover:text-white flex items-center gap-1">
                  <Copy className="w-3 h-3" />
                  粘贴
                </button>
              </div>
              <textarea
                value={manager.ocDraftPositive}
                onChange={(event) => manager.setOcDraftPositive(event.target.value)}
                rows={8}
                placeholder="1girl, ..."
                className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-white font-mono focus:outline-none focus:border-cyan-500 resize-none"
              />
            </div>
            <button
              type="button"
              onClick={manager.handleGenerateOCPreview}
              disabled={!manager.ocDraftPositive.trim() || manager.isGeneratingOCPreview}
              className="w-full rounded-xl bg-gray-100 py-2.5 text-sm font-bold text-black disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {manager.isGeneratingOCPreview ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {manager.ocDraftPreview ? '重新生成预览' : '生成预览'}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {manager.editingOCId ? (
            <button
              onClick={async () => {
                await manager.deleteEditingOC();
                manager.closeOCEditor();
              }}
              className="py-3 rounded-xl bg-red-500/15 text-red-300 font-medium flex items-center justify-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              删除
            </button>
          ) : (
            <button onClick={manager.closeOCEditor} className="py-3 rounded-xl bg-gray-700 text-white font-medium">
              取消
            </button>
          )}
          <button
            onClick={manager.handleSaveOC}
            disabled={manager.isSavingOC}
            className="py-3 rounded-xl bg-cyan-500 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {manager.isSavingOC ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
