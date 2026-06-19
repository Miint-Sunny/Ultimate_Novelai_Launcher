import { useCallback, useMemo, useState } from 'react';
import { createPublicOC, deletePublicOC, getPublicOCs, updatePublicOC } from '../../../services/publicLibrary';
import { generateImageStream } from '../../../services/novelai';
import { blobToBase64 } from '../imageUtils';
import type { CharacterPrompt, OCFile } from '../types';
import {
  buildCharacterPromptsFromOCs,
  filterMobileOCs,
  toMobileOCFile,
} from './mobileOCData';

interface UseMobileOCManagerOptions {
  currentUserId: string | null;
  isAuthenticated: boolean;
  requireAuth: (callback: () => void) => void;
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: React.Dispatch<React.SetStateAction<CharacterPrompt[]>>;
  closeSheet: () => void;
}

export function useMobileOCManager({
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
  const [ocEditorMode, setOcEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingOCId, setEditingOCId] = useState<string | null>(null);
  const [ocDraftName, setOcDraftName] = useState('');
  const [ocDraftAliases, setOcDraftAliases] = useState('');
  const [ocDraftPositive, setOcDraftPositive] = useState('');
  const [ocDraftPreview, setOcDraftPreview] = useState('');
  const [ocSearchQuery, setOcSearchQuery] = useState('');
  const [isGeneratingOCPreview, setIsGeneratingOCPreview] = useState(false);
  const [isSavingOC, setIsSavingOC] = useState(false);
  const [copiedOCId, setCopiedOCId] = useState<string | null>(null);

  const closeOCEditor = useCallback(() => {
    setOcEditorMode(null);
    setEditingOCId(null);
    setOcDraftName('');
    setOcDraftAliases('');
    setOcDraftPositive('');
    setOcDraftPreview('');
  }, []);

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

  const resetOCSelection = useCallback(() => {
    setSelectedOCIds(new Set());
    setOcSearchQuery('');
    closeOCEditor();
  }, [closeOCEditor]);

  const openCreateOC = useCallback(() => {
    if (!isAuthenticated) {
      requireAuth(() => {
        closeOCEditor();
        setOcEditorMode('create');
      });
      return;
    }
    closeOCEditor();
    setOcEditorMode('create');
  }, [closeOCEditor, isAuthenticated, requireAuth]);

  const openEditOC = useCallback((oc: OCFile) => {
    setEditingOCId(oc.id);
    setOcDraftName(oc.name);
    setOcDraftAliases((oc.aliases || []).join(', '));
    setOcDraftPositive(oc.positive);
    setOcDraftPreview(oc.preview || '');
    setOcEditorMode('edit');
  }, []);

  const handleToggleOCSelection = useCallback((oc: OCFile) => {
    setSelectedOCIds((prev) => {
      const next = new Set(prev);
      if (next.has(oc.id)) {
        next.delete(oc.id);
        return next;
      }
      if (next.size >= 6) {
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

  const handleSaveOC = useCallback(async () => {
    const name = ocDraftName.trim();
    const aliases = ocDraftAliases.split(',').map((item) => item.trim()).filter(Boolean);
    const positive = ocDraftPositive.trim();
    const preview = ocDraftPreview.trim();
    if (!name || !positive) {
      alert('请填写 OC 名称和正向提示词');
      return;
    }
    const duplicate = ocPublicFiles.some((oc) => oc.name === name && oc.id !== editingOCId);
    if (duplicate) {
      alert(`名称 "${name}" 已存在，请使用其他名称`);
      return;
    }

    setIsSavingOC(true);
    try {
      const previewBase64 = preview.startsWith('data:') ? preview : undefined;
      const result = editingOCId
        ? await updatePublicOC(editingOCId, {
          zh_name: name,
          tag_group: positive,
          preview_base64: previewBase64,
          zh_aliases: aliases.length > 0 ? aliases : undefined,
        })
        : await createPublicOC({
          zh_name: name,
          tag_group: positive,
          preview_base64: previewBase64,
          zh_aliases: aliases.length > 0 ? aliases : undefined,
          created_by: currentUserId || undefined,
        });
      if (!result.success || !result.oc) {
        alert(`${editingOCId ? '更新' : '创建'}失败: ${result.message}`);
        return;
      }
      await loadOCs();
      closeOCEditor();
    } finally {
      setIsSavingOC(false);
    }
  }, [closeOCEditor, currentUserId, editingOCId, loadOCs, ocDraftAliases, ocDraftName, ocDraftPositive, ocDraftPreview, ocPublicFiles]);

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

  const deleteEditingOC = useCallback(async () => {
    if (!editingOCId) return;
    const target = ocLocalFiles.find((oc) => oc.id === editingOCId);
    if (!target) return;
    await handleDeleteLocalOC(target);
  }, [editingOCId, handleDeleteLocalOC, ocLocalFiles]);

  const handleGenerateOCPreview = useCallback(async () => {
    if (!ocDraftPositive.trim() || isGeneratingOCPreview) return;
    setIsGeneratingOCPreview(true);
    const fixedPrompt = '2::1girl, solo::,1.4::artist:yun cao bing::, 1::artist:hanozuku::, 1.4::artist:ogipote, 0.2::artist:ramchi, 0.4::artist:momoko_(momopoco), 0.4::artist:sak_(lemondisk)::, -2::artist collaboration::, year2025, -0.6::flat color::, 1.3::white background,full body,stand::';
    const fixedNegative = '2::little dolls, extra characters,extra fingers,logo,watermark,signature,artist collaboration,deformed,what::,lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

    try {
      const result = await generateImageStream({
        positivePrompt: `${fixedPrompt}, ${ocDraftPositive.trim()}`,
        negativePrompt: fixedNegative,
        model: 'v4.5-full',
        width: 832,
        height: 1216,
        steps: 23,
        scale: 5,
        sampler: 'Euler Ancestral',
        cfgRescale: 0,
        noiseSchedule: 'karras',
        ucPreset: 'heavy',
        qualityToggle: true,
        varietyPlus: false,
        characterPrompts: [],
      });
      if (result.success && result.imageData) {
        setOcDraftPreview(await blobToBase64(result.imageData));
      } else {
        alert('预览图生成失败');
      }
    } catch (error) {
      console.error('Failed to generate OC preview:', error);
      alert('预览图生成失败');
    } finally {
      setIsGeneratingOCPreview(false);
    }
  }, [isGeneratingOCPreview, ocDraftPositive]);

  const handlePasteOCPrompt = useCallback(async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          setOcDraftPositive(text);
          return;
        }
      }
    } catch (error) {
      console.error('Failed to read clipboard:', error);
    }
    const manualText = window.prompt('剪贴板读取失败，请手动粘贴提示词');
    if (manualText) setOcDraftPositive(manualText);
  }, []);

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
    ocEditorMode,
    editingOCId,
    ocDraftName,
    setOcDraftName,
    ocDraftAliases,
    setOcDraftAliases,
    ocDraftPositive,
    setOcDraftPositive,
    ocDraftPreview,
    ocSearchQuery,
    setOcSearchQuery,
    isGeneratingOCPreview,
    isSavingOC,
    copiedOCId,
    setCopiedOCId,
    filteredOCs,
    loadOCs,
    resetOCSelection,
    openCreateOC,
    openEditOC,
    closeOCEditor,
    handleToggleOCSelection,
    handleSaveOC,
    handleDeleteLocalOC,
    deleteEditingOC,
    handleGenerateOCPreview,
    handlePasteOCPrompt,
    handleConfirmOC,
  };
}
