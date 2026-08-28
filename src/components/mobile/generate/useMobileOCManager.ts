import { useCallback, useMemo, useState } from 'react';
import { deletePublicOC, getPublicOCs } from '../../../services/publicLibrary';
import type { CharacterPrompt, OCFile } from '../types';
import {
  buildCharacterPromptsFromOCs,
  filterMobileOCs,
  toMobileOCFile,
} from './mobileOCData';
import { useMobileOCEditor } from './useMobileOCEditor';

interface UseMobileOCManagerOptions {
  /** 当前模型的同框角色上限。 */
  maxCharacters: number;
  currentUserId: string | null;
  isAuthenticated: boolean;
  requireAuth: (callback: () => void) => void;
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: React.Dispatch<React.SetStateAction<CharacterPrompt[]>>;
  closeSheet: () => void;
}

export function useMobileOCManager({
  maxCharacters,
  currentUserId,
  isAuthenticated,
  requireAuth,
  characterPrompts,
  setCharacterPrompts,
  closeSheet,
}: UseMobileOCManagerOptions) {
  const [ocTab, setOcTab] = useState<'public' | 'local'>('public');
  const [ocPublicFiles, setOcPublicFiles] = useState<OCFile[]>([]);
  const [ocLocalFiles, setOcLocalFiles] = useState<OCFile[]>([]);
  const [isLoadingOCs, setIsLoadingOCs] = useState(false);
  const [selectedOCIds, setSelectedOCIds] = useState<Set<string>>(new Set());
  const [ocSearchQuery, setOcSearchQuery] = useState('');
  const [copiedOCId, setCopiedOCId] = useState<string | null>(null);

  const loadOCs = useCallback(async () => {
    setIsLoadingOCs(true);
    try {
      const publicOCData = await getPublicOCs();
      const publicOCList: OCFile[] = publicOCData.map(toMobileOCFile);
      setOcPublicFiles(publicOCList);
      setOcLocalFiles(publicOCList.filter((oc) => currentUserId && oc.created_by === currentUserId));
    } catch (error) {
      console.error('Failed to load OCs:', error);
    } finally {
      setIsLoadingOCs(false);
    }
  }, [currentUserId]);

  const handleToggleOCSelection = useCallback((oc: OCFile) => {
    setSelectedOCIds((prev) => {
      const next = new Set(prev);
      if (next.has(oc.id)) {
        next.delete(oc.id);
        return next;
      }
      if (next.size >= maxCharacters) {
        alert('最多只能选择 6 个 OC');
        return prev;
      }
      if (!oc.positive.trim()) {
        alert('该 OC 没有可用的提示词');
        return prev;
      }
      next.add(oc.id);
      return next;
    });
  }, []);

  const handleDeleteLocalOC = useCallback(async (oc: OCFile) => {
    if (!isAuthenticated) {
      requireAuth(() => {
        void handleDeleteLocalOC(oc);
      });
      return;
    }
    const result = await deletePublicOC(oc.id);
    if (!result.success) {
      alert(`删除失败: ${result.message}`);
      return;
    }
    setOcPublicFiles((prev) => prev.filter((item) => item.id !== oc.id));
    setOcLocalFiles((prev) => prev.filter((item) => item.id !== oc.id));
    setSelectedOCIds((prev) => {
      if (!prev.has(oc.id)) return prev;
      const next = new Set(prev);
      next.delete(oc.id);
      return next;
    });
  }, [isAuthenticated, requireAuth]);

  const ocEditor = useMobileOCEditor({
    currentUserId,
    isAuthenticated,
    requireAuth,
    ocPublicFiles,
    ocLocalFiles,
    loadOCs,
    deleteLocalOC: handleDeleteLocalOC,
  });

  const resetOCSelection = useCallback(() => {
    setSelectedOCIds(new Set());
    setOcSearchQuery('');
    ocEditor.closeOCEditor();
  }, [ocEditor.closeOCEditor]);

  const handleConfirmOC = useCallback(() => {
    if (selectedOCIds.size === 0) {
      closeSheet();
      return;
    }
    const allOCsMap = new Map([...ocPublicFiles, ...ocLocalFiles].map((oc) => [oc.id, oc]));
    const selectedOCs = Array.from(selectedOCIds).map((id) => allOCsMap.get(id)).filter(Boolean) as OCFile[];
    const availableSlots = Math.max(0, 6 - characterPrompts.length);
    const newCharacters: CharacterPrompt[] = buildCharacterPromptsFromOCs(selectedOCs, availableSlots);
    if (newCharacters.length < selectedOCs.length) alert('角色提示词最多 6 个，已按剩余槽位添加');
    if (newCharacters.length > 0) setCharacterPrompts((prev) => [...prev, ...newCharacters]);
    setSelectedOCIds(new Set());
    closeSheet();
  }, [characterPrompts.length, closeSheet, ocLocalFiles, ocPublicFiles, selectedOCIds, setCharacterPrompts]);

  const filteredOCs = useMemo(() => {
    const source = ocTab === 'public' ? ocPublicFiles : ocLocalFiles;
    return filterMobileOCs(source, ocSearchQuery);
  }, [ocLocalFiles, ocPublicFiles, ocSearchQuery, ocTab]);

  return {
    ocTab,
    setOcTab,
    ocPublicFiles,
    ocLocalFiles,
    isLoadingOCs,
    selectedOCIds,
    setSelectedOCIds,
    ocEditorMode: ocEditor.ocEditorMode,
    editingOCId: ocEditor.editingOCId,
    ocDraftName: ocEditor.ocDraftName,
    setOcDraftName: ocEditor.setOcDraftName,
    ocDraftAliases: ocEditor.ocDraftAliases,
    setOcDraftAliases: ocEditor.setOcDraftAliases,
    ocDraftPositive: ocEditor.ocDraftPositive,
    setOcDraftPositive: ocEditor.setOcDraftPositive,
    ocDraftPreview: ocEditor.ocDraftPreview,
    ocSearchQuery,
    setOcSearchQuery,
    isGeneratingOCPreview: ocEditor.isGeneratingOCPreview,
    isSavingOC: ocEditor.isSavingOC,
    copiedOCId,
    setCopiedOCId,
    filteredOCs,
    loadOCs,
    resetOCSelection,
    openCreateOC: ocEditor.openCreateOC,
    openEditOC: ocEditor.openEditOC,
    closeOCEditor: ocEditor.closeOCEditor,
    handleToggleOCSelection,
    handleSaveOC: ocEditor.handleSaveOC,
    handleDeleteLocalOC,
    deleteEditingOC: ocEditor.deleteEditingOC,
    handleGenerateOCPreview: ocEditor.handleGenerateOCPreview,
    handlePasteOCPrompt: ocEditor.handlePasteOCPrompt,
    handleConfirmOC,
  };
}
