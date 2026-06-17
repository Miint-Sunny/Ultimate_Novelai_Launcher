import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  ArrowLeft,
  AlignLeft,
  Edit2,
  Eye,
  EyeOff,
  Search,
  Clock,
  Undo2,
  ExternalLink,
} from 'lucide-react';
import { useGeneration } from '../../contexts/GenerationContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  getPromptPresets,
  getActivePresetId,
  saveActivePresetId,
  type PromptPresetData,
} from '../../services/localLibrary';
import {
  getArtists,
} from '../../services/localLibrary';
import { copyToClipboard } from '../../utils/clipboard';
import { getBackendUrl } from '../../utils/apiConfig';
import { parseCharacterPromptContent } from '../../utils/promptParser';
import {
  getPublicLibraryOwnerId,
  getPublicArtists,
  getPublicOCs,
  getOCPreviewUrl,
  createPublicOC,
  updatePublicOC,
  deletePublicOC,
} from '../../services/publicLibrary';
import { generateImageStream } from '../../services/novelai';
import { countTokens } from '../../services/tokenizer';
import { KNOWLEDGE_SOURCES } from '../../services/agentService';
import { MobileAIAssistantSheet } from './MobileAIAssistantSheet';
import { MobileArtistModal } from './MobileArtistModal';
import { MobileImageImportModal } from './MobileImageImportModal';
import { MobilePreciseReferenceSheet } from './MobilePreciseReferenceSheet';
import { MobileVibeManagerSheet } from './MobileVibeManagerSheet';
import { loadCodexData, type CodexItem } from '../../services/codexData';
import { calculateCostFromUI } from '../../services/costCalculator';
import {
  MOBILE_LARGE_RESOLUTIONS as LARGE_RESOLUTIONS,
  MOBILE_WALLPAPER_RESOLUTIONS as WALLPAPER_RESOLUTIONS,
  MODELS,
  RESOLUTIONS,
} from '../generation/modelResolutionOptions';
import { FullscreenEditor, expandCollapsibleMarkers } from './FullscreenEditor';
import { blobToBase64 } from './imageUtils';
import {
  useMobileBackHandlers,
  useMobileEditorStateBridge,
  useMobileMetadataImportHandler,
} from './generate/useMobileGeneratePageEffects';
import { useMobileAnlas } from './generate/useMobileAnlas';
import { useMobileAgentAssistant } from './generate/useMobileAgentAssistant';
import { useMobileImageImport } from './generate/useMobileImageImport';
import { useMobileImportedImageActions } from './generate/useMobileImportedImageActions';
import { useMobileMetadataImportActions } from './generate/useMobileMetadataImportActions';
import { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';
import { pasteBackInpaintResult } from './generate/mobileInpaintPasteback';
import { useMobilePromptTranslation } from './generate/useMobilePromptTranslation';
import {
  prepareMobileCharacterPrompts,
  prepareMobileImg2Img,
  prepareMobilePreciseReferences,
  prepareMobilePrompts,
  prepareMobileVibeReferences,
} from './generate/mobileGenerationPreparation';
import { useMobileGenerationParams } from './generate/useMobileGenerationParams';
import type {
  ActiveVibe,
  ArtistFile,
  CharacterPrompt,
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

  const {
    localWidth,
    setLocalWidth,
    localHeight,
    setLocalHeight,
    model,
    setModel,
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
    steps,
    setSteps,
    scale,
    setScale,
    sampler,
    setSampler,
    noiseSchedule,
    setNoiseSchedule,
    cfgRescale,
    setCfgRescale,
    varietyPlus,
    setVarietyPlus,
    showAdvancedSettings,
    setShowAdvancedSettings,
    isPresetExpanded,
    setIsPresetExpanded,
    characterPrompts,
    setCharacterPrompts,
    activePresetId,
    setActivePresetId,
  } = useMobileGenerationParams({ targetWidth, targetHeight });

  // 全屏编辑器状态
  const [editorOpen, setEditorOpen] = useState<'prompt' | 'undesired' | null>(null);

  // AI 助手弹窗状态
  const [showAIAssistant, setShowAIAssistant] = useState(false);

  const { anlasInfo, isLoadingAnlas, fetchAnlas } = useMobileAnlas(isGenerating);

  // 下拉菜单状态
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showResolutionDropdown, setShowResolutionDropdown] = useState(false);
  const [resolutionTab, setResolutionTab] = useState<'small' | 'large' | 'wallpaper'>('small');

  // Vibe 管理器弹窗状态
  const [showVibeModal, setShowVibeModal] = useState(false);

  // Precise Reference 管理器弹窗状态
  const [showCRModal, setShowCRModal] = useState(false);

  const vibeLibrary = useMobileVibeLibrary({
    model,
    clearActiveCR: () => preciseReferenceLibrary.setActiveCR(null),
    showVibeModal,
  });
  const {
    activeVibes,
    setActiveVibes,
    localVibeFiles,
    setLocalVibeFiles,
    vibeFiles,
    isVibeExpanded,
    setIsVibeExpanded,
    loadingVibeIds,
    isVibeCompatibleWithModel,
    removeActiveVibe,
    updateActiveVibe,
    loadVibes,
  } = vibeLibrary;

  const preciseReferenceLibrary = useMobilePreciseReferences({
    clearActiveVibes: () => setActiveVibes([]),
    closeSheet: () => setShowCRModal(false),
  });
  const {
    activePreciseRefs,
    activeCR,
    setActiveCR,
    isCRExpanded,
    setIsCRExpanded,
    loadCRs,
    removePreciseRef,
    updatePreciseRefParam,
  } = preciseReferenceLibrary;

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
  const [isCharacterExpanded, setIsCharacterExpanded] = useState(true);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);

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

  const {
    showImageImportModal,
    setShowImageImportModal,
    importImageDataUrl,
    importImageMetadata,
    isParsingMetadata,
    isAnalyzingTagger,
    taggerResult,
    showTaggerResult,
    setShowTaggerResult,
    showFullMetadata,
    setShowFullMetadata,
    importOptions,
    setImportOptions,
    includeCharacter,
    setIncludeCharacter,
    openImageFile,
    analyzeWithTagger,
  } = useMobileImageImport();
  const {
    useImportedImageAsVibe,
    useImportedImageAsImg2Img,
    useImportedImageAsCR,
  } = useMobileImportedImageActions({
    importImageDataUrl,
    setActiveVibes,
    setImg2imgWithAutoRes,
    setActiveCR,
    closeImageImportModal: () => setShowImageImportModal(false),
  });
  const { importMetadata } = useMobileMetadataImportActions({
    importImageMetadata,
    importOptions,
    setPositivePrompt,
    setNegativePrompt,
    setSteps,
    setScale,
    setSampler,
    setNoiseSchedule,
    setLocalWidth,
    setLocalHeight,
    setSeed,
    setCharacterPrompts,
    setLocalVibeFiles,
    setActiveVibes,
    closeImageImportModal: () => setShowImageImportModal(false),
  });
  const importTaggerPrompt = useCallback(() => {
    if (!taggerResult?.tags) return;

    const finalPrompt = includeCharacter && taggerResult.character
      ? `${taggerResult.character}, ${taggerResult.tags}`
      : taggerResult.tags;

    if (importOptions.cleanImports) {
      setPositivePrompt(finalPrompt);
    } else {
      setPositivePrompt((prev: string) => prev ? `${prev}, ${finalPrompt}` : finalPrompt);
    }
    setShowImageImportModal(false);
  }, [includeCharacter, importOptions.cleanImports, setPositivePrompt, setShowImageImportModal, taggerResult]);

  const {
    aiModel,
    setAiModel,
    isGeneratingPrompt,
    agentState,
    handleAIGenerate,
    handleAIRegenerate,
    handleRestoreSnapshot,
  } = useMobileAgentAssistant({
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
    characterPrompts,
    setCharacterPrompts,
    activeVibes,
    setActiveVibes,
    vibeFiles,
    localVibeFiles,
    artistPublicFiles,
    artistLocalFiles,
    ocPublicFiles,
    ocLocalFiles,
    roleTagMap,
    clearActiveCR: () => setActiveCR(null),
  });
  const {
    hasChinesePrompt,
    isTranslating,
    handleTranslate,
  } = useMobilePromptTranslation({
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
  });

  useMobileEditorStateBridge({
    editorOpen,
    editingCharacterId,
    showAIAssistant,
    onEditorStateChange,
  });
  useMobileMetadataImportHandler({
    setPositivePrompt,
    setNegativePrompt,
  });
  useMobileBackHandlers({
    editorOpen,
    setEditorOpen,
    editingCharacterId,
    setEditingCharacterId,
    editingPositionId,
    setEditingPositionId,
    showAIAssistant,
    setShowAIAssistant,
    showImageImportModal,
    setShowImageImportModal,
    isInspirationModalOpen,
    setIsInspirationModalOpen,
    showArtistModal,
    setShowArtistModal,
    showOCModal,
    setShowOCModal,
    showVibeModal,
    setShowVibeModal,
    showCRModal,
    setShowCRModal,
  });

  // 获取当前激活的预设
  const activePreset = useMemo(
    () => promptPresets.find((p) => p.id === activePresetId),
    [promptPresets, activePresetId]
  );

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

  // 监听局部重绘事件
  useEffect(() => {
    const handleInpaintGenerate = async (event: Event) => {
      const customEvent = event as CustomEvent;
      if (isGenerating || isQueuing || isPreparing) return;

      const { imageBase64, maskBase64, strength, width, height, cropInfo } = customEvent.detail;

      // 保存裁切信息用于生成后回贴
      cropInfoRef.current = cropInfo || null;

      try {
        const { finalPrompt, finalNegative } = await prepareMobilePrompts({
          positivePrompt,
          negativePrompt,
          promptPresets,
          activePresetId,
        });
        const preciseReferences = await prepareMobilePreciseReferences(activePreciseRefs);
        const vibeReferences = await prepareMobileVibeReferences({
          activeVibes,
          model,
          includePublicRemoteCache: true,
        });

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
          characterPrompts: prepareMobileCharacterPrompts(characterPrompts),
          preciseReferences,
          vibeReferences,
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
          await pasteBackInpaintResult(result, savedCropInfo, addInpaintedImage);
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
      const { finalPrompt, finalNegative } = await prepareMobilePrompts({
        positivePrompt,
        negativePrompt,
        promptPresets,
        activePresetId,
      });
      const vibeReferences = await prepareMobileVibeReferences({ activeVibes, model });
      const preciseReferences = await prepareMobilePreciseReferences(activePreciseRefs);

      // 如果有保存的重绘参数，注入 inpaint 参数（优先于 img2img）
      const savedInpaint = savedInpaintRef.current;
      const img2img = savedInpaint ? undefined : await prepareMobileImg2Img({
        img2imgImage,
        localWidth,
        localHeight,
        img2imgStrength,
        img2imgNoise,
      });
      const inpaintParams = savedInpaint ? {
        inpaint: {
          imageBase64: savedInpaint.imageBase64,
          maskBase64: savedInpaint.maskBase64,
          strength: savedInpaint.strength,
        },
      } : {};

      await generate({
        model, positivePrompt: finalPrompt, negativePrompt: finalNegative,
        width: savedInpaint ? savedInpaint.width : localWidth,
        height: savedInpaint ? savedInpaint.height : localHeight,
        seed: seed ? parseInt(seed) : Math.floor(Math.random() * 4294967295),
        steps, scale, sampler, cfgRescale,
        noiseSchedule, ucPreset: 'heavy', qualityToggle: true, varietyPlus,
        vibeReferences,
        characterPrompts: prepareMobileCharacterPrompts(characterPrompts),
        preciseReferences,
        img2img,
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
                          onClick={() => removeActiveVibe(vibe.id)}
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
          {hasChinesePrompt && (
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
                  openImageFile(file);
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

      <MobileVibeManagerSheet
        isOpen={showVibeModal}
        onClose={() => setShowVibeModal(false)}
        library={vibeLibrary}
      />

      <MobilePreciseReferenceSheet
        isOpen={showCRModal}
        onClose={() => setShowCRModal(false)}
        library={preciseReferenceLibrary}
      />

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
      {showImageImportModal && (
        <MobileImageImportModal
          dataUrl={importImageDataUrl}
          metadata={importImageMetadata}
          isParsingMetadata={isParsingMetadata}
          isAnalyzingTagger={isAnalyzingTagger}
          taggerResult={taggerResult}
          showTaggerResult={showTaggerResult}
          setShowTaggerResult={setShowTaggerResult}
          showFullMetadata={showFullMetadata}
          setShowFullMetadata={setShowFullMetadata}
          importOptions={importOptions}
          setImportOptions={setImportOptions}
          includeCharacter={includeCharacter}
          setIncludeCharacter={setIncludeCharacter}
          onClose={() => setShowImageImportModal(false)}
          onAnalyzeWithTagger={analyzeWithTagger}
          onImportTaggerPrompt={importTaggerPrompt}
          onImportMetadata={importMetadata}
          onUseAsVibe={useImportedImageAsVibe}
          onUseAsImg2Img={useImportedImageAsImg2Img}
          onUseAsCR={useImportedImageAsCR}
        />
      )}
    </div>
  );
};

export default MobileGeneratePage;


