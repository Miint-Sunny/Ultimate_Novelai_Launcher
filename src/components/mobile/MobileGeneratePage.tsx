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
  X,
  Loader2,
  Languages,
  Wrench,
  RotateCcw,
  Check,
  Plus,
  Grid,
  Upload,
  Image as ImageIcon,
  User,
  Brush,
  Lightbulb,
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
import { MobileAdvancedSettingsSheet } from './MobileAdvancedSettingsSheet';
import { MobileArtistModal } from './MobileArtistModal';
import { MobileCharacterPromptEditor } from './MobileCharacterPromptEditor';
import { MobileCharacterPositionSheet } from './MobileCharacterPositionSheet';
import { MobileCharacterPromptsCard } from './MobileCharacterPromptsCard';
import { MobileImageImportModal } from './MobileImageImportModal';
import { MobileImg2ImgCard } from './MobileImg2ImgCard';
import { MobileInspirationSheet } from './MobileInspirationSheet';
import { MobileGenerateHeader } from './MobileGenerateHeader';
import { MobileGenerateToolbar } from './MobileGenerateToolbar';
import { MobileOCEditorSheet } from './MobileOCEditorSheet';
import { MobileOCSheet } from './MobileOCSheet';
import { MobilePreciseReferenceCard } from './MobilePreciseReferenceCard';
import { MobilePreciseReferenceSheet } from './MobilePreciseReferenceSheet';
import { MobileResolutionSheet } from './MobileResolutionSheet';
import { MobileVibeReferencesCard } from './MobileVibeReferencesCard';
import { MobileVibeManagerSheet } from './MobileVibeManagerSheet';
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
import { useMobileResolutionPicker } from './generate/useMobileResolutionPicker';
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
  const {
    resolutionTab,
    setResolutionTab,
    currentResLabel,
    currentOptions: currentResolutionOptions,
  } = useMobileResolutionPicker(localWidth, localHeight);

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
    loadCRs,
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
      <MobileGenerateHeader
        model={model}
        setModel={setModel}
        showModelDropdown={showModelDropdown}
        setShowModelDropdown={setShowModelDropdown}
        anlasInfo={anlasInfo}
        isLoadingAnlas={isLoadingAnlas}
        fetchAnlas={fetchAnlas}
      />

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

          <MobileVibeReferencesCard
            library={vibeLibrary}
            onOpenManager={() => setShowVibeModal(true)}
          />
          <MobilePreciseReferenceCard
            model={model}
            library={preciseReferenceLibrary}
            onOpenManager={() => setShowCRModal(true)}
          />

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

      <MobileGenerateToolbar
        currentResLabel={currentResLabel}
        openAdvancedSettings={() => setShowAdvancedSettings(true)}
        openResolutionDropdown={() => setShowResolutionDropdown(true)}
        openImageFile={openImageFile}
        onGenerate={handleGenerate}
        cancelTask={cancelTask}
        isGenerating={isGenerating}
        isQueuing={isQueuing}
        isPreparing={isPreparing}
        queuePosition={queuePosition}
        currentStep={currentStep}
        totalSteps={totalSteps}
        width={localWidth}
        height={localHeight}
        steps={steps}
        model={model}
        sampler={sampler}
        isOpus={anlasInfo?.isOpus ?? false}
        img2imgImage={img2imgImage}
        img2imgStrength={img2imgStrength}
        activePreciseRefs={activePreciseRefs}
        activeVibes={activeVibes}
      />

      <MobileResolutionSheet
        isOpen={showResolutionDropdown}
        onClose={() => setShowResolutionDropdown(false)}
        resolutionTab={resolutionTab}
        setResolutionTab={setResolutionTab}
        options={currentResolutionOptions}
        width={localWidth}
        height={localHeight}
        setWidth={setLocalWidth}
        setHeight={setLocalHeight}
      />

      <MobileAdvancedSettingsSheet
        isOpen={showAdvancedSettings}
        onClose={() => setShowAdvancedSettings(false)}
        promptPresets={promptPresets}
        activePresetId={activePresetId}
        onApplyPreset={handleApplyPreset}
        isPresetExpanded={isPresetExpanded}
        setIsPresetExpanded={setIsPresetExpanded}
        steps={steps}
        setSteps={setSteps}
        scale={scale}
        setScale={setScale}
        seed={seed}
        setSeed={setSeed}
        sampler={sampler}
        setSampler={setSampler}
        cfgRescale={cfgRescale}
        setCfgRescale={setCfgRescale}
        noiseSchedule={noiseSchedule}
        setNoiseSchedule={setNoiseSchedule}
        varietyPlus={varietyPlus}
        setVarietyPlus={setVarietyPlus}
      />

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


