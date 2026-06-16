import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  deleteVibeTag,
  renameVibeTag,
  saveVibe,
  saveVibeTagPool,
  setVibeTags as setVibeTagsStorage,
  type VibeData,
} from '../../services/localLibrary';
import { getPublicVibeFile } from '../../services/publicLibrary';
import type { VibeFile } from './types';
import type { EditingVibeDefaults } from './useVibeCrudActions';

interface UseVibeTagManagementParams {
  currentBotUserId: string;
  tagPool: string[];
  setTagPool: Dispatch<SetStateAction<string[]>>;
  selectedVibes: string[];
  localFiles: VibeFile[];
  publicFiles: VibeFile[];
  setSelectedTagFilter: Dispatch<SetStateAction<Set<string>>>;
  setEditingVibeDefaults: Dispatch<SetStateAction<EditingVibeDefaults | null>>;
  loadLocalVibes: () => Promise<void>;
  reloadTagPool: () => Promise<void>;
  showToast: (message: string, type: 'success' | 'error') => void;
}

function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function useVibeTagManagement({
  currentBotUserId,
  tagPool,
  setTagPool,
  selectedVibes,
  localFiles,
  publicFiles,
  setSelectedTagFilter,
  setEditingVibeDefaults,
  loadLocalVibes,
  reloadTagPool,
  showToast,
}: UseVibeTagManagementParams) {
  const [tagEditorNewName, setTagEditorNewName] = useState('');
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [tagSettingsEditing, setTagSettingsEditing] = useState<string | null>(null);
  const [tagSettingsEditDraft, setTagSettingsEditDraft] = useState('');
  const [tagSettingsNewName, setTagSettingsNewName] = useState('');
  const [tagSettingsCreating, setTagSettingsCreating] = useState(false);
  const [batchTagEditorOpen, setBatchTagEditorOpen] = useState(false);
  const [batchTagsToAdd, setBatchTagsToAdd] = useState<Set<string>>(new Set());
  const [batchNewTagCreating, setBatchNewTagCreating] = useState(false);
  const [batchNewTagName, setBatchNewTagName] = useState('');

  const tagSettingsTrimmedNewName = tagSettingsNewName.trim();
  const tagSettingsDuplicate = tagSettingsTrimmedNewName.length > 0 && tagPool.includes(tagSettingsTrimmedNewName);
  const canCreateTagSetting = tagSettingsTrimmedNewName.length > 0 && !tagSettingsDuplicate;

  const batchTrimmedNewTagName = batchNewTagName.trim();
  const batchNewTagDuplicate = batchTrimmedNewTagName.length > 0 && tagPool.includes(batchTrimmedNewTagName);
  const canCreateBatchNewTag = batchTrimmedNewTagName.length > 0 && !batchNewTagDuplicate;

  const persistTagPool = (tags: string[]) => {
    const sorted = sortTags(tags);
    setTagPool(sorted);
    saveVibeTagPool(sorted);
    return sorted;
  };

  const addTagToEditingDefaults = (name = tagEditorNewName) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (!tagPool.includes(trimmed)) {
      persistTagPool([...tagPool, trimmed]);
    }
    setEditingVibeDefaults(prev => prev ? { ...prev, tags: new Set([...prev.tags, trimmed]) } : prev);
    setTagEditorNewName('');
  };

  const closeTagSettings = () => {
    setTagSettingsOpen(false);
    setTagSettingsEditing(null);
    setTagSettingsCreating(false);
    setTagSettingsNewName('');
  };

  const submitNewTagSetting = () => {
    if (!canCreateTagSetting) return;
    persistTagPool([...tagPool, tagSettingsTrimmedNewName]);
    setTagSettingsNewName('');
  };

  const startTagSettingEdit = (tag: string) => {
    setTagSettingsEditing(tag);
    setTagSettingsEditDraft(tag);
  };

  const renameTagSetting = async (tag: string) => {
    const newName = tagSettingsEditDraft.trim();
    if (!newName || newName === tag) {
      setTagSettingsEditing(null);
      return;
    }
    if (tagPool.includes(newName)) {
      showToast('该标签名已存在', 'error');
      return;
    }
    await renameVibeTag(tag, newName);
    setSelectedTagFilter(prev => {
      const next = new Set(prev);
      if (next.delete(tag)) next.add(newName);
      return next;
    });
    await reloadTagPool();
    await loadLocalVibes();
    setTagSettingsEditing(null);
  };

  const deleteTagSetting = async (tag: string, usage: number) => {
    const message = usage > 0
      ? `确定删除标签 "${tag}"？\n\n该标签下的 ${usage} 个 Vibe 不会被删除，会回到"全部"中。`
      : `确定删除未使用的标签 "${tag}"？`;
    if (!confirm(message)) return;
    await deleteVibeTag(tag);
    setSelectedTagFilter(prev => {
      const next = new Set(prev);
      next.delete(tag);
      return next;
    });
    await reloadTagPool();
    await loadLocalVibes();
  };

  const closeBatchTagEditor = () => {
    setBatchTagEditorOpen(false);
    setBatchNewTagCreating(false);
    setBatchNewTagName('');
  };

  const submitNewBatchTag = () => {
    if (!canCreateBatchNewTag) return;
    persistTagPool([...tagPool, batchTrimmedNewTagName]);
    setBatchTagsToAdd(prev => {
      const next = new Set(prev);
      next.add(batchTrimmedNewTagName);
      return next;
    });
    setBatchNewTagName('');
    setBatchNewTagCreating(false);
  };

  const applyBatchTags = async () => {
    const tagsToAdd = Array.from(batchTagsToAdd);
    if (tagsToAdd.length === 0) {
      closeBatchTagEditor();
      return;
    }

    let tagged = 0;
    let promoted = 0;
    let failed = 0;

    for (const id of selectedVibes) {
      try {
        let local = localFiles.find(file => file.id === id);

        if (!local) {
          const publicFile = publicFiles.find(file => file.id === id);
          if (!publicFile?.fileName) {
            failed++;
            continue;
          }
          const fullData = await getPublicVibeFile(publicFile.fileName);
          if (!fullData) {
            failed++;
            continue;
          }
          const supportedModels = fullData.encodings ? Object.keys(fullData.encodings as Record<string, unknown>) : [];
          const newVibe: VibeData = {
            id: (fullData.id as string) || id,
            name: (fullData.name as string) || publicFile.name,
            size: '',
            preview: (fullData.thumbnail as string) || publicFile.preview || '',
            image: (fullData.image as string) || '',
            encodings: (fullData.encodings as VibeData['encodings']) || {},
            createdAt: Date.now(),
            defaultStrength: ((fullData.importInfo as Record<string, unknown>) || {}).strength as number | undefined,
            defaultInfoExtracted: ((fullData.importInfo as Record<string, unknown>) || {}).information_extracted as number | undefined,
            supportedModels,
            tags: [],
            cloudSync: 'none',
          };
          const saved = await saveVibe(newVibe);
          local = {
            id: saved.id,
            name: saved.name,
            size: saved.size,
            preview: saved.preview,
            image: saved.image,
            encodings: saved.encodings,
            defaultStrength: saved.defaultStrength,
            defaultInfoExtracted: saved.defaultInfoExtracted,
            supportedModels: saved.supportedModels,
            tags: saved.tags,
          } as VibeFile;
          promoted++;
        }

        const merged = Array.from(new Set([...(local.tags || []), ...tagsToAdd]));
        await setVibeTagsStorage(local.id, merged);
        if (currentBotUserId) {
          // Reserved for cloud push parity.
        }
        tagged++;
      } catch (err) {
        console.error(`批量打标签失败 (${id}):`, err);
        failed++;
      }
    }

    await loadLocalVibes();
    await reloadTagPool();
    closeBatchTagEditor();

    const parts: string[] = [];
    if (tagged > 0) parts.push(`已为 ${tagged} 个 Vibe 打标签`);
    if (promoted > 0) parts.push(`收纳了 ${promoted} 个`);
    if (failed > 0) parts.push(`${failed} 个失败`);
    showToast(parts.join('，') || '无变更', failed > 0 ? 'error' : 'success');
  };

  return {
    tagEditorNewName,
    setTagEditorNewName,
    tagSettingsOpen,
    setTagSettingsOpen,
    tagSettingsEditing,
    setTagSettingsEditing,
    tagSettingsEditDraft,
    setTagSettingsEditDraft,
    tagSettingsNewName,
    setTagSettingsNewName,
    tagSettingsCreating,
    setTagSettingsCreating,
    batchTagEditorOpen,
    setBatchTagEditorOpen,
    batchTagsToAdd,
    setBatchTagsToAdd,
    batchNewTagCreating,
    setBatchNewTagCreating,
    batchNewTagName,
    setBatchNewTagName,
    tagSettingsTrimmedNewName,
    tagSettingsDuplicate,
    canCreateTagSetting,
    batchTrimmedNewTagName,
    batchNewTagDuplicate,
    canCreateBatchNewTag,
    addTagToEditingDefaults,
    closeTagSettings,
    submitNewTagSetting,
    startTagSettingEdit,
    renameTagSetting,
    deleteTagSetting,
    closeBatchTagEditor,
    submitNewBatchTag,
    applyBatchTags,
  };
}
