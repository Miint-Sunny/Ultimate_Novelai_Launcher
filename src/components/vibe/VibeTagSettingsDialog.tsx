import type { Dispatch, SetStateAction } from 'react';
import { Check, Edit2, Plus, Settings, Tag, Trash2, X } from 'lucide-react';

interface VibeTagSettingsDialogProps {
  tagPool: string[];
  tagUsageCounts: Map<string, number>;
  tagSettingsEditing: string | null;
  setTagSettingsEditing: Dispatch<SetStateAction<string | null>>;
  tagSettingsEditDraft: string;
  setTagSettingsEditDraft: Dispatch<SetStateAction<string>>;
  tagSettingsNewName: string;
  setTagSettingsNewName: Dispatch<SetStateAction<string>>;
  tagSettingsCreating: boolean;
  setTagSettingsCreating: Dispatch<SetStateAction<boolean>>;
  tagSettingsTrimmedNewName: string;
  tagSettingsDuplicate: boolean;
  canCreateTagSetting: boolean;
  closeTagSettings: () => void;
  submitNewTagSetting: () => void;
  startTagSettingEdit: (tag: string) => void;
  renameTagSetting: (tag: string) => Promise<void>;
  deleteTagSetting: (tag: string, usage: number) => Promise<void>;
}

export function VibeTagSettingsDialog({
  tagPool,
  tagUsageCounts,
  tagSettingsEditing,
  setTagSettingsEditing,
  tagSettingsEditDraft,
  setTagSettingsEditDraft,
  tagSettingsNewName,
  setTagSettingsNewName,
  tagSettingsCreating,
  setTagSettingsCreating,
  tagSettingsTrimmedNewName,
  tagSettingsDuplicate,
  canCreateTagSetting,
  closeTagSettings,
  submitNewTagSetting,
  startTagSettingEdit,
  renameTagSetting,
  deleteTagSetting,
}: VibeTagSettingsDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={closeTagSettings}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">标签管理</span>
            <span className="text-xs text-gray-500">{tagPool.length} 个</span>
          </div>
          <button
            onClick={closeTagSettings}
            className="text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 pt-4 pb-2 shrink-0">
          {!tagSettingsCreating ? (
            <button
              onClick={() => { setTagSettingsCreating(true); setTagSettingsNewName(''); }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 border-dashed border-gray-700 hover:border-nai-accent/60 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/5 text-sm font-bold transition-colors"
            >
              <Plus className="w-4 h-4" />
              新建标签
            </button>
          ) : (
            <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-nai-accent shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={tagSettingsNewName}
                  onChange={(event) => setTagSettingsNewName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitNewTagSetting();
                    if (event.key === 'Escape') { setTagSettingsCreating(false); setTagSettingsNewName(''); }
                  }}
                  placeholder="输入新标签名"
                  className="flex-1 bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                />
              </div>
              {tagSettingsDuplicate && (
                <p className="text-[11px] text-red-400 pl-6">标签 "{tagSettingsTrimmedNewName}" 已存在</p>
              )}
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => { setTagSettingsCreating(false); setTagSettingsNewName(''); }}
                  className="px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={submitNewTagSetting}
                  disabled={!canCreateTagSetting}
                  className="px-3 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-xs font-bold rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                >
                  <Check className="w-3.5 h-3.5" />
                  创建
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4 pt-2">
          {tagPool.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <Tag className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm">还没有标签</p>
              <p className="text-xs mt-1 text-gray-600">点击上方按钮创建第一个</p>
            </div>
          ) : (
            <div className="space-y-1">
              {tagPool.map(tag => {
                const usage = tagUsageCounts.get(tag) || 0;
                const isEditing = tagSettingsEditing === tag;
                const isProtected = tag === '收藏';
                return (
                  <div
                    key={tag}
                    className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-md transition-colors ${
                      isEditing ? 'bg-nai-dark/60' : 'hover:bg-nai-dark/40'
                    }`}
                  >
                    {isEditing ? (
                      <>
                        <Tag className="w-4 h-4 text-nai-accent shrink-0" />
                        <input
                          type="text"
                          value={tagSettingsEditDraft}
                          onChange={(event) => setTagSettingsEditDraft(event.target.value)}
                          autoFocus
                          onKeyDown={async (event) => {
                            if (event.key === 'Enter') {
                              await renameTagSetting(tag);
                            }
                            if (event.key === 'Escape') setTagSettingsEditing(null);
                          }}
                          className="flex-1 bg-nai-dark text-white text-sm rounded px-2.5 py-1.5 border border-nai-accent focus:outline-none"
                        />
                        <button
                          onClick={() => renameTagSetting(tag)}
                          className="p-1.5 text-green-400 hover:bg-green-400/10 rounded transition-colors"
                          title="保存"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setTagSettingsEditing(null)}
                          className="p-1.5 text-gray-500 hover:bg-white/5 rounded transition-colors"
                          title="取消"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <Tag className="w-4 h-4 text-gray-500 shrink-0" />
                        <span className="flex-1 text-sm text-gray-200 truncate" title={tag}>{tag}</span>
                        <span className={`text-xs tabular-nums shrink-0 ${
                          usage > 0 ? 'text-gray-500' : 'text-gray-700'
                        }`}>
                          {usage > 0 ? `${usage} 个` : '未使用'}
                        </span>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          {!isProtected && (
                            <button
                              onClick={() => startTagSettingEdit(tag)}
                              className="p-1.5 text-gray-400 hover:text-nai-accent hover:bg-white/5 rounded transition-colors"
                              title="重命名"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {!isProtected && (
                            <button
                              onClick={() => deleteTagSetting(tag, usage)}
                              className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                              title="删除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
