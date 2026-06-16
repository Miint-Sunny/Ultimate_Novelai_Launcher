import React, { useState, useRef, useEffect, useMemo, useCallback, startTransition } from 'react';
import {
  NEWLINE_SENTINEL, splitPromptToTags, makeArtistMarker,
  parseCollapsibleMarker, filterHiddenTags,
} from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';
import {
  ChevronDown,
  ChevronRight,
  Sparkles,
  Bot,
  Dices,
  Send,
  RefreshCw,
  X,
  Palette,
  Loader2,
  Languages,
  Wrench,
  RotateCcw,
  Check,
  Plus,
  Grid,
  Upload,
  Image as ImageIcon,
  FileUp,
  Power,
  User,
  Users,
  ImagePlus,
  Ban,
  ArrowUp,
  ArrowDown,
  Trash2,
  Brush,
  Settings,
  Lightbulb,
  Filter,
  Copy,
  SlidersHorizontal,
  Download,
  ArrowLeft,
  AlignLeft,
  Edit2,
  Tag,
  Eye,
  EyeOff,
  Search,
  Heart,
  Cloud,
  CloudOff,
  MoreVertical,
  Globe,
  HardDrive,
  Clock,
  Undo2,
  ExternalLink,
} from 'lucide-react';
import { useGeneration } from '../../contexts/GenerationContext';
import { useAuth } from '../../contexts/AuthContext';
import { useDragDrop } from '../../contexts/DragDropContext';
import { registerBackHandler } from './MobileLayout';
import {
  getAppSettings,
  getPromptPresets,
  savePromptPresets,
  getActivePresetId,
  saveActivePresetId,
  type PromptPresetData,
  DEFAULT_PROMPT_PRESETS,
} from '../../services/localLibrary';
import {
  getArtists,
  saveArtist,
  deleteArtist,
  type ArtistData,
  getCRs,
  saveCR,
  deleteCR,
  type CRData,
  getVibes,
  type VibeData,
  saveVibe,
  createVibeFromImage,
  createVibeFromImageBase64,
  importVibeFromFile,
  importVibeBundleFromFile,
  deleteVibe,
  findVibeByImage,
  findVibeByEncoding,
  createVibeFromEncoding,
  findCachedEncoding,
  saveVibeEncoding,
  recordVibeUsageBatch,
  exportVibeToFile,
  exportVibesToBundle,
  getVibeTagPool,
  saveVibeTagPool,
  getRecentVibeEntries,
  clearRecentVibeEntries,
  removeRecentVibeEntry,
  type RecentVibeEntry,
  setVibeTags as setVibeTagsStorage,
  syncVibesFromCloud,
  SyncProtocolMismatchError,
  pushAllToCloud,
} from '../../services/localLibrary';
import { copyToClipboard } from '../../utils/clipboard';
import { getBackendUrl } from '../../utils/apiConfig';
import { parseCharacterPromptContent } from '../../utils/promptParser';
import {
  botService,
  addCloudTombstone,
  deleteCloudVibe,
  putCloudTagPool,
} from '../../services/botService';
import {
  getPublicLibraryOwnerId,
  getPublicVibes,
  getPublicVibeFile,
  fetchPublicVibeEncoding,
  getPublicCRs,
  getPublicCRPreviewUrl,
  getPublicArtists,
  getPublicOCs,
  getOCPreviewUrl,
  createPublicOC,
  updatePublicOC,
  deletePublicOC,
  type PublicCRData,
  type PublicArtistData,
} from '../../services/publicLibrary';
import { CloudManageModal } from '../vibe/CloudManageModal';
import { cloudSyncQueue, type CloudSyncQueueStatus } from '../../services/cloudSyncQueue';
import { shouldShowOnboarding, setOnboardingState } from '../../services/syncOnboarding';
import {
  getAnlas,
  type AnlasInfo,
  type GenerateImageParams,
  type VibeReference,
  generateImageStream,
  encodeVibeImage,
  processCRImage,
  processImg2ImgImage,
  updateCachedIsOpus,
} from '../../services/novelai';
import {
  translateChineseInPrompt,
  containsChinese,
} from '../../services/translate';
import { countTokens } from '../../services/tokenizer';
import {
  agentService,
  type AgentState,
  KNOWLEDGE_SOURCES,
  DEFAULT_AI_MODEL,
} from '../../services/agentService';
import { MobileAIAssistantSheet } from './MobileAIAssistantSheet';
import { MobileArtistModal } from './MobileArtistModal';
import { MetadataDetailPanel, type MetadataFile } from '../ToolsModal';
import { InspirationModal } from '../InspirationModal';
import { loadCodexData, type CodexItem } from '../../services/codexData';
import { calculateCostFromUI } from '../../services/costCalculator';
import {
  extractImageMetadata,
  getPictureSizeType,
  type ImageMetadata,
} from '../../utils/imageMetadata';
import { getUnsupportedImportSettings, formatUnsupportedSettings, normalizeNoiseSchedule } from '../../utils/generationOptions';
import {
  analyzeImageWithWDTagger,
  extractBase64FromDataUrl,
  type WDTaggerResult,
} from '../../services/wdTagger';
import {
  MAX_TOTAL_PIXELS,
  MOBILE_LARGE_RESOLUTIONS as LARGE_RESOLUTIONS,
  MOBILE_WALLPAPER_RESOLUTIONS as WALLPAPER_RESOLUTIONS,
  MODEL_MAP,
  MODEL_TO_ENCODING_KEY,
  MODELS,
  RESOLUTIONS,
} from '../generation/modelResolutionOptions';
import { FullscreenEditor, expandCollapsibleMarkers } from './FullscreenEditor';
import { blobToBase64 } from './imageUtils';
import type {
  ActiveCR,
  ActivePreciseRef,
  ActiveVibe,
  ArtistFile,
  CharacterPrompt,
  CRFile,
  OCFile,
  PreciseReferenceMode,
  VibeFile,
} from './types';

// ==================== 主组件 ====================
interface MobileGeneratePageProps {
  onEditorStateChange?: (isOpen: boolean) => void;
}

export const MobileGeneratePage: React.FC<MobileGeneratePageProps> = ({ onEditorStateChange }) => {
  const {
    isGenerating,
    generate,
    cancelTask,
    seedSetting: seed,
    setSeedSetting: setSeed,
    targetWidth,
    targetHeight,
    isQueuing,
    queuePosition,
    currentStep,
    totalSteps,
    setImage,
    addInpaintedImage,
  } = useGeneration();

  // Auth context
  const { isAuthenticated, requireAuth } = useAuth();
  const currentUserId = getPublicLibraryOwnerId();

  // 从 localStorage 恢复状态
  const getSavedState = () => {
    try {
      const saved = localStorage.getItem('mobile_generate_state');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error('Failed to load saved state:', e);
    }
    return null;
  };

  const savedState = getSavedState();

  const [localWidth, setLocalWidth] = useState(savedState?.localWidth ?? targetWidth);
  const [localHeight, setLocalHeight] = useState(savedState?.localHeight ?? targetHeight);
  const [model, setModel] = useState(savedState?.model ?? 'v4.5-full');
  const [positivePrompt, setPositivePrompt] = useState(savedState?.positivePrompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(savedState?.negativePrompt ?? '');
  const [steps, setSteps] = useState(savedState?.steps ?? 28);

  // 高级生成参数
  const [scale, setScale] = useState(savedState?.scale ?? 5);
  const [sampler, setSampler] = useState(savedState?.sampler ?? 'k_euler_ancestral');
  const [noiseSchedule, setNoiseSchedule] = useState(savedState?.noiseSchedule ?? 'karras');
  const [cfgRescale, setCfgRescale] = useState(savedState?.cfgRescale ?? 0);
  const [varietyPlus, setVarietyPlus] = useState(savedState?.varietyPlus ?? false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [isPresetExpanded, setIsPresetExpanded] = useState(false);

  // 全屏编辑器状态
  const [editorOpen, setEditorOpen] = useState<'prompt' | 'undesired' | null>(null);

  // AI 助手弹窗状态
  const [showAIAssistant, setShowAIAssistant] = useState(false);

  // AI Agent 状态
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [agentState, setAgentState] = useState<AgentState>({ status: 'idle', logs: [] });

  // 翻译状态
  const [isTranslating, setIsTranslating] = useState(false);

  // Anlas 状态
  const [anlasInfo, setAnlasInfo] = useState<AnlasInfo | null>(null);
  const [isLoadingAnlas, setIsLoadingAnlas] = useState(false);

  // 下拉菜单状态
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showResolutionDropdown, setShowResolutionDropdown] = useState(false);
  const [resolutionTab, setResolutionTab] = useState<'small' | 'large' | 'wallpaper'>('small');

  // Vibe 状态
  const [showVibeModal, setShowVibeModal] = useState(false);
  const [vibeTab, setVibeTab] = useState<'public' | 'local'>('public');
  const [vibeFiles, setVibeFiles] = useState<VibeFile[]>([]);
  const [localVibeFiles, setLocalVibeFiles] = useState<VibeFile[]>([]);
  const [activeVibes, setActiveVibes] = useState<ActiveVibe[]>([]);

  // 自动记录"最近使用"：activeVibes 任何变更都会被捕获
  useEffect(() => {
    if (activeVibes.length === 0) return;
    recordVibeUsageBatch(activeVibes.map(v => ({
      id: v.id,
      name: v.name,
      preview: v.preview,
    })));
  }, [activeVibes]);

  const [isLoadingVibes, setIsLoadingVibes] = useState(false);
  const [isVibeExpanded, setIsVibeExpanded] = useState(true);
  const [loadingVibeIds, setLoadingVibeIds] = useState<Set<string>>(new Set());
  const [collectingVibeIds, setCollectingVibeIds] = useState<Set<string>>(new Set());
  const [vibeSearchQuery, setVibeSearchQuery] = useState('');
  const [vibeModelFilter] = useState<string>('all');

  // ── Vibe 管理器扩展状态（对齐桌面端）──────────────────────────────────────
  // 云同步
  const vibeIsSyncingRef = useRef(false);
  const [vibeIsSyncing, setVibeIsSyncing] = useState(false);
  const [vibeProtocolMismatch, setVibeProtocolMismatch] = useState<{ server: number; required: number } | null>(null);
  // 标签
  const [vibeTagPool, setVibeTagPool] = useState<string[]>([]);
  const [vibeSelectedTagFilter, setVibeSelectedTagFilter] = useState<Set<string>>(new Set());
  // 最近使用
  const [vibeRecentEntries, setVibeRecentEntries] = useState<RecentVibeEntry[]>([]);
  // 三点菜单
  const [vibeMenuOpenId, setVibeMenuOpenId] = useState<string | null>(null);
  // 标签管理面板
  const [vibeTagSettingsOpen, setVibeTagSettingsOpen] = useState(false);
  const [vibeTagSettingsCreating, setVibeTagSettingsCreating] = useState(false);
  const [vibeTagSettingsNewName, setVibeTagSettingsNewName] = useState('');
  const [vibeTagSettingsEditing, setVibeTagSettingsEditing] = useState<string | null>(null);
  const [vibeTagSettingsEditDraft, setVibeTagSettingsEditDraft] = useState('');
  // 首次引导
  // 批量标签
  const [vibeBatchTagOpen, setVibeBatchTagOpen] = useState(false);
  const [vibeBatchTagsToAdd, setVibeBatchTagsToAdd] = useState<Set<string>>(new Set());
  // 单个 vibe 标签编辑
  const [vibeTagEditorTarget, setVibeTagEditorTarget] = useState<{ vibeId: string; current: Set<string> } | null>(null);
  // FAB 悬浮导入按钮
  const [vibeFabOpen, setVibeFabOpen] = useState(false);
  // 云端菜单
  const [vibeCloudMenuOpen, setVibeCloudMenuOpen] = useState(false);
  // 最近使用折叠

  // Precise Reference 状态 (原 CR)
  const [showCRModal, setShowCRModal] = useState(false);
  const [crTab, setCrTab] = useState<'public' | 'local'>('public');
  const [crPublicFiles, setCrPublicFiles] = useState<CRFile[]>([]);
  const [crLocalFiles, setCrLocalFiles] = useState<CRFile[]>([]);
  const [activePreciseRefs, setActivePreciseRefs] = useState<ActivePreciseRef[]>([]);
  const [isLoadingCRs, setIsLoadingCRs] = useState(false);
  const [isCRExpanded, setIsCRExpanded] = useState(true);

  // 兼容旧代码的 activeCR
  const activeCR = activePreciseRefs.length > 0 ? {
    ...activePreciseRefs[0],
    fidelity: activePreciseRefs[0].strength,
    styleAware: activePreciseRefs[0].mode === 'character&style',
  } : null;

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

  // Image2Image 状态
  const [img2imgImage, setImg2imgImage] = useState<string | null>(null);
  const [img2imgStrength, setImg2imgStrength] = useState(0.7);
  const [img2imgNoise, setImg2imgNoise] = useState(0);
  const [isImg2ImgExpanded, setIsImg2ImgExpanded] = useState(true);

  // 重绘后自动循环：保存重绘参数供循环生成使用
  const savedInpaintRef = useRef<{ imageBase64: string; maskBase64: string; strength: number; width: number; height: number } | null>(null);
  // 裁切/扩图重绘回贴信息
  const cropInfoRef = useRef<{ cropRect: { x: number; y: number; width: number; height: number }; originalImageBase64: string; originalWidth: number; originalHeight: number; isExpand?: boolean } | null>(null);
  const [hasInpaintParams, setHasInpaintParams] = useState(false);
  const [inpaintStrength, setInpaintStrength] = useState(0.7); // 重绘强度（独立于 img2imgStrength）

  // 设置图生图图片并自动匹配分辨率
  const MAX_TOTAL_PIXELS = 1024 * 3072;
  const setImg2imgWithAutoRes = useCallback((dataUrl: string) => {
    setImg2imgImage(dataUrl);
    savedInpaintRef.current = null;
    setHasInpaintParams(false);
    const img = new Image();
    img.onload = () => {
      let w = Math.round(img.naturalWidth / 64) * 64;
      let h = Math.round(img.naturalHeight / 64) * 64;
      w = Math.max(64, w);
      h = Math.max(64, h);
      const pixels = w * h;
      if (pixels > MAX_TOTAL_PIXELS) {
        const scale = Math.sqrt(MAX_TOTAL_PIXELS / pixels);
        w = Math.max(64, Math.floor((w * scale) / 64) * 64);
        h = Math.max(64, Math.floor((h * scale) / 64) * 64);
      }
      setLocalWidth(w);
      setLocalHeight(h);
      // 同步更新主画布显示为导入的图片
      setImage(dataUrl, w, h);
    };
    img.src = dataUrl;
  }, [setImage]);

  // Character Prompts 状态
  const [characterPrompts, setCharacterPrompts] = useState<CharacterPrompt[]>(() => {
    if (savedState?.characterPrompts) {
      return savedState.characterPrompts.map((c: any) => ({
        id: c.id || Date.now().toString(),
        positive: c.positive || '',
        negative: c.negative || '',
        activeTab: 'prompt' as const,
        enabled: c.enabled ?? true,
        position: c.position || '',
        name: c.name,
      }));
    }
    return [];
  });
  const [isCharacterExpanded, setIsCharacterExpanded] = useState(true);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);

  // 通知父组件编辑器状态变化
  useEffect(() => {
    onEditorStateChange?.(editorOpen !== null || editingCharacterId !== null || showAIAssistant);
  }, [editorOpen, editingCharacterId, showAIAssistant, onEditorStateChange]);

  // 灵感弹窗
  const [isInspirationModalOpen, setIsInspirationModalOpen] = useState(false);
  const [inspirationTab, setInspirationTab] = useState<'codex' | 'random'>('codex');
  const [codexData, setCodexData] = useState<CodexItem[]>([]);
  const [isLoadingCodex, setIsLoadingCodex] = useState(false);
  const [codexSearchQuery, setCodexSearchQuery] = useState('');
  const [codexR18Filter, setCodexR18Filter] = useState<'all' | 'safe' | 'r18'>('all');
  const [codexSelectedCategories, setCodexSelectedCategories] = useState<string[]>([]);
  const [showCategoryFilter, setShowCategoryFilter] = useState(false);
  const [randomCodexItem, setRandomCodexItem] = useState<CodexItem | null>(null);
  const [codexDisplayCount, setCodexDisplayCount] = useState(30); // 懒加载显示数量

  // 画师串状态
  const [showArtistModal, setShowArtistModal] = useState(false);
  const [artistTab, setArtistTab] = useState<'public' | 'local'>('public');
  const [artistPublicFiles, setArtistPublicFiles] = useState<ArtistFile[]>([]);
  const [artistLocalFiles, setArtistLocalFiles] = useState<ArtistFile[]>([]);
  const [isLoadingArtists, setIsLoadingArtists] = useState(false);
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null);

  // 预设状态
  const [promptPresets, setPromptPresets] = useState<PromptPresetData[]>([]);
  const [activePresetId, setActivePresetId] = useState<string>(savedState?.activePresetId ?? 'heavy');

  // OC 状态
  const [showOCModal, setShowOCModal] = useState(false);
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

  // 角色Tag映射（用于AI助手）
  const [roleTagMap, setRoleTagMap] = useState<
    Record<
      string,
      {
        role_en: string;
        role_zh: string[];
        origin_en: string;
        origin_zh: string[];
      }
    >
  >({});

  // 准备状态
  const [isPreparing, setIsPreparing] = useState(false);

  // 图片导入弹窗状态
  const [showImageImportModal, setShowImageImportModal] = useState(false);
  const [importImageDataUrl, setImportImageDataUrl] = useState<string | null>(null);
  const [importImageMetadata, setImportImageMetadata] = useState<ImageMetadata | null>(null);
  const [isParsingMetadata, setIsParsingMetadata] = useState(false);
  const [isAnalyzingTagger, setIsAnalyzingTagger] = useState(false);
  const [taggerResult, setTaggerResult] = useState<WDTaggerResult | null>(null);
  const [showTaggerResult, setShowTaggerResult] = useState(false);
  const [showFullMetadata, setShowFullMetadata] = useState(false);
  const [importOptions, setImportOptions] = useState({
    prompt: true,
    negativePrompt: true,
    characters: true,
    settings: false,
    seed: false,
    vibes: true,
    cleanImports: true,
  });
  const [includeCharacter, setIncludeCharacter] = useState(true);

  // 获取当前激活的预设
  const activePreset = useMemo(
    () => promptPresets.find((p) => p.id === activePresetId),
    [promptPresets, activePresetId]
  );

  const currentModelApi = useMemo(
    () => MODEL_MAP[model] || 'nai-diffusion-4-5-full',
    [model]
  );

  const isVibeCompatibleWithModel = useCallback((vibe: VibeFile & { image?: string; hasImage?: boolean }) => {
    // 有原图数据时可以为任意模型重新编码，视为始终兼容
    if (vibe.image || vibe.hasImage) return true;
    if (!vibe.supportedModels || vibe.supportedModels.length === 0) return true;
    const currentEncodingKey = MODEL_TO_ENCODING_KEY[currentModelApi];
    if (!currentEncodingKey) return true;
    return vibe.supportedModels.some((supportedModel) =>
      supportedModel === currentEncodingKey ||
      (currentModelApi === 'nai-diffusion-4-5-full' && supportedModel === 'v4full') ||
      (currentModelApi === 'nai-diffusion-4-5-curated' && supportedModel === 'v4curated')
    );
  }, [currentModelApi]);

  const availableVibeModels = useMemo(() => {
    const models = new Set<string>();
    const source = vibeTab === 'public' ? vibeFiles : localVibeFiles;
    source.forEach((vibe) => vibe.supportedModels?.forEach((modelKey) => models.add(modelKey)));
    return [...models].sort();
  }, [vibeFiles, localVibeFiles, vibeTab]);

  const filterVibeList = useCallback((files: VibeFile[]) => {
    let filtered = files;
    const q = vibeSearchQuery.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((file) => file.name.toLowerCase().includes(q));
    }
    if (vibeModelFilter !== 'all') {
      filtered = filtered.filter((file) => file.supportedModels?.includes(vibeModelFilter));
    }
    return filtered;
  }, [vibeModelFilter, vibeSearchQuery]);

  const filteredPublicVibes = useMemo(() => filterVibeList(vibeFiles), [filterVibeList, vibeFiles]);
  const filteredLocalVibes = useMemo(() => filterVibeList(localVibeFiles), [filterVibeList, localVibeFiles]);

  // Token 计数 - 包含预设和角色提示词的 token（剔除 ~ 禁用标签，与生成保持一致）
  const positiveTokens = useMemo(() => {
    let total = countTokens(expandCollapsibleMarkers(filterHiddenTags(positivePrompt)));
    if (activePreset?.positive) {
      total += countTokens(activePreset.positive);
    }
    // 计入启用的角色提示词
    characterPrompts.forEach((char) => {
      if (char.enabled && char.positive) {
        total += countTokens(filterHiddenTags(char.positive));
      }
    });
    return total;
  }, [positivePrompt, activePreset, characterPrompts]);

  const negativeTokens = useMemo(() => {
    let total = countTokens(filterHiddenTags(negativePrompt));
    if (activePreset?.negative) {
      total += countTokens(activePreset.negative);
    }
    // 计入启用的角色提示词
    characterPrompts.forEach((char) => {
      if (char.enabled && char.negative) {
        total += countTokens(filterHiddenTags(char.negative));
      }
    });
    return total;
  }, [negativePrompt, activePreset, characterPrompts]);

  // 订阅 Agent 状态
  useEffect(() => {
    const unsubscribe = agentService.addEventListener(setAgentState);
    return () => unsubscribe();
  }, []);

  // 注册元数据导入处理器（供工具页权重转换等使用）
  const { setHandleMetadataImport } = useDragDrop();
  useEffect(() => {
    const handler = (metadata: any, options: any) => {
      if (options.prompt && metadata.prompt) {
        if (options.cleanImports) {
          setPositivePrompt(metadata.prompt);
        } else {
          setPositivePrompt((prev: string) => prev ? `${prev}, ${metadata.prompt}` : metadata.prompt);
        }
      }
      if (options.negativePrompt && metadata.negativePrompt) {
        if (options.cleanImports) {
          setNegativePrompt(metadata.negativePrompt);
        } else {
          setNegativePrompt((prev: string) => prev ? `${prev}, ${metadata.negativePrompt}` : metadata.negativePrompt);
        }
      }
    };
    setHandleMetadataImport(handler);
    return () => setHandleMetadataImport(null);
  }, [setHandleMetadataImport]);

  // 注册返回处理器 - 处理各种弹出层的关闭
  useEffect(() => {
    const handleBack = () => {
      // 按优先级处理各种弹出层
      if (editorOpen !== null) {
        setEditorOpen(null);
        return true;
      }
      if (editingCharacterId !== null) {
        setEditingCharacterId(null);
        return true;
      }
      if (editingPositionId !== null) {
        setEditingPositionId(null);
        return true;
      }
      if (showAIAssistant) {
        setShowAIAssistant(false);
        return true;
      }
      if (showImageImportModal) {
        setShowImageImportModal(false);
        return true;
      }
      if (isInspirationModalOpen) {
        setIsInspirationModalOpen(false);
        return true;
      }
      if (showArtistModal) {
        setShowArtistModal(false);
        return true;
      }
      if (showOCModal) {
        setShowOCModal(false);
        return true;
      }
      if (showVibeModal) {
        setShowVibeModal(false);
        return true;
      }
      if (showCRModal) {
        setShowCRModal(false);
        return true;
      }
      return false;
    };

    return registerBackHandler(handleBack);
  }, [editorOpen, editingCharacterId, editingPositionId, showAIAssistant, showImageImportModal, isInspirationModalOpen, showArtistModal, showOCModal, showVibeModal, showCRModal]);

  // 保存状态到 localStorage
  useEffect(() => {
    const stateToSave = {
      localWidth,
      localHeight,
      model,
      positivePrompt,
      negativePrompt,
      steps,
      scale,
      sampler,
      noiseSchedule,
      cfgRescale,
      varietyPlus,
      activePresetId,
      characterPrompts: characterPrompts.map((c) => ({
        id: c.id,
        positive: c.positive,
        negative: c.negative,
        name: c.name,
        enabled: c.enabled,
        position: c.position,
      })),
    };
    localStorage.setItem('mobile_generate_state', JSON.stringify(stateToSave));
  }, [
    localWidth,
    localHeight,
    model,
    positivePrompt,
    negativePrompt,
    steps,
    scale,
    sampler,
    noiseSchedule,
    cfgRescale,
    varietyPlus,
    activePresetId,
    characterPrompts,
  ]);

  // 获取点数
  const fetchAnlas = async () => {
    setIsLoadingAnlas(true);
    try {
      const settings = getAppSettings();
      if (settings.loginMode === 'bot') {
        const result = await botService.getAnlas();
        if (result) {
          setAnlasInfo({ fixedTrainingStepsLeft: result.anlas, purchasedTrainingSteps: 0, isOpus: true });
          updateCachedIsOpus(true);
        }
      } else {
        const info = await getAnlas();
        setAnlasInfo(info);
        if (info) updateCachedIsOpus(info.isOpus);
      }
    } finally {
      setIsLoadingAnlas(false);
    }
  };

  // 加载 Vibes
  const loadVibes = async () => {
    setIsLoadingVibes(true);
    try {
      // 加载本地 Vibes
      const localVibes = await getVibes();
      const localVibeList: VibeFile[] = localVibes.map((v) => ({
        id: v.id, name: v.name, preview: v.preview, image: v.image,
        encodings: v.encodings, defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels,
      }));
      startTransition(() => setLocalVibeFiles(localVibeList));

      // 加载公共 Vibes（强制刷新）
      const publicVibes = await getPublicVibes(true);
      const backendUrl = getBackendUrl();
      const publicVibeList: VibeFile[] = publicVibes.map((v) => ({
        id: v.id || v.filename || `vibe-${Date.now()}`,
        name: v.name,
        preview: v.thumbnail ? (v.thumbnail.startsWith('/') ? `${backendUrl}${v.thumbnail}` : v.thumbnail) : '',
        supportedModels: v.supportedModels,
        defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted,
        fileName: v.filename,  // 保存文件名用于后续获取完整数据
      }));
      startTransition(() => setVibeFiles(publicVibeList));
    } catch (err) {
      console.error('Failed to load vibes:', err);
    } finally {
      setIsLoadingVibes(false);
    }
  };

  // ── Vibe 管理器辅助函数（对齐桌面端）──────────────────────────────────────

  const reloadVibeTagPool = useCallback(async () => {
    const pool = await getVibeTagPool();
    setVibeTagPool(pool);
  }, []);

  // Vibe 管理器打开时加载
  useEffect(() => {
    if (!showVibeModal) return;
    reloadVibeTagPool();
    setVibeRecentEntries(getRecentVibeEntries());
  }, [showVibeModal]);

  // 标签筛选后的本地 vibe 列表
  const vibeTagFilteredLocalFiles = useMemo(() => {
    let files = localVibeFiles;
    if (vibeSearchQuery.trim()) {
      const q = vibeSearchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (vibeSelectedTagFilter.size > 0) {
      files = files.filter(f => {
        const tags = (f as any).tags || [];
        return tags.some((t: string) => vibeSelectedTagFilter.has(t));
      });
    }
    return files;
  }, [localVibeFiles, vibeSearchQuery, vibeSelectedTagFilter]);

  // 标签使用计数
  const vibeTagUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of localVibeFiles) {
      const tags = (f as any).tags || [];
      for (const t of tags) {
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    return counts;
  }, [localVibeFiles]);

  // 加载 CRs
  const loadCRs = async () => {
    setIsLoadingCRs(true);
    try {
      // 加载本地 CRs
      const localCRs = await getCRs();
      const localCRList: CRFile[] = localCRs.map((cr) => ({
        id: cr.id,
        name: cr.name,
        preview: cr.preview,
      }));
      setCrLocalFiles(localCRList);

      // 加载公共 CRs
      const publicCRs = await getPublicCRs();
      const publicCRList: CRFile[] = publicCRs.map((cr) => ({
        id: cr.id,
        name: cr.name,
        preview: cr.preview_url ? getPublicCRPreviewUrl(cr.id) : '',
      }));
      setCrPublicFiles(publicCRList);
    } catch (err) {
      console.error('Failed to load CRs:', err);
    } finally {
      setIsLoadingCRs(false);
    }
  };

  // 加载画师串
  const loadArtists = async () => {
    setIsLoadingArtists(true);
    try {
      // 加载本地画师串
      const localArtists = await getArtists();
      const localArtistList: ArtistFile[] = localArtists
        .filter((a) => a.isLocal)
        .map((a) => ({
          id: a.id,
          name: a.name,
          previews: a.previews || [],
          prompt: a.prompt,
        }));
      setArtistLocalFiles(localArtistList);

      // 加载公共画师串
      const artists = await getPublicArtists();
      const backendUrl = getBackendUrl();
      const artistFiles: ArtistFile[] = artists.map((a) => ({
        id: a.id,
        name: a.name,
        previews: a.preview_url ? [`${backendUrl}${a.preview_url}`] : [],
        prompt: a.artist_string,
      }));
      setArtistPublicFiles(artistFiles);
    } catch (err) {
      console.error('Failed to load artists:', err);
    } finally {
      setIsLoadingArtists(false);
    }
  };

  // 加载 OC
  const loadOCs = async () => {
    setIsLoadingOCs(true);
    try {
      // 加载公共 OC
      const publicOCData = await getPublicOCs();
      const publicOCList: OCFile[] = publicOCData.map((oc) => ({
        id: oc.id,
        name: oc.zh_name || oc.en_name,
        preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
        positive: oc.tag_group || '',
        negative: '',
        user: 'Bot公共库',
        aliases: oc.zh_aliases || [],
        created_by: oc.created_by || '',
        created_at: oc.created_at || 0,
        isLocal: false,
      }));
      setOcPublicFiles(publicOCList);
      setOcLocalFiles(publicOCList.filter((oc) => currentUserId && oc.created_by === currentUserId));
    } catch (err) {
      console.error('Failed to load OCs:', err);
    } finally {
      setIsLoadingOCs(false);
    }
  };

  // 加载预设
  const loadPresets = () => {
    const presets = getPromptPresets();
    setPromptPresets(presets);
    const activeId = getActivePresetId();
    setActivePresetId(activeId);
  };

  // 加载角色Tag映射（用于AI助手）
  const loadRoleTags = async () => {
    try {
      const backendUrl = getBackendUrl();
      const response = await fetch(`${backendUrl}/api/data/role_tag_mapping.json`);
      if (response.ok) {
        const data = await response.json();
        setRoleTagMap(data);
      }
    } catch (error) {
      console.error('加载角色Tag映射失败:', error);
    }
  };

  useEffect(() => {
    fetchAnlas();
    loadVibes();
    loadCRs();
    loadArtists();
    loadOCs();
    loadPresets();
    loadRoleTags();
  }, []);

  useEffect(() => {
    if (showVibeModal) {
      loadVibes();
    }
  }, [showVibeModal]);

  useEffect(() => {
    if (!showOCModal) {
      setSelectedOCIds(new Set());
      setOcSearchQuery('');
      closeOCEditor();
      return;
    }
    loadOCs();
  }, [showOCModal]);

  // 监听预设变化（从设置页面保存后刷新）
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'prompt_presets') {
        loadPresets();
      }
    };
    // 监听自定义事件（同一页面内的变化）
    const handlePresetsUpdate = () => {
      loadPresets();
    };
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('presets-updated', handlePresetsUpdate);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('presets-updated', handlePresetsUpdate);
    };
  }, []);

  // 监听重新生成事件
  useEffect(() => {
    const handleRegenerate = () => {
      if (!isGenerating && !isQueuing && !isPreparing) {
        handleGenerate();
      }
    };
    window.addEventListener('regenerate-image', handleRegenerate);
    return () => window.removeEventListener('regenerate-image', handleRegenerate);
  }, [isGenerating, isQueuing, isPreparing]);

  // 监听从图库页面发来的导入元数据事件
  useEffect(() => {
    const handleOpenImageImport = (event: Event) => {
      const { dataUrl, metadata } = (event as CustomEvent).detail;
      setImportImageDataUrl(dataUrl);
      setImportImageMetadata(metadata || null);
      setIsParsingMetadata(false);
      setTaggerResult(null);
      setShowTaggerResult(false);
      setShowFullMetadata(false);
      setShowImageImportModal(true);
    };
    window.addEventListener('open-image-import', handleOpenImageImport);
    return () => window.removeEventListener('open-image-import', handleOpenImageImport);
  }, []);

  // 监听局部重绘事件
  useEffect(() => {
    const handleInpaintGenerate = async (event: Event) => {
      const customEvent = event as CustomEvent;
      if (isGenerating || isQueuing || isPreparing) return;

      const { imageBase64, maskBase64, strength, width, height, cropInfo } = customEvent.detail;

      // 保存裁切信息用于生成后回贴
      cropInfoRef.current = cropInfo || null;

      try {
        let finalPrompt = expandCollapsibleMarkers(filterHiddenTags(positivePrompt));
        let finalNegative = filterHiddenTags(negativePrompt);

        // 合并预设内容
        const activePreset = promptPresets.find((p) => p.id === activePresetId);
        if (activePreset) {
          if (activePreset.positive) {
            finalPrompt = finalPrompt ? `${activePreset.positive}, ${finalPrompt}` : activePreset.positive;
          }
          if (activePreset.negative) {
            finalNegative = finalNegative ? `${activePreset.negative}, ${finalNegative}` : activePreset.negative;
          }
        }

        if (containsChinese(finalPrompt)) finalPrompt = await translateChineseInPrompt(finalPrompt);
        if (containsChinese(finalNegative)) finalNegative = await translateChineseInPrompt(finalNegative);

        // 处理 Precise Reference 参数 - 支持多图，只处理启用的
        let preciseReferences: { imageBase64: string; mode: 'character&style' | 'character' | 'style'; informationExtracted: number; strength: number }[] | undefined;
        const enabledPreciseRefs = activePreciseRefs.filter(pr => pr.enabled);
        if (enabledPreciseRefs.length > 0) {
          preciseReferences = [];
          for (const pr of enabledPreciseRefs) {
            try {
              const processedBase64 = await processCRImage(pr.preview);
              preciseReferences.push({
                imageBase64: processedBase64,
                mode: pr.mode,
                informationExtracted: pr.informationExtracted,
                strength: pr.strength,
              });
            } catch (error) {
              console.error('Failed to process Precise Reference image:', error);
            }
          }
          if (preciseReferences.length === 0) {
            preciseReferences = undefined;
          }
        }

        // 处理 Vibe 参数 - 优先使用预编码缓存
        const vibeRefs: VibeReference[] = [];
        const currentModelApi = MODEL_MAP[model] || 'nai-diffusion-4-5-full';
        for (const vibe of activeVibes.filter((v) => v.enabled)) {
          let encoding: string | undefined;
          // 1. 使用 findCachedEncoding 查找预编码缓存
          if (vibe.encodings) {
            const vibeDataForCache: VibeData = {
              id: vibe.id, name: vibe.name, size: '', preview: vibe.preview || '',
              image: vibe.image, encodings: vibe.encodings, createdAt: 0,
            };
            const cached = findCachedEncoding(vibeDataForCache, currentModelApi, vibe.informationExtracted);
            if (cached) encoding = cached;
          }
          // 2. 如果本地没有，且是公共 vibe，查询远端编码缓存
          if (!encoding && vibe.isPublic && vibe.fileName) {
            try {
              const remoteEncoding = await fetchPublicVibeEncoding(
                vibe.fileName, currentModelApi, vibe.informationExtracted
              );
              if (remoteEncoding) {
                encoding = remoteEncoding;
                console.log(`使用远端公共编码缓存: ${vibe.name}`);
              }
            } catch (e) {
              console.warn('查询远端编码缓存失败:', e);
            }
          }
          // 3. 如果都没有，调用 API 编码
          if (!encoding && vibe.image) {
            try {
              const result = await encodeVibeImage(vibe.image, vibe.informationExtracted, currentModelApi);
              if (result) {
                encoding = result;
                try {
                  await saveVibeEncoding(vibe.id, currentModelApi, vibe.informationExtracted, result);
                } catch (e) {
                  console.warn('保存编码缓存失败:', e);
                }
              }
            } catch (err) { continue; }
          }
          if (encoding) {
            vibeRefs.push({ encodedVibe: encoding, originalImage: vibe.image, strength: vibe.referenceStrength, informationExtracted: vibe.informationExtracted });
          }
        }

        // 重绘完全独立，不插入图生图
        const result = await generate({
          model,
          positivePrompt: finalPrompt,
          negativePrompt: finalNegative,
          width,
          height,
          seed: seed ? parseInt(seed) : undefined,
          steps,
          scale,
          sampler,
          cfgRescale,
          noiseSchedule,
          ucPreset: 'heavy',
          qualityToggle: true,
          varietyPlus,
          characterPrompts: characterPrompts
            .filter((cp) => cp.enabled && cp.positive.trim())
            .map((cp) => ({
              positive: filterHiddenTags(cp.positive),
              negative: filterHiddenTags(cp.negative),
              enabled: cp.enabled,
              position: cp.position,
            })),
          preciseReferences,
          vibeReferences: vibeRefs.length > 0 ? vibeRefs : undefined,
          inpaint: {
            imageBase64,
            maskBase64,
            strength,
          },
          skipHistory: !!cropInfoRef.current,
        });

        // 裁切/扩图重绘回贴
        const savedCropInfo = cropInfoRef.current;
        if (savedCropInfo && result.success && result.imageData) {
          try {
            const { cropRect, originalImageBase64, originalWidth, originalHeight, isExpand } = savedCropInfo;

            const origImg = new Image();
            await new Promise<void>((resolve) => {
              origImg.onload = () => resolve();
              origImg.src = `data:image/png;base64,${originalImageBase64}`;
            });

            const cropResultBitmap = await createImageBitmap(result.imageData);

            let compositeCanvas: HTMLCanvasElement;

            if (isExpand) {
              // 扩图回贴：创建包含原图+扩展区域的更大画布
              const sel = cropRect;
              const minX = Math.min(0, sel.x);
              const minY = Math.min(0, sel.y);
              const maxX = Math.max(originalWidth, sel.x + sel.width);
              const maxY = Math.max(originalHeight, sel.y + sel.height);
              const finalW = maxX - minX;
              const finalH = maxY - minY;

              compositeCanvas = document.createElement('canvas');
              compositeCanvas.width = finalW;
              compositeCanvas.height = finalH;
              const ctx = compositeCanvas.getContext('2d')!;
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, finalW, finalH);
              // 绘制原图
              ctx.drawImage(origImg, -minX, -minY);
              // 绘制生成结果到选区位置
              ctx.drawImage(cropResultBitmap, sel.x - minX, sel.y - minY, sel.width, sel.height);

              const compositeBlob = await new Promise<Blob>((resolve) => {
                compositeCanvas.toBlob((blob) => resolve(blob!), 'image/png');
              });
              const compositeUrl = URL.createObjectURL(compositeBlob);
              addInpaintedImage(compositeUrl, finalW, finalH, result.seed || 0);
            } else {
              // 裁切回贴：将裁切结果贴回原图
              compositeCanvas = document.createElement('canvas');
              compositeCanvas.width = originalWidth;
              compositeCanvas.height = originalHeight;
              const ctx = compositeCanvas.getContext('2d')!;
              ctx.drawImage(origImg, 0, 0);
              ctx.drawImage(cropResultBitmap, cropRect.x, cropRect.y, cropRect.width, cropRect.height);

              const compositeBlob = await new Promise<Blob>((resolve) => {
                compositeCanvas.toBlob((blob) => resolve(blob!), 'image/png');
              });
              const compositeUrl = URL.createObjectURL(compositeBlob);
              addInpaintedImage(compositeUrl, originalWidth, originalHeight, result.seed || 0);
            }
            window.dispatchEvent(new Event('inpaint-pasteback-done'));
          } catch (err) {
            console.error('裁切/扩图重绘回贴失败:', err);
            window.dispatchEvent(new Event('inpaint-pasteback-done'));
          }
          cropInfoRef.current = null;
        }
      } catch (error) {
        console.error('局部重绘失败:', error);
        savedInpaintRef.current = null;
        setHasInpaintParams(false);
        cropInfoRef.current = null;
      }
    };

    window.addEventListener('inpaint-generate', handleInpaintGenerate);
    return () => window.removeEventListener('inpaint-generate', handleInpaintGenerate);
  }, [isGenerating, isQueuing, isPreparing, positivePrompt, negativePrompt, promptPresets, activePresetId, model, seed, steps, scale, sampler, cfgRescale, noiseSchedule, varietyPlus, characterPrompts, generate, addInpaintedImage, activePreciseRefs, activeVibes]);

  // 监听重绘面板的强度变化，同步到图生图区域
  useEffect(() => {
    const handler = (e: Event) => {
      const { strength } = (e as CustomEvent).detail;
      setInpaintStrength(strength);
      if (savedInpaintRef.current) {
        savedInpaintRef.current.strength = strength;
      }
    };
    window.addEventListener('inpaint-panel-strength-change', handler);
    return () => window.removeEventListener('inpaint-panel-strength-change', handler);
  }, []);

  // 生成完成后刷新点数
  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      fetchAnlas();
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  // 翻译处理
  const handleTranslate = async () => {
    const hasChinese = containsChinese(positivePrompt) || containsChinese(negativePrompt);
    if (hasChinese) {
      setIsTranslating(true);
      try {
        if (containsChinese(positivePrompt)) {
          setPositivePrompt(await translateChineseInPrompt(positivePrompt));
        }
        if (containsChinese(negativePrompt)) {
          setNegativePrompt(await translateChineseInPrompt(negativePrompt));
        }
      } finally {
        setIsTranslating(false);
      }
    }
  };

  // AI 生成处理
  const handleAIGenerate = async (request: string) => {
    if (!request || isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      agentService.setContext({
        currentPositive: positivePrompt,
        currentNegative: negativePrompt,
        currentCharacters: characterPrompts
          .filter((c) => c.enabled && c.positive.trim())
          .map((c) => ({
            name: c.name || '未命名角色',
            positive: c.positive,
            negative: c.negative || undefined,
          })),
        vibes: activeVibes.map((v) => ({ id: v.id, name: v.name, supportedModels: v.supportedModels || [] })),
        artists: [...artistPublicFiles, ...artistLocalFiles].map((a) => ({
          id: a.id,
          name: a.name,
          prompt: a.prompt,
        })),
        ocs: [...ocPublicFiles, ...ocLocalFiles].map((o) => ({
          id: o.id,
          name: o.name,
          zhName: o.name,
          positive: o.positive,
          negative: o.negative || '',
        })),
        roleTags: roleTagMap,
      });
      const result = await agentService.execute(request, aiModel);
      if (result) {
        // 应用正向提示词
        if (result.positive !== undefined) setPositivePrompt(result.positive);
        // 应用反向提示词
        if (result.negative !== undefined) setNegativePrompt(result.negative);
        // 应用角色提示词
        if (result.characters && result.characters.length > 0) {
          const newChars = result.characters.map((char, index) => ({
            id: `${Date.now()}-${index}`,
            positive: char.positive,
            negative: char.negative || '',
            activeTab: 'prompt' as const,
            enabled: true,
            name: char.name || `角色${index + 1}`,
          }));
          setCharacterPrompts(newChars.slice(0, 6));
        }
        // 应用 Vibe（result.vibes 是 ID 数组）
        if (result.vibes && result.vibes.length > 0) {
          const allVibes = [...vibeFiles, ...localVibeFiles];
          const newActiveVibes: ActiveVibe[] = [];
          for (const id of result.vibes) {
            const file = allVibes.find((f) => f.id === id);
            if (file) {
              newActiveVibes.push({
                ...file,
                referenceStrength: file.defaultStrength ?? 0.5,
                informationExtracted: file.defaultInfoExtracted ?? 0.5,
                enabled: true,
              });
            }
          }
          if (newActiveVibes.length > 0) {
            setActiveVibes(newActiveVibes);
            // Vibe 和 CR 互斥
            setActiveCR(null);
          }
        }
      }
    } catch (err) {
      console.error('AI generation failed:', err);
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  // AI 重新生成处理（使用指定的前置状态）
  const handleAIRegenerate = async (
    request: string,
    preState: { positive: string; negative: string; characters: { positive: string; negative?: string; name?: string }[] },
    imageBase64?: string,
  ) => {
    if (!request || isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      agentService.setContext({
        currentPositive: preState.positive,
        currentNegative: preState.negative,
        currentCharacters: preState.characters.map((c, i) => ({
          name: c.name || `角色${i + 1}`,
          positive: c.positive,
          negative: c.negative,
        })),
        vibes: activeVibes.map((v) => ({ id: v.id, name: v.name, supportedModels: v.supportedModels || [] })),
        artists: [...artistPublicFiles, ...artistLocalFiles].map((a) => ({
          id: a.id,
          name: a.name,
          prompt: a.prompt,
        })),
        ocs: [...ocPublicFiles, ...ocLocalFiles].map((o) => ({
          id: o.id,
          name: o.name,
          zhName: o.name,
          positive: o.positive,
          negative: o.negative || '',
        })),
        roleTags: roleTagMap,
      });
      const result = await agentService.execute(request, aiModel, true, imageBase64);
      if (result) {
        // 应用正向提示词
        if (result.positive !== undefined) setPositivePrompt(result.positive);
        // 应用反向提示词
        if (result.negative !== undefined) setNegativePrompt(result.negative);
        // 应用角色提示词
        if (result.characters && result.characters.length > 0) {
          const newChars = result.characters.map((char, index) => ({
            id: `${Date.now()}-${index}`,
            positive: char.positive,
            negative: char.negative || '',
            activeTab: 'prompt' as const,
            enabled: true,
            name: char.name || `角色${index + 1}`,
          }));
          setCharacterPrompts(newChars.slice(0, 6));
        }
        // 应用 Vibe（result.vibes 是 ID 数组）
        if (result.vibes && result.vibes.length > 0) {
          const allVibes = [...vibeFiles, ...localVibeFiles];
          const newActiveVibes: ActiveVibe[] = [];
          for (const id of result.vibes) {
            const file = allVibes.find((f) => f.id === id);
            if (file) {
              newActiveVibes.push({
                ...file,
                referenceStrength: file.defaultStrength ?? 0.5,
                informationExtracted: file.defaultInfoExtracted ?? 0.5,
                enabled: true,
              });
            }
          }
          if (newActiveVibes.length > 0) {
            setActiveVibes(newActiveVibes);
            // Vibe 和 CR 互斥
            setActiveCR(null);
          }
        }
      }
    } catch (err) {
      console.error('AI regeneration failed:', err);
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  // 恢复快照
  const handleRestoreSnapshot = (snapshot: {
    positive: string;
    negative: string;
    characters: { positive: string; negative?: string; name?: string }[];
    vibes: string[];
  }) => {
    setPositivePrompt(snapshot.positive);
    setNegativePrompt(snapshot.negative);
    if (snapshot.characters.length > 0) {
      setCharacterPrompts(
        snapshot.characters.map((c, i) => ({
          id: `${Date.now()}-${i}`,
          positive: c.positive,
          negative: c.negative || '',
          activeTab: 'prompt' as const,
          enabled: true,
          name: c.name || `角色${i + 1}`,
        }))
      );
    } else {
      setCharacterPrompts([]);
    }
    restoreSnapshotVibes(snapshot.vibes);
  };

  // Vibe 操作
  const restoreSnapshotVibes = (snapshotVibes: string[]) => {
    const allVibes = [...vibeFiles, ...localVibeFiles];
    if (snapshotVibes.length === 0) {
      setActiveVibes([]);
      return;
    }

    const restoredVibes: ActiveVibe[] = [];
    for (const vibeRef of snapshotVibes) {
      const file = allVibes.find((v) =>
        v.id === vibeRef ||
        v.name === vibeRef ||
        v.name.toLowerCase() === vibeRef.toLowerCase()
      );
      if (!file) continue;
      restoredVibes.push({
        ...file,
        referenceStrength: file.defaultStrength ?? 0.5,
        informationExtracted: file.defaultInfoExtracted ?? 1,
        enabled: true,
      });
    }

    setActiveVibes(restoredVibes);
    if (restoredVibes.length > 0) {
      setActiveCR(null);
    }
  };

  const handleAddVibe = async (vibe: VibeFile) => {
    if (activeVibes.some((v) => v.id === vibe.id)) return;

    // 判断是否是公共vibe（没有image字段但有fileName）
    const isPublicVibe = !vibe.image && vibeFiles.some(v => v.id === vibe.id);
    const publicVibeFile = isPublicVibe ? vibeFiles.find(v => v.id === vibe.id) : null;

    // 先添加到列表（可能没有完整数据）
    setActiveVibes((prev) => [
      ...prev,
      {
        ...vibe,
        referenceStrength: vibe.defaultStrength ?? 0.6,
        informationExtracted: vibe.defaultInfoExtracted ?? 1,
        enabled: true,
        isPublic: isPublicVibe,
      },
    ]);
    // CR 和 Vibe 互斥：启用 Vibe 时清空 CR
    setActiveCR(null);

    // 如果是公共vibe，异步加载完整数据
    if (isPublicVibe && publicVibeFile?.fileName) {
      setLoadingVibeIds(prev => new Set(prev).add(vibe.id));
      try {
        const fullData = await getPublicVibeFile(publicVibeFile.fileName);
        if (fullData) {
          // 加载完成后更新对应的 vibe
          setActiveVibes(prev => prev.map(v =>
            v.id === vibe.id ? {
              ...v,
              image: fullData.image as string,
              encodings: fullData.encodings as VibeData['encodings'],
            } : v
          ));
        }
      } catch (err) {
        console.error('Failed to load public vibe file:', err);
      } finally {
        setLoadingVibeIds(prev => {
          const next = new Set(prev);
          next.delete(vibe.id);
          return next;
        });
      }
    }
  };

  const handleRemoveVibe = (id: string) => {
    setActiveVibes((prev) => prev.filter((v) => v.id !== id));
  };

  const handleCollectPublicVibe = async (vibe: VibeFile) => {
    if (localVibeFiles.some((localVibe) => localVibe.id === vibe.id)) {
      alert('该 Vibe 已在本地');
      return;
    }
    if (!vibe.fileName) {
      alert('该公共 Vibe 缺少文件信息');
      return;
    }

    setCollectingVibeIds((prev) => new Set(prev).add(vibe.id));
    try {
      const fullData = await getPublicVibeFile(vibe.fileName);
      if (!fullData) {
        throw new Error('获取公共 Vibe 失败');
      }

      const importInfo = typeof fullData.importInfo === 'object' && fullData.importInfo
        ? fullData.importInfo as Record<string, unknown>
        : null;

      const saved = await saveVibe({
        id: String(fullData.id || vibe.id),
        name: String(fullData.name || vibe.name),
        size: String(fullData.size || '0.00 MB'),
        preview: String(fullData.thumbnail || vibe.preview || ''),
        image: typeof fullData.image === 'string' ? fullData.image : '',
        encodings: (fullData.encodings as VibeData['encodings']) || {},
        createdAt: typeof fullData.createdAt === 'number' ? fullData.createdAt : Date.now(),
        defaultStrength: typeof fullData.defaultStrength === 'number'
          ? fullData.defaultStrength
          : (typeof importInfo?.strength === 'number' ? importInfo.strength : vibe.defaultStrength),
        defaultInfoExtracted: typeof fullData.defaultInfoExtracted === 'number'
          ? fullData.defaultInfoExtracted
          : (typeof importInfo?.information_extracted === 'number' ? importInfo.information_extracted : vibe.defaultInfoExtracted),
        supportedModels: Array.isArray(fullData.supportedModels)
          ? fullData.supportedModels as string[]
          : (fullData.encodings ? Object.keys(fullData.encodings as Record<string, unknown>) : vibe.supportedModels),
      });

      setLocalVibeFiles((prev) => {
        if (prev.some((item) => item.id === saved.id)) return prev;
        return [{
          id: saved.id,
          name: saved.name,
          preview: saved.preview,
          image: saved.image,
          encodings: saved.encodings,
          defaultStrength: saved.defaultStrength,
          defaultInfoExtracted: saved.defaultInfoExtracted,
          supportedModels: saved.supportedModels,
        }, ...prev];
      });
    } catch (err) {
      console.error('Collect public vibe failed:', err);
      alert('收藏失败: ' + (err as Error).message);
    } finally {
      setCollectingVibeIds((prev) => {
        const next = new Set(prev);
        next.delete(vibe.id);
        return next;
      });
    }
  };

  const handleUnifiedVibeImport = async (file: File) => {
    try {
      setIsLoadingVibes(true);
      const isImage = file.type.startsWith('image/');
      const isVibeBundle = file.name.endsWith('.naiv4vibebundle');
      const isVibeFile = file.name.endsWith('.naiv4vibe');

      if (isImage) {
        const newVibe = await createVibeFromImage(file);
        setLocalVibeFiles((prev) => [{
          id: newVibe.id,
          name: newVibe.name,
          preview: newVibe.preview,
          image: newVibe.image,
          encodings: newVibe.encodings,
          defaultStrength: newVibe.defaultStrength,
          defaultInfoExtracted: newVibe.defaultInfoExtracted,
          supportedModels: newVibe.supportedModels,
        }, ...prev]);
        return;
      }

      if (isVibeBundle || isVibeFile) {
        const newVibes = isVibeBundle
          ? await importVibeBundleFromFile(file)
          : [await importVibeFromFile(file)];

        setLocalVibeFiles((prev) => [
          ...newVibes.map((v) => ({
            id: v.id,
            name: v.name,
            preview: v.preview,
            image: v.image,
            encodings: v.encodings,
            defaultStrength: v.defaultStrength,
            defaultInfoExtracted: v.defaultInfoExtracted,
            supportedModels: v.supportedModels,
          })),
          ...prev,
        ]);
        return;
      }

      throw new Error('仅支持图片、.naiv4vibe 或 .naiv4vibebundle 文件');
    } catch (err) {
      console.error('Unified vibe import failed:', err);
      alert('导入失败: ' + (err as Error).message);
    } finally {
      setIsLoadingVibes(false);
    }
  };

  // Precise Reference 操作
  const handleSelectCR = (cr: CRFile) => {
    const existingIndex = activePreciseRefs.findIndex(pr => pr.id === cr.id);
    if (existingIndex >= 0) {
      // 取消选中
      setActivePreciseRefs(prev => prev.filter(pr => pr.id !== cr.id));
    } else {
      // 添加选中
      setActivePreciseRefs(prev => [...prev, {
        id: cr.id,
        name: cr.name,
        preview: cr.preview,
        mode: 'character&style',
        informationExtracted: 1,
        strength: 1,
        enabled: true,
      }]);
      // Precise Reference 和 Vibe 互斥
      setActiveVibes([]);
    }
  };

  const handleRemoveCR = () => {
    setActivePreciseRefs([]);
  };

  const removePreciseRef = (id: string) => {
    setActivePreciseRefs(prev => prev.filter(pr => pr.id !== id));
  };

  const updatePreciseRefParam = (id: string, updates: Partial<ActivePreciseRef>) => {
    setActivePreciseRefs(prev => prev.map(pr =>
      pr.id === id ? { ...pr, ...updates } : pr
    ));
  };

  // Character Prompt 操作
  const addCharacterPrompt = () => {
    if (characterPrompts.length >= 6) return;
    setCharacterPrompts((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        positive: '',
        negative: '',
        activeTab: 'prompt',
        enabled: true,
      },
    ]);
  };

  const removeCharacterPrompt = (id: string) => {
    setCharacterPrompts((prev) => prev.filter((p) => p.id !== id));
  };

  const updateCharacterPrompt = (
    id: string,
    field: 'positive' | 'negative' | 'activeTab' | 'enabled' | 'name' | 'position',
    value: any
  ) => {
    setCharacterPrompts((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const moveCharacterPrompt = (index: number, direction: -1 | 1) => {
    setCharacterPrompts((prev) => {
      const newPrompts = [...prev];
      if (index + direction >= 0 && index + direction < newPrompts.length) {
        [newPrompts[index], newPrompts[index + direction]] = [
          newPrompts[index + direction],
          newPrompts[index],
        ];
      }
      return newPrompts;
    });
  };

  const clearAllCharacterPrompts = () => {
    setCharacterPrompts([]);
  };

  // 生成图片
  const handleGenerate = async () => {
    if (isGenerating || isQueuing || isPreparing) return;

    // 检查登录状态
    if (!isAuthenticated) {
      requireAuth(() => handleGenerate());
      return;
    }

    setIsPreparing(true);
    try {
      let finalPrompt = expandCollapsibleMarkers(filterHiddenTags(positivePrompt));
      let finalNegative = filterHiddenTags(negativePrompt);

      // 合并预设内容
      const activePreset = promptPresets.find((p) => p.id === activePresetId);
      if (activePreset) {
        if (activePreset.positive) {
          finalPrompt = finalPrompt ? `${activePreset.positive}, ${finalPrompt}` : activePreset.positive;
        }
        if (activePreset.negative) {
          finalNegative = finalNegative ? `${activePreset.negative}, ${finalNegative}` : activePreset.negative;
        }
      }

      if (containsChinese(finalPrompt)) finalPrompt = await translateChineseInPrompt(finalPrompt);
      if (containsChinese(finalNegative)) finalNegative = await translateChineseInPrompt(finalNegative);

      const vibeRefs: VibeReference[] = [];
      const currentModelApi = MODEL_MAP[model] || 'nai-diffusion-4-5-full';
      for (const vibe of activeVibes.filter((v) => v.enabled)) {
        let encoding: string | undefined;
        // 1. 使用 findCachedEncoding 查找预编码缓存（正确处理 encoding key 映射）
        if (vibe.encodings) {
          const vibeDataForCache: VibeData = {
            id: vibe.id,
            name: vibe.name,
            size: '',
            preview: vibe.preview || '',
            image: vibe.image,
            encodings: vibe.encodings,
            createdAt: 0,
          };
          const cached = findCachedEncoding(vibeDataForCache, currentModelApi, vibe.informationExtracted);
          if (cached) encoding = cached;
        }
        // 2. 如果没有预编码，调用 API 编码
        if (!encoding && vibe.image) {
          try {
            const result = await encodeVibeImage(vibe.image, vibe.informationExtracted, currentModelApi);
            if (result) {
              encoding = result;
              // 保存到 IndexedDB（持久化）
              try {
                await saveVibeEncoding(vibe.id, currentModelApi, vibe.informationExtracted, result);
              } catch (e) {
                console.warn('保存编码缓存失败:', e);
              }
            }
          } catch (err) { continue; }
        }
        if (encoding) {
          vibeRefs.push({ encodedVibe: encoding, originalImage: vibe.image, strength: vibe.referenceStrength, informationExtracted: vibe.informationExtracted });
        }
      }

      // 处理 Precise Reference 参数 - 支持多图，只处理启用的
      let preciseReferences: { imageBase64: string; mode: 'character&style' | 'character' | 'style'; informationExtracted: number; strength: number }[] | undefined;
      const enabledPreciseRefs = activePreciseRefs.filter(pr => pr.enabled);
      if (enabledPreciseRefs.length > 0) {
        preciseReferences = [];
        for (const pr of enabledPreciseRefs) {
          try {
            const processedBase64 = await processCRImage(pr.preview);
            preciseReferences.push({
              imageBase64: processedBase64,
              mode: pr.mode,
              informationExtracted: pr.informationExtracted,
              strength: pr.strength,
            });
          } catch (error) {
            console.error('Failed to process Precise Reference image:', error);
          }
        }
        if (preciseReferences.length === 0) {
          preciseReferences = undefined;
        }
      }

      // 处理 Image2Image 参数
      let img2img: { imageBase64: string; strength: number; noise: number } | undefined;
      if (img2imgImage) {
        try {
          const processedBase64 = await processImg2ImgImage(img2imgImage, localWidth, localHeight);
          img2img = {
            imageBase64: processedBase64,
            strength: img2imgStrength,
            noise: img2imgNoise,
          };
        } catch (error) {
          console.error('Failed to process img2img image:', error);
        }
      }

      // 如果有保存的重绘参数，注入 inpaint 参数（优先于 img2img）
      const inpaintParams = savedInpaintRef.current ? {
        inpaint: {
          imageBase64: savedInpaintRef.current.imageBase64,
          maskBase64: savedInpaintRef.current.maskBase64,
          strength: savedInpaintRef.current.strength,
        },
      } : {};

      await generate({
        model, positivePrompt: finalPrompt, negativePrompt: finalNegative,
        width: savedInpaintRef.current ? savedInpaintRef.current.width : localWidth,
        height: savedInpaintRef.current ? savedInpaintRef.current.height : localHeight,
        seed: seed ? parseInt(seed) : Math.floor(Math.random() * 4294967295),
        steps, scale, sampler, cfgRescale,
        noiseSchedule, ucPreset: 'heavy', qualityToggle: true, varietyPlus,
        vibeReferences: vibeRefs.length > 0 ? vibeRefs : undefined,
        characterPrompts: characterPrompts
          .filter((cp) => cp.enabled && cp.positive.trim())
          .map((cp) => ({
            positive: filterHiddenTags(cp.positive),
            negative: filterHiddenTags(cp.negative),
            enabled: cp.enabled,
            position: cp.position,
          })),
        preciseReferences,
        img2img: savedInpaintRef.current ? undefined : img2img, // 有重绘参数时不使用 img2img
        ...inpaintParams,
      });
    } finally {
      setIsPreparing(false);
    }
  };

  const currentResLabel = [...RESOLUTIONS, ...LARGE_RESOLUTIONS, ...WALLPAPER_RESOLUTIONS].find(
    (r) => r.width === localWidth && r.height === localHeight
  )?.label || '自定义';

  const handleInspirationSelect = (prompt: string) => {
    // 检测 charN: 模式，自动拆分到角色提示词
    const parsed = parseCharacterPromptContent(prompt);
    if (parsed.characters.length > 0) {
      const basePrompt = parsed.basePrompt.replace(/,\s*$/, '').trim();
      if (basePrompt) {
        setPositivePrompt((prev: string) => (prev ? `${prev}, ${basePrompt}` : basePrompt));
      }
      const newChars = parsed.characters.slice(0, 6 - characterPrompts.length).map((c, i) => ({
        id: `${Date.now()}-codex-${i}`,
        positive: c.content.replace(/,\s*$/, '').trim(),
        negative: (c.negative || '').replace(/,\s*$/, '').trim(),
        activeTab: 'prompt' as const,
        enabled: true,
        name: c.label,
      }));
      if (newChars.length > 0) {
        setCharacterPrompts(prev => [...prev, ...newChars].slice(0, 6));
      }
    } else {
      setPositivePrompt((prev: string) => (prev ? `${prev}, ${prompt}` : prompt));
    }
    setIsInspirationModalOpen(false);
  };

  // 加载法典数据
  const loadCodex = async () => {
    if (codexData.length > 0) return;
    setIsLoadingCodex(true);
    try {
      const data = await loadCodexData();
      setCodexData(data);
    } catch (err) {
      console.error('Failed to load codex:', err);
    } finally {
      setIsLoadingCodex(false);
    }
  };

  // 分类按 NSFW/Common 分组
  const categoriesByType = useMemo(() => {
    const nsfwCategories = new Set<string>();
    const commonCategories = new Set<string>();

    codexData.forEach(item => {
      if (item.isR18) {
        nsfwCategories.add(item.category);
      } else {
        commonCategories.add(item.category);
      }
    });

    return {
      nsfw: Array.from(nsfwCategories).sort(),
      common: Array.from(commonCategories).sort()
    };
  }, [codexData]);

  // 过滤法典数据
  const filteredCodexData = useMemo(() => {
    return codexData.filter((item) => {
      // 搜索过滤
      if (codexSearchQuery) {
        const query = codexSearchQuery.toLowerCase();
        if (!item.title.toLowerCase().includes(query) && !item.content.toLowerCase().includes(query)) {
          return false;
        }
      }
      // R18 过滤
      if (codexR18Filter === 'safe' && item.isR18) return false;
      if (codexR18Filter === 'r18' && !item.isR18) return false;
      // 分类过滤
      if (codexSelectedCategories.length > 0) {
        const itemKey = `${item.isR18 ? 'nsfw' : 'common'}:${item.category}`;
        if (!codexSelectedCategories.includes(itemKey)) return false;
      }
      return true;
    });
  }, [codexData, codexSearchQuery, codexR18Filter, codexSelectedCategories]);

  // 切换分类选择
  const toggleCodexCategory = (cat: string) => {
    setCodexSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    );
  };

  // 重置懒加载计数（当筛选条件变化时）
  useEffect(() => {
    setCodexDisplayCount(30);
  }, [codexSearchQuery, codexR18Filter, codexSelectedCategories]);

  // 滚动加载更多
  const handleCodexScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 200 && codexDisplayCount < filteredCodexData.length) {
      setCodexDisplayCount(prev => Math.min(prev + 30, filteredCodexData.length));
    }
  };

  // 随机灵感
  const handleRandomCodex = () => {
    if (filteredCodexData.length > 0) {
      const randomItem = filteredCodexData[Math.floor(Math.random() * filteredCodexData.length)];
      setRandomCodexItem(randomItem);
      setInspirationTab('random');
    }
  };

  // 打开灵感弹窗时加载数据
  useEffect(() => {
    if (isInspirationModalOpen) {
      loadCodex();
    }
  }, [isInspirationModalOpen]);

  // 画师串选择处理（单选）
  const handleSelectArtist = (artist: ArtistFile) => {
    setSelectedArtistId((prev) => (prev === artist.id ? null : artist.id));
  };

  // 确认画师串选择
  const handleConfirmArtists = () => {
    if (selectedArtistId) {
      const allArtists = [...artistPublicFiles, ...artistLocalFiles];
      const selectedArtist = allArtists.find((a) => a.id === selectedArtistId);
      if (selectedArtist) {
        const marker = makeArtistMarker(selectedArtist.name, selectedArtist.prompt);
        setPositivePrompt((prev: string) => (prev ? `${prev}, ${marker}` : marker));
      }
    }
    setSelectedArtistId(null);
    setShowArtistModal(false);
  };

  // 清空画师串选择
  const handleClearArtists = () => {
    setSelectedArtistId(null);
  };

  const closeOCEditor = () => {
    setOcEditorMode(null);
    setEditingOCId(null);
    setOcDraftName('');
    setOcDraftAliases('');
    setOcDraftPositive('');
    setOcDraftPreview('');
  };

  const openCreateOC = () => {
    if (!isAuthenticated) {
      requireAuth(() => {
        closeOCEditor();
        setOcEditorMode('create');
      });
      return;
    }
    closeOCEditor();
    setOcEditorMode('create');
  };

  const openEditOC = (oc: OCFile) => {
    setEditingOCId(oc.id);
    setOcDraftName(oc.name);
    setOcDraftAliases((oc.aliases || []).join(', '));
    setOcDraftPositive(oc.positive);
    setOcDraftPreview(oc.preview || '');
    setOcEditorMode('edit');
  };

  const handleToggleOCSelection = (oc: OCFile) => {
    setSelectedOCIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(oc.id)) {
        newSet.delete(oc.id);
        return newSet;
      }
      if (newSet.size >= 6) {
        alert('最多只能选择 6 个 OC');
        return prev;
      }
      if (!oc.positive.trim()) {
        alert('该 OC 没有可用的提示词');
        return prev;
      }
      newSet.add(oc.id);
      return newSet;
    });
  };

  const handleSaveOC = async () => {
    const name = ocDraftName.trim();
    const aliases = ocDraftAliases
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
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

      if (editingOCId) {
        const result = await updatePublicOC(editingOCId, {
          zh_name: name,
          tag_group: positive,
          preview_base64: previewBase64,
          zh_aliases: aliases.length > 0 ? aliases : undefined,
        });
        if (!result.success || !result.oc) {
          alert(`更新失败: ${result.message}`);
          return;
        }
      } else {
        const result = await createPublicOC({
          zh_name: name,
          tag_group: positive,
          preview_base64: previewBase64,
          zh_aliases: aliases.length > 0 ? aliases : undefined,
          created_by: currentUserId || undefined,
        });
        if (!result.success || !result.oc) {
          alert(`创建失败: ${result.message}`);
          return;
        }
      }

      await loadOCs();
      closeOCEditor();
    } finally {
      setIsSavingOC(false);
    }
  };

  const handleDeleteLocalOC = async (oc: OCFile) => {
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
  };

  const handleGenerateOCPreview = async () => {
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
  };

  const handlePasteOCPrompt = async () => {
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
    if (manualText) {
      setOcDraftPositive(manualText);
    }
  };

  const handleConfirmOC = () => {
    if (selectedOCIds.size === 0) {
      setShowOCModal(false);
      return;
    }

    const allOCsMap = new Map([...ocPublicFiles, ...ocLocalFiles].map(oc => [oc.id, oc]));
    const selectedOCs = Array.from(selectedOCIds).map(id => allOCsMap.get(id)).filter(Boolean) as typeof ocPublicFiles;
    const availableSlots = Math.max(0, 6 - characterPrompts.length);
    const newCharacters: CharacterPrompt[] = selectedOCs
      .slice(0, availableSlots)
      .map((oc) => ({
        id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        positive: oc.positive || '',
        negative: oc.negative || '',
        activeTab: 'prompt' as const,
        enabled: true,
        name: oc.name,
      }));

    if (newCharacters.length < selectedOCs.length) {
      alert('角色提示词最多 6 个，已按剩余槽位添加');
    }

    if (newCharacters.length > 0) {
      setCharacterPrompts((prev) => [...prev, ...newCharacters]);
    }

    setSelectedOCIds(new Set());
    setShowOCModal(false);
  };

  const handleClearOC = () => {
    setSelectedOCIds(new Set());
  };

  const filteredOCs = useMemo(() => {
    const source = ocTab === 'public' ? ocPublicFiles : ocLocalFiles;
    const query = ocSearchQuery.trim().toLowerCase();
    if (!query) return source;
    return source.filter((oc) =>
      oc.name.toLowerCase().includes(query) ||
      oc.positive.toLowerCase().includes(query) ||
      (oc.created_by || '').toLowerCase().includes(query)
    );
  }, [ocLocalFiles, ocPublicFiles, ocSearchQuery, ocTab]);

  // 预设应用处理 - 只切换预设，不修改提示词内容
  const handleApplyPreset = (preset: PromptPresetData) => {
    setActivePresetId(preset.id);
    saveActivePresetId(preset.id);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden bg-nai-bg">
      {/* 顶部栏 */}
      <header className="flex-shrink-0 flex items-center justify-between px-3 py-2 bg-nai-panel border-b border-gray-800">
        <div className="relative flex-1 max-w-[220px]">
          <button
            onClick={() => setShowModelDropdown(!showModelDropdown)}
            className="w-full flex items-center justify-between px-3 py-1.5 bg-gray-800/80 border border-gray-700/50 rounded-lg text-sm active:scale-[0.98]"
          >
            <span className="font-medium text-white">{MODELS.find((m) => m.id === model)?.name}</span>
            <ChevronDown className={`w-4 h-4 ml-1.5 text-gray-400 transition-transform ${showModelDropdown ? 'rotate-180' : ''}`} />
          </button>
          {showModelDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowModelDropdown(false)} />
              <div className="absolute z-50 w-full mt-1 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden animate-fade-in">
                {MODELS.map((m) => (
                  <button key={m.id} onClick={() => { setModel(m.id); setShowModelDropdown(false); }}
                    className={`w-full px-3 py-2.5 text-left text-sm ${model === m.id ? 'bg-gray-700 text-nai-accent' : 'hover:bg-gray-700'}`}>
                    <div className="font-medium">{m.name}</div>
                    <div className="text-xs text-gray-500">{m.desc}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchAnlas} disabled={isLoadingAnlas}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-800/80 border border-gray-700/50 rounded-lg active:scale-[0.98]">
            <span className="text-base">💎</span>
            <span className="text-sm font-mono text-nai-accent min-w-[32px]">
              {isLoadingAnlas ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : anlasInfo ? anlasInfo.fixedTrainingStepsLeft + anlasInfo.purchasedTrainingSteps : '—'}
            </span>
          </button>
        </div>
      </header>

      {/* 可滚动内容区 */}
      <div className="flex-1 overflow-y-auto scrollbar-hide">
        <div className="p-3 space-y-3">
          {/* 提示词展示卡片 - 点击进入编辑 */}
          <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
            {/* 正向提示词 */}
            <div className="w-full text-left p-3 border-b border-gray-700/30">
              <div className="flex items-center justify-between mb-2">
                <div
                  className="flex items-center gap-2 flex-1 cursor-pointer"
                  onClick={() => setEditorOpen('prompt')}
                >
                  <div className="w-2 h-2 rounded-full bg-nai-accent shadow-[0_0_8px_rgba(235,213,118,0.5)]" />
                  <span className="text-sm font-bold text-nai-accent">提示词</span>
                  <span className={`text-xs font-mono ${positiveTokens > 512 ? 'text-red-400' : 'text-gray-500'}`}>{positiveTokens}/512</span>
                </div>
                <div className="flex items-center gap-1">
                  {positivePrompt && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPositivePrompt('');
                      }}
                      className="p-1.5 text-gray-500 hover:text-red-400 active:scale-95 transition-all rounded-lg"
                      title="清空"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                  <ChevronRight
                    className="w-5 h-5 text-gray-500 cursor-pointer"
                    onClick={() => setEditorOpen('prompt')}
                  />
                </div>
              </div>
              <div
                className={`text-sm leading-relaxed line-clamp-3 cursor-pointer active:bg-gray-800/50 -mx-3 -mb-3 px-3 pb-3 pt-1 transition-colors ${positivePrompt ? 'text-gray-300' : 'text-gray-600'}`}
                onClick={() => setEditorOpen('prompt')}
              >
                {positivePrompt
                  ? splitPromptToTags(positivePrompt).filter(t => t !== NEWLINE_SENTINEL).map(t => {
                    const m = parseCollapsibleMarker(t);
                    return m ? `[${getMarkerVisual(m.type).label}·${m.name}]` : t;
                  }).join(', ')
                  : '点击输入提示词...'}
              </div>
            </div>

            {/* 负向提示词 */}
            <div className="w-full text-left p-3 border-b border-gray-700/30">
              <div className="flex items-center justify-between mb-2">
                <div
                  className="flex items-center gap-2 flex-1 cursor-pointer"
                  onClick={() => setEditorOpen('undesired')}
                >
                  <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
                  <span className="text-sm font-bold text-red-400">排除内容</span>
                  <span className={`text-xs font-mono ${negativeTokens > 512 ? 'text-red-400' : 'text-gray-500'}`}>{negativeTokens}/512</span>
                </div>
                <div className="flex items-center gap-1">
                  {negativePrompt && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setNegativePrompt('');
                      }}
                      className="p-1.5 text-gray-500 hover:text-red-400 active:scale-95 transition-all rounded-lg"
                      title="清空"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                  <ChevronRight
                    className="w-5 h-5 text-gray-500 cursor-pointer"
                    onClick={() => setEditorOpen('undesired')}
                  />
                </div>
              </div>
              <div
                className={`text-sm leading-relaxed line-clamp-2 cursor-pointer active:bg-gray-800/50 -mx-3 -mb-3 px-3 pb-3 pt-1 transition-colors ${negativePrompt ? 'text-gray-300' : 'text-gray-600'}`}
                onClick={() => setEditorOpen('undesired')}
              >
                {negativePrompt || '点击输入排除内容...'}
              </div>
            </div>

            {/* 工具栏 */}
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                onClick={() => setShowAIAssistant(true)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-purple-500/15 text-purple-400 active:bg-purple-500/25 transition-colors"
              >
                <Bot className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">AI助手</span>
              </button>
              <button
                onClick={() => setShowArtistModal(true)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-amber-500/15 text-amber-400 active:bg-amber-500/25 transition-colors"
              >
                <Brush className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">画师串</span>
              </button>
              <button
                onClick={() => setIsInspirationModalOpen(true)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-pink-500/15 text-pink-400 active:bg-pink-500/25 transition-colors"
              >
                <Lightbulb className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">灵感</span>
              </button>
              <button
                onClick={() => setShowOCModal(true)}
                className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-400 active:bg-cyan-500/25 transition-colors"
              >
                <User className="w-3.5 h-3.5" />
                <span className="text-xs font-medium">OC</span>
              </button>
            </div>
          </div>

          {/* Character Prompts 区域 - 支持收起/展开 */}
          <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
            <div
              className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
              onClick={() => {
                if (characterPrompts.length > 0) {
                  setIsCharacterExpanded(!isCharacterExpanded);
                }
              }}
            >
              <div className="flex items-center gap-2">
                {characterPrompts.length > 0 && (
                  <ChevronDown
                    className={`w-5 h-5 text-gray-400 transition-transform ${isCharacterExpanded ? '' : '-rotate-90'}`}
                  />
                )}
                <Users className="w-5 h-5 text-green-400" />
                <span className="text-sm font-bold text-gray-200">角色提示词</span>
                {characterPrompts.length > 0 && (
                  <span className="text-xs text-green-400 bg-green-500/20 px-1.5 py-0.5 rounded">
                    {characterPrompts.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {characterPrompts.length > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      clearAllCharacterPrompts();
                    }}
                    className="px-3 py-2 bg-red-500/20 text-red-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
                  >
                    <Trash2 className="w-4 h-4" />
                    清空
                  </button>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (characterPrompts.length < 6) {
                      addCharacterPrompt();
                      setIsCharacterExpanded(true);
                    }
                  }}
                  disabled={characterPrompts.length >= 6}
                  className={`px-3 py-2 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5 ${characterPrompts.length >= 6
                    ? 'bg-gray-700/50 text-gray-500'
                    : 'bg-green-500/20 text-green-400'
                    }`}
                >
                  <Plus className="w-4 h-4" />
                  添加
                </button>
              </div>
            </div>
            {characterPrompts.length > 0 && isCharacterExpanded && (
              <div className="border-t border-gray-700/30">
                {characterPrompts.map((char, index) => (
                  <div
                    key={char.id}
                    className={`p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''} ${!char.enabled ? 'opacity-60' : ''
                      }`}
                  >
                    {/* 角色头部 */}
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {/* 启用开关 */}
                        <button
                          onClick={() => updateCharacterPrompt(char.id, 'enabled', !char.enabled)}
                          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${char.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700/50 text-gray-500'
                            }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>
                        {/* 角色名称 */}
                        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
                          <User className="w-4 h-4 text-gray-500 shrink-0" />
                          <span className="text-sm font-bold text-gray-300 truncate max-w-[6rem]" title={char.name || `角色 ${index + 1}`}>
                            {char.name || `角色 ${index + 1}`}
                          </span>
                        </div>
                        {/* 正向/负向切换 */}
                        <div
                          className="flex items-center bg-black/40 rounded-full p-1 border border-gray-700/50 cursor-pointer"
                          onClick={() =>
                            updateCharacterPrompt(
                              char.id,
                              'activeTab',
                              char.activeTab === 'prompt' ? 'undesired' : 'prompt'
                            )
                          }
                        >
                          <div
                            className={`px-2.5 py-1 rounded-full transition-colors ${char.activeTab === 'prompt'
                              ? 'bg-nai-accent text-black'
                              : 'text-gray-500'
                              }`}
                          >
                            <Sparkles className="w-4 h-4" />
                          </div>
                          <div
                            className={`px-2.5 py-1 rounded-full transition-colors ${char.activeTab === 'undesired'
                              ? 'bg-red-500 text-white'
                              : 'text-gray-500'
                              }`}
                          >
                            <Ban className="w-4 h-4" />
                          </div>
                        </div>
                      </div>
                      {/* 操作按钮 */}
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => moveCharacterPrompt(index, -1)}
                          disabled={index === 0}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 disabled:opacity-30 active:scale-95 bg-gray-700/30"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => moveCharacterPrompt(index, 1)}
                          disabled={index === characterPrompts.length - 1}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 disabled:opacity-30 active:scale-95 bg-gray-700/30"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => removeCharacterPrompt(char.id)}
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 active:scale-95 bg-gray-700/30"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                    {/* 输入框 - 点击进入全屏编辑 */}
                    <div
                      onClick={() => setEditingCharacterId(char.id)}
                      className={`relative w-full min-h-[84px] p-3 pb-11 rounded-lg border text-sm cursor-pointer transition-colors ${char.activeTab === 'prompt'
                        ? 'bg-nai-accent/5 border-nai-accent/30'
                        : 'bg-red-500/5 border-red-500/30'
                        } ${!char.enabled ? 'opacity-50' : ''}`}
                    >
                      <div className="text-gray-300 line-clamp-2 whitespace-pre-wrap">
                        {(char.activeTab === 'prompt' ? char.positive : char.negative) || (
                          <span className="text-gray-600">
                            {char.activeTab === 'prompt' ? '点击输入角色提示词...' : '点击输入角色排除内容...'}
                          </span>
                        )}
                      </div>
                      {/* 底部操作栏：位置按钮 + Token 计数 */}
                      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between pointer-events-none">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingPositionId(char.id);
                          }}
                          className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-mono border bg-black/30 border-gray-600/40 text-gray-300 active:bg-black/50 active:text-white transition-colors"
                          title="设置位置"
                        >
                          <Grid className="w-4 h-4" />
                          {char.position || 'AUTO'}
                        </button>
                        <span className="text-sm text-gray-400 font-mono">
                          {countTokens(char.activeTab === 'prompt' ? char.positive : char.negative)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Vibes 区域 - 支持收起/展开 */}
          <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
            <div
              className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
              onClick={() => {
                if (activeVibes.length > 0) {
                  setIsVibeExpanded(!isVibeExpanded);
                } else {
                  setShowVibeModal(true);
                }
              }}
            >
              <div className="flex items-center gap-2">
                {activeVibes.length > 0 && (
                  <ChevronDown
                    className={`w-5 h-5 text-gray-400 transition-transform ${isVibeExpanded ? '' : '-rotate-90'}`}
                  />
                )}
                <Palette className="w-5 h-5 text-purple-400" />
                <span className="text-sm font-bold text-gray-200">Vibes</span>
                {activeVibes.length > 0 && (
                  <span className="text-xs text-purple-400 bg-purple-500/20 px-1.5 py-0.5 rounded">
                    {activeVibes.length}
                  </span>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowVibeModal(true);
                }}
                className="px-3 py-2 bg-purple-500/20 text-purple-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                添加
              </button>
            </div>
            {activeVibes.length > 0 && isVibeExpanded && (
              <div className="border-t border-gray-700/30">
                {activeVibes.map((vibe, index) => {
                  // 检查是否有原图（可以重新编码）
                  const hasOriginalImage = !!vibe.image;
                  const isLoading = loadingVibeIds.has(vibe.id);
                  const isCompatible = isVibeCompatibleWithModel(vibe);
                  return (
                    <div
                      key={vibe.id}
                      className={`flex items-center gap-3 p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''} ${!isCompatible ? 'bg-red-900/10' : ''}`}
                    >
                      {/* 预览图 - 与 CR 一致 */}
                      {isLoading ? (
                        <div className="w-14 h-14 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0">
                          <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                        </div>
                      ) : vibe.preview ? (
                        <img src={vibe.preview} alt={vibe.name} className={`w-14 h-14 rounded-lg object-cover flex-shrink-0 ${!isCompatible ? 'grayscale opacity-60' : !vibe.enabled ? 'opacity-50' : ''}`} />
                      ) : (
                        <div className={`w-14 h-14 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0 ${!isCompatible ? 'opacity-60' : !vibe.enabled ? 'opacity-50' : ''}`}>
                          <Palette className="w-6 h-6 text-gray-600" />
                        </div>
                      )}
                      {/* 名称和滑块 */}
                      <div className={`flex-1 min-w-0 flex flex-col justify-center ${!isCompatible ? 'opacity-70' : !vibe.enabled ? 'opacity-50' : ''}`}>
                        <div className={`text-sm font-medium truncate ${!isCompatible ? 'text-red-300/80 line-through' : vibe.enabled ? 'text-gray-200' : 'text-gray-500'}`}>
                          {vibe.name}
                        </div>
                        {!isCompatible && (
                          <div className="text-[11px] text-red-400 mt-0.5">不兼容当前模型</div>
                        )}
                        {/* 强度滑块 */}
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-gray-500 w-6">强度</span>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={vibe.referenceStrength}
                            onChange={(e) => {
                              setActiveVibes((prev) =>
                                prev.map((v) =>
                                  v.id === vibe.id ? { ...v, referenceStrength: parseFloat(e.target.value) } : v
                                )
                              );
                            }}
                            className="flex-1 h-1.5 accent-purple-500"
                          />
                          <span className="text-xs text-gray-400 w-8 text-right">{vibe.referenceStrength.toFixed(2)}</span>
                        </div>
                        {/* 信息提取滑块 - 有原图或正在加载时显示 */}
                        {(hasOriginalImage || isLoading) && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <span className="text-xs text-gray-500 w-6">提取</span>
                            {isLoading ? (
                              <>
                                <div className="flex-1 h-1.5 bg-gray-700 rounded-full" />
                                <span className="text-xs text-gray-500 w-8 text-right">加载中</span>
                              </>
                            ) : (
                              <>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  value={vibe.informationExtracted}
                                  onChange={(e) => {
                                    setActiveVibes((prev) =>
                                      prev.map((v) =>
                                        v.id === vibe.id ? { ...v, informationExtracted: parseFloat(e.target.value) } : v
                                      )
                                    );
                                  }}
                                  className="flex-1 h-1.5 accent-blue-500"
                                />
                                <span className="text-xs text-gray-400 w-8 text-right">{vibe.informationExtracted.toFixed(2)}</span>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                      {/* 右侧操作按钮 - 竖排 */}
                      <div className="flex flex-col gap-1.5">
                        {/* 启用开关 - 电源按钮 */}
                        <button
                          onClick={() => {
                            if (!isCompatible) return;
                            setActiveVibes((prev) =>
                              prev.map((v) => (v.id === vibe.id ? { ...v, enabled: !v.enabled } : v))
                            );
                          }}
                          disabled={!isCompatible}
                          title={!isCompatible ? '不兼容当前模型' : vibe.enabled ? '禁用' : '启用'}
                          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${!isCompatible
                              ? 'bg-red-900/20 text-red-500/50 cursor-not-allowed'
                              : vibe.enabled ? 'bg-green-500/20 text-green-400' : 'bg-gray-700/50 text-gray-500'
                            }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>
                        {/* 删除按钮 */}
                        <button
                          onClick={() => handleRemoveVibe(vibe.id)}
                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Precise Reference 区域 - 支持收起/展开 */}
          {(model === 'v4-full' || model === 'v4-curated-preview') ? (
            <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg opacity-50">
              <div className="flex items-center gap-2 p-3">
                <User className="w-5 h-5 text-gray-500" />
                <span className="text-sm font-bold text-gray-500">精确参考</span>
                <span className="text-xs text-gray-600 ml-auto">V4 模型不支持</span>
              </div>
            </div>
          ) : (
            <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
              <div
                className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
                onClick={() => {
                  if (activePreciseRefs.length > 0) {
                    setIsCRExpanded(!isCRExpanded);
                  } else {
                    setShowCRModal(true);
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  {activePreciseRefs.length > 0 && (
                    <ChevronDown
                      className={`w-5 h-5 text-gray-400 transition-transform ${isCRExpanded ? '' : '-rotate-90'}`}
                    />
                  )}
                  <User className="w-5 h-5 text-cyan-400" />
                  <span className="text-sm font-bold text-gray-200">精确参考</span>
                  {activePreciseRefs.length > 0 && (
                    <span className="text-xs text-cyan-400 bg-cyan-500/20 px-1.5 py-0.5 rounded">
                      {activePreciseRefs.filter(pr => pr.enabled).length}/{activePreciseRefs.length}
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowCRModal(true);
                  }}
                  className="px-3 py-2 bg-cyan-500/20 text-cyan-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4" />
                  {activePreciseRefs.length > 0 ? '管理' : '添加'}
                </button>
              </div>
              {activePreciseRefs.length > 0 && isCRExpanded && (
                <div className="border-t border-gray-700/30">
                  {activePreciseRefs.map((pr, index) => (
                    <div
                      key={pr.id}
                      className={`flex items-center gap-3 p-3 ${index > 0 ? 'border-t border-gray-700/30' : ''}`}
                    >
                      {/* 预览图 - 增大尺寸 */}
                      <img
                        src={pr.preview}
                        alt={pr.name}
                        className={`w-14 h-14 rounded-lg object-cover flex-shrink-0 ${!pr.enabled ? 'opacity-50' : ''}`}
                      />
                      {/* 名称和设置 */}
                      <div className={`flex-1 min-w-0 flex flex-col justify-center ${!pr.enabled ? 'opacity-50' : ''}`}>
                        {/* 名称和 Mode 下拉框在同一行 */}
                        <div className="flex items-center gap-2">
                          <div className="text-sm font-medium text-gray-200 truncate flex-1 min-w-0">{pr.name}</div>
                          {/* Mode 自定义下拉框 */}
                          <div className="relative w-28 shrink-0">
                            <select
                              value={pr.mode}
                              onChange={(e) => updatePreciseRefParam(pr.id, { mode: e.target.value as PreciseReferenceMode })}
                              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:border-cyan-500 outline-none appearance-none cursor-pointer opacity-0 absolute inset-0 z-10"
                            >
                              <option value="character&style">Character & Style</option>
                              <option value="character">Character</option>
                              <option value="style">Style</option>
                            </select>
                            {/* 显示层 - 缩写 */}
                            <div
                              className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 flex items-center justify-between pointer-events-none"
                            >
                              <span>{pr.mode === 'character&style' ? 'Char & Style' : pr.mode === 'character' ? 'Character' : 'Style'}</span>
                              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500">
                                <path d="m6 9 6 6 6-6" />
                              </svg>
                            </div>
                          </div>
                        </div>
                        {/* Strength 滑块 */}
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs text-gray-500 w-6">强度</span>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={pr.strength}
                            onChange={(e) => updatePreciseRefParam(pr.id, { strength: parseFloat(e.target.value) })}
                            className="flex-1 h-1.5 accent-cyan-500"
                          />
                          <span className="text-xs text-gray-400 w-8 text-right">{pr.strength.toFixed(2)}</span>
                        </div>
                        {/* Fidelity 滑块 */}
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-xs text-gray-500 w-6">保真</span>
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={pr.informationExtracted}
                            onChange={(e) => updatePreciseRefParam(pr.id, { informationExtracted: parseFloat(e.target.value) })}
                            className="flex-1 h-1.5 accent-blue-500"
                          />
                          <span className="text-xs text-gray-400 w-8 text-right">{pr.informationExtracted.toFixed(2)}</span>
                        </div>
                      </div>
                      {/* 右侧操作按钮 - 竖排 */}
                      <div className="flex flex-col gap-1.5">
                        {/* 启用开关 */}
                        <button
                          onClick={() => updatePreciseRefParam(pr.id, { enabled: !pr.enabled })}
                          className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors ${pr.enabled ? 'bg-cyan-500/20 text-cyan-400' : 'bg-gray-700/50 text-gray-500'
                            }`}
                        >
                          <Power className="w-4 h-4" />
                        </button>
                        {/* 删除按钮 */}
                        <button
                          onClick={() => removePreciseRef(pr.id)}
                          className="w-9 h-9 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Image2Image 区域 - 支持收起/展开 */}
          <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
            <div
              className="flex items-center justify-between p-3 active:bg-gray-800/50 transition-colors cursor-pointer"
              onClick={() => {
                if (img2imgImage) {
                  setIsImg2ImgExpanded(!isImg2ImgExpanded);
                }
              }}
            >
              <div className="flex items-center gap-2">
                {img2imgImage && (
                  <ChevronDown
                    className={`w-5 h-5 text-gray-400 transition-transform ${isImg2ImgExpanded ? '' : '-rotate-90'}`}
                  />
                )}
                <ImagePlus className="w-5 h-5 text-orange-400" />
                <span className="text-sm font-bold text-gray-200">图生图</span>
                {hasInpaintParams && (
                  <span className="text-xs text-blue-400 bg-blue-500/20 px-1.5 py-0.5 rounded">重绘</span>
                )}
                {img2imgImage && (
                  <span className="text-xs text-orange-400 bg-orange-500/20 px-1.5 py-0.5 rounded">1</span>
                )}
              </div>
              <label
                onClick={(e) => e.stopPropagation()}
                className="px-3 py-2 bg-orange-500/20 text-orange-400 text-sm font-medium rounded-lg active:scale-95 transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                {img2imgImage ? '更换' : '添加'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      setImg2imgWithAutoRes(reader.result as string);
                    };
                    reader.readAsDataURL(file);
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
            {img2imgImage && isImg2ImgExpanded && (
              <div className="border-t border-gray-700/30 p-3">
                <div className="flex items-start gap-3">
                  {/* 预览图 */}
                  <img src={img2imgImage} alt="Img2Img" className="w-12 h-12 rounded-lg object-cover flex-shrink-0" />
                  {/* 设置 */}
                  <div className="flex-1 min-w-0">
                    {/* Strength 滑块 */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-6">强度</span>
                      <input
                        type="range"
                        min="0.01"
                        max="0.99"
                        step="0.01"
                        value={hasInpaintParams ? inpaintStrength : img2imgStrength}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (hasInpaintParams) {
                            setInpaintStrength(val);
                            if (savedInpaintRef.current) {
                              savedInpaintRef.current.strength = val;
                            }
                            // 同步到重绘面板
                            window.dispatchEvent(new CustomEvent('inpaint-strength-sync', { detail: { strength: val } }));
                          } else {
                            setImg2imgStrength(val);
                          }
                        }}
                        className="flex-1 h-1 accent-orange-500"
                      />
                      <span className="text-xs text-gray-400 w-8 text-right">{(hasInpaintParams ? inpaintStrength : img2imgStrength).toFixed(2)}</span>
                    </div>
                    {/* Noise 滑块 - 仅在非重绘模式显示 */}
                    {!hasInpaintParams && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <span className="text-xs text-gray-500 w-6">噪声</span>
                        <input
                          type="range"
                          min="0"
                          max="0.99"
                          step="0.01"
                          value={img2imgNoise}
                          onChange={(e) => setImg2imgNoise(parseFloat(e.target.value))}
                          className="flex-1 h-1 accent-yellow-500"
                        />
                        <span className="text-xs text-gray-400 w-8 text-right">{img2imgNoise.toFixed(2)}</span>
                      </div>
                    )}
                  </div>
                  {/* 操作按钮 */}
                  <div className="flex flex-col gap-1 flex-shrink-0">
                    <button
                      onClick={() => {
                        const base64 = savedInpaintRef.current?.imageBase64 || (img2imgImage?.startsWith('data:') ? img2imgImage.split(',')[1] : null);
                        const w = localWidth;
                        const h = localHeight;
                        setHasInpaintParams(true);
                        window.dispatchEvent(new CustomEvent('open-inpaint-mode', { detail: { maskBase64: savedInpaintRef.current?.maskBase64 || null, imageBase64: base64, width: w, height: h } }));
                      }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-400 active:scale-95 transition-all"
                      title="重绘"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { setImg2imgImage(null); savedInpaintRef.current = null; setHasInpaintParams(false); }}
                      className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-700/50 text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 翻译按钮 */}
          {(containsChinese(positivePrompt) || containsChinese(negativePrompt)) && (
            <button
              onClick={handleTranslate}
              disabled={isTranslating}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500/20 text-blue-400 rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {isTranslating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
              <span className="text-sm font-medium">{isTranslating ? '翻译中...' : '翻译中文'}</span>
            </button>
          )}
        </div>
      </div>

      {/* 底部操作栏 */}
      <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800 safe-area-bottom">
        <div className="flex items-center gap-2 p-3">
          {/* 高级设置按钮 */}
          <button
            onClick={() => setShowAdvancedSettings(true)}
            className="w-10 h-10 flex items-center justify-center rounded-lg bg-gray-800 border border-gray-700 text-gray-400 active:scale-95 transition-all"
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          {/* 分辨率选择 */}
          <button
            onClick={() => setShowResolutionDropdown(true)}
            className="h-10 flex items-center gap-1.5 px-3 bg-gray-800 border border-gray-700 rounded-lg text-sm active:scale-[0.98] transition-all"
          >
            <Grid className="w-4 h-4 text-gray-400" />
            <span className="text-gray-200">{currentResLabel}</span>
          </button>

          {/* 导入图片按钮 */}
          <label className="h-10 flex items-center justify-center px-3 bg-gray-800 border border-gray-700 rounded-lg text-gray-400 active:scale-[0.98] transition-all cursor-pointer">
            <ImagePlus className="w-4 h-4" />
            <input
              type="file"
              accept="image/*,.vibe"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const dataUrl = reader.result as string;
                    setImportImageDataUrl(dataUrl);
                    setImportImageMetadata(null);
                    setTaggerResult(null);
                    setShowTaggerResult(false);
                    setShowImageImportModal(true);

                    // 解析元数据
                    if (!file.name.endsWith('.vibe')) {
                      setIsParsingMetadata(true);
                      extractImageMetadata(dataUrl)
                        .then((metadata) => {
                          setImportImageMetadata(metadata);
                        })
                        .catch((err) => {
                          console.error('解析元数据失败:', err);
                        })
                        .finally(() => {
                          setIsParsingMetadata(false);
                        });
                    }
                  };
                  reader.readAsDataURL(file);
                }
                e.target.value = '';
              }}
            />
          </label>

          {/* 生成按钮 */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating || isQueuing || isPreparing}
            className={`flex-1 h-10 flex items-center justify-center px-4 rounded-lg font-bold text-sm transition-all active:scale-[0.98] relative overflow-hidden ${isGenerating || isQueuing || isPreparing
              ? 'bg-gray-700 text-gray-300'
              : 'bg-nai-accent text-black'
              }`}
          >
            {/* 进度条背景 */}
            {isGenerating && totalSteps > 0 && (
              <div
                className="absolute inset-0 bg-nai-accent/30 transition-all duration-200"
                style={{ width: `${(currentStep / totalSteps) * 100}%` }}
              />
            )}
            {isGenerating || isQueuing || isPreparing ? (
              <div className="flex items-center gap-2 relative z-10">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="shrink-0 whitespace-nowrap">
                  {isQueuing ? `排队中 #${queuePosition}` : (isGenerating && currentStep > 0) ? `生成中 ${currentStep}/${totalSteps}` : '准备中...'}
                </span>
                {isQueuing && (
                  <button
                    onClick={(e) => { e.stopPropagation(); cancelTask(); }}
                    className="ml-2 px-2 py-0.5 text-xs bg-black/20 hover:bg-black/40 rounded transition-colors shrink-0 whitespace-nowrap"
                  >
                    取消
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between w-full">
                <div className="flex items-center gap-1.5">
                  <Send className="w-4 h-4" />
                  <span>生成</span>
                </div>
                <div className="flex items-center gap-1 bg-black/15 px-2 py-0.5 rounded text-xs font-mono font-bold">
                  <span>{(() => {
                    // 使用精确的点数计算
                    // Bot模式默认Opus，Token模式从subscription API判断
                    const result = calculateCostFromUI({
                      width: localWidth,
                      height: localHeight,
                      steps,
                      modelId: model,
                      sampler,
                      isOpus: anlasInfo?.isOpus ?? false,
                      img2imgStrength: img2imgImage ? img2imgStrength : undefined,
                      preciseRefCount: activePreciseRefs.filter(pr => pr.enabled).length,
                      vibeRefCount: activeVibes.filter(v => v.enabled).length,
                    });
                    return result.total;
                  })()}</span>
                  <span>💎</span>
                </div>
              </div>
            )}
          </button>
        </div>
      </div>

      {/* 分辨率选择底部弹窗 */}
      {showResolutionDropdown && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setShowResolutionDropdown(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl animate-slide-in-from-bottom safe-area-bottom">
            {/* 标题栏 */}
            <div className="flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-lg font-bold text-white">选择比例</h3>
              <button onClick={() => setShowResolutionDropdown(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tab 切换 */}
            <div className="flex gap-2 p-4 pb-2">
              <button
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${resolutionTab === 'small'
                  ? 'bg-nai-accent text-black'
                  : 'bg-gray-800 text-gray-400'
                  }`}
                onClick={() => setResolutionTab('small')}
              >
                小图
              </button>
              <button
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${resolutionTab === 'large'
                  ? 'bg-nai-accent text-black'
                  : 'bg-gray-800 text-gray-400'
                  }`}
                onClick={() => setResolutionTab('large')}
              >
                大图
              </button>
              <button
                className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${resolutionTab === 'wallpaper'
                  ? 'bg-nai-accent text-black'
                  : 'bg-gray-800 text-gray-400'
                  }`}
                onClick={() => setResolutionTab('wallpaper')}
              >
                壁纸
              </button>
            </div>

            {/* 比例选项 - 可视化卡片 */}
            <div className="grid grid-cols-3 gap-3 p-4">
              {(resolutionTab === 'small' ? RESOLUTIONS : resolutionTab === 'large' ? LARGE_RESOLUTIONS : WALLPAPER_RESOLUTIONS).map((r) => {
                const isSelected = localWidth === r.width && localHeight === r.height;
                const aspectRatio = r.width / r.height;
                // 计算预览框尺寸，最大 48px
                const previewSize = 40;
                const previewWidth = aspectRatio >= 1 ? previewSize : previewSize * aspectRatio;
                const previewHeight = aspectRatio >= 1 ? previewSize / aspectRatio : previewSize;

                return (
                  <button
                    key={r.label}
                    onClick={() => {
                      setLocalWidth(r.width);
                      setLocalHeight(r.height);
                    }}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all active:scale-95 ${isSelected
                      ? 'bg-nai-accent/20 border-nai-accent'
                      : 'bg-gray-800 border-gray-700'
                      }`}
                  >
                    {/* 比例预览框 */}
                    <div
                      className={`rounded border-2 ${isSelected ? 'border-nai-accent bg-nai-accent/30' : 'border-gray-500 bg-gray-700'}`}
                      style={{ width: previewWidth, height: previewHeight }}
                    />
                    {/* 标签 */}
                    <span className={`text-sm font-medium ${isSelected ? 'text-nai-accent' : 'text-gray-300'}`}>
                      {r.label}
                    </span>
                    {/* 尺寸 */}
                    <span className="text-xs text-gray-500">
                      {r.width}×{r.height}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 确认按钮 */}
            <div className="p-4 pt-0">
              <button
                onClick={() => setShowResolutionDropdown(false)}
                className="w-full py-3 bg-nai-accent text-black font-bold rounded-xl active:scale-[0.98] transition-all"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 高级生成设置弹窗 */}
      {showAdvancedSettings && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setShowAdvancedSettings(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[80vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            {/* 标题栏 */}
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="w-5 h-5 text-nai-accent" />
                <h3 className="text-lg font-bold text-white">生成设置</h3>
              </div>
              <button onClick={() => setShowAdvancedSettings(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 设置内容 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 提示词预设 - 下拉展开式 */}
              <div className="bg-gray-800/50 rounded-xl overflow-hidden">
                <button
                  onClick={() => setIsPresetExpanded(!isPresetExpanded)}
                  className="w-full p-3 flex items-center justify-between active:bg-gray-700/50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Settings className="w-5 h-5 text-nai-accent" />
                    <span className="text-sm font-medium text-gray-300">提示词预设</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-nai-accent">
                      {promptPresets.find((p) => p.id === activePresetId)?.name || '未选择'}
                    </span>
                    <ChevronDown
                      className={`w-4 h-4 text-gray-400 transition-transform ${isPresetExpanded ? 'rotate-180' : ''}`}
                    />
                  </div>
                </button>
                {isPresetExpanded && (
                  <div className="border-t border-gray-700 p-2 space-y-1 max-h-[200px] overflow-y-auto">
                    {promptPresets.map((preset) => {
                      const isActive = activePresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => {
                            handleApplyPreset(preset);
                            setIsPresetExpanded(false);
                          }}
                          className={`w-full p-2.5 rounded-lg text-left transition-colors ${isActive
                            ? 'bg-nai-accent/20 border border-nai-accent/50'
                            : 'bg-gray-800/50 border border-transparent hover:bg-gray-700/50'
                            }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className={`text-sm font-medium ${isActive ? 'text-nai-accent' : 'text-gray-300'}`}>
                              {preset.name}
                            </span>
                            {isActive && <Check className="w-4 h-4 text-nai-accent" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Steps */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Steps 步数</span>
                  <span className="text-sm font-mono text-nai-accent">{steps}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="50"
                  step="1"
                  value={steps}
                  onChange={(e) => setSteps(parseInt(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                />
              </div>

              {/* Prompt Guidance (Scale) + Variety+ */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Prompt Guidance</span>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setVarietyPlus(!varietyPlus)}
                      className={`px-2 py-1 text-xs rounded border flex items-center gap-1 transition-colors ${varietyPlus
                        ? 'bg-nai-accent/20 text-nai-accent border-nai-accent'
                        : 'bg-gray-800 text-gray-400 border-gray-700'
                        }`}
                    >
                      {varietyPlus ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                      Variety+
                    </button>
                    <span className="text-sm font-mono text-nai-accent">{scale}</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max="25"
                  step="0.1"
                  value={scale}
                  onChange={(e) => setScale(parseFloat(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                />
              </div>

              {/* Seed */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Seed 种子</span>
                  <button onClick={() => setSeed('')} className="text-xs text-gray-500 hover:text-white">
                    清空
                  </button>
                </div>
                <input
                  type="text"
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  placeholder="随机"
                  className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-nai-accent"
                />
              </div>

              {/* Sampler */}
              <div className="space-y-2">
                <span className="text-sm font-medium text-gray-300">Sampler 采样器</span>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'k_euler_ancestral', name: 'Euler Ancestral' },
                    { id: 'k_euler', name: 'Euler' },
                    { id: 'k_dpmpp_2s_ancestral', name: 'DPM++ 2S Ancestral' },
                    { id: 'k_dpmpp_2m_sde', name: 'DPM++ 2M SDE' },
                    { id: 'k_dpmpp_2m', name: 'DPM++ 2M' },
                    { id: 'k_dpmpp_sde', name: 'DPM++ SDE' },
                  ].map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSampler(s.id)}
                      className={`py-2.5 px-3 rounded-lg text-sm font-medium transition-colors ${sampler === s.id
                        ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                        : 'bg-gray-800 text-gray-400 border border-gray-700'
                        }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* CFG Rescale */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-300">Prompt Guidance Rescale</span>
                  <span className="text-sm font-mono text-nai-accent">{cfgRescale}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={cfgRescale}
                  onChange={(e) => setCfgRescale(parseFloat(e.target.value))}
                  className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                />
              </div>

              {/* Noise Schedule */}
              <div className="space-y-2">
                <span className="text-sm font-medium text-gray-300">Noise Schedule 噪声调度</span>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'karras', name: 'Karras' },
                    { id: 'exponential', name: 'Exponential' },
                    { id: 'polyexponential', name: 'Polyexponential' },
                  ].map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setNoiseSchedule(n.id)}
                      className={`py-2.5 px-3 rounded-lg text-sm font-medium transition-colors ${noiseSchedule === n.id
                        ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                        : 'bg-gray-800 text-gray-400 border border-gray-700'
                        }`}
                    >
                      {n.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className="flex-shrink-0 p-4 border-t border-gray-700 flex gap-3">
              <button
                onClick={() => {
                  setSteps(28);
                  setScale(5);
                  setSeed('');
                  setSampler('k_euler_ancestral');
                  setNoiseSchedule('karras');
                  setCfgRescale(0);
                  setVarietyPlus(false);
                }}
                className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
              >
                重置默认
              </button>
              <button
                onClick={() => setShowAdvancedSettings(false)}
                className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl active:scale-[0.98] transition-all"
              >
                确认
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全屏编辑器 */}
      <FullscreenEditor
        isOpen={editorOpen === 'prompt'}
        onClose={() => setEditorOpen(null)}
        type="prompt"
        value={positivePrompt}
        onChange={setPositivePrompt}
        presetTokens={activePreset?.positive ? countTokens(activePreset.positive) : 0}
        totalTokens={positiveTokens}
      />
      <FullscreenEditor
        isOpen={editorOpen === 'undesired'}
        onClose={() => setEditorOpen(null)}
        type="undesired"
        value={negativePrompt}
        onChange={setNegativePrompt}
        presetTokens={activePreset?.negative ? countTokens(activePreset.negative) : 0}
        totalTokens={negativeTokens}
      />
      <MobileAIAssistantSheet
        isOpen={showAIAssistant}
        onClose={() => setShowAIAssistant(false)}
        aiModel={aiModel}
        onAiModelChange={setAiModel}
        agentState={agentState}
        isGeneratingPrompt={isGeneratingPrompt}
        onAIGenerate={handleAIGenerate}
        onAIRegenerate={handleAIRegenerate}
        onRestoreSnapshot={handleRestoreSnapshot}
      />

      {/* 角色提示词全屏编辑器 */}
      {editingCharacterId && (() => {
        const char = characterPrompts.find((c) => c.id === editingCharacterId);
        if (!char) return null;
        const charIndex = characterPrompts.findIndex((c) => c.id === editingCharacterId);
        return (
          <FullscreenEditor
            isOpen={true}
            onClose={() => setEditingCharacterId(null)}
            type={char.activeTab === 'prompt' ? 'prompt' : 'undesired'}
            value={char.activeTab === 'prompt' ? char.positive : char.negative}
            onChange={(value) =>
              updateCharacterPrompt(
                char.id,
                char.activeTab === 'prompt' ? 'positive' : 'negative',
                value
              )
            }
            totalTokens={char.activeTab === 'prompt' ? positiveTokens : negativeTokens}
          />
        );
      })()}

      {/* 角色位置选择弹窗 */}
      {editingPositionId && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setEditingPositionId(null)}
        >
          <div
            className="bg-nai-panel border border-gray-700 rounded-2xl shadow-2xl p-4 w-full max-w-sm animate-slide-in-from-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-white flex items-center gap-2">
                <Grid className="w-4 h-4 text-nai-accent" />
                设置角色位置
              </h3>
              <button
                onClick={() => setEditingPositionId(null)}
                className="p-1 text-gray-400 active:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-6 gap-1 mb-3">
              <div className="col-span-1"></div>
              {['A', 'B', 'C', 'D', 'E'].map((col) => (
                <div key={col} className="text-center text-xs font-bold text-gray-500">
                  {col}
                </div>
              ))}
              {[1, 2, 3, 4, 5].map((row) => (
                <React.Fragment key={row}>
                  <div className="flex items-center justify-center text-xs font-bold text-gray-500">
                    {row}
                  </div>
                  {['A', 'B', 'C', 'D', 'E'].map((col) => {
                    const cellId = `${col}${row}`;
                    const isActive =
                      characterPrompts.find((p) => p.id === editingPositionId)?.position === cellId;
                    const charsInCell = characterPrompts.filter((p) => p.position === cellId);
                    return (
                      <button
                        key={cellId}
                        onClick={() => {
                          updateCharacterPrompt(editingPositionId, 'position', cellId);
                          setEditingPositionId(null);
                        }}
                        className={`aspect-square rounded border flex items-center justify-center relative transition-all duration-200 ${
                          isActive
                            ? 'bg-nai-accent/20 border-nai-accent shadow-[0_0_10px_rgba(235,213,118,0.2)]'
                            : 'bg-black/20 border-gray-700 active:border-gray-500 active:bg-white/5'
                        }`}
                      >
                        {isActive && (
                          <div className="absolute inset-0 bg-nai-accent/10 animate-pulse rounded" />
                        )}
                        <div className="flex flex-wrap items-center justify-center gap-0.5 p-0.5">
                          {charsInCell.map((c) => (
                            <div
                              key={c.id}
                              className={`w-3 h-3 rounded-full flex items-center justify-center text-[8px] font-bold shadow-sm ${
                                c.id === editingPositionId
                                  ? 'bg-nai-accent text-black ring-1 ring-white'
                                  : 'bg-gray-600 text-white'
                              }`}
                            >
                              {characterPrompts.findIndex((p) => p.id === c.id) + 1}
                            </div>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
            </div>

            <button
              onClick={() => {
                updateCharacterPrompt(editingPositionId, 'position', '');
                setEditingPositionId(null);
              }}
              className={`w-full py-2.5 mb-2 rounded-lg text-sm font-bold border transition-all flex items-center justify-center gap-2 ${
                !characterPrompts.find((p) => p.id === editingPositionId)?.position
                  ? 'bg-nai-accent text-black border-nai-accent'
                  : 'bg-black/20 text-gray-400 border-gray-700 active:text-white active:border-gray-500'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              自动 (Auto)
            </button>

            <div className="text-xs text-gray-500 text-center mt-1">
              当前正在设置 Char{' '}
              {characterPrompts.findIndex((p) => p.id === editingPositionId) + 1} 的位置
            </div>
          </div>
        </div>
      )}

      {/* Vibe 选择弹窗 */}
      {/* ════════════════════ Vibe 管理器（对齐桌面端）════════════════════ */}
      {showVibeModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => { setShowVibeModal(false); setVibeMenuOpenId(null); }} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            {/* 同步遮罩 */}
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-nai-accent" />
                <h3 className="text-lg font-bold text-white">Vibe管理器</h3>
              </div>
              <div className="flex items-center gap-1.5">
                {/* 上传备份 */}
                {/* 云端数据管理 */}
                <button
                  onClick={() => setVibeCloudMenuOpen(true)}
                  className="w-9 h-9 rounded-lg flex items-center justify-center border border-gray-700 bg-gray-800 text-gray-400 active:text-nai-accent transition-colors"
                >
                  <Cloud className="w-4 h-4" />
                </button>
                <button onClick={() => { setShowVibeModal(false); setVibeMenuOpenId(null); }} className="p-1.5 text-gray-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* 搜索栏 */}
            <div className="flex-shrink-0 px-3 py-2 border-b border-gray-700/50">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input type="text" value={vibeSearchQuery} onChange={(e) => setVibeSearchQuery(e.target.value)}
                  placeholder="搜索..." className="w-full h-10 bg-gray-800/70 text-sm text-gray-200 rounded-lg pl-9 pr-9 border border-gray-700 focus:border-nai-accent focus:outline-none" />
                {vibeSearchQuery && (
                  <button onClick={() => setVibeSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"><X className="w-4 h-4" /></button>
                )}
              </div>
            </div>
            {/* Tab 栏 */}
            <div className="flex-shrink-0 flex border-b border-gray-700">
              <button className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'public' ? 'border-nai-accent text-white bg-white/5' : 'border-transparent text-gray-400'}`}
                onClick={() => setVibeTab('public')}>
                <div className="flex items-center justify-center gap-1.5"><Globe className="w-4 h-4" />公共 Vibe</div>
              </button>
              <button className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${vibeTab === 'local' ? 'border-nai-accent text-white bg-white/5' : 'border-transparent text-gray-400'}`}
                onClick={() => setVibeTab('local')}>
                <div className="flex items-center justify-center gap-1.5"><HardDrive className="w-4 h-4" />我的Vibe</div>
              </button>
            </div>

            {/* 滑动切换 + 内容 */}
            <div
              className="flex-1 overflow-hidden relative flex flex-col min-h-0"
              onTouchStart={(e) => {
                const t = e.touches[0];
                (e.currentTarget as any)._tsx = t.clientX;
                (e.currentTarget as any)._tsy = t.clientY;
              }}
              onTouchEnd={(e) => {
                const sx = (e.currentTarget as any)._tsx;
                const sy = (e.currentTarget as any)._tsy;
                if (sx === undefined) return;
                const t = e.changedTouches[0];
                const dx = t.clientX - sx, dy = t.clientY - sy;
                if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50) {
                  if (dx > 0 && vibeTab === 'local') setVibeTab('public');
                  else if (dx < 0 && vibeTab === 'public') setVibeTab('local');
                }
              }}
            >
              <div className="h-full overflow-y-auto">
              {isLoadingVibes ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>
              ) : vibeTab === 'public' ? (
                /* ════ 公共 Tab ════ */
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-sm text-gray-400 mb-1.5">
                    <Globe className="w-4 h-4" />
                    <span className="font-bold">公共库</span>
                    <span className="text-gray-500">({filteredPublicVibes.length})</span>
                  </div>
                  {filteredPublicVibes.length === 0 ? (
                    <div className="flex flex-col items-center py-12 text-gray-500"><Palette className="w-12 h-12 mb-3 opacity-50" /><p className="text-sm">暂无公共Vibe</p></div>
                  ) : filteredPublicVibes.map(vibe => {
                    const isAdded = activeVibes.some(v => v.id === vibe.id);
                    const isCompatible = isVibeCompatibleWithModel(vibe);
                    const isCollected = localVibeFiles.some(v => v.id === vibe.id);
                    const isCollecting = collectingVibeIds.has(vibe.id);
                    return (
                      <div key={vibe.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${!isCompatible ? 'bg-gray-900/50 border-gray-800 opacity-60' : isAdded ? 'bg-nai-accent/10 border-nai-accent/50' : 'bg-gray-800/50 border-gray-700 active:bg-gray-700/50'}`}
                        onClick={() => { if (isAdded) setActiveVibes(p => p.filter(v => v.id !== vibe.id)); else handleAddVibe(vibe); }}>
                        <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${isAdded ? 'bg-nai-accent border-nai-accent' : 'border-gray-500'}`}>
                          {isAdded && <Check className="w-3 h-3 text-black" />}
                        </div>
                        {vibe.preview ? <img src={vibe.preview} alt={vibe.name} className="w-12 h-12 rounded-lg object-cover shrink-0" onError={(e) => { e.currentTarget.style.display = 'none'; const fb = e.currentTarget.nextElementSibling; if (fb) (fb as HTMLElement).style.display = 'flex'; }} /> : null}<div className={`w-12 h-12 rounded-lg bg-gray-700 items-center justify-center shrink-0 ${vibe.preview ? 'hidden' : 'flex'}`}><Palette className="w-4 h-4 text-gray-500" /></div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate ${isAdded ? 'text-nai-accent' : 'text-white'}`}>{vibe.name}</div>
                          {vibe.supportedModels && vibe.supportedModels.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">{vibe.supportedModels.slice(0, 2).map(m => <span key={m} className="text-[11px] px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">{m.includes('full') ? 'Full' : m.includes('curated') ? 'Curated' : m.split('-').pop()}</span>)}</div>
                          )}
                          {!isCompatible && <div className="mt-0.5 text-xs text-red-400">不兼容</div>}
                        </div>
                        <button onClick={async (e) => { e.stopPropagation(); await handleCollectPublicVibe(vibe); }} disabled={isCollected || isCollecting}
                          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${isCollected ? 'text-pink-400' : 'text-gray-400'} disabled:opacity-50`}>
                          {isCollecting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Heart className={`w-5 h-5 ${isCollected ? 'fill-current' : ''}`} />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); if (vibe.fileName) { const a = document.createElement('a'); a.href = `${getBackendUrl()}/api/vibes/download/${encodeURIComponent(vibe.fileName)}`; a.download = vibe.fileName; a.click(); } }}
                          className="w-9 h-9 rounded-full flex items-center justify-center text-gray-400 shrink-0"><Download className="w-5 h-5" /></button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                /* ════ 我的 Vibe Tab ════ */
                <div className="p-3 space-y-2">
                  {/* 最近使用 — 移动端空间不足,暂不显示 */}

                  {/* 列表标题 + 标签管理 */}
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 text-sm text-gray-400">
                      <span className="font-bold">{vibeSelectedTagFilter.size > 0 ? '已筛选' : '全部 Vibe'}</span>
                      <span className="text-gray-500">({vibeTagFilteredLocalFiles.length})</span>
                    </div>
                    <button onClick={() => setVibeTagSettingsOpen(true)} className="p-1.5 text-gray-500 active:text-nai-accent rounded active:bg-white/5 transition-colors" title="标签管理"><Settings className="w-4 h-4" /></button>
                  </div>

                  {/* 标签筛选 chips */}
                  {vibeTagPool.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-hide mb-1.5">
                      <button onClick={() => setVibeSelectedTagFilter(new Set())}
                        className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-full ${vibeSelectedTagFilter.size === 0 ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400'}`}>全部</button>
                      {vibeTagPool.map(tag => (
                        <button key={tag} onClick={() => setVibeSelectedTagFilter(prev => { const n = new Set(prev); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; })}
                          className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-full flex items-center gap-1 ${vibeSelectedTagFilter.has(tag) ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400'}`}>
                          <Tag className="w-3 h-3" />{tag}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 本地 Vibe 列表 */}
                  {vibeTagFilteredLocalFiles.length === 0 ? (
                    <div className="flex flex-col items-center py-10 text-gray-500"><Palette className="w-10 h-10 mb-2 opacity-30" /><p className="text-sm">暂无我的Vibe</p><p className="text-xs mt-1 text-gray-600">点击上方按钮导入</p></div>
                  ) : vibeTagFilteredLocalFiles.map(vibe => {
                    const isAdded = activeVibes.some(v => v.id === vibe.id);
                    const isCompatible = isVibeCompatibleWithModel(vibe);
                    return (
                      <div key={vibe.id}
                        className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${!isCompatible ? 'bg-gray-900/50 border-gray-800 opacity-60' : isAdded ? 'bg-nai-accent/10 border-nai-accent/50' : 'bg-gray-800/50 border-gray-700 active:bg-gray-700/50'}`}
                        onClick={() => { if (isAdded) setActiveVibes(p => p.filter(v => v.id !== vibe.id)); else handleAddVibe(vibe); }}>
                        <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${isAdded ? 'bg-nai-accent border-nai-accent' : 'border-gray-500'}`}>
                          {isAdded && <Check className="w-3 h-3 text-black" />}
                        </div>
                        {vibe.preview ? <img src={vibe.preview} alt={vibe.name} className="w-12 h-12 rounded-lg object-cover shrink-0" onError={(e) => { e.currentTarget.style.display = 'none'; const fb = e.currentTarget.nextElementSibling; if (fb) (fb as HTMLElement).style.display = 'flex'; }} /> : null}<div className={`w-12 h-12 rounded-lg bg-gray-700 items-center justify-center shrink-0 ${vibe.preview ? 'hidden' : 'flex'}`}><Palette className="w-4 h-4 text-gray-500" /></div>
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium truncate ${isAdded ? 'text-nai-accent' : 'text-white'}`}>{vibe.name}</div>
                          {vibe.supportedModels && vibe.supportedModels.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-0.5">{vibe.supportedModels.slice(0, 2).map(m => <span key={m} className="text-[11px] px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded">{m.includes('full') ? 'Full' : m.includes('curated') ? 'Curated' : m.split('-').pop()}</span>)}</div>
                          )}
                          {!isCompatible && <div className="mt-0.5 text-xs text-red-400">不兼容</div>}
                        </div>
                        {/* 三点菜单 */}
                        <div className="relative shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(prev => prev === vibe.id ? null : vibe.id); }}
                            className="w-9 h-9 rounded-full flex items-center justify-center text-gray-400 active:bg-white/10"><MoreVertical className="w-5 h-5" /></button>
                          {vibeMenuOpenId === vibe.id && (<>
                            <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); }} />
                            <div className="absolute right-0 top-full mt-1 w-44 bg-nai-panel border border-gray-700 rounded-xl shadow-xl z-50 py-1 text-sm">
                              <button onClick={(e) => { e.stopPropagation(); setVibeMenuOpenId(null); setVibeTagEditorTarget({ vibeId: vibe.id, current: new Set((vibe as any).tags || []) }); }}
                                className="w-full text-left px-4 py-3 text-gray-300 active:bg-white/10 flex items-center gap-2.5"><Tag className="w-4 h-4" /> 编辑标签</button>
                              <button onClick={async (e) => { e.stopPropagation(); setVibeMenuOpenId(null); const cf = (vibe as any).cloudFilename; void cf; removeRecentVibeEntry(vibe.id); await deleteVibe(vibe.id); setLocalVibeFiles(p => p.filter(v => v.id !== vibe.id)); setActiveVibes(p => p.filter(v => v.id !== vibe.id)); setVibeRecentEntries(getRecentVibeEntries()); }}
                                className="w-full text-left px-4 py-3 text-red-400 active:bg-red-900/20 flex items-center gap-2.5"><Trash2 className="w-4 h-4" /> 删除</button>
                            </div>
                          </>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </div>

            {/* 底部操作 + FAB */}
            <div className="flex-shrink-0 relative border-t border-gray-700 bg-nai-panel">
              {/* FAB 悬浮导入按钮 — 锚定在底部栏上方 */}
              {vibeTab === 'local' && (<>
                {vibeFabOpen && (
                  <div className="fixed inset-0 z-[8]" onClick={() => setVibeFabOpen(false)} />
                )}
                <button
                  onClick={() => setVibeFabOpen(prev => !prev)}
                  className={`absolute -top-16 right-4 z-10 w-12 h-12 rounded-full shadow-lg flex items-center justify-center active:scale-95 transition-colors ${
                    vibeFabOpen ? 'bg-gray-700 border border-gray-600' : 'bg-nai-accent border border-nai-accent'
                  }`}
                >
                  <Plus className={`w-6 h-6 transition-transform duration-200 ${vibeFabOpen ? 'text-white rotate-45' : 'text-black rotate-0'}`} />
                </button>
                {vibeFabOpen && (
                  <div className="absolute -top-40 right-4 z-10 flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
                    <label className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-gray-800 border border-gray-600 rounded-full shadow-lg cursor-pointer active:bg-gray-700 transition-colors">
                      <ImageIcon className="w-4 h-4 text-nai-accent" />
                      <span className="text-sm font-bold text-white">导入图片</span>
                      <input type="file" accept="image/*" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await handleUnifiedVibeImport(f); e.target.value = ''; setVibeFabOpen(false); }} />
                    </label>
                    <label className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-gray-800 border border-gray-600 rounded-full shadow-lg cursor-pointer active:bg-gray-700 transition-colors">
                      <FileUp className="w-4 h-4 text-nai-accent" />
                      <span className="text-sm font-bold text-white">导入文件</span>
                      <input type="file" accept=".naiv4vibe,.naiv4vibebundle" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; await handleUnifiedVibeImport(f); e.target.value = ''; setVibeFabOpen(false); }} />
                    </label>
                  </div>
                )}
              </>)}
              <div className="p-3">
                <div className="flex items-center gap-2">
                  {/* 左侧：批量操作（有选中时显示） */}
                  {vibeTab === 'local' && activeVibes.length > 0 && (<>
                    <button
                      onClick={async () => {
                        if (!confirm(`确定要删除选中的 ${activeVibes.length} 个 Vibe 吗？`)) return;
                        for (const v of activeVibes) {
                          removeRecentVibeEntry(v.id);
                          await deleteVibe(v.id);
                        }
                        setActiveVibes([]);
                        const allVibes = await getVibes();
                        setLocalVibeFiles(allVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview, image: v.image, encodings: v.encodings, defaultStrength: v.defaultStrength, defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels, tags: v.tags, cloudFilename: v.cloudFilename } as VibeFile)));
                        setVibeRecentEntries(getRecentVibeEntries());
                      }}
                      className="h-10 w-10 rounded-lg border border-red-800/50 bg-gray-800 flex items-center justify-center text-red-400 active:bg-red-900/30 transition-colors shrink-0"
                      title="删除"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const allVibes = await getVibes();
                          const selected = allVibes.filter(v => activeVibes.some(a => a.id === v.id));
                          if (selected.length === 0) return;
                          if (selected.length === 1) {
                            const blob = await exportVibeToFile(selected[0], selected[0].defaultStrength, selected[0].defaultInfoExtracted, undefined, true);
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a'); a.href = url; a.download = `${selected[0].name}.naiv4vibe`; a.click();
                            URL.revokeObjectURL(url);
                          } else {
                            const blob = await exportVibesToBundle(selected.map(v => v.id));
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a'); a.href = url; a.download = `vibes_${selected.length}.naiv4vibebundle`; a.click();
                            URL.revokeObjectURL(url);
                          }
                        } catch (err) { console.error('打包下载失败:', err); }
                      }}
                      className="h-10 w-10 rounded-lg border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 active:text-nai-accent active:border-nai-accent/50 transition-colors shrink-0"
                      title="打包下载"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => { setVibeBatchTagOpen(true); setVibeBatchTagsToAdd(new Set()); }}
                      className="h-10 w-10 rounded-lg border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 active:text-nai-accent active:border-nai-accent/50 transition-colors shrink-0"
                      title="添加标签"
                    >
                      <Tag className="w-4 h-4" />
                    </button>
                  </>)}
                  {/* 弹簧 — 把右侧按钮推到最右 */}
                  <div className="flex-1" />
                  {/* 右侧：清空 + 确认 */}
                  <button onClick={() => setActiveVibes([])} disabled={activeVibes.length === 0}
                    className="h-10 px-4 bg-gray-800 border border-gray-700 text-gray-300 font-bold rounded-lg text-sm active:scale-[0.98] transition-all disabled:opacity-50 shrink-0">清空</button>
                  <button onClick={() => { setShowVibeModal(false); setVibeMenuOpenId(null); setVibeFabOpen(false); }}
                    className="h-10 px-5 bg-nai-accent text-black font-bold rounded-lg text-sm active:scale-[0.98] transition-all shrink-0">确认 {activeVibes.length > 0 && `(${activeVibes.length})`}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Vibe 标签编辑弹窗（二级 sheet） */}
      {vibeTagEditorTarget && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={() => setVibeTagEditorTarget(null)}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[60vh] flex flex-col animate-slide-in-from-bottom" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <span className="font-bold text-white text-base">编辑标签</span>
              <button onClick={() => setVibeTagEditorTarget(null)} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {vibeTagPool.map(tag => {
                const checked = vibeTagEditorTarget.current.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input type="checkbox" checked={checked} onChange={() => {
                      setVibeTagEditorTarget(prev => { if (!prev) return prev; const n = new Set(prev.current); if (n.has(tag)) n.delete(tag); else n.add(tag); return { ...prev, current: n }; });
                    }} className="accent-nai-accent" />
                    <Tag className="w-3 h-3 text-gray-500" />{tag}
                  </label>
                );
              })}
              {vibeTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-700 flex gap-3">
              <button onClick={() => setVibeTagEditorTarget(null)} className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl text-sm">取消</button>
              <button onClick={async () => {
                if (!vibeTagEditorTarget) return;
                await setVibeTagsStorage(vibeTagEditorTarget.vibeId, Array.from(vibeTagEditorTarget.current));
                const allVibes = await getVibes();
                setLocalVibeFiles(allVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview, image: v.image, encodings: v.encodings, defaultStrength: v.defaultStrength, defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels, tags: v.tags, cloudFilename: v.cloudFilename } as VibeFile)));
                await reloadVibeTagPool();
                setVibeTagEditorTarget(null);
              }} className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl text-sm">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* Vibe 标签管理弹窗（二级 sheet） */}
      {vibeTagSettingsOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={() => { setVibeTagSettingsOpen(false); setVibeTagSettingsEditing(null); setVibeTagSettingsCreating(false); }}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[70vh] flex flex-col animate-slide-in-from-bottom" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <div className="flex items-center gap-2"><Settings className="w-4 h-4 text-nai-accent" /><span className="font-bold text-white text-base">标签管理</span><span className="text-xs text-gray-500">{vibeTagPool.length} 个</span></div>
              <button onClick={() => { setVibeTagSettingsOpen(false); setVibeTagSettingsEditing(null); setVibeTagSettingsCreating(false); }} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-4 pt-3 pb-2">
              {!vibeTagSettingsCreating ? (
                <button onClick={() => { setVibeTagSettingsCreating(true); setVibeTagSettingsNewName(''); }}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-700 text-gray-400 text-xs font-bold"><Plus className="w-3.5 h-3.5" /> 新建标签</button>
              ) : (() => {
                const t = vibeTagSettingsNewName.trim(); const dup = t.length > 0 && vibeTagPool.includes(t); const ok = t.length > 0 && !dup;
                return (
                  <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-2.5 space-y-2">
                    <input type="text" autoFocus value={vibeTagSettingsNewName} onChange={e => setVibeTagSettingsNewName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && ok) { const m = [...vibeTagPool, t].sort((a, b) => a.localeCompare(b, 'zh-CN')); setVibeTagPool(m); saveVibeTagPool(m); setVibeTagSettingsNewName(''); setVibeTagSettingsCreating(false); } if (e.key === 'Escape') { setVibeTagSettingsCreating(false); setVibeTagSettingsNewName(''); } }}
                      placeholder="输入新标签名" className="w-full bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none" />
                    {dup && <p className="text-[11px] text-red-400">标签 "{t}" 已存在</p>}
                    <div className="flex justify-end gap-2">
                      <button onClick={() => { setVibeTagSettingsCreating(false); setVibeTagSettingsNewName(''); }} className="px-3 py-1 text-xs text-gray-400">取消</button>
                      <button disabled={!ok} onClick={() => { const m = [...vibeTagPool, t].sort((a, b) => a.localeCompare(b, 'zh-CN')); setVibeTagPool(m); saveVibeTagPool(m); setVibeTagSettingsNewName(''); setVibeTagSettingsCreating(false); }}
                        className="px-3 py-1 bg-nai-accent text-black text-xs font-bold rounded-md disabled:opacity-30 flex items-center gap-1"><Check className="w-3 h-3" /> 创建</button>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {vibeTagPool.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-gray-500"><Tag className="w-8 h-8 mb-2 opacity-30" /><p className="text-xs">还没有标签</p></div>
              ) : vibeTagPool.map(tag => {
                const usage = vibeTagUsageCounts.get(tag) || 0;
                const isProtected = tag === '收藏';
                return (
                  <div key={tag} className="flex items-center gap-2 px-3 py-2.5 rounded-md">
                    <Tag className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="flex-1 text-sm text-gray-200 truncate">{tag}</span>
                    <span className="text-xs text-gray-500">{usage > 0 ? `${usage} 个` : '未使用'}</span>
                    {!isProtected && <button onClick={async () => {
const pool = vibeTagPool.filter(t => t !== tag); setVibeTagPool(pool); saveVibeTagPool(pool); }}
                      className="p-1 text-gray-400 active:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 批量添加标签弹窗（二级 sheet） */}
      {vibeBatchTagOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={() => { setVibeBatchTagOpen(false); setVibeBatchTagsToAdd(new Set()); }}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[60vh] flex flex-col animate-slide-in-from-bottom" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <span className="font-bold text-white text-base">批量添加标签 ({activeVibes.length})</span>
              <button onClick={() => { setVibeBatchTagOpen(false); setVibeBatchTagsToAdd(new Set()); }} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {vibeTagPool.map(tag => {
                const checked = vibeBatchTagsToAdd.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input type="checkbox" checked={checked} onChange={() => {
                      setVibeBatchTagsToAdd(prev => { const n = new Set(prev); if (n.has(tag)) n.delete(tag); else n.add(tag); return n; });
                    }} className="accent-nai-accent" />
                    <Tag className="w-3 h-3 text-gray-500" />{tag}
                  </label>
                );
              })}
              {vibeTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-700 flex gap-3">
              <button onClick={() => { setVibeBatchTagOpen(false); setVibeBatchTagsToAdd(new Set()); }}
                className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl text-sm">取消</button>
              <button onClick={async () => {
                const tagsToAdd = Array.from(vibeBatchTagsToAdd);
                if (tagsToAdd.length === 0) { setVibeBatchTagOpen(false); return; }
                for (const v of activeVibes) {
                  const allVibes = await getVibes();
                  const local = allVibes.find(lv => lv.id === v.id);
                  if (!local) continue;
                  const merged = Array.from(new Set([...(local.tags || []), ...tagsToAdd]));
                  await setVibeTagsStorage(v.id, merged);
                }
                const allVibes = await getVibes();
                setLocalVibeFiles(allVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview, image: v.image, encodings: v.encodings, defaultStrength: v.defaultStrength, defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels, tags: v.tags, cloudFilename: v.cloudFilename } as VibeFile)));
                await reloadVibeTagPool();
                setVibeBatchTagOpen(false);
                setVibeBatchTagsToAdd(new Set());
              }} className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl text-sm">应用</button>
            </div>
          </div>
        </div>
      )}

      {/* 云端数据管理弹窗 */}
      <CloudManageModal
        isOpen={vibeCloudMenuOpen}
        onClose={() => setVibeCloudMenuOpen(false)}
        onDataChanged={async () => {
          const allVibes = await getVibes();
          setLocalVibeFiles(allVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview, image: v.image, encodings: v.encodings, defaultStrength: v.defaultStrength, defaultInfoExtracted: v.defaultInfoExtracted, supportedModels: v.supportedModels, tags: v.tags, cloudFilename: v.cloudFilename } as VibeFile)));
          await reloadVibeTagPool();
        }}
      />

      {/* Precise Reference 选择弹窗 */}
      {showCRModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setShowCRModal(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            {/* 标题栏 */}
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <h3 className="text-lg font-bold text-white">角色管理器</h3>
              <button onClick={() => setShowCRModal(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tab 切换 */}
            <div className="flex-shrink-0 flex border-b border-gray-700">
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${crTab === 'public' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'
                  }`}
                onClick={() => setCrTab('public')}
              >
                公共 ({crPublicFiles.length})
              </button>
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${crTab === 'local' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'
                  }`}
                onClick={() => setCrTab('local')}
              >
                我的 ({crLocalFiles.length})
              </button>
            </div>

            {/* 可滑动内容区域 */}
            <div
              className="flex-1 overflow-hidden relative flex flex-col min-h-0"
              onTouchStart={(e) => {
                const touch = e.touches[0];
                (e.currentTarget as any)._touchStartX = touch.clientX;
                (e.currentTarget as any)._touchStartY = touch.clientY;
              }}
              onTouchEnd={(e) => {
                const startX = (e.currentTarget as any)._touchStartX;
                const startY = (e.currentTarget as any)._touchStartY;
                if (startX === undefined) return;
                const touch = e.changedTouches[0];
                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;
                // 只有水平滑动距离大于垂直滑动距离且超过50px才切换
                if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                  if (deltaX > 0 && crTab === 'local') {
                    setCrTab('public');
                  } else if (deltaX < 0 && crTab === 'public') {
                    setCrTab('local');
                  }
                }
              }}
            >
              {/* 本地上传按钮区域 */}
              {crTab === 'local' && (
                <div className="flex-shrink-0 p-3 border-b border-gray-700/50">
                  <label className="flex items-center justify-center gap-2 py-2.5 bg-gray-700/50 text-gray-300 rounded-xl active:scale-[0.98] active:bg-gray-600/50 transition-all cursor-pointer">
                    <ImageIcon className="w-4 h-4" />
                    <span className="text-sm font-medium">导入图片</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file || !file.type.startsWith('image/')) return;
                        try {
                          setIsLoadingCRs(true);
                          const reader = new FileReader();
                          reader.onload = async (event) => {
                            const base64 = event.target?.result as string;
                            const id = `cr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                            const name = file.name.replace(/\.[^/.]+$/, '');
                            const newCR: CRFile = { id, name, preview: base64 };
                            await saveCR({ ...newCR, isLocal: true });
                            setCrLocalFiles((prev) => [newCR, ...prev]);
                            // 添加到 activePreciseRefs
                            setActivePreciseRefs(prev => [...prev, {
                              id: newCR.id,
                              name: newCR.name,
                              preview: newCR.preview,
                              mode: 'character&style',
                              informationExtracted: 1,
                              strength: 1,
                              enabled: true,
                            }]);
                            setActiveVibes([]);
                            setShowCRModal(false);
                            setIsLoadingCRs(false);
                          };
                          reader.readAsDataURL(file);
                        } catch (err) {
                          console.error('Failed to import Precise Reference image:', err);
                          alert('导入图片失败: ' + (err as Error).message);
                          setIsLoadingCRs(false);
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
              )}

              {/* 内容列表 */}
              <div className="h-full overflow-y-auto">
                {isLoadingCRs ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : (crTab === 'public' ? crPublicFiles : crLocalFiles).length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                    <User className="w-12 h-12 mb-3 opacity-50" />
                    <p>{crTab === 'public' ? '暂无公共角色' : '暂无我的角色'}</p>
                    {crTab === 'local' && <p className="text-xs mt-2 text-gray-600">点击上方按钮添加</p>}
                    <p className="text-xs mt-4 text-gray-600">← 左右滑动切换 →</p>
                  </div>
                ) : (
                  <div className="p-3 space-y-2">
                    {(crTab === 'public' ? crPublicFiles : crLocalFiles).map((cr) => {
                      const isSelected = activePreciseRefs.some(pr => pr.id === cr.id);
                      return (
                        <div
                          key={cr.id}
                          className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${isSelected
                            ? 'bg-cyan-500/10 border-cyan-500/50'
                            : 'bg-gray-800/50 border-gray-700 active:bg-gray-700/50'
                            }`}
                          onClick={() => handleSelectCR(cr)}
                        >
                          <div
                            className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-cyan-500 border-cyan-500' : 'border-gray-500 bg-transparent'
                              }`}
                          >
                            {isSelected && <Check className="w-4 h-4 text-white" />}
                          </div>
                          {cr.preview ? (
                            <img src={cr.preview} alt={cr.name} className="w-12 h-12 rounded-lg object-cover" />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center">
                              <User className="w-5 h-5 text-gray-500" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className={`font-medium truncate ${isSelected ? 'text-cyan-300' : 'text-white'}`}>
                              {cr.name}
                            </div>
                          </div>
                          {crTab === 'local' && (
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                {
                                  await deleteCR(cr.id);
                                  setCrLocalFiles((prev) => prev.filter((c) => c.id !== cr.id));
                                  setActivePreciseRefs(prev => prev.filter(pr => pr.id !== cr.id));
                                }
                              }}
                              className="w-8 h-8 rounded-full bg-gray-700/50 flex items-center justify-center text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 底部操作 */}
            <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel">
              <div className="flex gap-3">
                <button
                  onClick={() => setActivePreciseRefs([])}
                  disabled={activePreciseRefs.length === 0}
                  className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100"
                >
                  清空
                </button>
                <button
                  onClick={() => setShowCRModal(false)}
                  className="flex-1 py-3 bg-cyan-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
                >
                  确认 {activePreciseRefs.length > 0 && `(${activePreciseRefs.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 画师串管理器弹窗（使用独立组件） */}
      <MobileArtistModal
        isOpen={showArtistModal}
        onClose={() => setShowArtistModal(false)}
        onConfirmSelection={(artist) => {
          if (artist) {
            const marker = makeArtistMarker(artist.name, artist.prompt);
            setPositivePrompt((prev: string) => (prev ? `${prev}, ${marker}` : marker));
          }
          setShowArtistModal(false);
        }}
      />

      {/* OC 选择弹窗 */}
      {showOCModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setShowOCModal(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <User className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold text-white">OC 角色</h3>
                {isLoadingOCs && <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={loadOCs}
                  className="p-2 text-gray-400 active:scale-95 transition-all"
                  title="刷新"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button onClick={() => setShowOCModal(false)} className="p-2 -mr-2 text-gray-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-shrink-0 flex border-b border-gray-700">
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${ocTab === 'public'
                  ? 'border-cyan-500 text-white bg-white/5'
                  : 'border-transparent text-gray-400'
                  }`}
                onClick={() => setOcTab('public')}
              >
                公共OC ({ocPublicFiles.length})
              </button>
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${ocTab === 'local'
                  ? 'border-cyan-500 text-white bg-white/5'
                  : 'border-transparent text-gray-400'
                  }`}
                onClick={() => setOcTab('local')}
              >
                我的OC ({ocLocalFiles.length})
              </button>
            </div>

            <div
              className="flex-1 overflow-hidden relative flex flex-col min-h-0"
              onTouchStart={(e) => {
                const touch = e.touches[0];
                (e.currentTarget as any)._touchStartX = touch.clientX;
                (e.currentTarget as any)._touchStartY = touch.clientY;
              }}
              onTouchEnd={(e) => {
                const startX = (e.currentTarget as any)._touchStartX;
                const startY = (e.currentTarget as any)._touchStartY;
                if (startX === undefined) return;
                const touch = e.changedTouches[0];
                const deltaX = touch.clientX - startX;
                const deltaY = touch.clientY - startY;
                if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                  if (deltaX > 0 && ocTab === 'local') {
                    setOcTab('public');
                  } else if (deltaX < 0 && ocTab === 'public') {
                    setOcTab('local');
                  }
                }
              }}
            >
              <div className="flex-shrink-0 p-3 border-b border-gray-700/50 bg-nai-panel/60">
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={ocSearchQuery}
                      onChange={(e) => setOcSearchQuery(e.target.value)}
                      placeholder={ocTab === 'public' ? '搜索公共 OC...' : '搜索我的 OC...'}
                      className="w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3 py-2.5 pr-10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-cyan-500"
                    />
                    <Filter className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
                  </div>
                  {ocTab === 'local' && (
                    <button
                      onClick={openCreateOC}
                      className="flex items-center justify-center gap-2 rounded-xl bg-cyan-500/15 px-4 py-2.5 text-cyan-300 active:scale-[0.98] transition-all"
                    >
                      <Plus className="w-4 h-4" />
                      <span className="text-sm font-medium">添加</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                {isLoadingOCs ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : filteredOCs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                    <User className="w-12 h-12 mb-3 opacity-50" />
                    <p>{ocTab === 'public' ? '暂无公共OC' : '暂无我的OC'}</p>
                    {ocTab === 'local' && <p className="text-xs mt-2 text-gray-600">点击上方按钮添加</p>}
                    <p className="text-xs mt-4 text-gray-600">← 左右滑动切换 →</p>
                  </div>
                ) : (
                  <div className="p-3 pb-24 grid grid-cols-3 gap-2">
                    {filteredOCs.map((oc) => {
                      const isSelected = selectedOCIds.has(oc.id);
                      return (
                        <div
                          key={oc.id}
                          className={`relative rounded-xl border overflow-hidden transition-all ${isSelected
                            ? 'border-cyan-500 ring-2 ring-cyan-500/30'
                            : 'border-gray-700 active:border-gray-600'
                            }`}
                          onClick={() => handleToggleOCSelection(oc)}
                        >
                          <div className="aspect-[3/4] bg-gray-800">
                            {oc.preview ? (
                              <img src={oc.preview} alt={oc.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <User className="w-8 h-8 text-gray-600" />
                              </div>
                            )}
                          </div>
                          <div className={`px-2 py-1.5 text-xs font-medium truncate text-center ${isSelected ? 'bg-cyan-500/20 text-cyan-300' : 'bg-gray-800/80 text-gray-300'
                            }`}>
                            {oc.name}
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyToClipboard(oc.positive);
                              setCopiedOCId(oc.id);
                              window.setTimeout(() => {
                                setCopiedOCId((prev) => (prev === oc.id ? null : prev));
                              }, 1200);
                            }}
                            className={`absolute top-1.5 right-1.5 h-8 min-w-8 rounded-full px-2 flex items-center justify-center ${
                              copiedOCId === oc.id ? 'bg-green-600 text-white' : 'bg-black/65 text-gray-100'
                            }`}
                            title={copiedOCId === oc.id ? '已复制' : '复制提示词'}
                          >
                            {copiedOCId === oc.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                          </button>
                          {ocTab === 'local' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditOC(oc);
                              }}
                              className="absolute top-1.5 left-1.5 h-8 min-w-8 rounded-full bg-black/65 px-2 flex items-center justify-center text-gray-100"
                              title="编辑"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel">
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={handleClearOC}
                  disabled={selectedOCIds.size === 0}
                  className="py-3 bg-gray-700 text-gray-300 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100"
                >
                  清空选择
                </button>
                <button
                  onClick={handleConfirmOC}
                  disabled={selectedOCIds.size === 0 || characterPrompts.length >= 6}
                  className="col-span-2 py-3 bg-cyan-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
                >
                  添加{selectedOCIds.size > 0 && ` (${selectedOCIds.size})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showOCModal && ocEditorMode && (
        <div className="fixed inset-0 z-[70] bg-black/80 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={closeOCEditor} />
          <div className="relative w-full max-h-[85vh] overflow-y-auto bg-nai-panel rounded-t-2xl border-t border-gray-700 p-4 safe-area-bottom">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h4 className="text-lg font-bold text-white">{ocEditorMode === 'create' ? '添加我的 OC' : '编辑我的 OC'}</h4>
              </div>
              <button onClick={closeOCEditor} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="w-24 shrink-0">
                  <div className="aspect-[832/1216] overflow-hidden rounded-xl border border-gray-700 bg-black/20 flex items-center justify-center relative">
                    {ocDraftPreview ? (
                      <img src={ocDraftPreview} alt="OC preview" className="h-full w-full object-cover" />
                    ) : (
                      <User className="w-8 h-8 text-gray-600" />
                    )}
                    {isGeneratingOCPreview && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                        <Loader2 className="w-5 h-5 animate-spin text-cyan-300" />
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex-1 space-y-3">
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">名称</label>
                    <input
                      value={ocDraftName}
                      onChange={(e) => setOcDraftName(e.target.value)}
                      placeholder="OC 名称..."
                      className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm font-bold focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-400 mb-1">别名（逗号分隔）</label>
                    <input
                      value={ocDraftAliases}
                      onChange={(e) => setOcDraftAliases(e.target.value)}
                      placeholder="小名, 昵称, ..."
                      className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="block text-xs text-gray-400">提示词</label>
                    <button
                      type="button"
                      onClick={handlePasteOCPrompt}
                      className="text-xs text-gray-300 hover:text-white flex items-center gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      粘贴
                    </button>
                  </div>
                  <textarea
                    value={ocDraftPositive}
                    onChange={(e) => setOcDraftPositive(e.target.value)}
                    rows={8}
                    placeholder="1girl, ..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl p-3 text-sm text-white font-mono focus:outline-none focus:border-cyan-500 resize-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleGenerateOCPreview}
                  disabled={!ocDraftPositive.trim() || isGeneratingOCPreview}
                  className="w-full rounded-xl bg-gray-100 py-2.5 text-sm font-bold text-black disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isGeneratingOCPreview ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {ocDraftPreview ? '重新生成预览' : '生成预览'}
                </button>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              {editingOCId ? (
                <button
                  onClick={async () => {
                    const target = ocLocalFiles.find((oc) => oc.id === editingOCId);
                    if (!target) return;
                    await handleDeleteLocalOC(target);
                    closeOCEditor();
                  }}
                  className="py-3 rounded-xl bg-red-500/15 text-red-300 font-medium flex items-center justify-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  删除
                </button>
              ) : (
                <button
                  onClick={closeOCEditor}
                  className="py-3 rounded-xl bg-gray-700 text-white font-medium"
                >
                  取消
                </button>
              )}
              <button
                onClick={handleSaveOC}
                disabled={isSavingOC}
                className="py-3 rounded-xl bg-cyan-500 text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isSavingOC ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 移动端灵感空间弹窗 */}
      {isInspirationModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setIsInspirationModalOpen(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            {/* 标题栏 */}
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-pink-400" />
                <h3 className="text-lg font-bold text-white">灵感空间</h3>
              </div>
              <button onClick={() => setIsInspirationModalOpen(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 筛选区域 - 对所有 Tab 生效 */}
            <div className="flex-shrink-0 p-3 border-b border-gray-700/50 space-y-2">
              {/* 搜索框 + 分类筛选按钮 */}
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    value={codexSearchQuery}
                    onChange={(e) => setCodexSearchQuery(e.target.value)}
                    placeholder="搜索法典内容..."
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-pink-500"
                  />
                  <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                </div>
                <button
                  onClick={() => setShowCategoryFilter(true)}
                  className={`px-3 py-2.5 rounded-xl border flex items-center gap-1.5 transition-colors ${codexSelectedCategories.length > 0
                    ? 'bg-pink-500/20 border-pink-500/50 text-pink-400'
                    : 'bg-gray-800 border-gray-700 text-gray-400'
                    }`}
                >
                  <Filter className="w-4 h-4" />
                  {codexSelectedCategories.length > 0 && (
                    <span className="text-xs font-bold">{codexSelectedCategories.length}</span>
                  )}
                </button>
              </div>
              {/* R18 筛选 */}
              <div className="flex gap-2">
                {(['all', 'safe', 'r18'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setCodexR18Filter(filter)}
                    className={`flex-1 py-2 rounded-lg text-xs font-medium transition-colors ${codexR18Filter === filter
                      ? filter === 'r18'
                        ? 'bg-pink-500/20 text-pink-400 border border-pink-500/50'
                        : filter === 'safe'
                          ? 'bg-green-500/20 text-green-400 border border-green-500/50'
                          : 'bg-gray-700 text-white border border-gray-600'
                      : 'bg-gray-800/50 text-gray-400 border border-gray-700'
                      }`}
                  >
                    {filter === 'all' ? '全部' : filter === 'safe' ? '全年龄' : 'R18'}
                  </button>
                ))}
              </div>
              {/* 已选分类标签 */}
              {codexSelectedCategories.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {codexSelectedCategories.map((cat) => {
                    const [type, name] = cat.split(':');
                    return (
                      <span
                        key={cat}
                        onClick={() => toggleCodexCategory(cat)}
                        className={`px-2 py-1 rounded-lg text-xs font-medium cursor-pointer flex items-center gap-1 ${type === 'nsfw'
                          ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                          : 'bg-green-500/20 text-green-400 border border-green-500/30'
                          }`}
                      >
                        {name}
                        <X className="w-3 h-3" />
                      </span>
                    );
                  })}
                  <button
                    onClick={() => setCodexSelectedCategories([])}
                    className="px-2 py-1 rounded-lg text-xs font-medium bg-gray-700 text-gray-400 hover:text-white"
                  >
                    清空
                  </button>
                </div>
              )}
            </div>

            {/* Tab 切换 */}
            <div className="flex-shrink-0 flex border-b border-gray-700">
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${inspirationTab === 'codex'
                  ? 'border-pink-500 text-white bg-white/5'
                  : 'border-transparent text-gray-400'
                  }`}
                onClick={() => setInspirationTab('codex')}
              >
                全部法典 ({filteredCodexData.length})
              </button>
              <button
                className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${inspirationTab === 'random'
                  ? 'border-pink-500 text-white bg-white/5'
                  : 'border-transparent text-gray-400'
                  }`}
                onClick={() => {
                  if (!randomCodexItem && filteredCodexData.length > 0) {
                    handleRandomCodex();
                  }
                  setInspirationTab('random');
                }}
              >
                随机灵感
              </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              {inspirationTab === 'codex' ? (
                /* 法典列表 */
                <div className="flex-1 overflow-y-auto" onScroll={handleCodexScroll}>
                  {isLoadingCodex ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                    </div>
                  ) : filteredCodexData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                      <Sparkles className="w-12 h-12 mb-3 opacity-50" />
                      <p>暂无匹配内容</p>
                    </div>
                  ) : (
                    <div className="p-3 space-y-2">
                      {filteredCodexData.slice(0, codexDisplayCount).map((item) => (
                        <div
                          key={item.id}
                          className="p-3 rounded-xl border bg-gray-800/50 border-gray-700 active:bg-gray-700/50 transition-all"
                          onClick={() => handleInspirationSelect(item.content)}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-medium text-white text-sm">{item.title}</span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-xs ${item.isR18
                                ? 'bg-pink-500/20 text-pink-400'
                                : 'bg-green-500/20 text-green-400'
                                }`}
                            >
                              {item.isR18 ? 'R18' : '全年龄'}
                            </span>
                            <span className="px-1.5 py-0.5 bg-gray-700 text-gray-400 rounded text-xs">
                              {item.category}
                            </span>
                          </div>
                          <p className="text-xs text-gray-400 line-clamp-2">{item.content}</p>
                        </div>
                      ))}
                      {codexDisplayCount < filteredCodexData.length && (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="w-5 h-5 animate-spin text-gray-500" />
                          <span className="ml-2 text-xs text-gray-500">
                            加载中... ({codexDisplayCount}/{filteredCodexData.length})
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* 随机灵感 Tab */
                <div className="flex-1 flex flex-col p-4 min-h-0">
                  {randomCodexItem ? (
                    <div className="flex-1 flex flex-col min-h-0">
                      {/* 标题和标签 */}
                      <div className="flex-shrink-0 flex items-center gap-2 mb-3 overflow-hidden">
                        <span className="text-lg font-bold text-white truncate min-w-0 shrink" title={randomCodexItem.title}>{randomCodexItem.title}</span>
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-bold whitespace-nowrap shrink-0 ${randomCodexItem.isR18
                            ? 'bg-pink-500/20 text-pink-400 border border-pink-500/30'
                            : 'bg-green-500/20 text-green-400 border border-green-500/30'
                            }`}
                        >
                          {randomCodexItem.isR18 ? 'R18' : '全年龄'}
                        </span>
                        <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 rounded text-xs border border-indigo-500/30 whitespace-nowrap shrink-0">
                          {randomCodexItem.category}
                        </span>
                      </div>

                      {/* 内容 - 限制最大高度 */}
                      <div className="flex-1 min-h-0 bg-gray-800/50 rounded-xl p-4 border border-gray-700 overflow-y-auto">
                        <p className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                          {randomCodexItem.content}
                        </p>
                      </div>

                      {/* 操作按钮 */}
                      <div className="flex-shrink-0 flex gap-2 mt-4">
                        <button
                          onClick={handleRandomCodex}
                          className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                        >
                          <Dices className="w-4 h-4" />
                          换一个
                        </button>
                        <button
                          onClick={() => {
                            copyToClipboard(randomCodexItem.content);
                          }}
                          className="py-3 px-4 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center"
                        >
                          <Copy className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleInspirationSelect(randomCodexItem.content)}
                          className="flex-1 py-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                        >
                          <Plus className="w-4 h-4" />
                          添加
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-500">
                      <Dices className="w-16 h-16 mb-4 opacity-50" />
                      <p className="text-lg font-medium mb-2">随机灵感</p>
                      <p className="text-sm text-gray-600 mb-6">从法典中随机抽取一条灵感</p>
                      <button
                        onClick={handleRandomCodex}
                        disabled={filteredCodexData.length === 0}
                        className="px-8 py-3 bg-gradient-to-r from-pink-500 to-purple-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all flex items-center gap-2 disabled:opacity-50"
                      >
                        <Dices className="w-5 h-5" />
                        开始随机
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 分类筛选弹窗 */}
      {showCategoryFilter && (
        <div className="fixed inset-0 z-[60] bg-black/70 flex items-end animate-fade-in">
          <div className="absolute inset-0" onClick={() => setShowCategoryFilter(false)} />
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[70vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
            {/* 标题栏 */}
            <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
              <div className="flex items-center gap-2">
                <Filter className="w-5 h-5 text-pink-400" />
                <h3 className="text-lg font-bold text-white">分类筛选</h3>
                {codexSelectedCategories.length > 0 && (
                  <span className="px-2 py-0.5 bg-pink-500/20 text-pink-400 rounded-full text-xs font-bold">
                    {codexSelectedCategories.length}
                  </span>
                )}
              </div>
              <button onClick={() => setShowCategoryFilter(false)} className="p-2 -mr-2 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 分类列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* R18 分类 */}
              {categoriesByType.nsfw.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-bold text-pink-400">R18 分类</span>
                    <span className="text-xs text-gray-500">({categoriesByType.nsfw.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {categoriesByType.nsfw.map((cat) => {
                      const key = `nsfw:${cat}`;
                      const isSelected = codexSelectedCategories.includes(key);
                      return (
                        <button
                          key={key}
                          onClick={() => toggleCodexCategory(key)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isSelected
                            ? 'bg-pink-500/30 text-pink-300 border border-pink-500/50'
                            : 'bg-gray-800 text-gray-400 border border-gray-700'
                            }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 全年龄分类 */}
              {categoriesByType.common.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-bold text-green-400">全年龄分类</span>
                    <span className="text-xs text-gray-500">({categoriesByType.common.length})</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {categoriesByType.common.map((cat) => {
                      const key = `common:${cat}`;
                      const isSelected = codexSelectedCategories.includes(key);
                      return (
                        <button
                          key={key}
                          onClick={() => toggleCodexCategory(key)}
                          className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${isSelected
                            ? 'bg-green-500/30 text-green-300 border border-green-500/50'
                            : 'bg-gray-800 text-gray-400 border border-gray-700'
                            }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 底部按钮 */}
            <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel flex gap-3">
              <button
                onClick={() => setCodexSelectedCategories([])}
                disabled={codexSelectedCategories.length === 0}
                className="flex-1 py-3 bg-gray-700 text-white font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
              >
                清空
              </button>
              <button
                onClick={() => setShowCategoryFilter(false)}
                className="flex-1 py-3 bg-pink-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
              >
                确认 ({codexSelectedCategories.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 图片导入弹窗 */}
      {showImageImportModal && importImageDataUrl && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center animate-fade-in"
          onClick={() => setShowImageImportModal(false)}
        >
          {/* 下半部分背景遮罩 */}
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-nai-panel pointer-events-none" />
          <div
            className="relative w-full bg-nai-panel rounded-t-2xl shadow-2xl max-h-[85vh] flex flex-col animate-slide-in-from-bottom mb-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 反推结果页面 */}
            {showTaggerResult && taggerResult ? (
              <>
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowTaggerResult(false)}
                      className="p-1.5 text-gray-400 active:text-white"
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h3 className="text-base font-bold text-white flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-nai-accent" />
                      反推结果
                    </h3>
                  </div>
                  <button
                    onClick={() => setShowImageImportModal(false)}
                    className="p-1.5 text-gray-400 active:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {/* 图片预览 + 基本信息 */}
                <div className="flex gap-3 p-4 border-b border-gray-700">
                  <div className="w-20 shrink-0">
                    <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
                      <img src={importImageDataUrl} alt="" className="w-full h-auto" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-gray-500 mb-1">解析模型</div>
                    <div className="text-sm text-white">wd-swinv2-tagger-v3</div>

                    {taggerResult.confidence && Object.keys(taggerResult.confidence).length > 0 && (
                      <div className="mt-2">
                        <div className="text-xs text-gray-500 mb-1">识别角色</div>
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(taggerResult.confidence)
                            .sort(([, a], [, b]) => b - a)
                            .slice(0, 3)
                            .map(([name, conf]) => (
                              <span
                                key={name}
                                className="px-2 py-0.5 bg-nai-accent/20 text-nai-accent rounded text-xs"
                              >
                                {name} ({(conf * 100).toFixed(0)}%)
                              </span>
                            ))}
                        </div>
                      </div>
                    )}

                    {taggerResult.rating && (
                      <div className="mt-2">
                        <div className="text-xs text-gray-500 mb-1">评级</div>
                        <span className={`px-2 py-0.5 rounded text-xs ${taggerResult.rating === 'general' ? 'bg-green-500/20 text-green-400' :
                          taggerResult.rating === 'sensitive' ? 'bg-yellow-500/20 text-yellow-400' :
                            'bg-red-500/20 text-red-400'
                          }`}>
                          {taggerResult.rating}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* 标签内容 */}
                <div className="p-4 flex-1 overflow-y-auto">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-gray-500">反推标签</span>
                    <button
                      onClick={() => {
                        if (taggerResult.tags) {
                          copyToClipboard(taggerResult.tags);
                        }
                      }}
                      className="flex items-center gap-1 text-xs text-gray-400 active:text-white px-2 py-1 rounded"
                    >
                      <Copy className="w-3 h-3" />
                      复制
                    </button>
                  </div>
                  <div className="text-xs text-gray-300 bg-gray-800/50 rounded-lg p-3 leading-relaxed max-h-32 overflow-y-auto">
                    {taggerResult.tags}
                  </div>
                </div>

                {/* 底部操作 */}
                <div className="p-4 border-t border-gray-700 space-y-3 safe-area-bottom">
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={importOptions.cleanImports}
                        onChange={() => setImportOptions(prev => ({ ...prev, cleanImports: !prev.cleanImports }))}
                        className="w-4 h-4 rounded"
                      />
                      清空现有提示词
                    </label>
                    {taggerResult.character && (
                      <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={includeCharacter}
                          onChange={() => setIncludeCharacter(!includeCharacter)}
                          className="w-4 h-4 rounded"
                        />
                        包含识别角色
                      </label>
                    )}
                  </div>

                  <button
                    onClick={() => {
                      if (taggerResult.tags) {
                        let finalPrompt = taggerResult.tags;
                        if (includeCharacter && taggerResult.character) {
                          finalPrompt = `${taggerResult.character}, ${taggerResult.tags}`;
                        }
                        if (importOptions.cleanImports) {
                          setPositivePrompt(finalPrompt);
                        } else {
                          setPositivePrompt((prev: string) => prev ? `${prev}, ${finalPrompt}` : finalPrompt);
                        }
                        setShowImageImportModal(false);
                      }
                    }}
                    className="w-full flex items-center justify-center gap-2 py-3 bg-nai-accent text-black font-bold rounded-xl"
                  >
                    <Download className="w-4 h-4" />
                    导入为正向提示词
                  </button>

                  <div className="text-xs text-gray-500 mb-2">或用作</div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        if (importImageDataUrl) {
                          try {
                            // 从 data URL 提取 base64 数据
                            const base64Data = importImageDataUrl.split(',')[1];
                            const newVibe = await createVibeFromImageBase64(base64Data, 0.6, 1, `vibe_${Date.now()}`);
                            if (newVibe) {
                              setActiveVibes(prev => [...prev, {
                                ...newVibe,
                                referenceStrength: newVibe.defaultStrength || 0.6,
                                informationExtracted: newVibe.defaultInfoExtracted || 1,
                                enabled: true,
                              }]);
                            }
                          } catch (err) {
                            console.error('创建 Vibe 失败:', err);
                          }
                        }
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <Palette className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">Vibe</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) setImg2imgWithAutoRes(importImageDataUrl);
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <ImageIcon className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">Img2Img</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) {
                          const newCR: ActiveCR = {
                            id: `cr_${Date.now()}`,
                            name: '导入的CR',
                            preview: importImageDataUrl,
                            fidelity: 1,
                            styleAware: false,
                          };
                          setActiveCR(newCR);
                        }
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <User className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">CR</span>
                    </button>
                  </div>
                </div>
              </>
            ) : showFullMetadata && importImageMetadata ? (
              /* 查看完整元数据二级面板 */
              <>
                {/* 头部 */}
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowFullMetadata(false)}
                      className="p-1.5 text-gray-400 active:text-white"
                    >
                      <ArrowLeft className="w-5 h-5" />
                    </button>
                    <h3 className="text-base font-bold text-white">完整元数据</h3>
                  </div>
                  <button
                    onClick={() => setShowImageImportModal(false)}
                    className="p-1.5 text-gray-400 active:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                {/* 详情面板 */}
                <div className="flex-1 min-h-0 overflow-y-auto">
                  <MetadataDetailPanel
                    file={{
                      name: '历史图片',
                      dataUrl: importImageDataUrl || '',
                      metadata: importImageMetadata,
                      isSelected: false,
                      fileSize: 0,
                    }}
                  />
                </div>
              </>
            ) : importImageMetadata ? (
              /* 有元数据的页面 */
              <>
                {/* 头部：图片预览 + 基本信息 */}
                <div className="flex gap-3 p-4 border-b border-gray-700">
                  <div className="w-24 shrink-0">
                    <div className="rounded-lg overflow-hidden border border-gray-600 bg-gray-900">
                      <img src={importImageDataUrl} alt="" className="w-full h-auto" />
                    </div>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-sm font-medium text-white truncate">{importImageMetadata.source}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {importImageMetadata.width}×{importImageMetadata.height} · {getPictureSizeType(importImageMetadata.width, importImageMetadata.height)}
                        </div>
                      </div>
                      <button
                        onClick={() => setShowImageImportModal(false)}
                        className="p-1 text-gray-400 active:text-white -mr-1 -mt-1"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    {/* 参数标签 */}
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {importImageMetadata.seed && (
                        <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">
                          Seed: {importImageMetadata.seed}
                        </span>
                      )}
                      {importImageMetadata.steps && (
                        <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">
                          Steps: {importImageMetadata.steps}
                        </span>
                      )}
                      {importImageMetadata.scale && (
                        <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300">
                          CFG: {importImageMetadata.scale}
                        </span>
                      )}
                      {importImageMetadata.characterPrompts && importImageMetadata.characterPrompts.length > 0 && (
                        <span className="px-2 py-1 bg-nai-accent/20 rounded text-xs text-nai-accent">
                          {importImageMetadata.characterPrompts.length} 角色
                        </span>
                      )}
                      {importImageMetadata.vibes && importImageMetadata.vibes.length > 0 && (
                        <span className="px-2 py-1 bg-purple-500/20 rounded text-xs text-purple-400">
                          {importImageMetadata.vibes.length} Vibe
                        </span>
                      )}
                    </div>

                    {/* 提示词预览 */}
                    {importImageMetadata.prompt && (
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs text-gray-500">提示词</span>
                          <button
                            onClick={() => copyToClipboard(importImageMetadata.prompt || '')}
                            className="p-1 text-gray-500 hover:text-nai-accent active:scale-95 transition-all"
                            title="复制提示词"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="text-xs text-gray-300 leading-relaxed break-all bg-gray-800/50 rounded-lg p-2 max-h-24 overflow-y-auto">
                          {importImageMetadata.prompt}
                        </div>
                      </div>
                    )}
                    <button
                      onClick={() => setShowFullMetadata(true)}
                      className="text-xs text-nai-accent active:opacity-70 mt-2"
                    >
                      查看完整元数据
                    </button>
                  </div>
                </div>

                {/* 导入区域 */}
                <div className="p-4 border-b border-gray-700">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-gray-300 font-medium">导入选项</span>
                    <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={importOptions.cleanImports}
                        onChange={() => setImportOptions(prev => ({ ...prev, cleanImports: !prev.cleanImports }))}
                        className="w-4 h-4 rounded"
                      />
                      清空现有内容
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {importImageMetadata.prompt && (
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={importOptions.prompt}
                          onChange={() => setImportOptions(prev => ({ ...prev, prompt: !prev.prompt }))}
                          className="w-4 h-4 rounded"
                        />
                        正向提示词
                      </label>
                    )}
                    {importImageMetadata.negativePrompt && (
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={importOptions.negativePrompt}
                          onChange={() => setImportOptions(prev => ({ ...prev, negativePrompt: !prev.negativePrompt }))}
                          className="w-4 h-4 rounded"
                        />
                        负向提示词
                      </label>
                    )}
                    {importImageMetadata.sourceType === 'novelai' && importImageMetadata.characterPrompts && importImageMetadata.characterPrompts.length > 0 && (
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={importOptions.characters}
                          onChange={() => setImportOptions(prev => ({ ...prev, characters: !prev.characters }))}
                          className="w-4 h-4 rounded"
                        />
                        角色提示词
                      </label>
                    )}
                    {importImageMetadata.sourceType === 'novelai' && (importImageMetadata.steps || importImageMetadata.scale) && (() => {
                      const settingsIssues = getUnsupportedImportSettings(importImageMetadata);
                      const settingsDisabled = settingsIssues.length > 0;
                      return (
                        <label className={`flex items-center gap-2 text-sm ${settingsDisabled ? 'cursor-not-allowed text-gray-500' : 'cursor-pointer text-gray-300'}`}>
                          <input
                            type="checkbox"
                            disabled={settingsDisabled}
                            checked={!settingsDisabled && importOptions.settings}
                            onChange={() => { if (!settingsDisabled) setImportOptions(prev => ({ ...prev, settings: !prev.settings })); }}
                            className="w-4 h-4 rounded disabled:opacity-50"
                          />
                          生成设置
                          {settingsDisabled && (
                            <span className="text-[10px] text-amber-500/80">不支持: {formatUnsupportedSettings(settingsIssues)}</span>
                          )}
                        </label>
                      );
                    })()}
                    {importImageMetadata.sourceType === 'novelai' && importImageMetadata.seed && (
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={importOptions.seed}
                          onChange={() => setImportOptions(prev => ({ ...prev, seed: !prev.seed }))}
                          className="w-4 h-4 rounded"
                        />
                        种子
                      </label>
                    )}
                    {importImageMetadata.sourceType === 'novelai' && importImageMetadata.vibes && importImageMetadata.vibes.length > 0 && (
                      <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={importOptions.vibes}
                          onChange={() => setImportOptions(prev => ({ ...prev, vibes: !prev.vibes }))}
                          className="w-4 h-4 rounded"
                        />
                        Vibe ({importImageMetadata.vibes.length})
                      </label>
                    )}
                  </div>

                  <button
                    onClick={async () => {
                      const meta = importImageMetadata;
                      if (importOptions.cleanImports) {
                        if (importOptions.prompt && meta.prompt) setPositivePrompt(meta.prompt);
                        if (importOptions.negativePrompt && meta.negativePrompt) setNegativePrompt(meta.negativePrompt);
                      } else {
                        if (importOptions.prompt && meta.prompt) {
                          setPositivePrompt((prev: string) => prev ? `${prev}, ${meta.prompt}` : meta.prompt);
                        }
                        if (importOptions.negativePrompt && meta.negativePrompt) {
                          setNegativePrompt((prev: string) => prev ? `${prev}, ${meta.negativePrompt}` : meta.negativePrompt);
                        }
                      }
                      // 仅 NovelAI 来源、且无不支持值时才导入生成设置（兜底，防 UI 状态残留）
                      if (importOptions.settings && meta.sourceType === 'novelai' && getUnsupportedImportSettings(meta).length === 0) {
                        if (meta.steps) setSteps(Number(meta.steps));
                        if (meta.scale) setScale(Number(meta.scale));
                        if (meta.sampler) setSampler(meta.sampler);   // 移动端 state 与元数据同为 API id，直接用
                        if (meta.noiseSchedule) setNoiseSchedule(normalizeNoiseSchedule(meta.noiseSchedule));
                        if (meta.width && meta.height) {
                          setLocalWidth(meta.width);
                          setLocalHeight(meta.height);
                        }
                      }
                      if (importOptions.seed && meta.seed) {
                        setSeed(String(meta.seed));
                      }
                      if (importOptions.characters && meta.characterPrompts) {
                        const newChars = meta.characterPrompts.map((cp, idx) => ({
                          id: `imported_${Date.now()}_${idx}`,
                          positive: cp.prompt || '',
                          negative: cp.uc || '',
                          activeTab: 'prompt' as const,
                          enabled: true,
                        }));
                        if (importOptions.cleanImports) {
                          setCharacterPrompts(newChars);
                        } else {
                          setCharacterPrompts(prev => [...prev, ...newChars]);
                        }
                      }

                      // 导入 Vibe
                      if (importOptions.vibes && meta.vibes && meta.vibes.length > 0) {
                        try {
                        console.log(`[Vibe导入] 检测到 ${meta.vibes.length} 个 vibe 数据`);

                        const generateVibeName = (vibeIndex: number) => {
                          return `导入的 Vibe ${vibeIndex + 1}`;
                        };

                        // 从元数据 source 推断 API 模型名（用于编码导入）
                        const inferApiModel = (source?: string): string => {
                          if (!source) return 'nai-diffusion-4-5-full';
                          const s = source.toLowerCase();
                          if (s.includes('v4.5 curated')) return 'nai-diffusion-4-5-curated';
                          if (s.includes('v4.5')) return 'nai-diffusion-4-5-full';
                          if (s.includes('v4 curated')) return 'nai-diffusion-4-curated';
                          if (s.includes('v4')) return 'nai-diffusion-4-full';
                          if (s.includes('v3')) return 'nai-diffusion-3';
                          return 'nai-diffusion-4-5-full';
                        };

                        const newVibes: ActiveVibe[] = [];

                        for (let index = 0; index < meta.vibes.length; index++) {
                          const vibe = meta.vibes[index];
                          console.log(`[Vibe导入] Vibe ${index + 1}:`, {
                            hasImage: !!vibe.image,
                            hasEncoding: !!vibe.encoding,
                            strength: vibe.strength,
                            informationExtracted: vibe.informationExtracted,
                          });

                          if (vibe.image) {
                            // 通过图片 hash 在本地存储中查找匹配的 vibe
                            const found = await findVibeByImage(vibe.image);
                            console.log(`[Vibe导入] 通过图片匹配结果:`, found ? found.name : '未找到');

                            if (found) {
                              let defaultInfoExtracted = found.defaultInfoExtracted ?? 1;
                              if (found.encodings) {
                                const firstModelKey = Object.keys(found.encodings)[0];
                                if (firstModelKey) {
                                  const firstEncoding = Object.values(found.encodings[firstModelKey])[0];
                                  if (firstEncoding?.params) {
                                    defaultInfoExtracted = firstEncoding.params.information_extracted;
                                  }
                                }
                              }

                              newVibes.push({
                                id: found.id,
                                name: found.name,
                                preview: found.preview,
                                image: found.image,
                                encodings: found.encodings,
                                referenceStrength: vibe.strength,
                                informationExtracted: defaultInfoExtracted,
                                supportedModels: found.supportedModels,
                                enabled: true,
                              });
                              console.log(`Vibe "${found.name}" 从本地存储匹配成功`);
                            } else {
                              // 未找到本地 vibe，从图片数据创建新的 vibe
                              console.log(`[Vibe导入] Vibe ${index + 1} 未在本地找到，从图片数据创建新 vibe...`);
                              const importedVibe = await createVibeFromImageBase64(
                                vibe.image,
                                vibe.strength,
                                vibe.informationExtracted ?? 1,
                                generateVibeName(index)
                              );

                              newVibes.push({
                                id: importedVibe.id,
                                name: importedVibe.name,
                                preview: importedVibe.preview,
                                image: importedVibe.image,
                                encodings: importedVibe.encodings,
                                referenceStrength: vibe.strength,
                                informationExtracted: vibe.informationExtracted ?? 1,
                                supportedModels: importedVibe.supportedModels,
                                enabled: true,
                              });

                              // 添加到本地文件列表
                              setLocalVibeFiles(prev => [{
                                id: importedVibe.id,
                                name: importedVibe.name,
                                preview: importedVibe.preview,
                                image: importedVibe.image,
                                encodings: importedVibe.encodings,
                                defaultStrength: importedVibe.defaultStrength,
                                defaultInfoExtracted: importedVibe.defaultInfoExtracted,
                                supportedModels: importedVibe.supportedModels,
                              }, ...prev]);

                              console.log(`[Vibe导入] Vibe ${index + 1} 已从图片数据创建并保存`);
                            }
                          } else if (vibe.encoding) {
                            // 兼容旧格式：通过编码匹配
                            console.log(`[Vibe导入] 尝试通过编码匹配...`);
                            const found = await findVibeByEncoding(vibe.encoding);
                            console.log(`[Vibe导入] 通过编码匹配结果:`, found ? found.vibe.name : '未找到');

                            if (found) {
                              newVibes.push({
                                id: found.vibe.id,
                                name: found.vibe.name,
                                preview: found.vibe.preview,
                                image: found.vibe.image,
                                encodings: found.vibe.encodings,
                                referenceStrength: vibe.strength,
                                informationExtracted: found.informationExtracted,
                                supportedModels: found.vibe.supportedModels,
                                enabled: true,
                              });
                              console.log(`Vibe "${found.vibe.name}" 从本地存储匹配成功（通过编码）`);
                            } else {
                              // 未找到本地 vibe，使用导入的编码数据创建新的vibe
                              const importedVibe = await createVibeFromEncoding(
                                vibe.encoding,
                                vibe.informationExtracted ?? 1,
                                vibe.strength,
                                inferApiModel(meta.source),
                                generateVibeName(index)
                              );

                              newVibes.push({
                                id: importedVibe.id,
                                name: importedVibe.name,
                                preview: importedVibe.preview,
                                image: importedVibe.image,
                                encodings: importedVibe.encodings,
                                referenceStrength: vibe.strength,
                                informationExtracted: vibe.informationExtracted ?? 1,
                                supportedModels: importedVibe.supportedModels,
                                enabled: true,
                              });

                              // 添加到本地文件列表
                              setLocalVibeFiles(prev => [{
                                id: importedVibe.id,
                                name: importedVibe.name,
                                preview: importedVibe.preview,
                                image: importedVibe.image,
                                encodings: importedVibe.encodings,
                                defaultStrength: importedVibe.defaultStrength,
                                defaultInfoExtracted: importedVibe.defaultInfoExtracted,
                                supportedModels: importedVibe.supportedModels,
                              }, ...prev]);

                              console.log(`Vibe ${index + 1} 未在本地找到，已创建新的 vibe 并保存`);
                            }
                          } else if (vibe.needsLocalMatch) {
                            // 没有 image 和 encoding，尝试通过 seed 从 vibe 历史中匹配
                            let matched = false;

                            // 1. 首先尝试通过 seed 匹配（最可靠）
                            if (meta.seed) {
                              const historyStr = localStorage.getItem('novelai_vibe_history');
                              if (historyStr) {
                                try {
                                  const history = JSON.parse(historyStr) as Record<string, {
                                    vibes: Array<{ id: string; strength: number; informationExtracted: number }>;
                                    timestamp: number;
                                  }>;

                                  const seedKey = String(meta.seed);
                                  const historyEntry = history[seedKey];

                                  if (historyEntry && historyEntry.vibes[index]) {
                                    const historyVibe = historyEntry.vibes[index];
                                    const allVibes = await getVibes();
                                    const found = allVibes.find(v => v.id === historyVibe.id);

                                    if (found) {
                                      newVibes.push({
                                        id: found.id,
                                        name: found.name,
                                        preview: found.preview,
                                        image: found.image,
                                        encodings: found.encodings,
                                        referenceStrength: historyVibe.strength,
                                        informationExtracted: historyVibe.informationExtracted,
                                        supportedModels: found.supportedModels,
                                        enabled: true,
                                      });
                                      console.log(`[Vibe导入] Vibe "${found.name}" 通过 seed=${seedKey} 匹配成功`);
                                      matched = true;
                                    }
                                  }
                                } catch (e) {
                                  console.warn('[Vibe导入] 解析 vibe 历史失败:', e);
                                }
                              }
                            }

                            // 2. 回退：通过 strength 匹配
                            if (!matched) {
                              console.log(`[Vibe导入] seed 匹配失败，尝试通过参数匹配...`);
                              const allVibes = await getVibes();
                              for (const localVibe of allVibes) {
                                if (!localVibe.encodings) continue;
                                for (const modelKey in localVibe.encodings) {
                                  const modelEncodings = localVibe.encodings[modelKey];
                                  for (const hash in modelEncodings) {
                                    const entry = modelEncodings[hash];
                                    if (entry.params && Math.abs(entry.params.information_extracted - (vibe.informationExtracted ?? 1)) < 0.01) {
                                      newVibes.push({
                                        id: localVibe.id,
                                        name: localVibe.name,
                                        preview: localVibe.preview,
                                        image: localVibe.image,
                                        encodings: localVibe.encodings,
                                        referenceStrength: vibe.strength,
                                        informationExtracted: entry.params.information_extracted,
                                        supportedModels: localVibe.supportedModels,
                                        enabled: true,
                                      });
                                      console.log(`[Vibe导入] Vibe "${localVibe.name}" 通过参数匹配成功（可能不准确）`);
                                      matched = true;
                                      break;
                                    }
                                  }
                                  if (matched) break;
                                }
                                if (matched) break;
                              }
                            }

                            if (!matched) {
                              console.log(`[Vibe导入] Vibe ${index + 1} 未能匹配到本地 vibe（无图片/编码数据）`);
                            }
                          }
                        }

                        if (newVibes.length > 0) {
                          if (importOptions.cleanImports) {
                            setActiveVibes(newVibes);
                          } else {
                            setActiveVibes(prev => [...prev, ...newVibes]);
                          }
                          console.log(`[Vibe导入] 成功导入 ${newVibes.length} 个 vibe`);
                        }
                        } catch (vibeErr) {
                          console.error('[Vibe导入] 导入失败:', vibeErr);
                        }
                      }

                      setShowImageImportModal(false);
                    }}
                    className="w-full mt-3 flex items-center justify-center gap-2 py-2.5 bg-nai-accent text-black font-bold rounded-xl"
                  >
                    <Download className="w-4 h-4" />
                    导入元数据
                  </button>
                </div>

                {/* 其他用途 */}
                <div className="p-4 safe-area-bottom">
                  <div className="text-xs text-gray-500 mb-2">或用作</div>
                  <div className="flex gap-2">
                    <button
                      onClick={async () => {
                        if (importImageDataUrl) {
                          try {
                            // 从 data URL 提取 base64 数据
                            const base64Data = importImageDataUrl.split(',')[1];
                            const newVibe = await createVibeFromImageBase64(base64Data, 0.6, 1, `vibe_${Date.now()}`);
                            if (newVibe) {
                              setActiveVibes(prev => [...prev, {
                                ...newVibe,
                                referenceStrength: newVibe.defaultStrength || 0.6,
                                informationExtracted: newVibe.defaultInfoExtracted || 1,
                                enabled: true,
                              }]);
                            }
                          } catch (err) {
                            console.error('创建 Vibe 失败:', err);
                          }
                        }
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <Palette className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">Vibe</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) setImg2imgWithAutoRes(importImageDataUrl);
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <ImageIcon className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">Img2Img</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) {
                          const newCR: ActiveCR = {
                            id: `cr_${Date.now()}`,
                            name: '导入的CR',
                            preview: importImageDataUrl,
                            fidelity: 1,
                            styleAware: false,
                          };
                          setActiveCR(newCR);
                        }
                        setShowImageImportModal(false);
                      }}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-gray-800 border border-gray-700 rounded-xl"
                    >
                      <User className="w-4 h-4 text-nai-accent" />
                      <span className="text-xs text-gray-300">CR</span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              /* 无元数据的简单模式 */
              <>
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
                  <h3 className="text-base font-bold text-white">选择用途</h3>
                  <button
                    onClick={() => setShowImageImportModal(false)}
                    className="p-1.5 text-gray-400 active:text-white"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                {isParsingMetadata ? (
                  <div className="flex items-center justify-center gap-2 text-gray-400 text-sm py-8">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>解析中...</span>
                  </div>
                ) : (
                  <div className="p-4 pb-8 space-y-3 safe-area-bottom">
                    {/* 无元数据提示 + 反推按钮 */}
                    <div className="p-3 bg-gray-800/50 rounded-xl border border-gray-700">
                      <div className="text-xs text-gray-400 mb-2">未检测到元数据</div>
                      <button
                        onClick={async () => {
                          if (!importImageDataUrl || isAnalyzingTagger) return;
                          setIsAnalyzingTagger(true);
                          try {
                            const base64 = extractBase64FromDataUrl(importImageDataUrl);
                            const result = await analyzeImageWithWDTagger(base64);
                            if (result) {
                              setTaggerResult(result);
                              setShowTaggerResult(true);
                            } else {
                              alert('反推失败，请稍后重试');
                            }
                          } catch (error) {
                            console.error('WD Tagger 分析失败:', error);
                            alert('反推失败，请稍后重试');
                          } finally {
                            setIsAnalyzingTagger(false);
                          }
                        }}
                        disabled={isAnalyzingTagger}
                        className="w-full flex items-center justify-center gap-2 py-2.5 bg-nai-accent/20 text-nai-accent border border-nai-accent/30 rounded-xl text-sm disabled:opacity-50"
                      >
                        {isAnalyzingTagger ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            反推中...
                          </>
                        ) : (
                          <>
                            <Sparkles className="w-4 h-4" />
                            AI 反推标签
                          </>
                        )}
                      </button>
                      <div className="text-[10px] text-gray-500 mt-1.5 text-center">
                        使用 WD Tagger 模型反推图片标签
                      </div>
                    </div>

                    <button
                      onClick={async () => {
                        if (importImageDataUrl) {
                          try {
                            // 从 data URL 提取 base64 数据
                            const base64Data = importImageDataUrl.split(',')[1];
                            const newVibe = await createVibeFromImageBase64(base64Data, 0.6, 1, `vibe_${Date.now()}`);
                            if (newVibe) {
                              setActiveVibes(prev => [...prev, {
                                ...newVibe,
                                referenceStrength: newVibe.defaultStrength || 0.6,
                                informationExtracted: newVibe.defaultInfoExtracted || 1,
                                enabled: true,
                              }]);
                            }
                          } catch (err) {
                            console.error('创建 Vibe 失败:', err);
                          }
                        }
                        setShowImageImportModal(false);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-xl"
                    >
                      <Palette className="w-5 h-5 text-nai-accent" />
                      <span className="text-sm text-white">Vibe Transfer</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) setImg2imgWithAutoRes(importImageDataUrl);
                        setShowImageImportModal(false);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-xl"
                    >
                      <ImageIcon className="w-5 h-5 text-nai-accent" />
                      <span className="text-sm text-white">Image2Image</span>
                    </button>
                    <button
                      onClick={() => {
                        if (importImageDataUrl) {
                          const newCR: ActiveCR = {
                            id: `cr_${Date.now()}`,
                            name: '导入的CR',
                            preview: importImageDataUrl,
                            fidelity: 1,
                            styleAware: false,
                          };
                          setActiveCR(newCR);
                        }
                        setShowImageImportModal(false);
                      }}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/50 border border-gray-700 rounded-xl"
                    >
                      <User className="w-5 h-5 text-nai-accent" />
                      <span className="text-sm text-white">Character Reference</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default MobileGeneratePage;


