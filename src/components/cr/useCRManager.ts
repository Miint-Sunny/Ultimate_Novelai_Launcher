// Precise Reference (CR) 管理器 - 自定义 Hook
import { useState, useRef, useEffect, useCallback } from 'react';
import type { CRFile, ActivePreciseRef, UseCRManagerReturn } from './types';
import { saveCR, getCRs, deleteCR } from '../../services/localLibrary';
import {
  getPublicCRs, getPublicCRPreviewUrl, createPublicCR,
  deletePublicCR, updatePublicCR,
} from '../../services/publicLibrary';

export function useCRManager(): UseCRManagerReturn {
  // --- Tab & Selection ---
  const [crTab, setCrTab] = useState<'public' | 'local'>('public');
  const [selectedCRs, setSelectedCRs] = useState<string[]>([]);

  // --- Data ---
  const [crPublicFiles, setCrPublicFiles] = useState<CRFile[]>([]);
  const [crLocalFiles, setCrLocalFiles] = useState<CRFile[]>([]);

  // --- Active Precise Refs ---
  const [activePreciseRefs, setActivePreciseRefs] = useState<ActivePreciseRef[]>([]);

  // --- Upload / Delete ---
  const [uploadingCRId, setUploadingCRId] = useState<string | null>(null);
  const [deletingCRId, setDeletingCRId] = useState<string | null>(null);
  const [uploadedCRIds, setUploadedCRIds] = useState<Set<string>>(new Set());
  const crInputRef = useRef<HTMLInputElement>(null);
  const quickCRInputRef = useRef<HTMLInputElement>(null);

  // --- Edit modal ---
  const [crEditModalOpen, setCrEditModalOpen] = useState(false);
  const [crEditTarget, setCrEditTarget] = useState<CRFile | null>(null);
  const [crEditName, setCrEditName] = useState('');
  const [crEditZhNames, setCrEditZhNames] = useState('');
  const [isSavingCREdit, setIsSavingCREdit] = useState(false);
  const [crEditIsUpload, setCrEditIsUpload] = useState(false);

  // --- Compat: activeCR (取第一个) ---
  const activeCR = activePreciseRefs.length > 0 ? {
    ...activePreciseRefs[0],
    fidelity: activePreciseRefs[0].strength,
    styleAware: activePreciseRefs[0].mode === 'character&style',
  } : null;

  const setActiveCR = useCallback((cr: (CRFile & { fidelity: number; styleAware: boolean }) | null) => {
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

  // --- Load data on mount ---
  useEffect(() => {
    const loadCRs = async () => {
      try {
        const storedCRs = await getCRs();
        const localCRs = storedCRs.filter(cr => cr.isLocal).map(cr => ({
          id: cr.id, name: cr.name, preview: cr.preview,
        }));
        setCrLocalFiles(localCRs);

        const publicCRs = await getPublicCRs();
        setCrPublicFiles(publicCRs.map(cr => ({
          id: cr.id, name: cr.name,
          preview: cr.preview_url ? getPublicCRPreviewUrl(cr.id) : '',
        })));
      } catch (error) {
        console.error('Failed to load CRs:', error);
      }
    };
    loadCRs();
  }, []);

  // --- Upload CR ---
  const handleCRUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const preview = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });

      const isLocal = true;
      const newFile: CRFile = { id: `cr${Date.now()}`, name: file.name, preview };

      try {
        await saveCR({ ...newFile, isLocal });
        if (isLocal) {
          setCrLocalFiles(prev => [newFile, ...prev]);
        } else {
          setCrPublicFiles(prev => [newFile, ...prev]);
        }
        setSelectedCRs(prev => [...prev, newFile.id]);
      } catch (error) {
        console.error('Failed to save Precise Reference:', error);
      }
    }
    if (event.target) event.target.value = '';
  }, [crTab]);

  // --- Toggle selection ---
  const handleToggleCRSelection = useCallback((id: string) => {
    setSelectedCRs(prev =>
      prev.includes(id) ? prev.filter(crId => crId !== id) : [...prev, id]
    );
  }, []);

  // --- Update param ---
  const updatePreciseRefParam = useCallback((id: string, updates: Partial<ActivePreciseRef>) => {
    setActivePreciseRefs(prev => prev.map(pr =>
      pr.id === id ? { ...pr, ...updates } : pr
    ));
  }, []);

  // --- Remove ---
  const removePreciseRef = useCallback((id: string) => {
    setActivePreciseRefs(prev => prev.filter(pr => pr.id !== id));
    setSelectedCRs(prev => prev.filter(crId => crId !== id));
  }, []);

  // --- Delete ---
  const handleDeleteCR = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeletingCRId(id);
    try {
      if (crTab === 'public') {
        const result = await deletePublicCR(id);
        if (result.success) {
          setCrPublicFiles(prev => prev.filter(f => f.id !== id));
        }
      } else {
        await deleteCR(id);
        setCrLocalFiles(prev => prev.filter(f => f.id !== id));
      }
      setSelectedCRs(prev => prev.filter(crId => crId !== id));
      setActivePreciseRefs(prev => prev.filter(pr => pr.id !== id));
    } catch (error) {
      console.error('Failed to delete Precise Reference:', error);
    } finally {
      setDeletingCRId(null);
    }
  }, [crTab]);

  // --- Save CR edit (or upload to public) ---
  const handleSaveCREdit = useCallback(async () => {
    if (!crEditTarget) return;
    setIsSavingCREdit(true);
    try {
      const zhNames = crEditZhNames
        .split(/[,，]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (crEditIsUpload) {
        // Upload local CR to public with name & zh_names
        const result = await createPublicCR({
          name: crEditName,
          image_base64: crEditTarget.preview,
          zh_names: zhNames,
        });
        if (result.success && result.cr) {
          setCrPublicFiles(prev => [{
            id: result.cr!.id,
            name: result.cr!.name,
            preview: result.cr!.preview_url ? getPublicCRPreviewUrl(result.cr!.id) : '',
          }, ...prev]);
          setUploadedCRIds(prev => new Set(prev).add(crEditTarget.id));
        }
        setCrEditModalOpen(false);
        setCrEditIsUpload(false);
      } else {
        // Edit existing public CR
        const result = await updatePublicCR(crEditTarget.id, {
          name: crEditName,
          zh_names: zhNames,
        });
        if (result.success) {
          setCrPublicFiles(prev => prev.map(f =>
            f.id === crEditTarget.id
              ? { ...f, name: crEditName, zh_names: zhNames } as any
              : f
          ));
          setCrEditModalOpen(false);
        }
      }
    } finally {
      setIsSavingCREdit(false);
    }
  }, [crEditTarget, crEditName, crEditZhNames, crEditIsUpload]);

  // --- Upload to public (open edit modal first) ---
  const handleUploadCRToPublic = useCallback(async (file: CRFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (uploadedCRIds.has(file.id)) return;
    // Open edit modal in upload mode
    setCrEditTarget(file);
    setCrEditName('');
    setCrEditZhNames('');
    setCrEditIsUpload(true);
    setCrEditModalOpen(true);
  }, [uploadedCRIds]);

  return {
    crTab, setCrTab, selectedCRs, setSelectedCRs,
    crPublicFiles, setCrPublicFiles, crLocalFiles, setCrLocalFiles,
    activePreciseRefs, setActivePreciseRefs,
    uploadingCRId, deletingCRId, uploadedCRIds,
    crInputRef, quickCRInputRef,
    crEditModalOpen, setCrEditModalOpen,
    crEditTarget, setCrEditTarget,
    crEditName, setCrEditName,
    crEditZhNames, setCrEditZhNames,
    isSavingCREdit, setIsSavingCREdit,
    crEditIsUpload,
    activeCR, setActiveCR,
    handleCRUpload, handleToggleCRSelection,
    updatePreciseRefParam, removePreciseRef,
    handleDeleteCR, handleSaveCREdit, handleUploadCRToPublic,
  };
}
