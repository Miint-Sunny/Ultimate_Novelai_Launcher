// Precise Reference (CR) 编辑弹窗
import React from 'react';
import { X, Pencil, Loader2, Upload } from 'lucide-react';
import type { UseCRManagerReturn } from './types';

interface CREditModalProps {
  manager: UseCRManagerReturn;
}

export const CREditModal: React.FC<CREditModalProps> = ({ manager: m }) => {
  if (!m.crEditModalOpen || !m.crEditTarget) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => m.setCrEditModalOpen(false)}>
      <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-96 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <div className="text-nai-accent">
              {m.crEditIsUpload ? <Upload className="w-5 h-5" /> : <Pencil className="w-5 h-5" />}
            </div>
            <span className="font-bold text-white text-base">{m.crEditIsUpload ? '上传到公共' : '编辑 CR'}</span>
          </div>
          <button onClick={() => m.setCrEditModalOpen(false)} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* 预览图 */}
          <div className="w-full h-32 rounded-lg overflow-hidden bg-black/30 border border-gray-700">
            <img
              src={m.crEditTarget.preview}
              alt={m.crEditTarget.name}
              className="w-full h-full object-contain"
            />
          </div>

          {/* 名称输入 */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">主名称</label>
            <input
              type="text"
              value={m.crEditName}
              onChange={(e) => m.setCrEditName(e.target.value)}
              placeholder="角色名称，如：琪亚娜、Kiana"
              className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
            />
          </div>

          {/* 别名输入 */}
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">别名（用于Bot匹配，多个用逗号分隔）</label>
            <input
              type="text"
              value={m.crEditZhNames}
              onChange={(e) => m.setCrEditZhNames(e.target.value)}
              placeholder="例如：小琪,K423"
              className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
            />
            <p className="text-xs text-gray-500 mt-1.5">Bot 会根据主名称和别名匹配并自动应用此角色</p>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 flex gap-3">
          <button
            onClick={() => m.setCrEditModalOpen(false)}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={m.handleSaveCREdit}
            disabled={m.isSavingCREdit || !m.crEditName.trim()}
            className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {m.isSavingCREdit ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {m.crEditIsUpload ? '上传中...' : '保存中...'}
              </>
            ) : (
              m.crEditIsUpload ? '确认上传' : '保存'
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
