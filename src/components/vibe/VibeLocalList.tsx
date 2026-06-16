import type { Dispatch, MouseEvent, RefObject, SetStateAction, UIEvent } from 'react';
import { Cloud, Clock, Download, Edit2, File, ListFilter, MoreVertical, Settings, Tag, Trash2, Upload } from 'lucide-react';
import { clearRecentVibeEntries, type RecentVibeEntry } from '../../services/localLibrary';
import { VibeCard } from './VibeCard';
import type { VibeFile } from './types';
import { sortVibesByCreatedAtDesc } from './vibeManagerUtils';
import type { EditingVibeDefaults } from './useVibeCrudActions';

interface VibeLocalListProps {
  localScrollRef: RefObject<HTMLDivElement | null>;
  handleLocalScroll: (event: UIEvent<HTMLDivElement>) => void;
  vibeTab: 'public' | 'local';
  recentEntries: RecentVibeEntry[];
  setRecentEntries: Dispatch<SetStateAction<RecentVibeEntry[]>>;
  localFiles: VibeFile[];
  publicFiles: VibeFile[];
  selectedVibes: string[];
  toggleVibeSelection: (id: string) => void;
  selectedTagFilter: Set<string>;
  setSelectedTagFilter: Dispatch<SetStateAction<Set<string>>>;
  tagPool: string[];
  setTagSettingsOpen: (open: boolean) => void;
  tagFilteredLocalFiles: VibeFile[];
  filteredLocalFiles: VibeFile[];
  vibeSearchQuery: string;
  vibeModelFilter: string;
  selectedModelId: string;
  isVibeInPublic: (vibeId: string) => boolean;
  handleDeleteVibeFile: (id: string, event: MouseEvent) => Promise<void>;
  vibeMenuOpenId: string | null;
  setVibeMenuOpenId: Dispatch<SetStateAction<string | null>>;
  setEditingVibeDefaults: Dispatch<SetStateAction<EditingVibeDefaults | null>>;
  handleDownloadVibe: (file: VibeFile) => Promise<void>;
  handleRemoveFromPublic: (file: VibeFile) => Promise<void>;
  handleUploadVibeToPublic: (file: VibeFile, event: MouseEvent) => void;
  uploadingVibeIds: Set<string>;
}

export function VibeLocalList({
  localScrollRef,
  handleLocalScroll,
  vibeTab,
  recentEntries,
  setRecentEntries,
  localFiles,
  publicFiles,
  selectedVibes,
  toggleVibeSelection,
  selectedTagFilter,
  setSelectedTagFilter,
  tagPool,
  setTagSettingsOpen,
  tagFilteredLocalFiles,
  filteredLocalFiles,
  vibeSearchQuery,
  vibeModelFilter,
  selectedModelId,
  isVibeInPublic,
  handleDeleteVibeFile,
  vibeMenuOpenId,
  setVibeMenuOpenId,
  setEditingVibeDefaults,
  handleDownloadVibe,
  handleRemoveFromPublic,
  handleUploadVibeToPublic,
  uploadingVibeIds,
}: VibeLocalListProps) {
  return (
    <div
      ref={localScrollRef}
      onScroll={handleLocalScroll}
      className={`absolute inset-0 overflow-y-scroll p-2 transition-transform duration-200 ease-out will-change-transform ${vibeTab === 'local'
        ? 'translate-x-0'
        : 'translate-x-full pointer-events-none'
        }`}
      style={vibeTab !== 'local' ? { contentVisibility: 'hidden' } : undefined}
    >
      {recentEntries.length > 0 && (() => {
        const recentVibes: VibeFile[] = [];
        for (const entry of recentEntries) {
          const live = localFiles.find(file => file.id === entry.id) || publicFiles.find(file => file.id === entry.id);
          if (live) recentVibes.push(live);
          if (recentVibes.length >= 8) break;
        }
        if (recentVibes.length === 0) return null;
        return (
          <div className="mb-3 px-1">
            <div className="flex items-center justify-between mb-2 text-xs text-gray-400">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                <span className="font-bold">最近使用</span>
              </div>
              <button
                onClick={() => {
                  clearRecentVibeEntries();
                  setRecentEntries([]);
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md text-gray-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="清空最近使用"
              >
                <Trash2 className="w-3 h-3" />
                <span>清空</span>
              </button>
            </div>
            <div className="flex gap-2">
              {recentVibes.map(file => {
                const isSelected = selectedVibes.includes(file.id);
                return (
                  <div
                    key={file.id}
                    className="flex-shrink-0 w-16 cursor-pointer group/recent transition-all"
                    onClick={() => toggleVibeSelection(file.id)}
                    title={file.name}
                  >
                    <div className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition-colors ${isSelected ? 'border-nai-accent' : 'border-transparent hover:border-gray-600'}`}>
                      {file.preview ? (
                        <img src={file.preview} alt={file.name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                          <File className="w-5 h-5 text-gray-500" />
                        </div>
                      )}
                    </div>
                    <div className={`text-[10px] mt-1 truncate text-center ${isSelected ? 'text-nai-accent font-bold' : 'text-gray-400'}`}>
                      {file.name}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div className="mb-2 px-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <ListFilter className="w-3.5 h-3.5" />
          <span className="font-bold">{selectedTagFilter.size > 0 ? '已筛选' : '全部 Vibe'}</span>
          <span className="text-gray-500">({tagFilteredLocalFiles.length})</span>
        </div>
        <button
          onClick={() => setTagSettingsOpen(true)}
          className="p-1 text-gray-500 hover:text-nai-accent rounded hover:bg-white/5 transition-colors"
          title="管理标签"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="mb-2 px-1">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-thin scrollbar-thumb-gray-700">
          <button
            onClick={() => setSelectedTagFilter(new Set())}
            className={`shrink-0 px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors flex items-center gap-1 ${
              selectedTagFilter.size === 0
                ? 'bg-nai-accent text-black'
                : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
            }`}
          >
            全部
          </button>
          {tagPool.map(tag => {
            const active = selectedTagFilter.has(tag);
            return (
              <button
                key={tag}
                onClick={() => {
                  setSelectedTagFilter(prev => {
                    const next = new Set(prev);
                    if (next.has(tag)) next.delete(tag);
                    else next.add(tag);
                    return next;
                  });
                }}
                className={`shrink-0 px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors flex items-center gap-1 ${
                  active
                    ? 'bg-nai-accent text-black'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700'
                }`}
                title={`筛选 "${tag}"`}
              >
                <Tag className="w-2.5 h-2.5" />
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {sortVibesByCreatedAtDesc(tagFilteredLocalFiles).map((file) => {
          const inPublic = isVibeInPublic(file.id);
          return (
            <VibeCard
              key={file.id}
              file={file}
              isSelected={selectedVibes.includes(file.id)}
              selectedModelId={selectedModelId}
              onClick={() => toggleVibeSelection(file.id)}
              tagPrefix={inPublic ? <span className="text-blue-400" title="已上传到公共"><Cloud className="w-3.5 h-3.5" /></span> : undefined}
              actions={
                <>
                  <button
                    onClick={(event) => handleDeleteVibeFile(file.id, event)}
                    className="p-2 text-gray-400 hover:text-red-400 rounded hover:bg-white/10 transition-colors"
                    title="删除"
                  >
                    <Trash2 className="w-5 h-5" />
                  </button>
                  <div className="relative">
                    <button
                      onClick={(event) => { event.stopPropagation(); setVibeMenuOpenId(prev => prev === file.id ? null : file.id); }}
                      className="p-2 text-gray-400 hover:text-white rounded hover:bg-white/10 transition-colors"
                      title="更多操作"
                    >
                      <MoreVertical className="w-5 h-5" />
                    </button>
                    {vibeMenuOpenId === file.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={(event) => { event.stopPropagation(); setVibeMenuOpenId(null); }} />
                        <div className="absolute right-0 top-full mt-1 w-44 bg-nai-panel border border-gray-700 rounded-lg shadow-xl z-50 py-1 text-sm">
                          <button
                            onClick={(event) => { event.stopPropagation(); setVibeMenuOpenId(null); setEditingVibeDefaults({ vibeId: file.id, name: file.name, editName: file.name, strength: file.defaultStrength ?? 1, infoExtracted: file.defaultInfoExtracted ?? 1, tags: new Set(file.tags || []) }); }}
                            className="w-full text-left px-3 py-2 text-gray-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
                          >
                            <Edit2 className="w-4 h-4" /> 编辑
                          </button>
                          <button
                            onClick={(event) => { event.stopPropagation(); setVibeMenuOpenId(null); handleDownloadVibe(file); }}
                            className="w-full text-left px-3 py-2 text-gray-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
                          >
                            <Download className="w-4 h-4" /> 下载
                          </button>
                          {inPublic ? (
                            <button
                              onClick={(event) => { event.stopPropagation(); setVibeMenuOpenId(null); handleRemoveFromPublic(file); }}
                              className="w-full text-left px-3 py-2 text-red-400 hover:bg-red-900/20 flex items-center gap-2"
                            >
                              <Cloud className="w-4 h-4" /> 从公共撤回
                            </button>
                          ) : (
                            <button
                              onClick={(event) => { handleUploadVibeToPublic(file, event); setVibeMenuOpenId(null); }}
                              disabled={uploadingVibeIds.has(file.id)}
                              className="w-full text-left px-3 py-2 text-gray-300 hover:bg-white/10 hover:text-white flex items-center gap-2 disabled:opacity-50"
                            >
                              <Upload className="w-4 h-4" /> 上传到公共
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </>
              }
            />
          );
        })}

        {filteredLocalFiles.length === 0 && localFiles.length > 0 && (vibeSearchQuery.trim() || vibeModelFilter !== 'all') && (
          <div className="col-span-2 flex flex-col items-center justify-center h-full text-gray-500 py-10">
            <File className="w-10 h-10 mb-2 opacity-20" />
            <p className="text-sm">无搜索结果</p>
          </div>
        )}
        {localFiles.length === 0 && (
          <div className="col-span-2 flex flex-col items-center justify-center h-full text-gray-500 py-10">
            <File className="w-10 h-10 mb-2 opacity-20" />
            <p className="text-sm">未找到我的Vibe</p>
            <p className="text-xs mt-1">点右上角"添加文件"按钮导入</p>
          </div>
        )}
      </div>
    </div>
  );
}
