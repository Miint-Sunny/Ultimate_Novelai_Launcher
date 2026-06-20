// OC管理器 - 自定义 Hook
import { useState, useEffect, useCallback } from 'react';
import confetti from 'canvas-confetti';
import type { OCFile, UseOCManagerReturn } from './types';
import { saveOC, getOCs, deleteOC } from '../../services/localLibrary';
import {
  getPublicOCs, getOCPreviewUrl, clearPublicOCCache,
  createPublicOC, updatePublicOC, deletePublicOC, getPublicLibraryOwnerId,
} from '../../services/publicLibrary';
import { generateImageStream } from '../../services/novelai';

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function useOCManager(): UseOCManagerReturn {
  // --- Tab & Selection ---
  const [ocTab, setOcTab] = useState<'public' | 'local'>('public');
  const [selectedOCs, setSelectedOCs] = useState<string[]>([]);
  const [justSelectedOCId, setJustSelectedOCId] = useState<string | null>(null);

  // --- Data ---
  const [ocPublicFiles, setOcPublicFiles] = useState<OCFile[]>([]);
  const [ocLocalFiles, setOcLocalFiles] = useState<OCFile[]>([]);
  const [isLoadingPublicOCs, setIsLoadingPublicOCs] = useState(false);

  // --- Creation / Editing ---
  const [isCreatingOC, setIsCreatingOC] = useState(false);
  const [editingOCId, setEditingOCId] = useState<string | null>(null);
  const [newOCName, setNewOCName] = useState('');
  const [newOCPositive, setNewOCPositive] = useState('');
  const [newOCAliases, setNewOCAliases] = useState('');  // 别名，逗号分隔
  const [newOCPreview, setNewOCPreview] = useState<string | null>(null);
  const [isNewPreview, setIsNewPreview] = useState(false); // 标记预览图是否是新生成的
  const [newOCCreatedBy, setNewOCCreatedBy] = useState('');
  const [newOCCreatedAt, setNewOCCreatedAt] = useState('');
  const [isGeneratingOCPreview, setIsGeneratingOCPreview] = useState(false);
  const [isSavingOC, setIsSavingOC] = useState(false);
  const [copiedOCId, setCopiedOCId] = useState<string | null>(null);
  const [savedToLocalOCId, setSavedToLocalOCId] = useState<string | null>(null);

  // --- Load data on mount ---
  useEffect(() => {
    const loadOCs = async () => {
      try {
        const storedOCs = await getOCs();
        const localOCs: OCFile[] = storedOCs.filter(oc => oc.isLocal).map(oc => ({
          id: oc.id, name: oc.name, preview: oc.preview,
          positive: oc.positive, negative: oc.negative, user: oc.user,
          aliases: oc.aliases,
          publicId: oc.publicId,
          origin: oc.origin,
        }));
        setOcLocalFiles(localOCs);

        setIsLoadingPublicOCs(true);
        try {
          const publicOCData = await getPublicOCs();
          const publicOCs: OCFile[] = publicOCData.map(oc => ({
            id: oc.id,
            name: oc.zh_name || oc.en_name,
            preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
            positive: oc.tag_group,
            negative: oc.negative_prompt || '',
            user: 'Bot公共库',
            aliases: oc.zh_aliases || [],
            created_by: oc.created_by || '',
            created_at: oc.created_at || 0,
          }));
          setOcPublicFiles(publicOCs);
        } catch (err) {
          console.error('Failed to load public OCs:', err);
          setOcPublicFiles([]);
        } finally {
          setIsLoadingPublicOCs(false);
        }
      } catch (error) {
        console.error('Failed to load OCs:', error);
        setOcLocalFiles([]);
      }
    };
    loadOCs();
  }, []);

  // --- Refresh public OCs ---
  const refreshPublicOCs = useCallback(async () => {
    setIsLoadingPublicOCs(true);
    clearPublicOCCache();
    try {
      const publicOCData = await getPublicOCs(true);
      const publicOCs = publicOCData.map(oc => ({
        id: oc.id,
        name: oc.zh_name || oc.en_name,
        preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
        positive: oc.tag_group,
        negative: oc.negative_prompt || '',
        user: 'Bot公共库',
        aliases: oc.zh_aliases || [],
        created_by: oc.created_by || '',
        created_at: oc.created_at || 0,
      }));
      setOcPublicFiles(publicOCs);
    } catch (err) {
      console.error('刷新公共OC失败:', err);
    } finally {
      setIsLoadingPublicOCs(false);
    }
  }, []);

  // --- Selection ---
  const toggleOCSelection = useCallback((id: string) => {
    setSelectedOCs(prev => {
      if (prev.includes(id)) return prev.filter(item => item !== id);
      if (prev.length >= 6) return prev;
      return [...prev, id];
    });
  }, []);

  // --- Random OC ---
  const handleRandomOC = useCallback(() => {
    const currentFiles = ocTab === 'public' ? ocPublicFiles : ocLocalFiles;
    const availableFiles = currentFiles.filter(f => !selectedOCs.includes(f.id));
    if (availableFiles.length === 0 || selectedOCs.length >= 6) return;

    const randomFile = availableFiles[Math.floor(Math.random() * availableFiles.length)];
    setSelectedOCs(prev => [...prev, randomFile.id]);

    setTimeout(() => {
      const element = document.getElementById(`oc-card-${randomFile.id}`);
      if (!element) return;

      const observer = new IntersectionObserver((entries) => {
        const entry = entries[0];
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          observer.disconnect();
          setJustSelectedOCId(randomFile.id);
          const rect = element.getBoundingClientRect();
          const x = (rect.left + rect.width / 2) / window.innerWidth;
          const y = (rect.top + rect.height / 2) / window.innerHeight;
          confetti({ particleCount: 100, spread: 70, origin: { x, y }, zIndex: 9999 });
          setTimeout(() => setJustSelectedOCId(null), 2000);
        }
      }, { threshold: 0.5 });

      observer.observe(element);
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => observer.disconnect(), 5000);
    }, 50);
  }, [ocTab, ocPublicFiles, ocLocalFiles, selectedOCs]);

  // --- Open / Create ---
  const openOCDetail = useCallback((oc: OCFile) => {
    setEditingOCId(oc.id);
    setNewOCName(oc.name);
    setNewOCPositive(oc.positive);
    setNewOCAliases(oc.aliases?.join(', ') || '');
    setNewOCPreview(oc.preview);
    setIsNewPreview(false); // 原有预览图，不是新生成的
    setNewOCCreatedBy(oc.created_by || '');
    // 将时间戳转换为日期字符串
    if (oc.created_at) {
      const date = new Date(oc.created_at * 1000);
      setNewOCCreatedAt(date.toISOString().split('T')[0]);
    } else {
      setNewOCCreatedAt('');
    }
    setIsCreatingOC(true);
  }, []);

  const openCreateOC = useCallback(() => {
    setEditingOCId(null);
    setNewOCName('');
    setNewOCPositive('');
    setNewOCAliases('');
    setNewOCPreview(null);
    setIsNewPreview(false);
    // 自动填充当前登录用户的 ID 作为创建者
    setNewOCCreatedBy(getPublicLibraryOwnerId());
    setNewOCCreatedAt('');
    setIsCreatingOC(true);
  }, []);

  // --- Preview generation ---
  const handleGenerateOCPreview = async () => {
    if (!newOCPositive || isGeneratingOCPreview) return;
    setIsGeneratingOCPreview(true);

    const fixedPrompt = '2::1girl, solo::, 0.6::artist:shano hiyori::, 1.2::artist:min (120716) ::, 0.6::artist:momoco ::, 0.6::artist:Akakura::, 1::artist:miv4t ::,::artist:aramedraw,artist:kouyafu,0.5::artist:fujiyama,::artist:motimoti067,0.8::artist:ham_melon_(iloha_24),::0.7::artist:onineko::,artist:ouchi_kaeru,0.95::artist:syagamu,::artist:konya_karasue,artist:luozhou pile,0.6::artist:hagimorijia,:: 0.6::artist:yumenouchi_chiharu,1.02::artist:huang_gua,:: -2::artist collaboration,noise,film grain::, year 2024, year 2025, -0.45::flat color::, 1.3::white background,full body,stand::';
    const fixedNegative = '2::little dolls, extra characters,extra fingers,logo,watermark,signature,artist collaboration,deformed,what::,lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 0.5::monochrome, blue tint, cyan tint, desaturated, cold color::';

    const combinedPositive = `${fixedPrompt}, ${newOCPositive}`;

    try {
      const result = await generateImageStream({
        positivePrompt: combinedPositive, negativePrompt: fixedNegative,
        model: 'v4.5-full', width: 832, height: 1216, steps: 28, scale: 5,
        sampler: 'Euler Ancestral', cfgRescale: 0, noiseSchedule: 'karras',
        ucPreset: 'heavy', qualityToggle: true, varietyPlus: false, characterPrompts: [],
      });
      if (result.success && result.imageData) {
        setNewOCPreview(await blobToBase64(result.imageData));
        setIsNewPreview(true); // 标记为新生成的预览图
      } else {
        setNewOCPreview('https://placehold.co/832x1216/ef4444/fff?text=Failed');
      }
    } catch (error) {
      console.error('OC 预览图生成失败:', error);
      setNewOCPreview('https://placehold.co/832x1216/ef4444/fff?text=Error');
    }
    setIsGeneratingOCPreview(false);
  };

  // --- Save ---
  const handleSaveOC = async (target?: 'public' | 'local') => {
    if (!newOCName || isSavingOC) return;

    // 名称查重（排除当前编辑的OC）
    const isDuplicate = ocPublicFiles.some(oc =>
      oc.name === newOCName && oc.id !== editingOCId
    );
    if (isDuplicate) {
      alert(`名称"${newOCName}"已存在，请使用其他名称`);
      return;
    }

    setIsSavingOC(true);
    try {
      const isPublic = target === 'public' || (target === undefined && ocTab === 'public');
      // 解析别名：逗号分隔，去除空白
      const aliasesArray = newOCAliases
        .split(/[,，]/)
        .map(s => s.trim())
        .filter(s => s.length > 0);

      if (editingOCId) {
        const existingInPublic = ocPublicFiles.find(f => f.id === editingOCId);
        const existingInLocal = ocLocalFiles.find(f => f.id === editingOCId);
        const existing = existingInPublic || existingInLocal;

        if (existingInPublic) {
          // 将日期字符串转换为时间戳
          let createdAtTimestamp: number | undefined;
          if (newOCCreatedAt) {
            createdAtTimestamp = Math.floor(new Date(newOCCreatedAt).getTime() / 1000);
          }
          // 只有新生成的预览图才提交（base64格式）
          const previewToSubmit = isNewPreview && newOCPreview?.startsWith('data:') ? newOCPreview : undefined;
          const result = await updatePublicOC(editingOCId, {
            zh_name: newOCName, tag_group: newOCPositive, preview_base64: previewToSubmit,
            zh_aliases: aliasesArray.length > 0 ? aliasesArray : undefined,
            created_by: newOCCreatedBy || undefined,
            created_at: createdAtTimestamp,
          });
          if (!result.success) { alert(`更新失败: ${result.message}`); return; }
          const updatedOC: OCFile = {
            id: editingOCId, name: newOCName, positive: newOCPositive, negative: '',
            preview: newOCPreview || existing?.preview || '', user: existing?.user || 'Bot公共库',
            aliases: aliasesArray,
            created_by: newOCCreatedBy, created_at: createdAtTimestamp,
          };
          setOcPublicFiles(prev => prev.map(f => f.id === editingOCId ? updatedOC : f));
        } else {
          const updatedOC: OCFile = {
            id: editingOCId, name: newOCName, positive: newOCPositive, negative: '',
            preview: newOCPreview || existing?.preview || 'https://placehold.co/832x1216/cbd5e0/000?text=NoPreview',
            user: existing?.user || 'LocalUser',
            aliases: aliasesArray,
          };
          await saveOC({ ...updatedOC, user: updatedOC.user || 'LocalUser', isLocal: true });
          setOcLocalFiles(prev => prev.map(f => f.id === editingOCId ? updatedOC : f));
        }
      } else {
        if (isPublic) {
          // 只有新生成的预览图才提交（base64格式）
          const previewToSubmit = isNewPreview && newOCPreview?.startsWith('data:') ? newOCPreview : undefined;
          // 不传 en_name，由服务端根据 zh_name 用拼音生成（与 bot 端一致）
          const currentUserId = getPublicLibraryOwnerId();
          const result = await createPublicOC({
            zh_name: newOCName, tag_group: newOCPositive, preview_base64: previewToSubmit,
            zh_aliases: aliasesArray.length > 0 ? aliasesArray : undefined,
            created_by: newOCCreatedBy || currentUserId || undefined,
          });
          if (!result.success) { alert(`创建失败: ${result.message}`); return; }
          if (result.oc) {
            const newOC: OCFile = {
              id: result.oc.id, name: result.oc.zh_name || result.oc.en_name,
              positive: result.oc.tag_group, negative: '',
              preview: result.oc.preview_url ? getOCPreviewUrl(result.oc.en_name) : '', user: 'Bot公共库',
              aliases: aliasesArray,
            };
            setOcPublicFiles(prev => [...prev, newOC]);
          }
        } else {
          const newOC: OCFile = {
            id: Date.now().toString(), name: newOCName, positive: newOCPositive, negative: '',
            preview: newOCPreview || 'https://placehold.co/832x1216/cbd5e0/000?text=NoPreview', user: 'LocalUser',
            aliases: aliasesArray,
          };
          await saveOC({ ...newOC, user: newOC.user || 'LocalUser', isLocal: true });
          setOcLocalFiles(prev => [...prev, newOC]);
        }
      }
      // Reset form
      setIsCreatingOC(false); setEditingOCId(null);
      setNewOCName(''); setNewOCPositive(''); setNewOCAliases(''); setNewOCPreview(null);
      setIsNewPreview(false);
      setNewOCCreatedBy(''); setNewOCCreatedAt('');
    } finally {
      setIsSavingOC(false);
    }
  };

  // --- Delete ---
  /** 彻底删除: 删公共条目 + 删 origin='created' 本地副本 (fork 副本不动) */
  const deletePublicOCTotally = async (publicId: string): Promise<{ success: boolean; message?: string }> => {
    const result = await deletePublicOC(publicId);
    if (!result.success) return { success: false, message: result.message };
    setOcPublicFiles(prev => prev.filter(f => f.id !== publicId));
    const toDelete = ocLocalFiles.filter(f =>
      f.id === publicId && (f.origin === 'created' || f.origin === undefined),
    );
    for (const local of toDelete) {
      try { await deleteOC(local.id); } catch (e) { console.error('删本地副本失败:', e); }
    }
    if (toDelete.length > 0) {
      setOcLocalFiles(prev => prev.filter(f => !toDelete.some(d => d.id === f.id)));
    }
    return { success: true };
  };

  /** 撤回发布: 删公共条目 + 把对应本地 created 副本转为纯本地 (保留为私人版,清 publicId/origin) */
  const unpublishOC = async (publicId: string): Promise<{ success: boolean; message?: string }> => {
    const result = await deletePublicOC(publicId);
    if (!result.success) return { success: false, message: result.message };
    setOcPublicFiles(prev => prev.filter(f => f.id !== publicId));
    // 把 created 本地副本 (id === publicId) 转为纯本地保留
    const localCreated = ocLocalFiles.find(f => f.id === publicId && (f.origin === 'created' || f.origin === undefined));
    if (localCreated) {
      const detached: OCFile = {
        ...localCreated,
        id: `local_${Date.now()}`, // 换 id 避免跟其它本地条目冲突 (公共 id 可能跟某个 local 串了 key)
        origin: 'local',
        publicId: undefined,
      };
      await saveOC({ ...detached, user: detached.user || 'LocalUser', isLocal: true });
      // 删旧 entry 再加新的 (id 变了)
      await deleteOC(localCreated.id);
      setOcLocalFiles(prev => [...prev.filter(f => f.id !== localCreated.id), detached]);
    }
    return { success: true };
  };

  /** 仅删本地副本 (公共条目由调用方处理) - 用于"删公共时连带清本地副本"场景 */
  const deleteOCLocalCopy = async (localId: string): Promise<void> => {
    await deleteOC(localId);
    setOcLocalFiles(prev => prev.filter(f => f.id !== localId));
    if (selectedOCs.includes(localId)) {
      setSelectedOCs(prev => prev.filter(sid => sid !== localId));
    }
  };

  const handleDeleteOC = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isPublicOC = ocPublicFiles.some(f => f.id === id);
    if (isPublicOC) {
      const result = await deletePublicOC(id);
      if (!result.success) { alert(`删除失败: ${result.message}`); return; }
      setOcPublicFiles(prev => prev.filter(f => f.id !== id));
    } else {
      await deleteOC(id);
      setOcLocalFiles(prev => prev.filter(f => f.id !== id));
    }
    if (selectedOCs.includes(id)) {
      setSelectedOCs(prev => prev.filter(selectedId => selectedId !== id));
    }
  };

  // --- Generate preview from arbitrary prompt (tag-manager 用,不依赖 hook 内表单 state) ---
  const generatePreviewBase64 = async (
    positive: string,
    onProgress?: (step: number, total: number) => void,
  ): Promise<string | null> => {
    if (!positive.trim()) return null;
    const fixedPrompt = '2::1girl, solo::, 0.6::artist:shano hiyori::, 1.2::artist:min (120716) ::, 0.6::artist:momoco ::, 0.6::artist:Akakura::, 1::artist:miv4t ::,::artist:aramedraw,artist:kouyafu,0.5::artist:fujiyama,::artist:motimoti067,0.8::artist:ham_melon_(iloha_24),::0.7::artist:onineko::,artist:ouchi_kaeru,0.95::artist:syagamu,::artist:konya_karasue,artist:luozhou pile,0.6::artist:hagimorijia,:: 0.6::artist:yumenouchi_chiharu,1.02::artist:huang_gua,:: -2::artist collaboration,noise,film grain::, year 2024, year 2025, -0.45::flat color::, 1.3::white background,full body,stand::';
    const fixedNegative = '2::little dolls, extra characters,extra fingers,logo,watermark,signature,artist collaboration,deformed,what::,lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 0.5::monochrome, blue tint, cyan tint, desaturated, cold color::';
    try {
      const result = await generateImageStream({
        positivePrompt: `${fixedPrompt}, ${positive.trim()}`,
        negativePrompt: fixedNegative,
        model: 'v4.5-full', width: 832, height: 1216, steps: 28, scale: 5,
        sampler: 'Euler Ancestral', cfgRescale: 0, noiseSchedule: 'karras',
        ucPreset: 'heavy', qualityToggle: true, varietyPlus: false, characterPrompts: [],
      }, onProgress ? (p) => onProgress(p.step, p.totalSteps) : undefined);
      if (result.success && result.imageData) {
        return await blobToBase64(result.imageData);
      }
      return null;
    } catch (err) {
      console.error('OC 预览图生成失败:', err);
      return null;
    }
  };

  // --- Save from payload (tag-manager 统一新建面板用,不依赖 hook 内表单 state) ---
  const saveOCFromPayload = async (
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    target: 'public' | 'local',
  ): Promise<{ success: boolean; message?: string; id?: string }> => {
    const trimmedName = payload.name.trim();
    if (!trimmedName) return { success: false, message: '名字不能为空' };
    if (!payload.positive.trim()) return { success: false, message: '正向提示词不能为空' };

    // 名称查重
    const list = target === 'public' ? ocPublicFiles : ocLocalFiles;
    if (list.some(oc => oc.name === trimmedName)) {
      return { success: false, message: `名称"${trimmedName}"已存在` };
    }

    const preview = payload.previews[0];
    const previewBase64 = preview?.startsWith('data:') ? preview : undefined;

    if (target === 'public') {
      const currentUserId = getPublicLibraryOwnerId();
      const result = await createPublicOC({
        zh_name: trimmedName,
        tag_group: payload.positive.trim(),
        negative_prompt: payload.negative?.trim() || undefined,
        preview_base64: previewBase64,
        zh_aliases: payload.aliases && payload.aliases.length > 0 ? payload.aliases : undefined,
        created_by: currentUserId || undefined,
      });
      if (!result.success) return { success: false, message: result.message };
      if (result.oc) {
        const newOC: OCFile = {
          id: result.oc.id,
          name: result.oc.zh_name || result.oc.en_name,
          positive: result.oc.tag_group,
          negative: result.oc.negative_prompt || '',
          preview: result.oc.preview_url ? getOCPreviewUrl(result.oc.en_name) : '',
          user: 'Bot公共库',
          aliases: payload.aliases,
          // 关键: 写回 created_by/created_at,CharacterPanel.myOCs 过滤需要
          created_by: result.oc.created_by || currentUserId || undefined,
          created_at: result.oc.created_at,
        };
        setOcPublicFiles(prev => [...prev, newOC]);
      }
      return { success: true, id: result.oc?.id };
    } else {
      const newOC: OCFile = {
        id: Date.now().toString(),
        name: trimmedName,
        positive: payload.positive.trim(),
        negative: payload.negative?.trim() || '',
        preview: preview || 'https://placehold.co/832x1216/cbd5e0/000?text=NoPreview',
        user: 'LocalUser',
        aliases: payload.aliases,
      };
      await saveOC({ ...newOC, user: newOC.user || 'LocalUser', isLocal: true });
      setOcLocalFiles(prev => [...prev, newOC]);
      return { success: true, id: newOC.id };
    }
  };

  // --- Update from payload (tag-manager 编辑面板用) ---
  // favorited: hook 不动 OCFile(私有 tags 由 Panel 走 characterTagsStore)
  // local: 直接更新 OCFile
  // created: updatePublicOC + 同步更新本地副本
  const updateOCFromPayload = async (
    id: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    origin: 'local' | 'favorited' | 'created',
  ): Promise<{ success: boolean; message?: string }> => {
    if (origin === 'favorited') {
      // OC 私有 tags 由 Panel 端独立处理(characterTagsStore)
      return { success: true };
    }

    const local = ocLocalFiles.find(f => f.id === id);
    const previewToSubmit = payload.previews[0]?.startsWith('data:') ? payload.previews[0] : undefined;

    if (origin === 'created') {
      const publicId = local?.publicId || id;
      const result = await updatePublicOC(publicId, {
        zh_name: payload.name.trim(),
        tag_group: payload.positive.trim(),
        negative_prompt: payload.negative?.trim() || '',
        preview_base64: previewToSubmit,
        zh_aliases: payload.aliases && payload.aliases.length > 0 ? payload.aliases : undefined,
      });
      if (!result.success) return { success: false, message: result.message };
      // 预览图 cache-busting:
      //   - 用户上传了新图 (base64 dataURL) → 直接显示 base64,免等网络
      //   - 没上传新图 → 后端可能因 zh_name 变化重生 labeled 图,URL 不变需要时间戳强制 reload
      const previewIsBase64 = payload.previews[0]?.startsWith('data:');
      const cacheBust = Date.now();
      setOcPublicFiles(prev => prev.map(f => f.id === publicId ? {
        ...f,
        name: payload.name.trim(),
        positive: payload.positive.trim(),
        negative: payload.negative?.trim() || '',
        preview: previewIsBase64
          ? payload.previews[0]!
          : `${(f.preview || '').split('?')[0]}?t=${cacheBust}`,
        aliases: payload.aliases,
      } : f));
      if (local) {
        const updated: OCFile = {
          ...local,
          name: payload.name.trim(),
          positive: payload.positive.trim(),
          negative: payload.negative?.trim() || '',
          preview: payload.previews[0] || local.preview,
          aliases: payload.aliases,
        };
        await saveOC({ ...updated, user: local.user || 'LocalUser', isLocal: true });
        setOcLocalFiles(prev => prev.map(f => f.id === id ? updated : f));
      }
      return { success: true };
    }

    // origin === 'local'
    if (!local) return { success: false, message: '本地无该 OC' };
    const updated: OCFile = {
      ...local,
      name: payload.name.trim(),
      positive: payload.positive.trim(),
      negative: payload.negative?.trim() || '',
      preview: payload.previews[0] || local.preview,
      aliases: payload.aliases,
    };
    await saveOC({ ...updated, user: local.user || 'LocalUser', isLocal: true });
    setOcLocalFiles(prev => prev.map(f => f.id === id ? updated : f));
    return { success: true };
  };

  // --- Fork: 把公共 OC 改了之后另存为本地副本 ---
  // mode='favorited' (默认): 用于"收藏的别人的 OC"流程,保留 publicId 链接,同 source 已有副本就更新
  // mode='detached': 用于"我自己发布的 OC fork 一份脱钩本地版"流程,不带 publicId,origin='local',每次新建
  // 同名冲突自动加 (副本) / (副本 2) 后缀,避免与公共原作或其他本地 OC 在列表中互相覆盖
  const forkOCToLocal = async (
    sourcePublicId: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      aliases?: string[];
      previews: string[];
    },
    mode: 'favorited' | 'detached' = 'favorited',
  ): Promise<{ success: boolean; message?: string; localId?: string; finalName?: string }> => {
    const trimmedName = payload.name.trim();
    if (!trimmedName) return { success: false, message: '名字不能为空' };
    if (!payload.positive.trim()) return { success: false, message: '正向提示词不能为空' };

    // detached 模式不复用已有副本,每次新建一份独立的
    const existing = mode === 'favorited' ? ocLocalFiles.find(f => f.publicId === sourcePublicId) : undefined;

    // 名称冲突检测:跟其他本地 OC 或非源公共 OC 同名 (排除自身已有副本)
    const collides = (n: string): boolean => {
      const localCollide = ocLocalFiles.some(f => f.id !== existing?.id && f.name === n);
      const publicCollide = ocPublicFiles.some(p => p.id !== sourcePublicId && p.name === n);
      return localCollide || publicCollide;
    };
    // 已含「(副本)」「(副本 N)」后缀的剥掉再递增,避免叠加
    const stripped = trimmedName.replace(/\s*\(副本(?:\s+\d+)?\)$/, '');
    let finalName = trimmedName;
    if (collides(finalName)) {
      let i = 1;
      while (true) {
        const candidate = i === 1 ? `${stripped} (副本)` : `${stripped} (副本 ${i})`;
        if (!collides(candidate)) { finalName = candidate; break; }
        i++;
      }
    }

    const preview = payload.previews[0];
    const localId = existing?.id || `local_${Date.now()}`;
    const localOC: OCFile = {
      id: localId,
      name: finalName,
      positive: payload.positive.trim(),
      negative: payload.negative?.trim() || '',
      preview: preview || existing?.preview || 'https://placehold.co/832x1216/cbd5e0/000?text=NoPreview',
      user: existing?.user || 'LocalUser',
      aliases: payload.aliases,
      publicId: mode === 'favorited' ? sourcePublicId : undefined,
      origin: mode === 'favorited' ? 'favorited' : 'local',
    };
    await saveOC({ ...localOC, user: localOC.user || 'LocalUser', isLocal: true });
    setOcLocalFiles(prev => existing
      ? prev.map(f => f.id === localId ? localOC : f)
      : [...prev, localOC]
    );
    return { success: true, localId, finalName };
  };

  // --- Save public to local ---
  // 写入 publicId + origin='favorited',对齐 ArtistFile,后续 fork 编辑按 publicId 精确链接
  const handleSaveOCToLocal = async (file: OCFile, e: React.MouseEvent) => {
    e.stopPropagation();
    const existingLocal = ocLocalFiles.find(f => f.publicId === file.id || f.name === file.name);
    if (existingLocal) {
      // 老数据可能没 publicId,这次顺手补上,做"按机会迁移"
      if (!existingLocal.publicId) {
        const migrated: OCFile = { ...existingLocal, publicId: file.id, origin: 'favorited' };
        await saveOC({ ...migrated, user: migrated.user || 'LocalUser', isLocal: true });
        setOcLocalFiles(prev => prev.map(f => f.id === existingLocal.id ? migrated : f));
      }
      setSavedToLocalOCId(file.id);
      setTimeout(() => setSavedToLocalOCId(null), 1500);
      return;
    }
    const localOC: OCFile = {
      id: `local_${Date.now()}`, name: file.name, positive: file.positive,
      negative: file.negative || '', preview: file.preview, user: 'LocalUser',
      aliases: file.aliases,
      publicId: file.id,
      origin: 'favorited',
    };
    await saveOC({ ...localOC, user: localOC.user || 'LocalUser', isLocal: true });
    setOcLocalFiles(prev => [...prev, localOC]);
    setSavedToLocalOCId(file.id);
    setTimeout(() => setSavedToLocalOCId(null), 1500);
  };

  return {
    ocTab, setOcTab, selectedOCs, setSelectedOCs, justSelectedOCId, setJustSelectedOCId,
    ocPublicFiles, setOcPublicFiles, ocLocalFiles, setOcLocalFiles,
    isLoadingPublicOCs, setIsLoadingPublicOCs,
    isCreatingOC, setIsCreatingOC, editingOCId,
    newOCName, setNewOCName, newOCPositive, setNewOCPositive,
    newOCAliases, setNewOCAliases, newOCPreview,
    newOCCreatedBy, setNewOCCreatedBy, newOCCreatedAt, setNewOCCreatedAt,
    isGeneratingOCPreview, isSavingOC,
    copiedOCId, setCopiedOCId, savedToLocalOCId,
    openOCDetail, openCreateOC, handleGenerateOCPreview, generatePreviewBase64,
    handleSaveOC, saveOCFromPayload, updateOCFromPayload, forkOCToLocal,
    handleDeleteOC, deleteOCLocalCopy, unpublishOC, deletePublicOCTotally, toggleOCSelection,
    handleRandomOC, handleSaveOCToLocal, refreshPublicOCs,
  };
}
