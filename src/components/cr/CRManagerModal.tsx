// Precise Reference (CR) 管理器 - 弹窗组件
import React from 'react';
import {
  X, Plus, Check, Globe, HardDrive, RotateCcw,
  Loader2, Trash2, Upload, Pencil,
} from 'lucide-react';
import type { UseCRManagerReturn } from './types';

interface CRManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  manager: UseCRManagerReturn;
  onConfirmSelection: () => void;
}

export const CRManagerModal: React.FC<CRManagerModalProps> = ({
  isOpen, onClose, manager: m, onConfirmSelection,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[500px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <div className="text-nai-accent">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            </div>
            <span className="font-bold text-white text-base">角色管理器</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={m.crInputRef as React.RefObject<HTMLInputElement>}
              className="hidden"
              onChange={m.handleCRUpload}
              accept="image/*"
            />
            <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800">
          <button
            className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${
              m.crTab === 'public'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
            onClick={() => m.setCrTab('public')}
          >
            <div className="flex items-center justify-center gap-2">
              <Globe className="w-4 h-4" />
              公共角色
            </div>
          </button>
          <button
            className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${
              m.crTab === 'local'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
            onClick={() => m.setCrTab('local')}
          >
            <div className="flex items-center justify-center gap-2">
              <HardDrive className="w-4 h-4" />
              我的角色
            </div>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden bg-nai-dark/30 min-h-[300px] relative">
          {/* Public Tab */}
          <div 
            className={`absolute inset-0 overflow-y-auto p-3 transition-transform duration-200 ease-out will-change-transform ${
              m.crTab === 'public' ? 'translate-x-0' : '-translate-x-full pointer-events-none'
            }`}
            style={m.crTab !== 'public' ? { contentVisibility: 'hidden' } : undefined}
          >
            <div className="grid grid-cols-3 gap-3">
              {m.crPublicFiles.map((file) => (
                <CRCard
                  key={file.id}
                  file={file}
                  isSelected={m.selectedCRs.includes(file.id)}
                  isPublic
                  manager={m}
                />
              ))}
            </div>
            {m.crPublicFiles.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-3">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-50"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                </div>
                <p className="text-sm">未找到公共角色</p>
              </div>
            )}
          </div>

          {/* Local Tab */}
          <div 
            className={`absolute inset-0 overflow-y-auto p-3 transition-transform duration-200 ease-out will-change-transform ${
              m.crTab === 'local' ? 'translate-x-0' : 'translate-x-full pointer-events-none'
            }`}
            style={m.crTab !== 'local' ? { contentVisibility: 'hidden' } : undefined}
          >
            <div className="grid grid-cols-3 gap-3">
              {/* Upload Button Card */}
              <div
                className="group relative aspect-[832/1216] rounded-lg border-2 border-dashed border-gray-600 cursor-pointer overflow-hidden transition-all bg-gray-800/50 hover:border-nai-accent hover:bg-gray-800"
                onClick={() => (m.crInputRef as React.RefObject<HTMLInputElement>).current?.click()}
              >
                <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 group-hover:text-nai-accent transition-colors">
                  <Plus className="w-10 h-10 mb-2" />
                  <span className="text-sm font-bold">上传图片</span>
                </div>
              </div>
              {m.crLocalFiles.map((file) => (
                <CRCard
                  key={file.id}
                  file={file}
                  isSelected={m.selectedCRs.includes(file.id)}
                  isPublic={false}
                  manager={m}
                />
              ))}
            </div>

          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center shrink-0">
          <button
            onClick={() => m.setSelectedCRs([])}
            disabled={m.selectedCRs.length === 0}
            className="px-3 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <RotateCcw className="w-4 h-4" />
            清空选择
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors">
              取消
            </button>
            <button
              onClick={onConfirmSelection}
              className="px-4 py-1.5 text-sm font-bold bg-nai-accent text-black rounded hover:bg-[#ebd576] transition-colors"
            >
              确认选择 ({m.selectedCRs.length})
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


// --- CR 卡片子组件 ---
const CRCard: React.FC<{
  file: UseCRManagerReturn['crPublicFiles'][0];
  isSelected: boolean;
  isPublic: boolean;
  manager: UseCRManagerReturn;
}> = ({ file, isSelected, isPublic, manager: m }) => {
  return (
    <div
      key={file.id}
      className={`group relative aspect-[832/1216] rounded-lg border-2 cursor-pointer overflow-hidden transition-all bg-gray-800 ${
        isSelected
          ? 'border-nai-accent ring-2 ring-nai-accent/20'
          : 'border-gray-700 hover:border-gray-500'
      }`}
      onClick={() => m.handleToggleCRSelection(file.id)}
    >
      <img
        src={file.preview} alt={file.name} loading="lazy" decoding="async"
        className="w-full h-full object-cover opacity-0 transition-opacity duration-300"
        onLoad={(e) => e.currentTarget.classList.remove('opacity-0')}
      />
      {isSelected && (
        <div className="absolute top-1.5 left-1.5 bg-nai-accent text-black rounded-full p-1 shadow-lg z-10">
          <Check className="w-3.5 h-3.5" />
        </div>
      )}
      {/* Action Buttons */}
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
        {isPublic && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              m.setCrEditTarget(file);
              m.setCrEditName(file.name);
              m.setCrEditZhNames((file as any).zh_names?.join(', ') || '');
              m.setCrEditModalOpen(true);
            }}
            className="bg-gray-800 hover:bg-gray-700 text-white rounded p-1.5 shadow-lg border border-gray-600"
            title="编辑"
          >
            <Pencil className="w-4 h-4" />
          </button>
        )}
        {isPublic && (
          <button
            onClick={(e) => m.handleDeleteCR(file.id, e)}
            disabled={m.deletingCRId === file.id}
            className="bg-red-500/90 hover:bg-red-600 text-white rounded p-1.5 shadow-lg border border-red-400/50 disabled:opacity-50"
            title="删除"
          >
            {m.deletingCRId === file.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
        )}
        {!isPublic && (
          <>
            <button
              onClick={(e) => m.handleUploadCRToPublic(file, e)}
              disabled={m.uploadingCRId === file.id || m.uploadedCRIds.has(file.id)}
              className={`rounded p-1.5 shadow-lg border ${
                m.uploadedCRIds.has(file.id)
                  ? 'bg-green-500 text-white border-green-400'
                  : 'bg-gray-800 hover:bg-gray-700 text-white border-gray-600'
              }`}
              title={m.uploadedCRIds.has(file.id) ? "已上传" : "上传到公共"}
            >
              {m.uploadingCRId === file.id ? <Loader2 className="w-4 h-4 animate-spin" /> : m.uploadedCRIds.has(file.id) ? <Check className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            </button>
            <button
              onClick={(e) => m.handleDeleteCR(file.id, e)}
              className="bg-red-500/90 hover:bg-red-600 text-white rounded p-1.5 shadow-lg border border-red-400/50"
              title="删除"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2 pt-5">
        <div className={`text-sm font-bold truncate ${isSelected ? 'text-nai-accent' : 'text-white'}`}>
          {file.name}
        </div>
      </div>
    </div>
  );
};
