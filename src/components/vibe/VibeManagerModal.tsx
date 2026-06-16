import React, { useState, useRef, useEffect, useCallback, useMemo, startTransition } from 'react';
import {
  Settings2, Upload, Edit2, Plus, X, RotateCcw, File, Globe, HardDrive,
  Trash2, Loader2, RefreshCw, Download, Search,
  Heart, MoreVertical, Cloud, CloudOff, Clock, ListFilter, Package, Tag,
  Settings, Check
} from 'lucide-react';
import { VibeCard } from './VibeCard';
import { PublicVibeManagerModal } from './PublicVibeManagerModal';
import { type VibeFile, type ActiveVibe, MODEL_MAP, MODEL_TO_ENCODING_KEY, isVibeCompatibleWithModelId } from './types';
import {
  saveVibe, getVibes, deleteVibe, type VibeData,
  createVibeFromImage, importVibeFromFile, importVibeBundleFromFile, exportVibeToFile, exportVibesToBundle,
  getVibeTagPool, saveVibeTagPool, setVibeTags as setVibeTagsStorage, renameVibeTag, deleteVibeTag,
  migrateFavoritedToTag, syncVibesFromCloud, pushAllToCloud, SyncProtocolMismatchError,
  getRecentVibeEntries, recordVibeUsageBatch, clearRecentVibeEntries, removeRecentVibeEntry, type RecentVibeEntry,
} from '../../services/localLibrary';
import { getBackendUrl } from '../../utils/apiConfig';
import {
  getPublicVibes, getPublicVibeFile, deletePublicVibe, uploadVibeToPublic,
  getPublicLibraryOwnerId,
} from '../../services/publicLibrary';
import {
  deleteCloudVibe, addCloudTombstone, putCloudTagPool,
} from '../../services/botService';
import { CloudManageModal } from './CloudManageModal';
import { encodeVibeImage } from '../../services/novelai';
import { useConfirm } from '../tag-manager/parts/useConfirm';

// ─── 模块级状态：跨 modal 卸载/重挂载存活，用于还原滚动位置和无限滚动累计数 ──
let savedPublicScrollTop = 0;
let savedLocalScrollTop = 0;
let savedVisiblePublicCount = 20;

// ─── Internal types ───────────────────────────────────────────────────────────

/** 一条待导入的 vibe 配置（多 vibe 导入面板使用） */
interface ImportItem {
  uid: string;            // 仅前端 React key 用
  vibeData: VibeData;     // 已解析、未入库
  name: string;
  strength: number;
  infoExtracted: number;
  tags: Set<string>;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VibeManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedModelId: string;
  /** IDs of currently active vibes (used to initialize selection on open) */
  activeVibeIds: string[];
  /** Called when user confirms selection; parent builds ActiveVibes from this */
  onConfirmSelection: (selectedIds: string[], allFiles: VibeFile[]) => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const VibeManagerModal: React.FC<VibeManagerModalProps> = ({
  isOpen,
  onClose,
  selectedModelId,
  activeVibeIds,
  onConfirmSelection,
  showToast,
}) => {
  // 二次确认弹窗（用于破坏性操作，如删除 vibe）
  // 注意：故意命名为 confirmAction 以避免与全局 window.confirm 冲突
  const { confirm: confirmAction, confirmDialog } = useConfirm();

  // ── Tab / search / filter ────────────────────────────────────────────────

  const [vibeTab, setVibeTab] = useState<'public' | 'local'>(() => {
    try {
      const saved = localStorage.getItem('vibe_tab');
      return (saved === 'public' || saved === 'local') ? saved : 'public';
    } catch { return 'public'; }
  });

  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  // 最近使用记录（含 id + 快照）— 由外部 useEffect 也可能写入 localStorage
  const [recentEntries, setRecentEntries] = useState<RecentVibeEntry[]>(() => getRecentVibeEntries());

  /** 在本组件内追加 vibe 到最近使用：写 localStorage + 同步本地 state */
  const bumpRecentUsage = useCallback((vibes: Array<{ id: string; name?: string; preview?: string }>) => {
    if (!vibes.length) return;
    recordVibeUsageBatch(vibes);
    setRecentEntries(getRecentVibeEntries());
  }, []);

  const [vibeSearchQuery, setVibeSearchQuery] = useState('');
  const [vibeModelFilter, setVibeModelFilter] = useState<string>('all');

  // 标签筛选：选中的标签集合（空集 = 显示全部）
  const [selectedTagFilter, setSelectedTagFilter] = useState<Set<string>>(new Set());
  // 标签池：所有可用的标签
  const [tagPool, setTagPool] = useState<string[]>([]);
  // 给单个 vibe 编辑标签的弹层目标
  const [tagEditorTarget, setTagEditorTarget] = useState<{ vibeId: string; current: Set<string> } | null>(null);
  const [tagEditorNewName, setTagEditorNewName] = useState('');

  // 标签设置面板（管理标签池本身：新建/重命名/删除）
  const [tagSettingsOpen, setTagSettingsOpen] = useState(false);
  const [tagSettingsEditing, setTagSettingsEditing] = useState<string | null>(null);
  const [tagSettingsEditDraft, setTagSettingsEditDraft] = useState('');
  const [tagSettingsNewName, setTagSettingsNewName] = useState('');
  const [tagSettingsCreating, setTagSettingsCreating] = useState(false);

  // 公共 Vibe 管理面板（仅管理"我上传的"）
  const [publicVibeManagerOpen, setPublicVibeManagerOpen] = useState(false);
  // 批量编辑标签
  const [batchTagEditorOpen, setBatchTagEditorOpen] = useState(false);
  const [batchTagsToAdd, setBatchTagsToAdd] = useState<Set<string>>(new Set());
  const [batchNewTagCreating, setBatchNewTagCreating] = useState(false);
  const [batchNewTagName, setBatchNewTagName] = useState('');

  // 云同步状态(保留用于遮罩显示)
  // 云端管理弹窗
  const [cloudManageOpen, setCloudManageOpen] = useState(false);
  const currentBotUserId = useMemo(() => getPublicLibraryOwnerId(), [isOpen]);

  // Persist tab
  useEffect(() => {
    try { localStorage.setItem('vibe_tab', vibeTab); } catch { }
  }, [vibeTab]);
  // recentEntries 由 storage helper 负责写 localStorage，这里不再单独 persist

  // Snapshot selection when modal opens
  useEffect(() => {
    if (isOpen) {
      setSelectedVibes([...activeVibeIds]);
    }
  }, [isOpen]);

  // ── File lists ───────────────────────────────────────────────────────────

  const [publicFiles, setPublicFiles] = useState<VibeFile[]>([]);
  const [localFiles, setLocalFiles] = useState<VibeFile[]>([]);
  const [isLoadingPublicVibes, setIsLoadingPublicVibes] = useState(false);

  const [visiblePublicVibeCount, setVisiblePublicVibeCount] = useState(savedVisiblePublicCount);
  const publicVibeEndRef = useRef<HTMLDivElement>(null);
  // 两个 tab 的滚动容器
  const publicScrollRef = useRef<HTMLDivElement>(null);
  const localScrollRef = useRef<HTMLDivElement>(null);

  // 把累计的可见数量同步到模块级缓存，下次打开 modal 直接用
  useEffect(() => {
    savedVisiblePublicCount = visiblePublicVibeCount;
  }, [visiblePublicVibeCount]);

  // modal 重新挂载 / tab 切换 / 列表加载完成后，把上次的 scrollTop 还原回容器
  // 依赖 publicFiles.length / localFiles.length：异步 fetch 完成后再还原一次，
  // 否则首次打开时容器内容为空、scrollTop 写入会被 clamp 到 0
  useEffect(() => {
    if (!isOpen) return;
    const ref = vibeTab === 'public' ? publicScrollRef : localScrollRef;
    const saved = vibeTab === 'public' ? savedPublicScrollTop : savedLocalScrollTop;
    if (saved <= 0) return;
    const id = requestAnimationFrame(() => {
      if (ref.current) ref.current.scrollTop = saved;
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, vibeTab, publicFiles.length, localFiles.length]);

  // Infinite scroll for public vibes — fixed: added dependency array
  useEffect(() => {
    const el = publicVibeEndRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisiblePublicVibeCount(prev => prev + 20);
      }
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [publicFiles, vibeSearchQuery, vibeModelFilter]);

  // ── Action state ─────────────────────────────────────────────────────────

  const [downloadingVibeIds, setDownloadingVibeIds] = useState<Set<string>>(new Set());
  const [savingVibeIds, setSavingVibeIds] = useState<Set<string>>(new Set());
  const [uploadingVibeIds, setUploadingVibeIds] = useState<Set<string>>(new Set());
  const [vibeMenuOpenId, setVibeMenuOpenId] = useState<string | null>(null);

  // 重新加载标签池（当 localFiles 变化或 tagPool 变化时）
  const reloadTagPool = useCallback(async () => {
    const pool = await getVibeTagPool();
    setTagPool(pool);
  }, []);

  // ── Sub-dialog state ─────────────────────────────────────────────────────

  const [editingVibeDefaults, setEditingVibeDefaults] = useState<{
    vibeId: string; name: string; editName: string; strength: number; infoExtracted: number;
    tags: Set<string>;
  } | null>(null);

  // 多 vibe 导入配置面板 — items 非 null 即面板打开
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null);
  // 单 vibe 卡片新建标签输入框（按 uid 隔离）
  const [importItemNewTagDraft, setImportItemNewTagDraft] = useState<Record<string, string>>({});

  const [vibeUploadTarget, setVibeUploadTarget] = useState<VibeFile | null>(null);
  const [vibeUploadName, setVibeUploadName] = useState('');
  const [vibeUploadStrength, setVibeUploadStrength] = useState(1);
  const [vibeUploadInfoExtracted, setVibeUploadInfoExtracted] = useState(1);

  const inputRef = useRef<HTMLInputElement>(null);

  // ── Filtered / sorted lists ──────────────────────────────────────────────

  const filteredPublicFiles = useMemo(() => {
    let files = publicFiles;
    if (vibeSearchQuery.trim()) {
      const q = vibeSearchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (vibeModelFilter !== 'all') {
      files = files.filter(f => f.supportedModels?.includes(vibeModelFilter));
    }
    return files;
  }, [publicFiles, vibeSearchQuery, vibeModelFilter]);

  const filteredLocalFiles = useMemo(() => {
    let files = localFiles;
    if (vibeSearchQuery.trim()) {
      const q = vibeSearchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (vibeModelFilter !== 'all') {
      files = files.filter(f => f.supportedModels?.includes(vibeModelFilter));
    }
    return files;
  }, [localFiles, vibeSearchQuery, vibeModelFilter]);

  // 在 filteredLocalFiles 之上再应用标签筛选（用户选中标签的并集）
  const tagFilteredLocalFiles = useMemo(() => {
    if (selectedTagFilter.size === 0) return filteredLocalFiles;
    return filteredLocalFiles.filter(f => {
      const tags = f.tags || [];
      return tags.some(t => selectedTagFilter.has(t));
    });
  }, [filteredLocalFiles, selectedTagFilter]);

  // 当前用户在公共库的上传数量
  const myPublicUploadsCount = useMemo(() => {
    if (!currentBotUserId) return 0;
    return publicFiles.filter(f => f.uploaderId === currentBotUserId).length;
  }, [publicFiles, currentBotUserId]);

  // 每个标签被多少个 vibe 使用（用于标签设置面板的统计列）
  const tagUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of localFiles) {
      if (v.tags) {
        for (const t of v.tags) {
          counts.set(t, (counts.get(t) || 0) + 1);
        }
      }
    }
    return counts;
  }, [localFiles]);

  // ── Load functions ───────────────────────────────────────────────────────

  const loadLocalVibes = async () => {
    try {
      const savedVibes = await getVibes();
      const vibeFiles: VibeFile[] = savedVibes.map(v => ({
        id: v.id, name: v.name, size: v.size, preview: v.preview, image: v.image,
        encodings: v.encodings, defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels,
        createdAt: v.createdAt,
        tags: v.tags,
        cloudSync: v.cloudSync,
        cloudFilename: v.cloudFilename,
      }));
      setLocalFiles(vibeFiles);
    } catch (err) {
      console.error("Error loading local vibes:", err);
    }
  };

  const loadPublicVibes = async (forceRefresh = false) => {
    setIsLoadingPublicVibes(true);
    try {
      const vibes = await getPublicVibes(forceRefresh);
      const backendUrl = getBackendUrl();
      const vibeFiles: VibeFile[] = vibes.map(v => ({
        id: v.id || v.filename || `vibe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: v.name, size: '',
        preview: v.thumbnail ? (v.thumbnail.startsWith('/') ? `${backendUrl}${v.thumbnail}` : v.thumbnail) : '',
        supportedModels: v.supportedModels, defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted, fileName: v.filename, hasImage: v.hasImage,
        uploaderId: v.uploaderId,
      }));
      // 用 transition 包裹大列表更新，让用户的 tab 切换/点击保持响应
      startTransition(() => {
        setPublicFiles(vibeFiles);
        // 不再每次刷新清回 20；保留上次累计的数量，仅当总数缩水时 clamp
        setVisiblePublicVibeCount(prev => Math.max(20, Math.min(prev, vibeFiles.length || 20)));
      });
    } catch (err) {
      console.error('Failed to load public vibes:', err);
      setPublicFiles([]);
    } finally {
      setIsLoadingPublicVibes(false);
    }
  };

  // Load every time modal opens (force refresh public vibes + tags + sync from cloud)
  useEffect(() => {
    if (isOpen) {
      // 一次性迁移收藏
      migrateFavoritedToTag().then(() => reloadTagPool());
      loadLocalVibes();
      loadPublicVibes(true);
      // 重新读取最近使用 — 捕获外部入口（管理器外）的写入
      setRecentEntries(getRecentVibeEntries());
      // 云同步状态初始化（不自动触发，等用户手动点击）
    }
  }, [isOpen]);

  // (onboarding handlers removed — 手动上传/恢复已取代引导流程)
  {
  }
  // ── Selection ────────────────────────────────────────────────────────────

  const toggleVibeSelection = (id: string) => {
    if (selectedVibes.includes(id)) {
      setSelectedVibes(prev => prev.filter(v => v !== id));
      return;
    }
    setSelectedVibes(prev => [...prev, id]);
  };


  const isVibeInLocal = useCallback((vibeId: string) => {
    return localFiles.some(lf => lf.id === vibeId);
  }, [localFiles]);

  const isVibeInPublic = useCallback((vibeId: string) => {
    return publicFiles.some(pf => pf.id === vibeId);
  }, [publicFiles]);

  // ── CRUD handlers ────────────────────────────────────────────────────────

  const handleSaveVibeToLocal = async (file: VibeFile) => {
    if (isVibeInLocal(file.id) || savingVibeIds.has(file.id)) return;
    setSavingVibeIds(prev => new Set(prev).add(file.id));
    try {
      const fileName = file.fileName || `${file.name}.naiv4vibe`;
      const fullData = await getPublicVibeFile(fileName);
      if (!fullData) { showToast('获取Vibe数据失败', 'error'); return; }
      const supportedModels = fullData.encodings ? Object.keys(fullData.encodings as Record<string, unknown>) : [];
      const vibeData: VibeData = {
        id: (fullData.id as string) || file.id,
        name: (fullData.name as string) || file.name,
        size: '',
        preview: (fullData.thumbnail as string) || file.preview || '',
        image: (fullData.image as string) || '',
        encodings: (fullData.encodings as VibeData['encodings']) || {},
        createdAt: Date.now(),
        defaultStrength: (fullData.importInfo as any)?.strength ?? file.defaultStrength,
        defaultInfoExtracted: (fullData.importInfo as any)?.information_extracted ?? file.defaultInfoExtracted,
        supportedModels,
        tags: ['收藏'],  // 自动打"收藏"标签
        cloudSync: 'none',
      };
      const saved = await saveVibe(vibeData);
      // 后台尝试推送到云端（若已 Bot 授权）
      if (currentBotUserId) {
      }
      await loadLocalVibes();
      await reloadTagPool();
      showToast('已收藏到我的Vibe', 'success');
    } catch (err) {
      console.error('收藏Vibe失败:', err);
      showToast('收藏失败', 'error');
    } finally {
      setSavingVibeIds(prev => { const n = new Set(prev); n.delete(file.id); return n; });
    }
  };

  const handleDeleteVibeFile = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const target = localFiles.find(f => f.id === id);
    const ok = await confirmAction({
      title: '删除 Vibe',
      message: target?.name
        ? `确定要删除 "${target.name}" 吗？此操作不可恢复。`
        : '确定要删除此 Vibe 吗？此操作不可恢复。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteVibe(id);
      setLocalFiles(prev => prev.filter(f => f.id !== id));
      if (selectedVibes.includes(id)) {
        setSelectedVibes(prev => prev.filter(vId => vId !== id));
      }
      // 同步从最近使用列表移除，避免幽灵条目
      removeRecentVibeEntry(id);
      setRecentEntries(getRecentVibeEntries());
    } catch (error) {
      console.error("Failed to delete vibe:", error);
    }
  };

  const handleDownloadVibe = async (vibeFile: VibeFile) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(v => v.id === vibeFile.id);
      if (vibe) {
        const blob = await exportVibeToFile(vibe, vibe.defaultStrength, vibe.defaultInfoExtracted, undefined, true);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${vibe.name}.naiv4vibe`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('下载vibe失败:', err);
      showToast('下载失败', 'error');
    }
  };

  const handleRemoveFromPublic = async (vibeFile: VibeFile) => {
    const publicFile = publicFiles.find(pf => pf.id === vibeFile.id);
    if (!publicFile) { showToast('未在公共Vibe中找到匹配', 'error'); return; }
    const filename = publicFile.fileName || `${publicFile.name}.naiv4vibe`;
    if (!confirm('确定从公共Vibe撤回吗？')) return;
    try {
      const result = await deletePublicVibe(filename);
      if (result.success) {
        setPublicFiles(prev => prev.filter(f => f.id !== publicFile.id));
        showToast('已从公共Vibe撤回', 'success');
      } else {
        showToast(result.message || '撤回失败', 'error');
      }
    } catch (err) {
      console.error('撤回失败:', err);
      showToast('撤回失败', 'error');
    }
  };

  const saveVibeEdit = async (vibeId: string, editName: string, strength: number, infoExtracted: number) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(v => v.id === vibeId);
      if (vibe) {
        const newName = editName.trim();
        if (newName) vibe.name = newName;
        vibe.defaultStrength = strength;
        vibe.defaultInfoExtracted = infoExtracted;
        await saveVibe(vibe);
        loadLocalVibes();
        // 同步到云端
        if (currentBotUserId) {
        }
      }
      setEditingVibeDefaults(null);
      showToast('已保存', 'success');
    } catch (err) {
      console.error('保存失败:', err);
      showToast('保存失败', 'error');
    }
  };

  // ── File upload (inside modal) ───────────────────────────────────────────

  /** 解析单个 .naiv4vibe / 图片文件 → VibeData（不入库）。返回 null 表示不支持的类型。 */
  const parseFileToVibeData = async (file: File): Promise<VibeData | null> => {
    if (file.name.endsWith('.naiv4vibe')) {
      const content = await file.text();
      const naiv4vibe = JSON.parse(content);
      if (naiv4vibe.identifier !== 'novelai-vibe-transfer') throw new Error('无效的 vibe 文件格式');
      const supportedModels = naiv4vibe.encodings ? Object.keys(naiv4vibe.encodings) : [];
      return {
        id: naiv4vibe.id || Date.now().toString(),
        name: naiv4vibe.name || file.name.replace('.naiv4vibe', ''),
        size: (content.length / 1024 / 1024).toFixed(2) + ' MB',
        preview: naiv4vibe.thumbnail || '',
        image: naiv4vibe.image || '',
        encodings: naiv4vibe.encodings || {},
        createdAt: naiv4vibe.createdAt || Date.now(),
        defaultStrength: naiv4vibe.importInfo?.strength,
        defaultInfoExtracted: naiv4vibe.importInfo?.information_extracted,
        supportedModels,
        tags: naiv4vibe.tags || [],
      };
    }
    if (file.type.startsWith('image/')) {
      const size = (file.size / 1024 / 1024).toFixed(2) + ' MB';
      const arrayBuffer = await file.arrayBuffer();
      const imageBase64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      const thumbnail = await new Promise<string>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const maxSize = 256;
          let w = img.width, h = img.height;
          if (w > h) { if (w > maxSize) { h = (h * maxSize) / w; w = maxSize; } }
          else { if (h > maxSize) { w = (w * maxSize) / h; h = maxSize; } }
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        };
        img.onerror = () => resolve('');
        img.src = URL.createObjectURL(file);
      });
      const simpleHash = (str: string): string => {
        let hash = 0;
        for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash = hash & hash; }
        return Math.abs(hash).toString(16).padStart(8, '0') + Date.now().toString(16);
      };
      const id = typeof crypto !== 'undefined' && crypto.subtle
        ? await crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageBase64)).then(buf =>
          Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
        ).catch(() => simpleHash(imageBase64))
        : simpleHash(imageBase64);
      return { id, name: file.name.replace(/\.[^/.]+$/, ''), size, preview: thumbnail, image: imageBase64, encodings: {}, createdAt: Date.now() };
    }
    return null;
  };

  /** 把单个 vibebundle 文件解包并入库（共享：单/多文件路径都用） */
  const importBundleFile = async (file: File): Promise<number> => {
    const savedVibes = await importVibeBundleFromFile(file);
    const newFiles: VibeFile[] = savedVibes.map(v => ({
      id: v.id, name: v.name, size: v.size, preview: v.preview, image: v.image,
      encodings: v.encodings, defaultStrength: v.defaultStrength,
      defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels,
      tags: v.tags,
    }));
    setLocalFiles(prev => [...newFiles, ...prev]);
    setSelectedVibes(prev => [...prev, ...savedVibes.map(v => v.id)]);
    bumpRecentUsage(savedVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview })));
    if (currentBotUserId) {
      savedVibes.forEach(v => {
      });
    }
    return savedVibes.length;
  };

  /** 直接保存一个已解析的 vibeData 到 IndexedDB（用于多文件批量场景，跳过重命名对话框） */
  const saveVibeDataDirect = async (vibeData: VibeData): Promise<void> => {
    const savedVibe = await saveVibe(vibeData);
    const newFile: VibeFile = {
      id: savedVibe.id, name: savedVibe.name, size: savedVibe.size,
      preview: savedVibe.preview, image: savedVibe.image, encodings: savedVibe.encodings,
      defaultStrength: savedVibe.defaultStrength, defaultInfoExtracted: savedVibe.defaultInfoExtracted,
      supportedModels: savedVibe.supportedModels, tags: savedVibe.tags,
    };
    setLocalFiles(prev => [newFile, ...prev]);
    setSelectedVibes(prev => [...prev, newFile.id]);
    bumpRecentUsage([{ id: newFile.id, name: newFile.name, preview: newFile.preview }]);
    if (currentBotUserId) {
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (event.target) event.target.value = '';
    if (files.length === 0) return;

    // 1) Bundle 文件直接入库（已有完整配置），不进配置面板
    // 2) 普通 .naiv4vibe / 图片 → 解析后送入配置面板
    const items: ImportItem[] = [];
    let bundleImported = 0;
    let parseFailed = 0;
    let unsupported = 0;

    for (const file of files) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          bundleImported += await importBundleFile(file);
          continue;
        }
        const vibeData = await parseFileToVibeData(file);
        if (!vibeData) {
          unsupported++;
          continue;
        }
        items.push({
          uid: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${items.length}`,
          vibeData,
          name: vibeData.name,
          strength: vibeData.defaultStrength ?? 0.5,
          infoExtracted: vibeData.defaultInfoExtracted ?? 1,
          tags: new Set(vibeData.tags || []),
        });
      } catch (err) {
        console.error(`解析 ${file.name} 失败:`, err);
        parseFailed++;
      }
    }

    if (bundleImported > 0) {
      showToast(`已导入 ${bundleImported} 个 Vibe (来自 bundle)`, 'success');
    }
    if (parseFailed > 0) {
      showToast(`${parseFailed} 个文件解析失败`, 'error');
    }
    if (unsupported > 0 && items.length === 0 && bundleImported === 0) {
      alert('请上传图片文件、.naiv4vibe 或 .naiv4vibebundle 文件');
      return;
    }

    if (items.length > 0) {
      setImportItemNewTagDraft({});
      setImportItems(items);
    }
  };

  /** 确认多 vibe 导入：循环 importItems，每个 vibe 使用其独立配置入库 */
  const confirmVibeImport = async () => {
    if (!importItems || importItems.length === 0) return;
    const items = importItems;
    setImportItems(null);
    setImportItemNewTagDraft({});

    let imported = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const finalName = item.name.trim() || item.vibeData.name;
        const merged: VibeData = {
          ...item.vibeData,
          name: finalName,
          defaultStrength: item.strength,
          defaultInfoExtracted: item.infoExtracted,
          tags: Array.from(item.tags),
        };
        await saveVibeDataDirect(merged);
        imported++;
      } catch (err) {
        console.error('导入失败:', err);
        failed++;
      }
    }
    await reloadTagPool();
    showToast(
      failed > 0
        ? `已导入 ${imported}，${failed} 个失败`
        : `已成功导入 ${imported} 个 Vibe`,
      failed > 0 ? 'error' : 'success'
    );
  };

  /** 给单个 item 切换某个标签 */
  const toggleItemTag = (uid: string, tag: string) => {
    setImportItems(items => items?.map(it => {
      if (it.uid !== uid) return it;
      const next = new Set(it.tags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...it, tags: next };
    }) || null);
  };

  /** 给单个 item 添加一个新标签（同时加进 tagPool） */
  const addNewTagToItem = (uid: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setImportItems(items => items?.map(it => {
      if (it.uid !== uid) return it;
      const next = new Set(it.tags);
      next.add(trimmed);
      return { ...it, tags: next };
    }) || null);
    if (!tagPool.includes(trimmed)) {
      const merged = [...tagPool, trimmed].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      setTagPool(merged);
      saveVibeTagPool(merged);
    }
  };


  // ── Upload to public ─────────────────────────────────────────────────────

  const handleUploadVibeToPublic = (vibeFile: VibeFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (uploadingVibeIds.has(vibeFile.id)) return;
    setVibeUploadTarget(vibeFile);
    setVibeUploadName('');
    setVibeUploadStrength(vibeFile.defaultStrength ?? 1);
    setVibeUploadInfoExtracted(vibeFile.defaultInfoExtracted ?? 1);
  };

  const confirmUploadVibeToPublic = async () => {
    const vibeFile = vibeUploadTarget;
    if (!vibeFile || !vibeUploadName.trim()) return;
    setVibeUploadTarget(null);
    try {
      setUploadingVibeIds(prev => new Set(prev).add(vibeFile.id));
      let fullVibeData: Record<string, unknown> | null = null;

      const vibes = await getVibes();
      const vibe = vibes.find(v => v.id === vibeFile.id);
      if (vibe) {
        fullVibeData = {
          identifier: "novelai-vibe-transfer", version: 1, type: "image",
          id: vibe.id, name: vibe.name, image: vibe.image, thumbnail: vibe.preview,
          encodings: vibe.encodings, createdAt: vibe.createdAt,
          importInfo: { strength: vibeUploadStrength, information_extracted: vibeUploadInfoExtracted },
        };
      }

      if (!fullVibeData) { showToast('无法获取vibe数据', 'error'); return; }

      // Auto pre-encode
      const imageData = (fullVibeData as any).image as string | undefined;
      if (imageData) {
        const { computeVibeEncodingHash } = await import('../../services/localLibrary');
        const targetIE = vibeUploadInfoExtracted;
        const modelsToEncode = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'];
        const modelKeyMap: Record<string, string> = {
          'nai-diffusion-4-5-full': 'v4-5full', 'nai-diffusion-4-5-curated': 'v4-5curated',
        };
        const encodings = ((fullVibeData as any).encodings || {}) as Record<string, Record<string, any>>;
        for (const model of modelsToEncode) {
          const modelKey = modelKeyMap[model];
          const modelEncodings = encodings[modelKey] || {};
          let hasEncoding = false;
          for (const entry of Object.values(modelEncodings)) {
            if (entry?.params && Math.abs(entry.params.information_extracted - targetIE) < 0.001) {
              hasEncoding = true; break;
            }
          }
          if (!hasEncoding) {
            showToast(`正在为 ${modelKey} 预编码 (IE=${targetIE})...`, 'success');
            try {
              const encoded = await encodeVibeImage(imageData, targetIE, model);
              if (encoded) {
                const hashKey = await computeVibeEncodingHash(targetIE);
                if (!encodings[modelKey]) encodings[modelKey] = {};
                encodings[modelKey][hashKey] = { encoding: encoded, params: { information_extracted: targetIE } };
              }
            } catch (err) { console.warn(`[上传预编码] ${modelKey} 编码失败:`, err); }
          }
        }
        (fullVibeData as any).encodings = encodings;
      }

      const result = await uploadVibeToPublic(fullVibeData, vibeUploadName.trim());
      showToast(result.message, result.success ? 'success' : 'error');
      if (result.success) loadPublicVibes();
    } catch (error) {
      console.error('上传vibe失败:', error);
      showToast('上传失败：' + (error instanceof Error ? error.message : '未知错误'), 'error');
    } finally {
      setUploadingVibeIds(prev => { const n = new Set(prev); n.delete(vibeFile.id); return n; });
    }
  };

  // ── Drag-drop on modal ───────────────────────────────────────────────────

  const handleModalDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files);
    const pushIfAuthed = (id: string) => {
      if (currentBotUserId) {
      }
    };
    for (const file of files) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          const savedVibes = await importVibeBundleFromFile(file);
          const newFiles: VibeFile[] = savedVibes.map(v => ({
            id: v.id, name: v.name, size: v.size, preview: v.preview, image: v.image,
            encodings: v.encodings, defaultStrength: v.defaultStrength,
            defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels,
          }));
          setLocalFiles(prev => [...newFiles, ...prev]);
          setSelectedVibes(prev => [...prev, ...savedVibes.map(v => v.id)]);
          bumpRecentUsage(savedVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview })));
          savedVibes.forEach(v => pushIfAuthed(v.id));
          showToast(`成功导入 ${savedVibes.length} 个 Vibe`, 'success');
        } else if (file.name.endsWith('.naiv4vibe')) {
          const savedVibe = await importVibeFromFile(file);
          const newFile: VibeFile = {
            id: savedVibe.id, name: savedVibe.name, size: savedVibe.size,
            preview: savedVibe.preview, image: savedVibe.image, encodings: savedVibe.encodings,
            defaultStrength: savedVibe.defaultStrength, defaultInfoExtracted: savedVibe.defaultInfoExtracted,
            supportedModels: savedVibe.supportedModels,
          };
          setLocalFiles(prev => [newFile, ...prev]);
          setSelectedVibes(prev => [...prev, savedVibe.id]);
          bumpRecentUsage([{ id: savedVibe.id, name: savedVibe.name, preview: savedVibe.preview }]);
          pushIfAuthed(savedVibe.id);
          showToast('成功导入 Vibe', 'success');
        } else if (file.type.startsWith('image/')) {
          const savedVibe = await createVibeFromImage(file);
          const newFile: VibeFile = {
            id: savedVibe.id, name: savedVibe.name, size: savedVibe.size,
            preview: savedVibe.preview, image: savedVibe.image, encodings: savedVibe.encodings,
            defaultStrength: savedVibe.defaultStrength, defaultInfoExtracted: savedVibe.defaultInfoExtracted,
            supportedModels: savedVibe.supportedModels,
          };
          setLocalFiles(prev => [newFile, ...prev]);
          setSelectedVibes(prev => [...prev, savedVibe.id]);
          bumpRecentUsage([{ id: savedVibe.id, name: savedVibe.name, preview: savedVibe.preview }]);
          pushIfAuthed(savedVibe.id);
          showToast('成功导入图片为 Vibe', 'success');
        }
      } catch (error) {
        console.error('Failed to import vibe:', error);
        showToast('导入失败: ' + (error as Error).message, 'error');
      }
    }
  };

  // ── Batch operations ──────────────────────────────────────────────────────

  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const handleBatchDelete = async () => {
    const localSelected = selectedVibes.filter(id => localFiles.some(f => f.id === id));
    if (localSelected.length === 0) {
      showToast('没有选中本地 Vibe', 'error');
      return;
    }
    const ok = await confirmAction({
      title: '批量删除',
      message: `确定要删除选中的 ${localSelected.length} 个 Vibe 吗？此操作不可恢复。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    setIsBatchDeleting(true);
    let deleted = 0;
    for (const id of localSelected) {
      try {
        await deleteVibe(id);
        removeRecentVibeEntry(id);
        deleted++;
      } catch (err) {
        console.error(`删除 vibe ${id} 失败:`, err);
      }
    }
    setSelectedVibes(prev => prev.filter(id => !localSelected.includes(id)));
    await loadLocalVibes();
    await reloadTagPool();
    setRecentEntries(getRecentVibeEntries());
    showToast(`已删除 ${deleted} 个 Vibe`, 'success');
    setIsBatchDeleting(false);
  };

  const handleBatchBundleDownload = async () => {
    const localSelected = selectedVibes.filter(id => localFiles.some(f => f.id === id));
    if (localSelected.length === 0) {
      showToast('没有选中本地 Vibe', 'error');
      return;
    }
    try {
      const blob = await exportVibesToBundle(localSelected);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `vibes_${localSelected.length}个_${new Date().toISOString().slice(0, 10)}.naiv4vibebundle`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`已打包 ${localSelected.length} 个 Vibe`, 'success');
    } catch (err) {
      console.error('打包下载失败:', err);
      showToast('打包失败: ' + (err as Error).message, 'error');
    }
  };

  // ── Confirm / close ──────────────────────────────────────────────────────

  const handleConfirmSelection = () => {
    const allFiles = [...publicFiles, ...localFiles];
    // Update usage order only on confirm — track all selected vibes (public + local)
    if (selectedVibes.length > 0) {
      const snapshots = selectedVibes
        .map(id => allFiles.find(f => f.id === id))
        .filter(Boolean)
        .map(f => ({ id: f!.id, name: f!.name, preview: f!.preview }));
      bumpRecentUsage(snapshots);
    }
    onConfirmSelection(selectedVibes, allFiles);
  };

  const handleClose = () => {
    onClose();
  };

  // ── Public vibe download handler ─────────────────────────────────────────

  const handlePublicVibeDownload = (file: VibeFile, e: React.MouseEvent) => {
    e.stopPropagation();
    const fileName = file.fileName || `${file.name}.naiv4vibe`;
    const backendUrl = getBackendUrl();

    const a = document.createElement('a');
    a.href = `${backendUrl}/api/vibes/download/${encodeURIComponent(fileName)}`;
    a.download = fileName;
    a.click();
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (!isOpen) return null;

  return (
    <>
      {/* Main Modal */}
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={handleClose}>
        <div
          className="relative bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[640px] h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
          onClick={(e) => e.stopPropagation()}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={handleModalDrop}
        >
          {/* Header */}
          <div className="p-4 border-b border-gray-800 flex items-center gap-3 bg-nai-dark/50">
            <div className="flex items-center gap-2 shrink-0">
              <Settings2 className="w-5 h-5 text-nai-accent" />
              <span className="font-bold text-white text-base">Vibe管理器</span>
            </div>
            <div className="flex-1 relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={vibeSearchQuery}
                onChange={(e) => { setVibeSearchQuery(e.target.value); setVisiblePublicVibeCount(20); }}
                placeholder="搜索..."
                className="w-full h-8 bg-gray-800/80 text-gray-200 text-sm rounded-lg pl-8 pr-7 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
              />
              {vibeSearchQuery && (
                <button onClick={() => setVibeSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input type="file" ref={inputRef} className="hidden" multiple onChange={handleFileUpload} accept="image/*,.naiv4vibe,.naiv4vibebundle" />
              {/* 云端数据管理 */}
              <button
                onClick={() => setCloudManageOpen(true)}
                className="h-8 w-8 rounded flex items-center justify-center transition-colors border bg-gray-800 border-gray-600 text-gray-400 hover:bg-gray-700 hover:text-nai-accent"
                title="云端数据管理"
              >
                <Cloud className="w-4 h-4" />
              </button>
              <button
                onClick={() => inputRef.current?.click()}
                className="h-8 px-3 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded flex items-center justify-center gap-1.5 transition-colors shadow-sm"
                title="添加文件（支持多选）"
              >
                <Plus className="w-4 h-4" />
                添加文件
              </button>
              <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-gray-800">
            <button
              className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'public'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
              onClick={() => setVibeTab('public')}
            >
              <div className="flex items-center justify-center gap-2">
                <Globe className="w-4 h-4" />
                公共 Vibe
                {isLoadingPublicVibes && <Loader2 className="w-3 h-3 animate-spin" />}
              </div>
            </button>
            <button
              className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'local'
                ? 'border-nai-accent text-white bg-white/5'
                : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-white/5'
                }`}
              onClick={() => setVibeTab('local')}
            >
              <div className="flex items-center justify-center gap-2">
                <HardDrive className="w-4 h-4" />
                我的Vibe
              </div>
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden bg-nai-dark/30 min-h-[400px] relative">
            {/* Public Vibe Tab */}
            <div
              ref={publicScrollRef}
              onScroll={(e) => { savedPublicScrollTop = e.currentTarget.scrollTop; }}
              className={`absolute inset-0 overflow-y-auto p-2 transition-transform duration-200 ease-out will-change-transform ${vibeTab === 'public'
                ? 'translate-x-0'
                : '-translate-x-full pointer-events-none'
                }`}
              style={vibeTab !== 'public' ? { contentVisibility: 'hidden' } : undefined}
            >
              {/* "管理我上传的"入口栏 */}
              <div className="mb-2 px-1 flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs text-gray-400">
                  <Globe className="w-3.5 h-3.5" />
                  <span className="font-bold">公共库</span>
                  <span className="text-gray-500">({publicFiles.length})</span>
                </div>
                <button
                  onClick={() => setPublicVibeManagerOpen(true)}
                  disabled={!currentBotUserId}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-nai-accent hover:border-nai-accent/50 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-300 disabled:hover:border-gray-700 disabled:hover:bg-gray-800"
                  title={currentBotUserId ? '管理我上传到公共库的 Vibe' : '需 Bot 授权'}
                >
                  <Settings className="w-3 h-3" />
                  管理我上传的
                  {currentBotUserId && (
                    <span className="text-nai-accent">({myPublicUploadsCount})</span>
                  )}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {filteredPublicFiles.slice(0, visiblePublicVibeCount).map((file) => {
                  const isSaved = isVibeInLocal(file.id);
                  const isMine = !!currentBotUserId && file.uploaderId === currentBotUserId;
                  return (
                    <VibeCard
                      key={file.id}
                      file={file}
                      isSelected={selectedVibes.includes(file.id)}
                      selectedModelId={selectedModelId}
                      onClick={() => toggleVibeSelection(file.id)}
                      tagPrefix={isMine ? <span className="text-nai-accent" title="我上传的"><Cloud className="w-3.5 h-3.5" /></span> : undefined}
                      actions={
                        <>
                          <button
                            disabled={savingVibeIds.has(file.id)}
                            onClick={(e) => { e.stopPropagation(); handleSaveVibeToLocal(file); }}
                            className={`p-2 rounded transition-colors ${savingVibeIds.has(file.id) ? 'text-gray-500' : 'text-gray-400 hover:text-pink-400 hover:bg-white/10'}`}
                            title="收藏到我的Vibe"
                          >
                            {savingVibeIds.has(file.id) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Heart className="w-5 h-5" />}
                          </button>
                          <button
                            disabled={downloadingVibeIds.has(file.id)}
                            onClick={(e) => handlePublicVibeDownload(file, e)}
                            className="p-2 text-gray-400 hover:text-nai-accent rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                            title="下载"
                          >
                            {downloadingVibeIds.has(file.id) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                          </button>
                        </>
                      }
                    />
                  );
                })}
                {visiblePublicVibeCount < filteredPublicFiles.length && (
                  <div ref={publicVibeEndRef} className="py-2 text-center text-xs text-gray-500">加载更多...</div>
                )}
              </div>

              {filteredPublicFiles.length === 0 && publicFiles.length > 0 && (vibeSearchQuery.trim() || vibeModelFilter !== 'all') && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                  <File className="w-10 h-10 mb-2 opacity-20" />
                  <p className="text-sm">无搜索结果</p>
                </div>
              )}
              {publicFiles.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
                  <File className="w-10 h-10 mb-2 opacity-20" />
                  <p className="text-sm mb-3">未找到公共Vibe</p>
                  <button
                    onClick={() => loadPublicVibes(true)}
                    disabled={isLoadingPublicVibes}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs font-bold text-gray-300 hover:text-white transition-colors border border-gray-700"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingPublicVibes ? 'animate-spin' : ''}`} />
                    刷新
                  </button>
                </div>
              )}
            </div>

            {/* Local Vibe Tab */}
            <div
              ref={localScrollRef}
              onScroll={(e) => { savedLocalScrollTop = e.currentTarget.scrollTop; }}
              className={`absolute inset-0 overflow-y-scroll p-2 transition-transform duration-200 ease-out will-change-transform ${vibeTab === 'local'
                ? 'translate-x-0'
                : 'translate-x-full pointer-events-none'
                }`}
              style={vibeTab !== 'local' ? { contentVisibility: 'hidden' } : undefined}
            >
              {/* 最近使用区域 */}
              {recentEntries.length > 0 && (() => {
                // 只渲染在 localFiles 或 publicFiles 中真实存在的条目，
                // 幽灵条目（已被删除的源数据）在这里被过滤掉，避免后续操作失败
                // 只渲染一行能放下的数量（w-16=64px + gap-2=8px = 72px/个，容器约636px → 8个）
                const recentVibes: VibeFile[] = [];
                for (const entry of recentEntries) {
                  const live = localFiles.find(f => f.id === entry.id) || publicFiles.find(f => f.id === entry.id);
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
                            className={`flex-shrink-0 w-16 cursor-pointer group/recent transition-all`}
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

              {/* IndexedDB vibe 列表 */}
              {/* 列表标题栏 */}
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

                {/* 标签筛选条（横向滚动 chips） */}
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
                  {/* IndexedDB 本地 vibe */}
                  {[...tagFilteredLocalFiles].sort((a, b) => {
                    return (b.createdAt || 0) - (a.createdAt || 0);
                  }).map((file) => {
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
                              onClick={(e) => handleDeleteVibeFile(file.id, e)}
                              className="p-2 text-gray-400 hover:text-red-400 rounded hover:bg-white/10 transition-colors"
                              title="删除"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                            {/* 三点菜单 */}
                            <div className="relative">
                              <button
                                onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(prev => prev === file.id ? null : file.id); }}
                                className="p-2 text-gray-400 hover:text-white rounded hover:bg-white/10 transition-colors"
                                title="更多操作"
                              >
                                <MoreVertical className="w-5 h-5" />
                              </button>
                              {vibeMenuOpenId === file.id && (
                                <>
                                  <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); }} />
                                  <div className="absolute right-0 top-full mt-1 w-44 bg-nai-panel border border-gray-700 rounded-lg shadow-xl z-50 py-1 text-sm">
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); setEditingVibeDefaults({ vibeId: file.id, name: file.name, editName: file.name, strength: file.defaultStrength ?? 1, infoExtracted: file.defaultInfoExtracted ?? 1, tags: new Set(file.tags || []) }); }}
                                      className="w-full text-left px-3 py-2 text-gray-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
                                    >
                                      <Edit2 className="w-4 h-4" /> 编辑
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); handleDownloadVibe(file); }}
                                      className="w-full text-left px-3 py-2 text-gray-300 hover:bg-white/10 hover:text-white flex items-center gap-2"
                                    >
                                      <Download className="w-4 h-4" /> 下载
                                    </button>
                                    {inPublic ? (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); handleRemoveFromPublic(file); }}
                                        className="w-full text-left px-3 py-2 text-red-400 hover:bg-red-900/20 flex items-center gap-2"
                                      >
                                        <Cloud className="w-4 h-4" /> 从公共撤回
                                      </button>
                                    ) : (
                                      <button
                                        onClick={(e) => { handleUploadVibeToPublic(file, e); setVibeMenuOpenId(null); }}
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
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-gray-800 bg-nai-dark/50 flex justify-between items-center shrink-0">
            <div className={`flex items-center gap-1.5 transition-opacity ${vibeTab === 'local' && selectedVibes.length > 0 ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <button
                onClick={handleBatchDelete}
                disabled={isBatchDeleting}
                className="px-2.5 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 transition-colors flex items-center gap-1 border border-red-400/30 rounded hover:bg-red-400/10 disabled:opacity-50"
                title="批量删除选中的本地 Vibe"
              >
                {isBatchDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                删除
              </button>
              <button
                onClick={handleBatchBundleDownload}
                className="px-2.5 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors flex items-center gap-1 border border-gray-600 rounded hover:bg-white/10"
                title="将选中的 Vibe 打包为 .naiv4vibebundle 文件下载"
              >
                <Package className="w-3.5 h-3.5" />
                打包下载
              </button>
              <button
                onClick={() => {
                  setBatchTagsToAdd(new Set());
                  setBatchTagEditorOpen(true);
                }}
                className="px-2.5 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors flex items-center gap-1 border border-gray-600 rounded hover:bg-white/10"
                title="批量添加标签"
              >
                <Tag className="w-3.5 h-3.5" />
                添加标签
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedVibes([])}
                disabled={selectedVibes.length === 0}
                className="px-2.5 py-1.5 text-sm font-bold text-red-400 hover:text-red-300 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                清空
              </button>
              <button onClick={handleClose} className="px-3 py-1.5 text-sm font-bold text-gray-300 hover:text-white transition-colors">
                取消
              </button>
              <button
                onClick={handleConfirmSelection}
                className="px-4 py-1.5 text-sm font-bold bg-nai-accent text-black rounded hover:bg-[#ebd576] transition-colors"
              >
                确认选择 ({selectedVibes.length})
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Sub-dialogs ─────────────────────────────────────────────────────── */}

      {/* Upload to public dialog */}
      {vibeUploadTarget && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setVibeUploadTarget(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">上传到公共Vibe</span>
              </div>
              <button onClick={() => setVibeUploadTarget(null)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">主名称</label>
                <input type="text" value={vibeUploadName} onChange={(e) => setVibeUploadName(e.target.value)} placeholder="为这个Vibe起个名字"
                  className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  autoFocus onKeyDown={(e) => { if (e.key === 'Enter' && vibeUploadName.trim()) confirmUploadVibeToPublic(); }} />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Strength</label><span className="text-xs text-nai-accent font-mono">{vibeUploadStrength.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={vibeUploadStrength} onChange={(e) => setVibeUploadStrength(parseFloat(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Info Extracted</label><span className="text-xs text-nai-accent font-mono">{vibeUploadInfoExtracted.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={vibeUploadInfoExtracted} onChange={(e) => setVibeUploadInfoExtracted(parseFloat(e.target.value))} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setVibeUploadTarget(null)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
              <button onClick={confirmUploadVibeToPublic} disabled={!vibeUploadName.trim()} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors disabled:opacity-50">确认上传</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit vibe dialog */}
      {editingVibeDefaults && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setEditingVibeDefaults(null)}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-96 max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Edit2 className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">编辑 Vibe</span>
              </div>
              <button onClick={() => setEditingVibeDefaults(null)} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1.5">名称</label>
                <input
                  type="text"
                  value={editingVibeDefaults.editName}
                  onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, editName: e.target.value } : null)}
                  placeholder="输入名称"
                  className="w-full bg-nai-dark text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  autoFocus
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Strength</label><span className="text-xs text-nai-accent font-mono">{editingVibeDefaults.strength.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={editingVibeDefaults.strength} onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, strength: parseFloat(e.target.value) } : null)} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1.5"><label className="text-xs text-gray-400">Info Extracted</label><span className="text-xs text-nai-accent font-mono">{editingVibeDefaults.infoExtracted.toFixed(2)}</span></div>
                <input type="range" min="0" max="1" step="0.01" value={editingVibeDefaults.infoExtracted} onChange={(e) => setEditingVibeDefaults(prev => prev ? { ...prev, infoExtracted: parseFloat(e.target.value) } : null)} className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent" />
              </div>
              {/* 标签 */}
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Tag className="w-3.5 h-3.5 text-gray-400" />
                  <label className="text-xs text-gray-400">标签</label>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tagPool.map(tag => {
                    const active = editingVibeDefaults.tags.has(tag);
                    return (
                      <button key={tag} onClick={() => setEditingVibeDefaults(prev => {
                        if (!prev) return prev;
                        const next = new Set(prev.tags);
                        if (next.has(tag)) next.delete(tag); else next.add(tag);
                        return { ...prev, tags: next };
                      })}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-full border transition-colors ${active ? 'bg-nai-accent text-black border-nai-accent' : 'bg-gray-800 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:bg-gray-700'}`}
                      >{tag}</button>
                    );
                  })}
                  {tagPool.length === 0 && <span className="text-xs text-gray-500">暂无标签</span>}
                </div>
                <div className="flex gap-2">
                  <input type="text" value={tagEditorNewName} onChange={(e) => setTagEditorNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const name = tagEditorNewName.trim();
                        if (!name) return;
                        if (!tagPool.includes(name)) { setTagPool(prev => [...prev, name].sort((a, b) => a.localeCompare(b, 'zh-CN'))); saveVibeTagPool([...tagPool, name]); }
                        setEditingVibeDefaults(prev => prev ? { ...prev, tags: new Set([...prev.tags, name]) } : prev);
                        setTagEditorNewName('');
                      }
                    }}
                    placeholder="新建标签..."
                    className="flex-1 bg-nai-dark text-white text-xs rounded px-2 py-1.5 border border-gray-700 focus:border-nai-accent focus:outline-none" />
                  <button onClick={() => {
                    const name = tagEditorNewName.trim();
                    if (!name) return;
                    if (!tagPool.includes(name)) { setTagPool(prev => [...prev, name].sort((a, b) => a.localeCompare(b, 'zh-CN'))); saveVibeTagPool([...tagPool, name]); }
                    setEditingVibeDefaults(prev => prev ? { ...prev, tags: new Set([...prev.tags, name]) } : prev);
                    setTagEditorNewName('');
                  }} disabled={!tagEditorNewName.trim()}
                    className="px-2.5 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-xs font-bold rounded disabled:opacity-30 flex items-center gap-1">
                    <Check className="w-3.5 h-3.5" /> 添加
                  </button>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={() => setEditingVibeDefaults(null)} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
              <button onClick={async () => {
                // 保存名称/参数
                await saveVibeEdit(editingVibeDefaults.vibeId, editingVibeDefaults.editName, editingVibeDefaults.strength, editingVibeDefaults.infoExtracted);
                // 保存标签
                await setVibeTagsStorage(editingVibeDefaults.vibeId, Array.from(editingVibeDefaults.tags));
                await loadLocalVibes();
                await reloadTagPool();
                setEditingVibeDefaults(null);
              }} className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* 多 Vibe 导入配置面板 */}
      {importItems && importItems.length > 0 && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setImportItems(null)}>
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
              <div className="flex items-center gap-2">
                <File className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">
                  {importItems.length === 1 ? '导入 Vibe' : `导入 ${importItems.length} 个 Vibe`}
                </span>
              </div>
              <button onClick={() => setImportItems(null)} className="text-gray-400 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body — 卡片列表 */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              {importItems.map((item, idx) => (
                <div
                  key={item.uid}
                  className="bg-nai-input/60 border border-gray-700/50 rounded-xl overflow-hidden hover:border-gray-600/60 transition-colors"
                >
                  {/* 顶部：缩略图 + 名称 + 移除 */}
                  <div className="flex items-start gap-4 p-4 pb-3">
                    <div className="shrink-0 w-20 h-20 rounded-lg overflow-hidden bg-gray-900 border border-gray-700/60 flex items-center justify-center">
                      {item.vibeData.preview ? (
                        <img src={item.vibeData.preview} alt={item.name} className="w-full h-full object-cover" />
                      ) : (
                        <File className="w-8 h-8 text-gray-600" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-semibold">名称</div>
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => {
                          const newName = e.target.value;
                          setImportItems(items => items?.map(it =>
                            it.uid === item.uid ? { ...it, name: newName } : it
                          ) || null);
                        }}
                        placeholder="为这个 Vibe 起个名字"
                        className="w-full bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700/80 focus:border-nai-accent focus:outline-none transition-colors"
                        autoFocus={idx === 0}
                      />
                    </div>
                    {importItems.length > 1 && (
                      <button
                        onClick={() => {
                          setImportItems(items => items?.filter(it => it.uid !== item.uid) || null);
                        }}
                        className="shrink-0 p-1.5 text-gray-500 hover:text-red-400 rounded-md hover:bg-red-400/10 transition-colors"
                        title="从导入列表移除"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* 中部：参数滑杆（两列） */}
                  <div className="px-4 pb-3 grid grid-cols-2 gap-x-4 gap-y-2">
                    <div>
                      <div className="flex justify-between items-baseline mb-1.5">
                        <label className="text-xs text-gray-400">Strength</label>
                        <span className="text-xs text-nai-accent font-mono tabular-nums">{item.strength.toFixed(2)}</span>
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.01"
                        value={item.strength}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setImportItems(items => items?.map(it =>
                            it.uid === item.uid ? { ...it, strength: v } : it
                          ) || null);
                        }}
                        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                      />
                    </div>
                    <div>
                      <div className="flex justify-between items-baseline mb-1.5">
                        <label className="text-xs text-gray-400">Info Extracted</label>
                        <span className="text-xs text-nai-accent font-mono tabular-nums">{item.infoExtracted.toFixed(2)}</span>
                      </div>
                      <input
                        type="range" min="0" max="1" step="0.01"
                        value={item.infoExtracted}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setImportItems(items => items?.map(it =>
                            it.uid === item.uid ? { ...it, infoExtracted: v } : it
                          ) || null);
                        }}
                        className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                      />
                    </div>
                  </div>

                  {/* 底部：标签区域（独立背景，视觉上分离） */}
                  <div className="border-t border-gray-700/50 bg-nai-dark/30 px-4 py-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-1.5 text-xs text-gray-400">
                        <Tag className="w-3 h-3" />
                        <span>标签</span>
                      </div>
                      {item.tags.size > 0 && (
                        <span className="text-[10px] text-nai-accent">{item.tags.size} 个已选</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {tagPool.length === 0 && (
                        <span className="text-[11px] text-gray-600 italic">还没有标签，下方输入框创建第一个</span>
                      )}
                      {tagPool.map(tag => {
                        const active = item.tags.has(tag);
                        return (
                          <button
                            key={tag}
                            onClick={() => toggleItemTag(item.uid, tag)}
                            className={`px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors flex items-center gap-1 border ${
                              active
                                ? 'bg-nai-accent text-black border-nai-accent shadow-sm'
                                : 'bg-gray-800/80 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:border-gray-600 hover:bg-gray-700/60'
                            }`}
                          >
                            {tag}
                          </button>
                        );
                      })}
                      {importItemNewTagDraft[item.uid] !== undefined ? (
                        <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-800 border border-nai-accent/50">
                          <input
                            type="text"
                            autoFocus
                            value={importItemNewTagDraft[item.uid] || ''}
                            onChange={(e) => setImportItemNewTagDraft(prev => ({ ...prev, [item.uid]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                const v = (importItemNewTagDraft[item.uid] || '').trim();
                                if (v) { addNewTagToItem(item.uid, v); }
                                setImportItemNewTagDraft(prev => { const n = { ...prev }; delete n[item.uid]; return n; });
                              }
                              if (e.key === 'Escape') {
                                setImportItemNewTagDraft(prev => { const n = { ...prev }; delete n[item.uid]; return n; });
                              }
                            }}
                            onBlur={() => {
                              const v = (importItemNewTagDraft[item.uid] || '').trim();
                              if (v) { addNewTagToItem(item.uid, v); }
                              setImportItemNewTagDraft(prev => { const n = { ...prev }; delete n[item.uid]; return n; });
                            }}
                            placeholder="标签名"
                            className="w-16 bg-transparent text-[11px] text-white focus:outline-none placeholder:text-gray-500 leading-none"
                          />
                          <button
                            onMouseDown={(e) => {
                              e.preventDefault();
                              const v = (importItemNewTagDraft[item.uid] || '').trim();
                              if (v) { addNewTagToItem(item.uid, v); }
                              setImportItemNewTagDraft(prev => { const n = { ...prev }; delete n[item.uid]; return n; });
                            }}
                            className="p-0.5 text-green-400 hover:text-green-300 transition-colors"
                          >
                            <Check className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setImportItemNewTagDraft(prev => ({ ...prev, [item.uid]: '' }))}
                          className="px-2.5 py-1 text-[11px] rounded-full bg-gray-800/80 text-gray-400 border border-gray-700/50 hover:text-gray-200 hover:border-gray-600 transition-colors flex items-center gap-1"
                        >
                          <Plus className="w-3 h-3" />
                          新建
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-gray-800 flex gap-3 shrink-0 bg-nai-dark/30">
              <button
                onClick={() => setImportItems(null)}
                className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmVibeImport}
                disabled={importItems.length === 0}
                className="flex-1 py-2.5 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
              >
                确认导入{importItems.length > 1 ? ` (${importItems.length})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 单 Vibe 标签编辑弹层 */}

      {/* 批量添加标签弹层 */}
      {batchTagEditorOpen && (() => {
        const totalSelected = selectedVibes.length;
        const trimmedNew = batchNewTagName.trim();
        const dupNew = trimmedNew.length > 0 && tagPool.includes(trimmedNew);
        const canCreateNew = trimmedNew.length > 0 && !dupNew;
        const closeModal = () => {
          setBatchTagEditorOpen(false);
          setBatchNewTagCreating(false);
          setBatchNewTagName('');
        };
        const submitNewBatchTag = () => {
          if (!canCreateNew) return;
          const merged = [...tagPool, trimmedNew].sort((a, b) => a.localeCompare(b, 'zh-CN'));
          setTagPool(merged);
          saveVibeTagPool(merged);
          // 自动勾选新建的标签
          setBatchTagsToAdd(prev => {
            const next = new Set(prev);
            next.add(trimmedNew);
            return next;
          });
          setBatchNewTagName('');
          setBatchNewTagCreating(false);
        };
        return (
        <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeModal}>
          <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
              <div className="flex items-center gap-2">
                <Tag className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">批量添加标签 ({totalSelected})</span>
              </div>
              <button onClick={closeModal} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
              {tagPool.map(tag => {
                const checked = batchTagsToAdd.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200 hover:text-white">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setBatchTagsToAdd(prev => {
                          const next = new Set(prev);
                          if (next.has(tag)) next.delete(tag);
                          else next.add(tag);
                          return next;
                        });
                      }}
                      className="accent-nai-accent"
                    />
                    <Tag className="w-3 h-3 text-gray-500" />
                    {tag}
                  </label>
                );
              })}
              {tagPool.length === 0 && (
                <div className="text-xs text-gray-500 text-center py-2">暂无标签，下方可新建</div>
              )}

              {/* 新建标签 — 折叠按钮 / 展开表单 */}
              <div className="pt-2">
                {!batchNewTagCreating ? (
                  <button
                    onClick={() => { setBatchNewTagCreating(true); setBatchNewTagName(''); }}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-700 hover:border-nai-accent/60 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/5 text-xs font-bold transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    新建标签
                  </button>
                ) : (
                  <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <Tag className="w-3.5 h-3.5 text-nai-accent shrink-0" />
                      <input
                        type="text"
                        autoFocus
                        value={batchNewTagName}
                        onChange={(e) => setBatchNewTagName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitNewBatchTag();
                          if (e.key === 'Escape') { setBatchNewTagCreating(false); setBatchNewTagName(''); }
                        }}
                        placeholder="输入新标签名"
                        className="flex-1 bg-nai-dark text-white text-xs rounded-md px-2 py-1.5 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                      />
                    </div>
                    {dupNew && (
                      <p className="text-[11px] text-red-400 pl-5">标签 "{trimmedNew}" 已存在</p>
                    )}
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => { setBatchNewTagCreating(false); setBatchNewTagName(''); }}
                        className="px-2.5 py-1 text-[11px] font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                      >
                        取消
                      </button>
                      <button
                        onClick={submitNewBatchTag}
                        disabled={!canCreateNew}
                        className="px-2.5 py-1 bg-nai-accent hover:bg-[#ebd576] text-black text-[11px] font-bold rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" />
                        创建
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="p-4 border-t border-gray-800 flex gap-3">
              <button onClick={closeModal} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
              <button
                onClick={async () => {
                  const tagsToAdd = Array.from(batchTagsToAdd);
                  if (tagsToAdd.length === 0) {
                    closeModal();
                    return;
                  }

                  let tagged = 0;
                  let promoted = 0;
                  let failed = 0;

                  for (const id of selectedVibes) {
                    try {
                      // 1) 已在本地库 → 直接合并标签
                      let local = localFiles.find(f => f.id === id);

                      // 2) 不在本地库 → 隐式 promote：从公共库拉完整数据 + 入库
                      if (!local) {
                        const publicFile = publicFiles.find(f => f.id === id);
                        if (!publicFile?.fileName) {
                          // 既不在本地也不在公共（可能是只有快照的幽灵 entry）→ 跳过
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
                          id: saved.id, name: saved.name, size: saved.size,
                          preview: saved.preview, image: saved.image, encodings: saved.encodings,
                          defaultStrength: saved.defaultStrength,
                          defaultInfoExtracted: saved.defaultInfoExtracted,
                          supportedModels: saved.supportedModels,
                          tags: saved.tags,
                        } as VibeFile;
                        promoted++;
                      }

                      // 3) 合并标签写入
                      const merged = Array.from(new Set([...(local.tags || []), ...tagsToAdd]));
                      await setVibeTagsStorage(local.id, merged);
                      if (currentBotUserId) {
                      }
                      tagged++;
                    } catch (err) {
                      console.error(`批量打标签失败 (${id}):`, err);
                      failed++;
                    }
                  }

                  await loadLocalVibes();
                  await reloadTagPool();
                  closeModal();

                  const parts: string[] = [];
                  if (tagged > 0) parts.push(`已为 ${tagged} 个 Vibe 打标签`);
                  if (promoted > 0) parts.push(`收纳了 ${promoted} 个`);
                  if (failed > 0) parts.push(`${failed} 个失败`);
                  showToast(parts.join('，') || '无变更', failed > 0 ? 'error' : 'success');
                }}
                className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors"
              >
                应用
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* 云端数据管理弹窗 */}
      <CloudManageModal
        isOpen={cloudManageOpen}
        onClose={() => setCloudManageOpen(false)}
        onDataChanged={async () => {
          await loadLocalVibes();
          await reloadTagPool();
        }}
      />

      {/* 公共 Vibe 管理面板 — 嵌入在主 Modal 内 */}
      <PublicVibeManagerModal
        isOpen={publicVibeManagerOpen}
        onClose={() => {
          setPublicVibeManagerOpen(false);
          // 关闭时刷新公共列表，反映可能的撤回/编辑变化
          loadPublicVibes(true);
        }}
        selectedModelId={selectedModelId}
        showToast={showToast}
      />


      {/* 标签管理面板 */}
      {tagSettingsOpen && (() => {
        const trimmedNewName = tagSettingsNewName.trim();
        const isDuplicate = trimmedNewName.length > 0 && tagPool.includes(trimmedNewName);
        const canCreate = trimmedNewName.length > 0 && !isDuplicate;
        const submitNewTag = () => {
          if (!canCreate) return;
          const merged = [...tagPool, trimmedNewName].sort((a, b) => a.localeCompare(b, 'zh-CN'));
          setTagPool(merged);
          saveVibeTagPool(merged);
          setTagSettingsNewName('');
        };
        return (
        <div
          className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => { setTagSettingsOpen(false); setTagSettingsEditing(null); setTagSettingsCreating(false); setTagSettingsNewName(''); }}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-nai-accent" />
                <span className="font-bold text-white text-base">标签管理</span>
                <span className="text-xs text-gray-500">{tagPool.length} 个</span>
              </div>
              <button
                onClick={() => { setTagSettingsOpen(false); setTagSettingsEditing(null); setTagSettingsCreating(false); setTagSettingsNewName(''); }}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 新建标签 — 折叠按钮 / 展开表单 */}
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
                      onChange={(e) => setTagSettingsNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitNewTag();
                        if (e.key === 'Escape') { setTagSettingsCreating(false); setTagSettingsNewName(''); }
                      }}
                      placeholder="输入新标签名"
                      className="flex-1 bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                    />
                  </div>
                  {isDuplicate && (
                    <p className="text-[11px] text-red-400 pl-6">标签 "{trimmedNewName}" 已存在</p>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      onClick={() => { setTagSettingsCreating(false); setTagSettingsNewName(''); }}
                      className="px-3 py-1.5 text-xs font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={submitNewTag}
                      disabled={!canCreate}
                      className="px-3 py-1.5 bg-nai-accent hover:bg-[#ebd576] text-black text-xs font-bold rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                    >
                      <Check className="w-3.5 h-3.5" />
                      创建
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 列表 */}
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
                              onChange={(e) => setTagSettingsEditDraft(e.target.value)}
                              autoFocus
                              onKeyDown={async (e) => {
                                if (e.key === 'Enter') {
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
                                    const n = new Set(prev);
                                    if (n.delete(tag)) n.add(newName);
                                    return n;
                                  });
                                  await reloadTagPool();
                                  await loadLocalVibes();
                                  setTagSettingsEditing(null);
                                }
                                if (e.key === 'Escape') setTagSettingsEditing(null);
                              }}
                              className="flex-1 bg-nai-dark text-white text-sm rounded px-2.5 py-1.5 border border-nai-accent focus:outline-none"
                            />
                            <button
                              onClick={async () => {
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
                                  const n = new Set(prev);
                                  if (n.delete(tag)) n.add(newName);
                                  return n;
                                });
                                await reloadTagPool();
                                await loadLocalVibes();
                                setTagSettingsEditing(null);
                              }}
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
                                  onClick={() => {
                                    setTagSettingsEditing(tag);
                                    setTagSettingsEditDraft(tag);
                                  }}
                                  className="p-1.5 text-gray-400 hover:text-nai-accent hover:bg-white/5 rounded transition-colors"
                                  title="重命名"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {!isProtected && (
                                <button
                                  onClick={async () => {
                                    const msg = usage > 0
                                      ? `确定删除标签 "${tag}"？\n\n该标签下的 ${usage} 个 Vibe 不会被删除，会回到"全部"中。`
                                      : `确定删除未使用的标签 "${tag}"？`;
                                    if (!confirm(msg)) return;
                                    await deleteVibeTag(tag);
                                    setSelectedTagFilter(prev => {
                                      const n = new Set(prev);
                                      n.delete(tag);
                                      return n;
                                    });
                                    await reloadTagPool();
                                    await loadLocalVibes();
                                  }}
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
      })()}

      {/* 二次确认弹窗（删除等破坏性操作） */}
      {confirmDialog}
    </>
  );
};
