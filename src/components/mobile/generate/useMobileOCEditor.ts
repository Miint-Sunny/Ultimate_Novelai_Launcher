import { useCallback, useState } from 'react';
import { createPublicOC, updatePublicOC } from '../../../services/publicLibrary';
import { generateImageStream } from '../../../services/novelai';
import { blobToBase64 } from '../imageUtils';
import type { OCFile } from '../types';

const OC_PREVIEW_PROMPT =
  '2::1girl, solo::,1.4::artist:yun cao bing::, 1::artist:hanozuku::, 1.4::artist:ogipote, 0.2::artist:ramchi, 0.4::artist:momoko_(momopoco), 0.4::artist:sak_(lemondisk)::, -2::artist collaboration::, year2025, -0.6::flat color::, 1.3::white background,full body,stand::';
const OC_PREVIEW_NEGATIVE =
  '2::little dolls, extra characters,extra fingers,logo,watermark,signature,artist collaboration,deformed,what::,lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

interface UseMobileOCEditorOptions {
  currentUserId: string | null;
  isAuthenticated: boolean;
  requireAuth: (callback: () => void) => void;
  ocPublicFiles: OCFile[];
  ocLocalFiles: OCFile[];
  loadOCs: () => Promise<void>;
  deleteLocalOC: (oc: OCFile) => Promise<void>;
}

export function useMobileOCEditor({
  currentUserId,
  isAuthenticated,
  requireAuth,
  ocPublicFiles,
  ocLocalFiles,
  loadOCs,
  deleteLocalOC,
}: UseMobileOCEditorOptions) {
  const [ocEditorMode, setOcEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingOCId, setEditingOCId] = useState<string | null>(null);
  const [ocDraftName, setOcDraftName] = useState('');
  const [ocDraftAliases, setOcDraftAliases] = useState('');
  const [ocDraftPositive, setOcDraftPositive] = useState('');
  const [ocDraftPreview, setOcDraftPreview] = useState('');
  const [isGeneratingOCPreview, setIsGeneratingOCPreview] = useState(false);
  const [isSavingOC, setIsSavingOC] = useState(false);

  const closeOCEditor = useCallback(() => {
    setOcEditorMode(null);
    setEditingOCId(null);
    setOcDraftName('');
    setOcDraftAliases('');
    setOcDraftPositive('');
    setOcDraftPreview('');
  }, []);

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

  const deleteEditingOC = useCallback(async () => {
    if (!editingOCId) return;
    const target = ocLocalFiles.find((oc) => oc.id === editingOCId);
    if (!target) return;
    await deleteLocalOC(target);
  }, [deleteLocalOC, editingOCId, ocLocalFiles]);

  const handleGenerateOCPreview = useCallback(async () => {
    if (!ocDraftPositive.trim() || isGeneratingOCPreview) return;
    setIsGeneratingOCPreview(true);

    try {
      const result = await generateImageStream({
        positivePrompt: `${OC_PREVIEW_PROMPT}, ${ocDraftPositive.trim()}`,
        negativePrompt: OC_PREVIEW_NEGATIVE,
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

  return {
    ocEditorMode,
    editingOCId,
    ocDraftName,
    setOcDraftName,
    ocDraftAliases,
    setOcDraftAliases,
    ocDraftPositive,
    setOcDraftPositive,
    ocDraftPreview,
    isGeneratingOCPreview,
    isSavingOC,
    openCreateOC,
    openEditOC,
    closeOCEditor,
    handleSaveOC,
    deleteEditingOC,
    handleGenerateOCPreview,
    handlePasteOCPrompt,
  };
}
