// 画师串管理器 - 自定义 Hook
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { ArtistFile, ArtistPreviewProgress, UseArtistManagerReturn } from './types';
import { saveArtist, getArtists, deleteArtist } from '../../services/localLibrary';
import {
  getPublicArtists, clearPublicArtistCache,
  createPublicArtist, updatePublicArtist, deletePublicArtist, usePublicArtist,
  getPublicLibraryOwnerId, type PublicArtistData,
} from '../../services/publicLibrary';
import { generateImageStream } from '../../services/novelai';

const ARTIST_PAGE_SIZE = 16;

const COMMON_POSITIVE = 'best quality, amazing quality, very aesthetic, absurdres, very aesthetic, masterpiece, no text';

// 四个固定预览图提示词模板：利用 NovelAI 的随机语法 (||A|B||) 测出画师串在不同变量下的天然倾向
const buildPreviewPrompts = (artistString: string) => [
  // 1. 季节、光照与基本景别的随机组合（注重整体氛围）
  `${artistString}, -2::artist collaboration::, 1.3::The atmosphere of ||winter|autumn|summer|spring||::, ||day|night|star night|golden hour|sunset||, lively atmosphere, ||cowboy shot|upper body||, 1girl, solo, ${COMMON_POSITIVE}`,
  // 2. 场景地点、服饰类型与姿势的随机组合（测试画师的背景与着装倾向）
  `${artistString}, -2::artist collaboration::, ||outdoors, nature|indoors, room|city street|fantasy ruins||, ||casual wear|school uniform|fantasy clothing|elegant dress||, ||standing|sitting|dynamic pose||, full body, 1girl, solo, ${COMMON_POSITIVE}`,
  // 3. 色彩倾向、面部情绪与视角的随机组合（测试画师的脸部特写与色调偏好）
  `${artistString}, -2::artist collaboration::, ||vibrant colors|pastel colors|dark moody colors|monochrome||, ||smile|expressionless|crying|angry||, ||looking at viewer|looking away||, close-up, portrait, 1girl, solo, ${COMMON_POSITIVE}`,
  // 4. 主体与构图的随机盲测（测试纯场景、双人交互或其他非标准主体）
  `${artistString}, -2::artist collaboration::, ||scenery, no humans, wide angle|2girls, interacting, cowboy shot|1boy, solo, upper body|1girl, solo, extreme dynamic angle||, ||highly detailed background|simple background||, ${COMMON_POSITIVE}`
];

const BASE_NEGATIVE = '2::little dolls, extra characters,extra fingers,logo,watermark,signature,artist collaboration,deformed,what::, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 1';
const PLACEHOLDER_COLORS = ['ffadad', 'ffd6a5', 'fdffb6', 'caffbf'];

const PREVIEW_GEN_PARAMS = {
  model: 'v4.5-full' as const,
  width: 1216,
  height: 832,
  steps: 28,
  scale: 5,
  sampler: 'Euler Ancestral' as const,
  cfgRescale: 0,
  noiseSchedule: 'karras' as const,
  ucPreset: 'heavy' as const,
  qualityToggle: true,
  varietyPlus: false,
  characterPrompts: [] as any[],
};

const EXCLUDE_WORDS = new Set([
  "masterpiece", "year 2025", "year 2026", "best quality", "very aesthetic", "year 2024",
  "absurdres", "no text", "year2025", "year2024", "realistic",
  "colorful", "location", "incredibly absurdres", "detailed",
  "ultra-detailed", "amazing quality", "stunning composition",
  "artist collaboration", "1girl", "2girls", "3girls", "4girls", "5girls", "6+girls",
  "multiple girls", "boy", "1boy", "2boys", "solo", "solo focus", "girls", "boys"
]);

export function getArtistTokens(prompt: string): string[] {
  const tokens = new Set<string>();
  const parts = prompt.split(/[,，]/);
  
  for (let p of parts) {
    if (!/artist/i.test(p)) continue;
    if (/artist\s*collaboration/i.test(p)) continue;
    
    let rawT = p.replace(/[+-]?\d+(?:\.\d+)?::/g, '')
             .replace(/::[+-]?\d+(?:\.\d+)?/g, '')
             .replace(/:[+-]?\d+(?:\.\d+)?/g, '')
             .replace(/:/g, '')
             .replace(/artist/gi, '')
             .replace(/[\[\]\{\}()]/g, '')
             .replace(/\s+/g, ' ')
             .trim()
             .toLowerCase();
             
    if (rawT && !EXCLUDE_WORDS.has(rawT) && rawT.length > 1) {
      tokens.add(rawT.replace(/ /g, '_'));
    }
  }
  
  if (tokens.size === 0) {
    for (let p of parts) {
      let rawT = p.replace(/[+-]?\d+(?:\.\d+)?::/g, '')
             .replace(/::[+-]?\d+(?:\.\d+)?/g, '')
             .replace(/:[+-]?\d+(?:\.\d+)?/g, '')
             .replace(/:/g, '')
             .replace(/[\[\]\{\}()]/g, '')
             .replace(/\s+/g, ' ')
             .trim()
             .toLowerCase();
             
      if (rawT && !EXCLUDE_WORDS.has(rawT) && rawT.length > 3) {
        tokens.add(rawT.replace(/ /g, '_'));
      }
    }
  }
  
  return Array.from(tokens);
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

export function useArtistManager(): UseArtistManagerReturn {
  // --- Tab & Selection ---
  const [artistTab, setArtistTab] = useState<'public' | 'local'>('public');
  const [selectedArtistIds, setSelectedArtistIds] = useState<string[]>([]);
  const [editorArtistTags, setEditorArtistTags] = useState<{ label: string; content: string }[]>([]);

  // --- Recent usage order (persisted) ---
  const [artistUsageOrder, setArtistUsageOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('artist_usage_order');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem('artist_usage_order', JSON.stringify(artistUsageOrder)); } catch { }
  }, [artistUsageOrder]);

  // --- Local source filter ---
  const [localArtistSource, setLocalArtistSource] = useState<'all' | 'local' | 'favorited' | 'created'>('all');

  // --- 标签系统 ---
  const [artistTagPool, setArtistTagPool] = useState<string[]>([]);
  const [selectedTagFilter, setSelectedTagFilter] = useState<Set<string>>(new Set());

  // --- Data ---
  const [artistPublicFiles, setArtistPublicFiles] = useState<ArtistFile[]>([]);
  const [artistLocalFiles, setArtistLocalFiles] = useState<ArtistFile[]>([]);
  const [isLoadingPublicArtists, setIsLoadingPublicArtists] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // 标签池：从本地画师串 + localStorage 收集
  // 注: '收藏' 是历史遗留 token,语义已被 origin === 'favorited' + ⭐ 系统取代,
  // 这里在聚合时静默过滤,让 chip 行/编辑弹窗等下游一致看不到它。存量数据不动。
  const reloadArtistTagPool = useCallback(() => {
    const used = new Set<string>();
    for (const f of artistLocalFiles) {
      if (f.tags) f.tags.forEach(t => { if (t && t !== '收藏') used.add(t); });
    }
    try {
      const saved = localStorage.getItem('artist_tag_pool');
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) arr.forEach((t: unknown) => { if (typeof t === 'string' && t && t !== '收藏') used.add(t); });
      }
    } catch { }
    setArtistTagPool(Array.from(used).sort((a, b) => a.localeCompare(b, 'zh-CN')));
  }, [artistLocalFiles]);

  useEffect(() => { reloadArtistTagPool(); }, [artistLocalFiles, reloadArtistTagPool]);

  const saveArtistTagPool = useCallback((pool: string[]) => {
    try { localStorage.setItem('artist_tag_pool', JSON.stringify(pool)); } catch { }
    setArtistTagPool(pool);
  }, []);

  // saveArtistTags is defined after loadLocalArtists below

  const filteredArtistPublicFiles = useMemo(() => {
    if (!searchQuery.trim()) return artistPublicFiles;
    const lowerQ = searchQuery.toLowerCase().replace(/_/g, ' ');
    return artistPublicFiles.filter(a => 
      a.name.toLowerCase().replace(/_/g, ' ').includes(lowerQ) || 
      a.prompt.toLowerCase().replace(/_/g, ' ').includes(lowerQ)
    );
  }, [artistPublicFiles, searchQuery]);

  const filteredArtistLocalFiles = useMemo(() => {
    // 纯本地列表，不再自动合并公共库中"我创建的"画师串
    let filtered = [...artistLocalFiles];
    // 按来源筛选
    if (localArtistSource === 'local') {
      filtered = filtered.filter(f => !f.origin || f.origin === 'local');
    } else if (localArtistSource === 'favorited') {
      filtered = filtered.filter(f => f.origin === 'favorited');
    } else if (localArtistSource === 'created') {
      filtered = filtered.filter(f => f.origin === 'created');
    }

    // 按标签筛选
    if (selectedTagFilter.size > 0) {
      filtered = filtered.filter(f => {
        const tags = f.tags || [];
        return tags.some(t => selectedTagFilter.has(t));
      });
    }

    if (!searchQuery.trim()) return filtered;
    const lowerQ = searchQuery.toLowerCase().replace(/_/g, ' ');
    return filtered.filter(a =>
      a.name.toLowerCase().replace(/_/g, ' ').includes(lowerQ) ||
      a.prompt.toLowerCase().replace(/_/g, ' ').includes(lowerQ)
    );
  }, [artistLocalFiles, artistPublicFiles, searchQuery, localArtistSource, selectedTagFilter]);

  // --- Lazy loading ---
  const [artistPublicDisplayCount, setArtistPublicDisplayCount] = useState(ARTIST_PAGE_SIZE);
  const [artistLocalDisplayCount, setArtistLocalDisplayCount] = useState(ARTIST_PAGE_SIZE);
  const [isLoadingMoreArtists, setIsLoadingMoreArtists] = useState(false);
  const artistPublicScrollRef = useRef<HTMLDivElement>(null);
  const artistLocalScrollRef = useRef<HTMLDivElement>(null);
  // 记录上次离开时的滚动位置，模态框 DOM 卸载/重挂载后用于还原
  const artistPublicScrollTopRef = useRef(0);
  const artistLocalScrollTopRef = useRef(0);

  // --- Creation / Editing ---
  const [isCreatingArtist, setIsCreatingArtist] = useState(false);
  const [editingArtistId, setEditingArtistId] = useState<string | null>(null);
  const [newArtistName, setNewArtistName] = useState('');
  const [newArtistPrompt, setNewArtistPrompt] = useState('');
  const [originalArtistPrompt, setOriginalArtistPrompt] = useState('');
  const [newArtistPreviews, setNewArtistPreviews] = useState<string[]>([]);
  const [newArtistTags, setNewArtistTags] = useState<Set<string>>(new Set());
  const [selectedArtistCoverIndex, setSelectedArtistCoverIndex] = useState(0);
  const [isGeneratingArtistPreviews, setIsGeneratingArtistPreviews] = useState(false);
  const [artistPreviewProgress, setArtistPreviewProgress] = useState<ArtistPreviewProgress | null>(null);
  const [copiedArtistId, setCopiedArtistId] = useState<string | null>(null);
  const [savedArtistId, setSavedArtistId] = useState<string | null>(null);
  const [isSavingArtist, setIsSavingArtist] = useState(false);

  // --- Load data on mount ---
  const loadPublicArtists = useCallback(async (forceRefresh = false) => {
    setIsLoadingPublicArtists(true);
    try {
      const artists = await getPublicArtists(forceRefresh);
      const artistFiles: ArtistFile[] = artists.map(a => ({
        id: a.id,
        name: a.name,
        previews: a.preview_url ? [a.preview_url] : [],
        prompt: a.artist_string,
        negative: a.negative || undefined,
        usageCount: a.usage_count,
        createdTime: a.created_time,
        createdTimeStr: a.created_time_str,
        addedBy: a.added_by,
        isLocal: false,
      }));
      artistFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      setArtistPublicFiles(artistFiles);
      // 不再每次刷新都把分页清回 16；只在分页计数超过总数时 clamp，避免还原 scrollTop 后内容不够撑开
      setArtistPublicDisplayCount(prev => Math.max(ARTIST_PAGE_SIZE, Math.min(prev, artistFiles.length || ARTIST_PAGE_SIZE)));
    } catch (err) {
      console.error('Failed to load public artists:', err);
      setArtistPublicFiles([]);
    } finally {
      setIsLoadingPublicArtists(false);
    }
  }, []);

  const loadLocalArtists = useCallback(async () => {
    try {
      const storedArtists = await getArtists();
      const localArtists = storedArtists.filter(a => a.isLocal).map(a => ({
        id: a.id,
        name: a.name,
        previews: a.previews,
        prompt: a.prompt,
        negative: a.negative,
        usageCount: a.usageCount,
        createdTime: a.createdTime ?? a.createdAt,
        createdTimeStr: a.createdTimeStr ?? (a.createdAt ? new Date(a.createdAt).toLocaleString() : undefined),
        addedBy: a.addedBy,
        isLocal: true,
        origin: a.origin ?? 'local' as const,  // 老数据没有 origin 视为 local
        publicId: a.publicId,
        tags: a.tags || [],
      }));
      setArtistLocalFiles(localArtists);
    } catch (error) {
      console.error('Failed to load local Artists:', error);
      setArtistLocalFiles([]);
    }
  }, []);

  const saveArtistTags = useCallback(async (artistId: string, tags: string[]) => {
    const allArtists = await getArtists();
    const artist = allArtists.find(a => a.id === artistId);
    if (!artist) return;
    artist.tags = tags;
    await saveArtist(artist);
    await loadLocalArtists();
  }, [loadLocalArtists]);

  useEffect(() => {
    loadLocalArtists();
    loadPublicArtists();
  }, [loadLocalArtists, loadPublicArtists]);


  // --- Scroll lazy load ---
  const handleArtistScroll = useCallback((e: React.UIEvent<HTMLDivElement>, isPublic: boolean) => {
    const target = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = target;
    // 持续记录滚动位置，关闭后下次打开时还原
    if (isPublic) artistPublicScrollTopRef.current = scrollTop;
    else artistLocalScrollTopRef.current = scrollTop;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      if (isPublic) {
        const totalCount = artistPublicFiles.length;
        if (artistPublicDisplayCount < totalCount && !isLoadingMoreArtists) {
          setIsLoadingMoreArtists(true);
          setTimeout(() => {
            setArtistPublicDisplayCount(prev => Math.min(prev + ARTIST_PAGE_SIZE, totalCount));
            setIsLoadingMoreArtists(false);
          }, 100);
        }
      } else {
        const totalCount = artistLocalFiles.length;
        if (artistLocalDisplayCount < totalCount && !isLoadingMoreArtists) {
          setIsLoadingMoreArtists(true);
          setTimeout(() => {
            setArtistLocalDisplayCount(prev => Math.min(prev + ARTIST_PAGE_SIZE, totalCount));
            setIsLoadingMoreArtists(false);
          }, 100);
        }
      }
    }
  }, [artistPublicFiles.length, artistLocalFiles.length, artistPublicDisplayCount, artistLocalDisplayCount, isLoadingMoreArtists]);

  // --- Selection ---
  const toggleArtistSelection = useCallback((id: string) => {
    setSelectedArtistIds(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]);
  }, []);

  const handleClearArtistSelection = useCallback(() => {
    setSelectedArtistIds([]);
  }, []);

  // Update usage order (called on confirm from modal)
  const updateArtistUsageOrder = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      // 空数组 = 清空最近使用
      setArtistUsageOrder([]);
      return;
    }
    setArtistUsageOrder(prev => [
      ...ids,
      ...prev.filter(id => !ids.includes(id)),
    ]);
  }, []);

  // --- Tags sync ---
  const handleTagsChange = useCallback((tags: { id: string; type: string; label: string; content: string; collapsed: boolean }[]) => {
    const artistTags = tags.filter(t => t.type === 'artist');
    setEditorArtistTags(artistTags.map(t => ({ label: t.label, content: t.content })));
    const allFiles = [...artistPublicFiles, ...artistLocalFiles];
    const matchedIds = artistTags
      .map(tag => {
        const byName = allFiles.find(f => f.name === tag.label);
        if (byName) return byName.id;
        const byContent = allFiles.find(f => f.prompt === tag.content);
        return byContent?.id;
      })
      .filter((id): id is string => !!id);
    setSelectedArtistIds(prev => {
      if (prev.length === matchedIds.length && prev.every((v, i) => v === matchedIds[i])) {
        return prev;
      }
      return matchedIds;
    });
  }, [artistPublicFiles, artistLocalFiles]);

  // --- Open / Create ---
  const openArtistDetail = useCallback((artist: ArtistFile) => {
    setEditingArtistId(artist.id);
    setNewArtistName(artist.name);
    setNewArtistPrompt(artist.prompt);
    setOriginalArtistPrompt(artist.prompt);
    setNewArtistPreviews(artist.previews);
    setNewArtistTags(new Set(artist.tags || []));
    setSelectedArtistCoverIndex(0);
    setIsCreatingArtist(true);
  }, []);

  const openCreateArtist = useCallback(() => {
    setEditingArtistId(null);
    setNewArtistName('');
    setNewArtistPrompt('');
    setOriginalArtistPrompt('');
    setNewArtistPreviews([]);
    setNewArtistTags(new Set());
    setSelectedArtistCoverIndex(0);
    setIsCreatingArtist(true);
  }, []);

  const handleArtistPromptChange = useCallback((value: string) => {
    setNewArtistPrompt(value);
  }, []);

  // --- Preview generation helpers ---
  const generateOnePreview = async (
    index: number,
    prompts: string[],
    negativePrompt: string,
    onProgress?: (step: number, total: number) => void,
  ): Promise<string> => {
    try {
      const result = await generateImageStream({
        positivePrompt: prompts[index],
        negativePrompt,
        ...PREVIEW_GEN_PARAMS,
      }, onProgress ? (p) => onProgress(p.step, p.totalSteps) : undefined);
      if (result.success && result.imageData) {
        return await blobToBase64(result.imageData);
      }
      return `https://placehold.co/512x512/${PLACEHOLDER_COLORS[index]}/000?text=Failed`;
    } catch (error) {
      console.error(`生成第 ${index + 1} 张预览图失败:`, error);
      return `https://placehold.co/512x512/${PLACEHOLDER_COLORS[index]}/000?text=Error`;
    }
  };

  // 生成单张预览图（追加到末尾）
  const handleGenerateSingleArtistPreview = async () => {
    if (!newArtistPrompt || isGeneratingArtistPreviews) return;
    setIsGeneratingArtistPreviews(true);
    const currentIndex = newArtistPreviews.length;
    setArtistPreviewProgress({ current: currentIndex + 1, total: 4 });

    const prompts = buildPreviewPrompts(newArtistPrompt);
    const negativePrompt = BASE_NEGATIVE;

    if (currentIndex >= prompts.length) {
      setIsGeneratingArtistPreviews(false);
      setArtistPreviewProgress(null);
      return;
    }

    const base64 = await generateOnePreview(currentIndex, prompts, negativePrompt);
    setNewArtistPreviews(prev => [...prev, base64]);
    setOriginalArtistPrompt(newArtistPrompt);
    setIsGeneratingArtistPreviews(false);
    setArtistPreviewProgress(null);
  };

  // 重新生成指定索引的预览图
  const handleRegenerateArtistPreviewAt = async (index: number) => {
    if (!newArtistPrompt || isGeneratingArtistPreviews) return;
    setIsGeneratingArtistPreviews(true);
    setArtistPreviewProgress({ current: index + 1, total: 4 });

    const prompts = buildPreviewPrompts(newArtistPrompt);
    const negativePrompt = BASE_NEGATIVE;

    const base64 = await generateOnePreview(index, prompts, negativePrompt);
    setNewArtistPreviews(prev => {
      const newPreviews = [...prev];
      newPreviews[index] = base64;
      return newPreviews;
    });
    setOriginalArtistPrompt(newArtistPrompt);
    setIsGeneratingArtistPreviews(false);
    setArtistPreviewProgress(null);
  };

  // 重新生成所有预览图
  const handleRegenerateAllArtistPreviews = async () => {
    setNewArtistPreviews([]);
    setSelectedArtistCoverIndex(0);
    setTimeout(() => handleGenerateSingleArtistPreview(), 100);
  };

  // 一次性生成全部4张
  const handleGenerateArtistPreview = async () => {
    if (!newArtistPrompt || isGeneratingArtistPreviews) return;
    setIsGeneratingArtistPreviews(true);
    setArtistPreviewProgress({ current: 0, total: 4 });
    setNewArtistPreviews([]);
    setSelectedArtistCoverIndex(0);

    const prompts = buildPreviewPrompts(newArtistPrompt);
    const negativePrompt = BASE_NEGATIVE;
    const generatedPreviews: string[] = [];

    for (let i = 0; i < prompts.length; i++) {
      setArtistPreviewProgress({ current: i + 1, total: 4 });
      const base64 = await generateOnePreview(i, prompts, negativePrompt);
      generatedPreviews.push(base64);
      setNewArtistPreviews([...generatedPreviews]);
    }

    setIsGeneratingArtistPreviews(false);
    setArtistPreviewProgress(null);
  };

  // --- Save ---
  const handleSaveArtist = async (target?: 'public' | 'local') => {
    if (!newArtistName || newArtistPreviews.length === 0 || isSavingArtist) return;
    setIsSavingArtist(true);
    try {
      const isLocal = target ? target === 'local' : artistTab === 'local';
      const reorderedPreviews = [...newArtistPreviews];
      if (selectedArtistCoverIndex > 0 && selectedArtistCoverIndex < reorderedPreviews.length) {
        const [coverImage] = reorderedPreviews.splice(selectedArtistCoverIndex, 1);
        reorderedPreviews.unshift(coverImage);
      }

      const tagsArr = Array.from(newArtistTags);
      if (editingArtistId) {
        const existingInPublic = artistPublicFiles.find(f => f.id === editingArtistId);
        const existingLocal = artistLocalFiles.find(f => f.id === editingArtistId);
        if (existingInPublic || (existingLocal?.origin === 'created' && existingLocal.publicId)) {
          // 编辑公共串（更新服务器 + 如果有本地副本也更新其标签）
          const publicId = existingLocal?.publicId || editingArtistId;
          const result = await updatePublicArtist(publicId, {
            artist_string: newArtistPrompt,
            preview_base64: reorderedPreviews[0] || undefined,
          });
          if (!result.success) { alert(`更新失败: ${result.message}`); return; }
          // 如果本地有副本，更新它的标签
          if (existingLocal) {
            const updatedLocal: ArtistFile = {
              ...existingLocal,
              name: newArtistName,
              prompt: newArtistPrompt,
              previews: reorderedPreviews,
              tags: tagsArr,
            };
            await saveArtist({ ...updatedLocal, isLocal: true, origin: existingLocal.origin ?? 'created', publicId: existingLocal.publicId, tags: tagsArr });
            setArtistLocalFiles(files => files.map(f => f.id === editingArtistId ? updatedLocal : f));
          }
          await loadPublicArtists(true);
        } else {
          // 编辑本地串
          const updatedArtist: ArtistFile = {
            id: editingArtistId, name: newArtistName, previews: reorderedPreviews,
            prompt: newArtistPrompt, isLocal: true,
            origin: existingLocal?.origin ?? 'local',
            publicId: existingLocal?.publicId,
            tags: tagsArr,
          };
          await saveArtist({ ...updatedArtist, isLocal: true, origin: updatedArtist.origin, publicId: updatedArtist.publicId, tags: tagsArr });
          setArtistLocalFiles(files => files.map(f => f.id === editingArtistId ? updatedArtist : f));
        }
      } else {
        if (isLocal) {
          const newArtist: ArtistFile = { id: Date.now().toString(), name: newArtistName, previews: reorderedPreviews, prompt: newArtistPrompt, isLocal: true, origin: 'local', tags: tagsArr };
          await saveArtist({ ...newArtist, isLocal: true, origin: 'local', tags: tagsArr });
          setArtistLocalFiles(prev => [...prev, newArtist]);
        } else {
          const result = await createPublicArtist({ name: newArtistName, artist_string: newArtistPrompt, preview_base64: reorderedPreviews[0] || undefined, added_by: getPublicLibraryOwnerId() });
          if (!result.success) { alert(`创建失败: ${result.message}`); return; }
          await loadPublicArtists(true);
        }
      }

      // Reset form
      setIsCreatingArtist(false);
      setEditingArtistId(null);
      setNewArtistName('');
      setNewArtistPrompt('');
      setOriginalArtistPrompt('');
      setNewArtistPreviews([]);
      setNewArtistTags(new Set());
      setSelectedArtistCoverIndex(0);
    } finally {
      setIsSavingArtist(false);
    }
  };

  /** 彻底删除: 删公共条目 + 删 origin='created' 本地副本 (fork 副本不动) */
  const deletePublicArtistTotally = async (publicId: string): Promise<{ success: boolean; message?: string }> => {
    const result = await deletePublicArtist(publicId);
    if (!result.success) return { success: false, message: result.message };
    setArtistPublicFiles(prev => prev.filter(f => f.id !== publicId));
    const toDelete = artistLocalFiles.filter(f => f.publicId === publicId && f.origin === 'created');
    for (const local of toDelete) {
      try {
        await deleteArtist(local.id);
      } catch (e) { console.error('删本地副本失败:', e); }
    }
    if (toDelete.length > 0) {
      setArtistLocalFiles(prev => prev.filter(f => !toDelete.some(d => d.id === f.id)));
    }
    return { success: true };
  };

  /** 撤回发布: 删公共条目 + 把 origin='created' 本地副本转为纯本地 (保留作私人版,清 publicId/origin) */
  const unpublishArtist = async (publicId: string): Promise<{ success: boolean; message?: string }> => {
    const result = await deletePublicArtist(publicId);
    if (!result.success) return { success: false, message: result.message };
    setArtistPublicFiles(prev => prev.filter(f => f.id !== publicId));
    const localCreated = artistLocalFiles.find(f => f.publicId === publicId && f.origin === 'created');
    if (localCreated) {
      const detached: ArtistFile = {
        ...localCreated,
        id: `local_${Date.now()}`,
        origin: 'local',
        publicId: undefined,
      };
      await saveArtist({ ...detached, isLocal: true, origin: 'local', tags: detached.tags || [] });
      await deleteArtist(localCreated.id);
      setArtistLocalFiles(prev => [...prev.filter(f => f.id !== localCreated.id), detached]);
    }
    return { success: true };
  };

  // --- Delete ---
  const handleDeleteArtist = async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    // 只删本地，不影响公共库
    await deleteArtist(id);
    setArtistLocalFiles(prev => prev.filter(f => f.id !== id));
    setArtistUsageOrder(prev => prev.filter(uid => uid !== id));
    setIsCreatingArtist(false);
  };

  // --- Save public to local (quick action on card) ---
  const savePublicToLocal = async (file: ArtistFile) => {
    // 检查是否已收藏（按 publicId 或名称去重）
    if (artistLocalFiles.some(f => f.publicId === file.id || f.name === file.name)) {
      setSavedArtistId(file.id);
      setTimeout(() => setSavedArtistId(null), 1500);
      return;
    }
    const localArtist: ArtistFile = {
      id: `fav_${Date.now()}`,
      name: file.name,
      previews: file.previews,
      prompt: file.prompt,
      isLocal: true,
      origin: 'favorited',
      publicId: file.id,
      tags: [],
    };
    await saveArtist({ ...localArtist, isLocal: true, origin: 'favorited', publicId: file.id, tags: [] });
    setArtistLocalFiles(prev => [...prev, localArtist]);
    setSavedArtistId(file.id);
    setTimeout(() => setSavedArtistId(null), 1500);
  };

  // --- Unfavorite (remove favorited artist from local) ---
  const unfavoriteArtist = async (id: string) => {
    const file = artistLocalFiles.find(f => f.id === id);
    if (!file || file.origin !== 'favorited') return;
    await deleteArtist(id);
    setArtistLocalFiles(prev => prev.filter(f => f.id !== id));
    setArtistUsageOrder(prev => prev.filter(uid => uid !== id));
  };

  // --- Create local copy from favorited/created ---
  // --- Fork: 从公共画师串 (含我自己发布的) 另存为脱钩本地副本 ---
  // 跟 OC 的 forkOCToLocal('detached') 对齐:不带 publicId,origin='local',独立于原作
  // 同名自动加「(副本)」「(副本 2)」后缀,跟其他本地 / 非源公共 不冲突
  const forkArtistToLocal = async (
    sourcePublicId: string,
    payload: { name: string; positive: string; negative?: string; previews: string[]; tags?: string[] },
  ): Promise<{ success: boolean; message?: string; localId?: string; finalName?: string }> => {
    const trimmedName = payload.name.trim();
    if (!trimmedName) return { success: false, message: '名字不能为空' };
    if (!payload.positive.trim()) return { success: false, message: '正向提示词不能为空' };

    const collides = (n: string): boolean => {
      const localCollide = artistLocalFiles.some(f => f.name === n);
      const publicCollide = artistPublicFiles.some(p => p.id !== sourcePublicId && p.name === n);
      return localCollide || publicCollide;
    };
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

    const localId = `local_${Date.now()}`;
    const localArtist: ArtistFile = {
      id: localId,
      name: finalName,
      previews: payload.previews,
      prompt: payload.positive.trim(),
      negative: payload.negative?.trim() || undefined,
      isLocal: true,
      origin: 'local',
      tags: payload.tags || [],
    };
    await saveArtist({ ...localArtist, isLocal: true, origin: 'local', tags: payload.tags || [] });
    setArtistLocalFiles(prev => [...prev, localArtist]);
    return { success: true, localId, finalName };
  };

  const createLocalCopy = async (file: ArtistFile) => {
    // 自动生成不重复的名称：A1 → A1(1) → A1(2) ...
    const allNames = new Set(artistLocalFiles.map(f => f.name));
    let newName = `${file.name}(1)`;
    let i = 2;
    while (allNames.has(newName)) {
      newName = `${file.name}(${i++})`;
    }
    const localCopy: ArtistFile = {
      id: `local_${Date.now()}`,
      name: newName,
      previews: file.previews,
      prompt: file.prompt,
      isLocal: true,
      origin: 'local',
    };
    await saveArtist({ ...localCopy, isLocal: true, origin: 'local' });
    setArtistLocalFiles(prev => [...prev, localCopy]);
  };

  // --- Generate single preview at index (tag-manager 用,不依赖 hook 内表单 state) ---
  const generatePreviewBase64 = async (
    positive: string,
    index: number,
    onProgress?: (step: number, total: number) => void,
  ): Promise<string | null> => {
    if (!positive.trim() || index < 0 || index > 3) return null;
    try {
      const prompts = buildPreviewPrompts(positive.trim());
      return await generateOnePreview(index, prompts, BASE_NEGATIVE, onProgress);
    } catch (err) {
      console.error('画师串预览图生成失败:', err);
      return null;
    }
  };

  // --- Save from payload (tag-manager 统一新建面板用,不依赖 hook 内表单 state) ---
  const saveArtistFromPayload = async (
    payload: {
      name: string;
      positive: string;
      negative?: string;
      previews: string[];
      tags?: string[];
    },
    target: 'public' | 'local',
  ): Promise<{ success: boolean; message?: string; id?: string }> => {
    const trimmedName = payload.name.trim();
    if (!trimmedName) return { success: false, message: '名字不能为空' };
    if (!payload.positive.trim()) return { success: false, message: '正向提示词不能为空' };
    const trimmedNegative = payload.negative?.trim() || undefined;

    if (target === 'public') {
      const result = await createPublicArtist({
        name: trimmedName,
        artist_string: payload.positive.trim(),
        negative: trimmedNegative,
        preview_base64: payload.previews[0] || undefined,
        added_by: getPublicLibraryOwnerId(),
      });
      if (!result.success) return { success: false, message: result.message };
      await loadPublicArtists(true);
      // 同时存一份本地副本,origin=created,记录 publicId 便于后续编辑
      if (result.artist?.id) {
        const localCopy: ArtistFile = {
          id: result.artist.id,
          name: trimmedName,
          previews: payload.previews,
          prompt: payload.positive.trim(),
          negative: trimmedNegative,
          isLocal: true,
          origin: 'created',
          publicId: result.artist.id,
          tags: payload.tags || [],
        };
        await saveArtist({ ...localCopy, isLocal: true, origin: 'created', publicId: result.artist.id, tags: payload.tags || [] });
        setArtistLocalFiles(prev => [...prev.filter(f => f.id !== result.artist!.id), localCopy]);
      }
      return { success: true, id: result.artist?.id };
    } else {
      const newArtist: ArtistFile = {
        id: Date.now().toString(),
        name: trimmedName,
        previews: payload.previews,
        prompt: payload.positive.trim(),
        negative: trimmedNegative,
        isLocal: true,
        origin: 'local',
        tags: payload.tags || [],
      };
      await saveArtist({ ...newArtist, isLocal: true, origin: 'local', tags: payload.tags || [] });
      setArtistLocalFiles(prev => [...prev, newArtist]);
      return { success: true, id: newArtist.id };
    }
  };

  // --- Update from payload (tag-manager 编辑面板用) ---
  // favorited: 只更新私有 tags(prompt/preview/name 是上游的,不可改)
  // local: 全字段更新
  // created: updatePublicArtist + 同步更新/补建本地副本
  //   注意 created 分支允许 local 不存在 - 此时 id 即公共条目 id (mineAll 对"我的公共无本地副本"
  //   走兜底路径),需要顺手补建一份本地副本作为新状态
  const updateArtistFromPayload = async (
    id: string,
    payload: {
      name: string;
      positive: string;
      negative?: string;
      previews: string[];
      tags?: string[];
    },
    origin: 'local' | 'favorited' | 'created',
  ): Promise<{ success: boolean; message?: string }> => {
    const local = artistLocalFiles.find(a => a.id === id);
    const trimmedNegative = payload.negative?.trim() || undefined;

    if (origin === 'favorited') {
      if (!local) return { success: false, message: '本地无该画师串' };
      // 只更新 tags
      const updated: ArtistFile = { ...local, tags: payload.tags || [] };
      await saveArtist({ ...updated, isLocal: true, origin: 'favorited', publicId: local.publicId, tags: payload.tags || [] });
      setArtistLocalFiles(prev => prev.map(f => f.id === id ? updated : f));
      return { success: true };
    }

    if (origin === 'created') {
      // 兜底:无本地副本时 id 本身就是公共条目 id
      const publicId = local?.publicId ?? id;
      if (!publicId) return { success: false, message: '本地无对应公共 ID,无法同步' };
      const previewToSubmit = payload.previews[0]?.startsWith('data:') ? payload.previews[0] : undefined;
      const result = await updatePublicArtist(publicId, {
        artist_string: payload.positive.trim(),
        negative: trimmedNegative ?? '',
        preview_base64: previewToSubmit,
      });
      if (!result.success) return { success: false, message: result.message };
      await loadPublicArtists(true);
      // 预览图 cache-busting:URL 不变但后端文件已替换,需要时间戳强制浏览器重新加载
      const cacheBust = Date.now();
      const bustUrl = (u: string) => u.startsWith('data:') ? u : `${u.split('?')[0]}?t=${cacheBust}`;
      setArtistPublicFiles(prev => prev.map(f => f.id === publicId ? {
        ...f,
        previews: f.previews.map(bustUrl),
      } : f));
      // 本地副本:有则原地更新,无则用 publicId 当本地 id 补建一份
      const updated: ArtistFile = {
        ...(local || {} as ArtistFile),
        id: local?.id ?? publicId,
        name: payload.name.trim(),
        prompt: payload.positive.trim(),
        negative: trimmedNegative,
        previews: payload.previews.map(bustUrl),
        tags: payload.tags || [],
        isLocal: true,
        origin: 'created',
        publicId,
      };
      await saveArtist({ ...updated, isLocal: true, origin: 'created', publicId, tags: payload.tags || [] });
      setArtistLocalFiles(prev => {
        const exists = prev.some(f => f.id === updated.id);
        return exists ? prev.map(f => f.id === updated.id ? updated : f) : [...prev, updated];
      });
      return { success: true };
    }

    // origin === 'local'
    if (!local) return { success: false, message: '本地无该画师串' };
    const updated: ArtistFile = {
      ...local,
      name: payload.name.trim(),
      prompt: payload.positive.trim(),
      negative: trimmedNegative,
      previews: payload.previews,
      tags: payload.tags || [],
    };
    await saveArtist({ ...updated, isLocal: true, origin: 'local', tags: payload.tags || [] });
    setArtistLocalFiles(prev => prev.map(f => f.id === id ? updated : f));
    return { success: true };
  };

  // --- Upload local artist to public ---
  const uploadToPublic = async (file: ArtistFile) => {
    if (!file.name || !file.prompt) return;
    const result = await createPublicArtist({
      name: file.name,
      artist_string: file.prompt,
      preview_base64: file.previews[0] || undefined,
      added_by: getPublicLibraryOwnerId(),
    });
    if (!result.success) {
      alert(`上传失败: ${result.message}`);
      return;
    }
    // 刷新公共列表
    await loadPublicArtists(true);
    // 将本地串标记为 created 并记录 publicId
    if (result.artist?.id) {
      const updated: ArtistFile = { ...file, origin: 'created', publicId: result.artist.id };
      await saveArtist({ ...updated, isLocal: true, origin: 'created', publicId: result.artist.id });
      setArtistLocalFiles(prev => prev.map(f => f.id === file.id ? updated : f));
    }
  };

  return {
    artistTab, setArtistTab,
    searchQuery, setSearchQuery,
    selectedArtistIds, 
    artistPublicFiles: filteredArtistPublicFiles, 
    artistLocalFiles: filteredArtistLocalFiles,
    isLoadingPublicArtists, editorArtistTags,
    artistUsageOrder, updateArtistUsageOrder,
    localArtistSource, setLocalArtistSource,
    artistTagPool, selectedTagFilter, setSelectedTagFilter, reloadArtistTagPool, saveArtistTags, saveArtistTagPool,
    artistPublicDisplayCount, setArtistPublicDisplayCount, artistLocalDisplayCount, isLoadingMoreArtists,
    artistPublicScrollRef, artistLocalScrollRef,
    artistPublicScrollTopRef, artistLocalScrollTopRef,
    handleArtistScroll,
    toggleArtistSelection, handleClearArtistSelection,
    isCreatingArtist, setIsCreatingArtist, editingArtistId,
    newArtistName, setNewArtistName, newArtistPrompt,
    newArtistPreviews, setNewArtistPreviews, newArtistTags, setNewArtistTags, selectedArtistCoverIndex, setSelectedArtistCoverIndex,
    isGeneratingArtistPreviews, artistPreviewProgress,
    copiedArtistId, setCopiedArtistId, savedArtistId, setSavedArtistId,
    isSavingArtist,
    loadPublicArtists, loadLocalArtists, openArtistDetail, openCreateArtist,
    handleArtistPromptChange,
    handleGenerateSingleArtistPreview, handleRegenerateArtistPreviewAt,
    handleRegenerateAllArtistPreviews, handleGenerateArtistPreview,
    handleSaveArtist, saveArtistFromPayload, updateArtistFromPayload, generatePreviewBase64, handleDeleteArtist,
    handleTagsChange, savePublicToLocal,
    unfavoriteArtist, createLocalCopy, forkArtistToLocal,
    unpublishArtist, deletePublicArtistTotally, uploadToPublic,
  };
}
