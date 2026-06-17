import { useCallback, useMemo, useState } from 'react';
import { deleteCR, getCRs, saveCR } from '../../../services/localLibrary';
import { getPublicCRPreviewUrl, getPublicCRs } from '../../../services/publicLibrary';
import type { ActiveCR, ActivePreciseRef, CRFile } from '../types';

interface UseMobilePreciseReferencesOptions {
  clearActiveVibes: () => void;
  closeSheet: () => void;
}

const readImageAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (event) => resolve(event.target?.result as string);
  reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

export function useMobilePreciseReferences({
  clearActiveVibes,
  closeSheet,
}: UseMobilePreciseReferencesOptions) {
  const [crTab, setCrTab] = useState<'public' | 'local'>('public');
  const [crPublicFiles, setCrPublicFiles] = useState<CRFile[]>([]);
  const [crLocalFiles, setCrLocalFiles] = useState<CRFile[]>([]);
  const [activePreciseRefs, setActivePreciseRefs] = useState<ActivePreciseRef[]>([]);
  const [isLoadingCRs, setIsLoadingCRs] = useState(false);
  const [isCRExpanded, setIsCRExpanded] = useState(true);

  const activeCR = useMemo(() => activePreciseRefs.length > 0 ? {
    ...activePreciseRefs[0],
    fidelity: activePreciseRefs[0].strength,
    styleAware: activePreciseRefs[0].mode === 'character&style',
  } : null, [activePreciseRefs]);

  const setActiveCR = useCallback((cr: ActiveCR | null) => {
    if (cr) {
      setActivePreciseRefs([{
        id: cr.id,
        name: cr.name,
        preview: cr.preview,
        mode: cr.styleAware ? 'character&style' : 'character',
        informationExtracted: 1,
        strength: cr.fidelity,
        enabled: true,
      }]);
    } else {
      setActivePreciseRefs([]);
    }
  }, []);

  const loadCRs = useCallback(async () => {
    setIsLoadingCRs(true);
    try {
      const localCRs = await getCRs();
      setCrLocalFiles(localCRs.map((cr) => ({
        id: cr.id,
        name: cr.name,
        preview: cr.preview,
      })));

      const publicCRs = await getPublicCRs();
      setCrPublicFiles(publicCRs.map((cr) => ({
        id: cr.id,
        name: cr.name,
        preview: cr.preview_url ? getPublicCRPreviewUrl(cr.id) : '',
      })));
    } catch (error) {
      console.error('Failed to load CRs:', error);
    } finally {
      setIsLoadingCRs(false);
    }
  }, []);

  const handleSelectCR = useCallback((cr: CRFile) => {
    const existingIndex = activePreciseRefs.findIndex((item) => item.id === cr.id);
    if (existingIndex >= 0) {
      setActivePreciseRefs((prev) => prev.filter((item) => item.id !== cr.id));
    } else {
      setActivePreciseRefs((prev) => [...prev, {
        id: cr.id,
        name: cr.name,
        preview: cr.preview,
        mode: 'character&style',
        informationExtracted: 1,
        strength: 1,
        enabled: true,
      }]);
      clearActiveVibes();
    }
  }, [activePreciseRefs, clearActiveVibes]);

  const importLocalCRImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    try {
      setIsLoadingCRs(true);
      const base64 = await readImageAsDataUrl(file);
      const id = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const name = file.name.replace(/\.[^/.]+$/, '');
      const newCR: CRFile = { id, name, preview: base64 };
      await saveCR({ ...newCR, isLocal: true });
      setCrLocalFiles((prev) => [newCR, ...prev]);
      setActivePreciseRefs((prev) => [...prev, {
        id: newCR.id,
        name: newCR.name,
        preview: newCR.preview,
        mode: 'character&style',
        informationExtracted: 1,
        strength: 1,
        enabled: true,
      }]);
      clearActiveVibes();
      closeSheet();
    } catch (error) {
      console.error('Failed to import Precise Reference image:', error);
      alert('导入图片失败: ' + (error as Error).message);
    } finally {
      setIsLoadingCRs(false);
    }
  }, [clearActiveVibes, closeSheet]);

  const deleteLocalCR = useCallback(async (cr: CRFile) => {
    await deleteCR(cr.id);
    setCrLocalFiles((prev) => prev.filter((item) => item.id !== cr.id));
    setActivePreciseRefs((prev) => prev.filter((item) => item.id !== cr.id));
  }, []);

  const removePreciseRef = useCallback((id: string) => {
    setActivePreciseRefs((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const updatePreciseRefParam = useCallback((id: string, updates: Partial<ActivePreciseRef>) => {
    setActivePreciseRefs((prev) => prev.map((item) => item.id === id ? { ...item, ...updates } : item));
  }, []);

  return {
    crTab,
    setCrTab,
    crPublicFiles,
    crLocalFiles,
    activePreciseRefs,
    setActivePreciseRefs,
    activeCR,
    setActiveCR,
    isLoadingCRs,
    isCRExpanded,
    setIsCRExpanded,
    loadCRs,
    handleSelectCR,
    importLocalCRImage,
    deleteLocalCR,
    removePreciseRef,
    updatePreciseRefParam,
  };
}
