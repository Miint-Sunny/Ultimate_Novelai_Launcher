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
  ImagePlus,
  Brush,
  Settings,
  Lightbulb,
  SlidersHorizontal,
  ArrowLeft,
  AlignLeft,
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
import { getBackendUrl } from '../../utils/apiConfig';
import { parseCharacterPromptContent } from '../../utils/promptParser';
import { getPublicLibraryOwnerId } from '../../services/publicLibrary';
import { countTokens } from '../../services/tokenizer';
import { KNOWLEDGE_SOURCES } from '../../services/agentService';
import { MobileAIAssistantSheet } from './MobileAIAssistantSheet';
import { MobileArtistModal } from './MobileArtistModal';
import { MobileCharacterPromptEditor } from './MobileCharacterPromptEditor';
import { MobileCharacterPositionSheet } from './MobileCharacterPositionSheet';
import { MobileCharacterPromptsCard } from './MobileCharacterPromptsCard';
import { MobileImageImportModal } from './MobileImageImportModal';
import { MobileImg2ImgCard } from './MobileImg2ImgCard';
import { MobileInspirationSheet } from './MobileInspirationSheet';
import { MobileOCEditorSheet } from './MobileOCEditorSheet';
import { MobileOCSheet } from './MobileOCSheet';
import { MobilePreciseReferenceSheet } from './MobilePreciseReferenceSheet';
import { MobileVibeManagerSheet } from './MobileVibeManagerSheet';
import { calculateCostFromUI } from '../../services/costCalculator';
import {
  MOBILE_LARGE_RESOLUTIONS as LARGE_RESOLUTIONS,
  MOBILE_WALLPAPER_RESOLUTIONS as WALLPAPER_RESOLUTIONS,
  MODELS,
  RESOLUTIONS,
} from '../generation/modelResolutionOptions';
import { FullscreenEditor, expandCollapsibleMarkers } from './FullscreenEditor';
import {
  useMobileBackHandlers,
  useMobileEditorStateBridge,
  useMobileMetadataImportHandler,
} from './generate/useMobileGeneratePageEffects';
import { useMobileAnlas } from './generate/useMobileAnlas';
import { useMobileAgentAssistant } from './generate/useMobileAgentAssistant';
import { useMobileArtistLibrary } from './generate/useMobileArtistLibrary';
import { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';
import { useMobileImg2Img } from './generate/useMobileImg2Img';
import { useMobileImageImport } from './generate/useMobileImageImport';
import { useMobileImportedImageActions } from './generate/useMobileImportedImageActions';
import { useMobileMetadataImportActions } from './generate/useMobileMetadataImportActions';
import { useMobileOCManager } from './generate/useMobileOCManager';
import { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';
import { useMobileInpaintGenerate } from './generate/useMobileInpaintGenerate';
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
  CharacterPrompt,
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

  const img2imgState = useMobileImg2Img({
    setLocalWidth,
    setLocalHeight,
    setImage,
  });
  const {
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    savedInpaintRef,
    cropInfoRef,
    clearInpaintParams,
    setImg2imgWithAutoRes,
  } = img2imgState;

  const characterPromptManager = useMobileCharacterPrompts({
    characterPrompts,
    setCharacterPrompts,
  });
  const {
    editingCharacterId,
    setEditingCharacterId,
    editingPositionId,
    setEditingPositionId,
  } = characterPromptManager;

  // 灵感弹窗
  const [isInspirationModalOpen, setIsInspirationModalOpen] = useState(false);
  const codexInspiration = useMobileCodexInspiration(isInspirationModalOpen);

  // 画师串状态
  const [showArtistModal, setShowArtistModal] = useState(false);
  const {
    artistPublicFiles,
    artistLocalFiles,
    loadArtists,
  } = useMobileArtistLibrary();

  // 预设状态
  const [promptPresets, setPromptPresets] = useState<PromptPresetData[]>([]);

  // OC 管理器弹窗状态
  const [showOCModal, setShowOCModal] = useState(false);
  const ocManager = useMobileOCManager({
    currentUserId,
    isAuthenticated,
    requireAuth,
    characterPrompts,
    setCharacterPrompts,
    closeSheet: () => setShowOCModal(false),
  });
  const {
    loadOCs,
    resetOCSelection,
  } = ocManager;

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
    ocPublicFiles: ocManager.ocPublicFiles,
    ocLocalFiles: ocManager.ocLocalFiles,
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
      resetOCSelection();
      return;
    }
    loadOCs();
  }, [loadOCs, resetOCSelection, showOCModal]);

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

  useMobileInpaintGenerate({
    isGenerating,
    isQueuing,
    isPreparing,
    positivePrompt,
    negativePrompt,
    promptPresets,
    activePresetId,
    model,
    seed,
    steps,
    scale,
    sampler,
    cfgRescale,
    noiseSchedule,
    varietyPlus,
    characterPrompts,
    activePreciseRefs,
    activeVibes,
    cropInfoRef,
    generate,
    addInpaintedImage,
    clearInpaintParams,
  });

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

          <MobileCharacterPromptsCard manager={characterPromptManager} />

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

          <MobileImg2ImgCard
            imageState={img2imgState}
            width={localWidth}
            height={localHeight}
          />

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

      <MobileCharacterPromptEditor
        manager={characterPromptManager}
        positiveTokens={positiveTokens}
        negativeTokens={negativeTokens}
      />
      <MobileCharacterPositionSheet manager={characterPromptManager} />

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

      <MobileOCSheet
        isOpen={showOCModal}
        onClose={() => setShowOCModal(false)}
        characterPromptCount={characterPrompts.length}
        manager={ocManager}
      />
      <MobileOCEditorSheet
        isOpen={showOCModal}
        manager={ocManager}
      />

      <MobileInspirationSheet
        isOpen={isInspirationModalOpen}
        onClose={() => setIsInspirationModalOpen(false)}
        onSelect={handleInspirationSelect}
        library={codexInspiration}
      />

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


