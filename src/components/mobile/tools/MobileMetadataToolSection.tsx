import React from 'react';
import {
  Archive,
  Check,
  FileEdit,
  FileX,
  Image as ImageIcon,
  Loader2,
  Trash2,
  Upload,
} from 'lucide-react';
import { MobileMetadataDetail } from './MobileMetadataDetail';
import type { MobileProcessFileForTarget } from './types';
import { useMobileMetadataBatch } from './useMobileMetadataBatch';

interface MobileMetadataToolSectionProps {
  processFileForTarget: MobileProcessFileForTarget;
}

export const MobileMetadataToolSection: React.FC<MobileMetadataToolSectionProps> = ({
  processFileForTarget,
}) => {
  const metadataBatch = useMobileMetadataBatch(processFileForTarget);
  const {
    metadataFiles,
    isLoading,
    loadingProgress,
    batchMode,
    setBatchMode,
    customPrompt,
    setCustomPrompt,
    isProcessing,
    viewingFile,
    setViewingIndex,
    fileInputRef,
    handleImport,
    handleFileSelect,
    toggleSelect,
    toggleSelectAll,
    removeSelected,
    clearAll,
    handleDownloadZip,
    selectedCount,
    allSelected,
    hasFiles,
  } = metadataBatch;

  return (
    <>
      {!hasFiles && (
        <div className="flex-1 flex flex-col items-center justify-center px-8">
          <div className="w-20 h-20 rounded-2xl bg-gray-800/60 flex items-center justify-center mb-5">
            <Upload className="w-10 h-10 text-gray-500" />
          </div>
          <h4 className="text-lg font-semibold text-white mb-1.5">添加图片</h4>
          <p className="text-xs text-gray-400 text-center mb-6">查看生成参数，批量清除或覆写元数据</p>
          <input ref={fileInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-6 py-3 bg-nai-accent text-black rounded-xl text-sm font-bold">
            <ImageIcon className="w-5 h-5" />
            选择图片
          </button>
        </div>
      )}

      {hasFiles && (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="shrink-0 px-3 py-2.5 border-b border-gray-800 flex items-center gap-2 flex-wrap">
            <input ref={fileInputRef} type="file" multiple accept="image/*" onChange={handleFileSelect} className="hidden" />
            <button onClick={() => fileInputRef.current?.click()} disabled={isLoading} className="flex items-center gap-1.5 px-3 py-1.5 bg-nai-accent/15 text-nai-accent border border-nai-accent/25 rounded-lg text-xs font-medium">
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImageIcon className="w-3.5 h-3.5" />}
              添加
            </button>
            <button onClick={toggleSelectAll} className="text-xs text-gray-400 px-2 py-1.5 rounded-lg active:bg-gray-800">{allSelected ? '取消全选' : '全选'}</button>
            {selectedCount > 0 && (
              <button onClick={removeSelected} className="text-xs text-red-400 px-2 py-1.5 rounded-lg active:bg-gray-800 flex items-center gap-1">
                <Trash2 className="w-3 h-3" />{selectedCount}
              </button>
            )}
            <button onClick={clearAll} className="text-xs text-gray-500 px-2 py-1.5 rounded-lg active:bg-gray-800 ml-auto">清空</button>
          </div>

          {isLoading && loadingProgress.total > 0 && (
            <div className="px-3 py-2 bg-gray-900/40 border-b border-gray-800 shrink-0">
              <div className="flex items-center gap-2 text-xs text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>{loadingProgress.current}/{loadingProgress.total}</span>
                <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
                  <div className="h-full bg-nai-accent/60 rounded-full transition-all" style={{ width: `${(loadingProgress.current / loadingProgress.total) * 100}%` }} />
                </div>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2.5">
            <div className="grid grid-cols-3 gap-1.5">
              {metadataFiles.map((file, index) => (
                <div
                  key={index}
                  className={`relative group rounded-xl overflow-hidden border-2 aspect-square ${
                    file.isSelected ? 'border-nai-accent/50' : 'border-transparent'
                  }`}
                  onClick={() => setViewingIndex(index)}
                >
                  {file.dataUrl ? (
                    <img src={file.dataUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-gray-800 flex items-center justify-center"><ImageIcon className="w-5 h-5 text-gray-600" /></div>
                  )}
                  <button
                    className={`absolute top-1 left-1 w-5 h-5 rounded-md flex items-center justify-center ${
                      file.isSelected ? 'bg-nai-accent text-black' : 'bg-black/40 text-transparent'
                    }`}
                    onClick={(event) => { event.stopPropagation(); toggleSelect(index); }}
                  >
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </button>
                  {file.metadata && (
                    <div className="absolute top-1 right-1 px-1 py-0.5 rounded bg-nai-accent text-[8px] font-bold text-black">META</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {selectedCount > 0 && (
            <div className="shrink-0 px-3 py-3 border-t border-gray-800 bg-gray-900/50 space-y-2">
              {batchMode === 'custom' && (
                <input type="text" value={customPrompt} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="自定义提示词..." className="w-full px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-white placeholder-gray-500 focus:outline-none" />
              )}
              <div className="flex items-center gap-2">
                <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700 shrink-0">
                  <button className={`px-3.5 py-2 rounded-md text-xs font-medium flex items-center gap-1 ${batchMode === 'clean' ? 'bg-nai-accent text-black' : 'text-gray-400'}`} onClick={() => setBatchMode('clean')}>
                    <FileX className="w-3.5 h-3.5" />清除
                  </button>
                  <button className={`px-3.5 py-2 rounded-md text-xs font-medium flex items-center gap-1 ${batchMode === 'custom' ? 'bg-nai-accent text-black' : 'text-gray-400'}`} onClick={() => setBatchMode('custom')}>
                    <FileEdit className="w-3.5 h-3.5" />覆写
                  </button>
                </div>
                <button
                  onClick={handleDownloadZip}
                  disabled={isProcessing || (batchMode === 'custom' && !customPrompt)}
                  className="flex items-center gap-1.5 px-5 py-2.5 bg-nai-accent text-black rounded-lg text-sm font-bold ml-auto shrink-0 disabled:opacity-50"
                >
                  {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                  {selectedCount > 1 ? `打包 (${selectedCount})` : '下载'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {viewingFile && (
        <MobileMetadataDetail
          file={viewingFile}
          onBack={() => setViewingIndex(null)}
          onImport={handleImport}
        />
      )}
    </>
  );
};
