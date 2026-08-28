import React, { useState, useRef, useEffect, useCallback, useMemo, startTransition } from 'react';
import confetti from 'canvas-confetti';
import type { PromptEditorRef } from './PromptEditor';
import { useArtistManager, ArtistManagerModal } from './artist';
import { useOCManager, OCManagerModal } from './oc';
import { useCRManager, CRManagerModal, CREditModal } from './cr';
import { TagManagerModal } from './tag-manager';
import { VibeManagerModal, type VibeFile, isVibeCompatibleWithModelId } from './vibe';
import { InspirationModal } from './InspirationModal';
import { ToolsModal } from './ToolsModal';
import { SettingsModal } from './SettingsModal';
import { ProfileModal } from './ProfileModal';
import { saveAISettings, getAISettings, DEFAULT_AI_SETTINGS, getAppSettings, getCodexFilterSettings, saveCodexFilterSettings, type CodexFilterSettings } from '../services/localLibrary';
import { appBackendApi } from '../api/appBackendApi';
import { useGeneration, type HistoryItemMetadata } from '../contexts/GenerationContext';
import { useAuth } from '../contexts/AuthContext';
import { useDragDrop } from '../contexts/DragDropContext';
import { countTokens } from '../services/tokenizer';
import { useAgentDock } from '../contexts/AgentDockContext';
import { AISettingsPanel } from './left-sidebar/AISettingsPanel';
import { CharacterPositionModal } from './left-sidebar/CharacterPositionModal';
import { CharacterPromptsSection } from './left-sidebar/CharacterPromptsSection';
import { GenerationFooterControls } from './left-sidebar/GenerationFooterControls';
import { Image2ImageSection } from './left-sidebar/Image2ImageSection';
import type { InpaintCropInfo } from './generation/inpaintPasteback';
import { PreciseReferenceSection } from './left-sidebar/PreciseReferenceSection';
import { PromptComposerSection } from './left-sidebar/PromptComposerSection';
import { PromptPresetModal } from './left-sidebar/PromptPresetModal';
import { ResizableTextarea } from './left-sidebar/ResizableTextarea';
import { SidebarHeader } from './left-sidebar/SidebarHeader';
import { ToastBanner } from './left-sidebar/ToastBanner';
import { VibeTransferSection } from './left-sidebar/VibeTransferSection';
import { useAprilFools } from './left-sidebar/useAprilFools';
import { useAgentPromptGeneration } from './left-sidebar/useAgentPromptGeneration';
import { useAgentSnapshotActions } from './left-sidebar/useAgentSnapshotActions';
import { useCharacterPrompts } from './left-sidebar/useCharacterPrompts';
import { useDropZoneHandlers } from './left-sidebar/useDropZoneHandlers';
import { useAnlasStatus } from './left-sidebar/useAnlasStatus';
import { useGenerationRunner } from './left-sidebar/useGenerationRunner';
import { useGenerationCompletionEffects } from './left-sidebar/useGenerationCompletionEffects';
import { useHistoryMetadataApply } from './left-sidebar/useHistoryMetadataApply';
import { useImg2ImgImport } from './left-sidebar/useImg2ImgImport';
import { useInspirationActions } from './left-sidebar/useInspirationActions';
import { useMetadataImportHandler } from './left-sidebar/useMetadataImportHandler';
import { usePreciseReferenceImport } from './left-sidebar/usePreciseReferenceImport';
import { usePreciseReferenceSelection } from './left-sidebar/usePreciseReferenceSelection';
import { usePromptLibraryActions } from './left-sidebar/usePromptLibraryActions';
import { usePromptTranslation } from './left-sidebar/usePromptTranslation';
import { usePromptPresets } from './left-sidebar/usePromptPresets';
import { useCharacterPromptResize, usePromptBoxResize, useSidebarResize } from './left-sidebar/useResizablePanels';
import { useToast } from './left-sidebar/useToast';
import { useActiveVibes } from './left-sidebar/useActiveVibes';
import { useVibeImportHandlers } from './left-sidebar/useVibeImportHandlers';
import { useVibeLibrary } from './left-sidebar/useVibeLibrary';
import { useVibeExport } from './left-sidebar/useVibeExport';
import {
  MODELS,
  RESOLUTIONS,
  clampToMaxPixels,
  defaultModelOption,
  maxCharactersForModel,
  type ModelOption,
} from './generation/modelResolutionOptions';

// Vibe编码缓存 (moved to vibe module)
const vibeEncodingCache = new Map<string, string>();

// VibeFile type and constants are now imported from './vibe'

const VIBE_FILES_PUBLIC_INIT: VibeFile[] = [];

const VIBE_FILES_LOCAL_INIT: VibeFile[] = [];










interface LeftSidebarProps {
  onLogout?: () => void;
  onRegisterApplyMetadata?: (handler: (metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => void) => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({ onLogout, onRegisterApplyMetadata }) => {
  // Generation context
  const { isGenerating, generate, seedSetting: seed, setSeedSetting: setSeed, currentSeed, setImage, addInpaintedImage, history: generationHistory } = useGeneration();

  // Auth context
  const { isAuthenticated, isBotAuthorized, requireAuth, openLoginModal } = useAuth();

  // Drag-drop context
  const { setHandleImg2ImgDrop, setHandleVibeDrop, setHandleCRDrop, setHandleMetadataImport, sidebarScrollRef, setPendingFile } = useDragDrop();

  const {
    anlasInfo,
    isLoadingAnlas,
    onlineCount,
    fetchAnlas,
  } = useAnlasStatus();

  const {
    aprilFoolsEffect,
    aprilSpinActive,
    setAprilSpinActive,
    aprilCostActive,
    setAprilCostActive,
    aprilFoolsCost,
    resetAprilFoolsCost,
  } = useAprilFools();

  // 循环生成状态
  const [isLoopGenerating, setIsLoopGenerating] = useState(false);
  const loopGeneratingRef = useRef(false);

  // 重绘后自动循环：保��重绘参数供循环生成使用
  const savedInpaintRef = useRef<{ imageBase64: string; maskBase64: string; strength: number; width: number; height: number } | null>(null);
  // 裁切/扩图重绘回贴信息
  const cropInfoRef = useRef<InpaintCropInfo | null>(null);
  const [hasInpaintParams, setHasInpaintParams] = useState(false);
  const [inpaintStrength, setInpaintStrength] = useState(0.7); // 重绘强度（独立于 img2imgStrength）
  const [isInpaintPanelOpen, setIsInpaintPanelOpen] = useState(false);

  // 监听重绘面板关闭事件
  useEffect(() => {
    const handler = () => setIsInpaintPanelOpen(false);
    window.addEventListener('close-inpaint-mode', handler);
    return () => window.removeEventListener('close-inpaint-mode', handler);
  }, []);

  // 准备生成状态（包括vibe编码等预处理）
  const [isPreparing, setIsPreparing] = useState(false);

  const { toastMessage, toastType, showToast } = useToast();

  const resolutionSourceRef = useRef('默认竖图');

  const reportResolutionNormalization = (
    source: string,
    result: ReturnType<typeof clampToMaxPixels>,
  ) => {
    if (!result.changed) return;
    const message = `${source}尺寸已调整：${result.originalWidth}×${result.originalHeight} → ${result.width}×${result.height}`;
    console.warn('[Resolution] normalized', {
      source,
      from: `${result.originalWidth}x${result.originalHeight}`,
      to: `${result.width}x${result.height}`,
    });
    showToast(message, 'warning');
    setIsResSelectorOpen(true);
    setResHighlight(true);
    setTimeout(() => setResHighlight(false), 2500);
  };

  const {
    promptBoxHeight,
    setPromptBoxHeight,
    promptBaseHeight,
    promptContentHeightsRef,
    activeTabRef,
    isDraggingPromptBox,
    handlePromptBoxMouseDown,
  } = usePromptBoxResize();
  const { sidebarWidth, handleSidebarMouseDown } = useSidebarResize();
  const {
    charHeights,
    setCharHeights,
    charBaseHeights,
    charContentHeightsRef,
    isDraggingChar,
    handleCharMouseDown,
  } = useCharacterPromptResize();

  const [isVibeModalOpen, setIsVibeModalOpen] = useState(false);
  const {
    vibeTab,
    setVibeTab,
    selectedVibes,
    setSelectedVibes,
    vibeUsageOrder,
    setVibeUsageOrder,
    vibeSelectionSnapshot,
    publicFiles,
    setPublicFiles,
    localFiles,
    setLocalFiles,
    visiblePublicVibeCount,
    publicVibeEndRef,
    vibeSearchQuery,
    setVibeSearchQuery,
    vibeModelFilter,
    setVibeModelFilter,
    filteredPublicFiles,
    filteredLocalFiles,
    availableVibeModels,
    linkedFolders,
    currentFolderName,
    folderVibeFiles,
    localDirectoryHandle,
    needsPermission,
    isLinkingFolder,
    downloadingVibeIds,
    setDownloadingVibeIds,
    pinnedVibeIds,
    togglePinVibe,
    savingVibeIds,
    isVibeInLocal,
    handleSaveVibeToLocal,
    vibeMenuOpenId,
    setVibeMenuOpenId,
    editingVibeDefaults,
    setEditingVibeDefaults,
    saveVibeDefaults,
    isVibeInPublic,
    handleDownloadVibe,
    handleRemoveFromPublic,
    loadFilesFromHandle,
    enterFolder,
    exitFolder,
    loadLocalVibes,
    isLoadingPublicVibes,
    loadPublicVibes,
    handleLinkFolder,
    handleUnlinkFolder,
  } = useVibeLibrary(showToast, isVibeModalOpen);

  const inputRef = useRef<HTMLInputElement>(null);
  const quickVibeInputRef = useRef<HTMLInputElement>(null);
  const aiLogScrollRef = useRef<HTMLDivElement>(null);

  // OC State
  const [isCRModalOpen, setIsCRModalOpen] = useState(false);
  const [isOCModalOpen, setIsOCModalOpen] = useState(false);
  const [isArtistModalOpen, setIsArtistModalOpen] = useState(false);
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [isInspirationModalOpen, setIsInspirationModalOpen] = useState(false);
  const [isToolsModalOpen, setIsToolsModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  // 法典筛选设置状态（用于随机灵感功能）
  const [codexFilterSettings, setCodexFilterSettings] = useState<CodexFilterSettings>(() => getCodexFilterSettings());

  // 更新法典筛选设置
  const updateCodexFilterSettings = useCallback((settings: CodexFilterSettings) => {
    setCodexFilterSettings(settings);
    saveCodexFilterSettings(settings);
  }, []);


  // Agent 会话/模型状态已上移到 AgentDockContext；左栏只保留提示词域并注册写回 handlers。
  const { aiModel, setIsGeneratingPrompt, registerHandlers } = useAgentDock();
  const promptAreaRef = useRef<HTMLDivElement>(null);
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

  // 加载角色Tag映射
  useEffect(() => {
    const loadRoleTags = async () => {
      try {
        const response = await appBackendApi.request('/api/data/role_tag_mapping.json');
        if (response.ok) {
          const data = await response.json();
          setRoleTagMap(data);
        }
      } catch (error) {
        console.error('加载角色Tag映射失败:', error);
      }
    };
    loadRoleTags();
  }, []);



  // Artist State (extracted to useArtistManager hook)
  const artistManager = useArtistManager();
  const crManager = useCRManager();

  const {
    characterPrompts,
    setCharacterPrompts,
    isCharacterSectionOpen,
    setIsCharacterSectionOpen,
    isClearConfirming,
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    clearAllCharacterPrompts,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
  } = useCharacterPrompts();

  const {
    promptPresets,
    activePreset,
    activePresetId,
    setActivePresetId,
    isPresetModalOpen,
    setIsPresetModalOpen,
    editingPresetId,
    setEditingPresetId,
    handleUpdatePreset,
    handleAddPreset,
    handleDeletePreset,
  } = usePromptPresets();

  const {
    activeVibes,
    setActiveVibes,
    loadingVibeIds,
    setLoadingVibeIds,
    exportingVibeId,
    setExportingVibeId,
    uploadingVibeIds,
    vibeUploadTarget,
    setVibeUploadTarget,
    vibeUploadName,
    setVibeUploadName,
    vibeUploadStrength,
    setVibeUploadStrength,
    vibeUploadInfoExtracted,
    setVibeUploadInfoExtracted,
    toggleVibeSelection,
    closeVibeModal,
    handleVibeConfirmSelection,
    removeActiveVibe,
    updateActiveVibe,
    handleDeleteVibeFile,
    handleDeletePublicVibe,
    handleUploadVibeToPublic,
    confirmUploadVibeToPublic,
  } = useActiveVibes({
    publicFiles,
    setPublicFiles,
    localFiles,
    setLocalFiles,
    selectedVibes,
    setSelectedVibes,
    setVibeUsageOrder,
    localDirectoryHandle,
    loadFilesFromHandle,
    setIsVibeModalOpen,
    clearPreciseReference: () => crManager.setActiveCR(null),
    loadPublicVibes,
    showToast,
  });

  const isActiveVibeCompatible = (vibe: { supportedModels?: string[]; image?: string }): boolean => {
    return isVibeCompatibleWithModelId(vibe, selectedModel.id);
  };

  const {
    vibeImportPending,
    setVibeImportPending,
    vibeImportName,
    setVibeImportName,
    vibeImportStrength,
    setVibeImportStrength,
    vibeImportInfoExtracted,
    setVibeImportInfoExtracted,
    handleFileUpload,
    confirmVibeImport,
    handleQuickVibeUpload,
    handleVibeDropCallback,
  } = useVibeImportHandlers({
    localDirectoryHandle,
    loadFilesFromHandle,
    setLocalFiles,
    setSelectedVibes,
    setVibeUsageOrder,
    setActiveVibes,
    clearPreciseReference: () => crManager.setActiveCR(null),
    showToast,
  });

  const { handleQuickCRUpload, handleCRDropCallback } = usePreciseReferenceImport({
    setCrLocalFiles: crManager.setCrLocalFiles,
    setActivePreciseRefs: crManager.setActivePreciseRefs,
    setActiveVibes,
    setSelectedVibes,
  });
  const handleConfirmCR = usePreciseReferenceSelection({
    selectedCRs: crManager.selectedCRs,
    crPublicFiles: crManager.crPublicFiles,
    crLocalFiles: crManager.crLocalFiles,
    activePreciseRefs: crManager.activePreciseRefs,
    setActivePreciseRefs: crManager.setActivePreciseRefs,
    setActiveVibes,
    setSelectedVibes,
    setIsCRModalOpen,
  });

  const [activeTab, setActiveTab] = useState<'prompt' | 'undesired' | 'ai'>('prompt');
  const [chipMode, setChipMode] = useState(true); // 芯片布局模式（默认开启）
  // 同步 activeTabRef
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // 切换标签页时，用已记录的内容高度重新计算显示高度
  useEffect(() => {
    const content = promptContentHeightsRef.current[activeTab] || 0;
    setPromptBoxHeight(Math.max(promptBaseHeight.current, content));
  }, [activeTab]);

  // 切换编辑模式时清空内容高度记录（芯片和文本模式高度不同）
  useEffect(() => {
    promptContentHeightsRef.current = { prompt: 0, undesired: 0 };
  }, [chipMode]);

  // 内容高度变化 → max(手动基准, 内容高度)
  const handlePromptContentHeightChange = useCallback((contentHeight: number) => {
    const tab = activeTabRef.current;
    promptContentHeightsRef.current[tab] = contentHeight;
    if (isDraggingPromptBox.current) return;
    setPromptBoxHeight(Math.max(promptBaseHeight.current, contentHeight));
  }, []);

  const handleCharContentHeightChange = useCallback((charId: string, contentHeight: number) => {
    charContentHeightsRef.current[charId] = contentHeight;
    if (isDraggingChar.current === charId) return;
    const base = charBaseHeights.current[charId] || 150;
    setCharHeights(h => ({ ...h, [charId]: Math.max(base, contentHeight) }));
  }, []);
  const [positivePrompt, setPositivePrompt] = useState(() => {
    try { return localStorage.getItem('desktop_positive_prompt') || ''; } catch { return ''; }
  });
  const [negativePrompt, setNegativePrompt] = useState(() => {
    try { return localStorage.getItem('desktop_negative_prompt') || ''; } catch { return ''; }
  });

  // 提示词变化时保存到 localStorage
  useEffect(() => {
    try { localStorage.setItem('desktop_positive_prompt', positivePrompt); } catch { /* ignore */ }
  }, [positivePrompt]);
  useEffect(() => {
    try { localStorage.setItem('desktop_negative_prompt', negativePrompt); } catch { /* ignore */ }
  }, [negativePrompt]);

  // 同步画师标签到状态（仅芯片模式需要，文本模式由编辑器自身同步）
  useEffect(() => {
    if (chipMode) {
      const tags: { id: string; type: string; label: string; content: string; collapsed: boolean }[] = [];
      const regex = /<<artist:([^:]+):((?:.|\n)*?)>>/g;
      let match;
      while ((match = regex.exec(positivePrompt)) !== null) {
        tags.push({ id: '', type: 'artist', label: match[1], content: match[match.length === 3 ? 2 : 3], collapsed: true });
      }
      artistManager.handleTagsChange(tags);
    }
  }, [chipMode, positivePrompt, artistManager.handleTagsChange]);
  // 首次启动用 DEFAULT_MODEL_ID(经 defaultModelOption 查表,不取 MODELS[0]——
  // 让列表顺序决定默认是本次已经犯过一次的 bug);之后恢复上次选择,由
  // getAISettings 负责校验存量值仍然存在。
  const [selectedModel, setSelectedModel] = useState<ModelOption>(
    () => MODELS.find((option) => option.id === getAISettings().model) ?? defaultModelOption(),
  );
  const ocManager = useOCManager(maxCharactersForModel(selectedModel.id));
  const handleExportVibe = useVibeExport({
    exportingVibeId,
    setExportingVibeId,
    activeVibes,
    setActiveVibes,
    publicFiles,
    selectedModel,
  });

  const [isResSelectorOpen, setIsResSelectorOpen] = useState(false);
  const [resolutionTab, setResolutionTab] = useState<'small' | 'large' | 'wallpaper'>('small');
  const [resHighlight, setResHighlight] = useState(false);
  const [resolution, setResolution] = useState(RESOLUTIONS[0]);
  const [customWidth, setCustomWidth] = useState(832);
  const [customHeight, setCustomHeight] = useState(1216);
  const [customWidthInput, setCustomWidthInput] = useState('832');  // 用户输入的原始值
  const [customHeightInput, setCustomHeightInput] = useState('1216');  // 用户输入的原始值
  const [isCustomRes, setIsCustomRes] = useState(false);
  const {
    img2imgImage,
    img2imgStrength,
    setImg2imgStrength,
    img2imgNoise,
    setImg2imgNoise,
    img2imgInputRef,
    img2imgSectionRef,
    img2imgFlash,
    setImg2imgWithAutoRes,
    handleImg2ImgUpload,
    handleImg2ImgDropCallback,
    clearImg2Img,
  } = useImg2ImgImport({
    savedInpaintRef,
    setHasInpaintParams,
    resolutionSourceRef,
    reportResolutionNormalization,
    setResolution,
    setCustomWidth,
    setCustomHeight,
    setCustomWidthInput,
    setCustomHeightInput,
    setIsCustomRes,
    setImage,
    setIsResSelectorOpen,
    setResHighlight,
  });
  const {
    img2imgDropActive,
    setImg2imgDropActive,
    vibeDropActive,
    setVibeDropActive,
    crDropActive,
    setCrDropActive,
    img2imgDragCounterRef,
    vibeDragCounterRef,
    crDragCounterRef,
    createDropZoneHandlers,
  } = useDropZoneHandlers();

  const openImg2ImgInpaint = useCallback(() => {
    const base64 = savedInpaintRef.current?.imageBase64 || (img2imgImage?.startsWith('data:') ? img2imgImage.split(',')[1] : null);
    setHasInpaintParams(true);
    setIsInpaintPanelOpen(true);
    window.dispatchEvent(new CustomEvent('open-inpaint-mode', {
      detail: {
        maskBase64: savedInpaintRef.current?.maskBase64 || null,
        imageBase64: base64,
        width: customWidth,
        height: customHeight,
      },
    }));
  }, [customHeight, customWidth, img2imgImage]);

  const handleImg2ImgStrengthChange = useCallback((value: number) => {
    if (hasInpaintParams) {
      setInpaintStrength(value);
      if (savedInpaintRef.current) {
        savedInpaintRef.current.strength = value;
      }
      window.dispatchEvent(new CustomEvent('inpaint-strength-sync', { detail: { strength: value } }));
      return;
    }

    setImg2imgStrength(value);
  }, [hasInpaintParams, setImg2imgStrength]);

  // AI Settings State - 从 localStorage 加载初始值
  const [steps, setSteps] = useState(() => getAISettings().steps);
  const [scale, setScale] = useState(() => getAISettings().scale);
  const [sampler, setSampler] = useState(() => getAISettings().sampler);
  const [scaleRescale, setScaleRescale] = useState(() => getAISettings().scaleRescale);
  const [noiseSchedule, setNoiseSchedule] = useState(() => getAISettings().noiseSchedule);
  const [varietyPlus, setVarietyPlus] = useState(() => getAISettings().varietyPlus);
  // 透明背景(仅 V5)。不进 saveAISettings:那份设置是跨模型共享的生成参数,
  // 而这是个模型专属能力,记住它会让切回 4.5 时留下一个不存在的开关状态。
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [normalizeVibeStrength, setNormalizeVibeStrength] = useState(() => getAISettings().normalizeVibeStrength);
  const [isAISettingsOpen, setIsAISettingsOpen] = useState(false);

  // 保存 AI 设置到 localStorage
  useEffect(() => {
    saveAISettings({ steps, scale, sampler, scaleRescale, noiseSchedule, varietyPlus, normalizeVibeStrength, model: selectedModel.id });
  }, [steps, scale, sampler, scaleRescale, noiseSchedule, varietyPlus, normalizeVibeStrength, selectedModel]);

  // 重置 AI 设置
  const resetAISettings = () => {
    setSteps(DEFAULT_AI_SETTINGS.steps);
    setScale(DEFAULT_AI_SETTINGS.scale);
    setSeed('');
    setSampler(DEFAULT_AI_SETTINGS.sampler);
    setScaleRescale(DEFAULT_AI_SETTINGS.scaleRescale);
    setNoiseSchedule(DEFAULT_AI_SETTINGS.noiseSchedule);
    setVarietyPlus(DEFAULT_AI_SETTINGS.varietyPlus);
    setNormalizeVibeStrength(DEFAULT_AI_SETTINGS.normalizeVibeStrength);
  };

  const handleMetadataImportCallback = useMetadataImportHandler({
    resolutionSourceRef,
    reportResolutionNormalization,
    setSelectedModel,
    setResolution,
    setCustomWidth,
    setCustomHeight,
    setCustomWidthInput,
    setCustomHeightInput,
    setIsCustomRes,
    setPositivePrompt,
    setNegativePrompt,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
    setLocalFiles,
    setActiveVibes,
    setSeed,
    setSteps,
    setScale,
    setSampler,
    setScaleRescale,
    setNoiseSchedule,
  });

  const [highlightAISettings, setHighlightAISettings] = useState<string | null>(null);
  const aiSettingsRef = useRef<HTMLDivElement>(null);
  // Removed unused refs: promptBtnRef, undesiredBtnRef, and pillStyle state

  const scrollToAISettings = (settingName: string) => {
    setIsAISettingsOpen(true);
    // Small timeout to allow state update and DOM rendering
    setTimeout(() => {
      aiSettingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightAISettings(settingName);
      setTimeout(() => setHighlightAISettings(null), 1500); // Remove highlight after animation
    }, 100);
  };

  // 使用 GLM Tokenizer 计算 token 数
  const totalTokenCount = useMemo(() => {
    // 剔除 ~ 开头的禁用标签后再计数（与生成时的 filterHiddenTags 保持一致）
    const countActive = (prompt: string) =>
      countTokens(prompt.split(/[,，]/).map(t => t.trim()).filter(t => !t.startsWith('~')).join(', '));
    if (activeTab === 'prompt') {
      let total = countActive(positivePrompt);
      characterPrompts.filter(p => p.enabled).forEach(p => {
        total += countActive(p.positive);
      });
      if (activePreset?.positive) {
        total += countActive(activePreset.positive);
      }
      return total;
    } else {
      let total = countActive(negativePrompt);
      characterPrompts.filter(p => p.enabled).forEach(p => {
        total += countActive(p.negative);
      });
      if (activePreset?.negative) {
        total += countActive(activePreset.negative);
      }
      return total;
    }
  }, [activeTab, positivePrompt, negativePrompt, characterPrompts, activePreset]);

  const handleResolutionChange = (res: typeof RESOLUTIONS[0]) => {
    resolutionSourceRef.current = `用户选择预设 ${res.label} ${res.width}×${res.height}`;
    setResolution(res);
    setCustomWidth(res.width);
    setCustomHeight(res.height);
    setCustomWidthInput(String(res.width));
    setCustomHeightInput(String(res.height));
    setIsCustomRes(false);
    setIsResSelectorOpen(false);
  };

  const { handleAIGenerate, handleAIGenerateWithRequest } = useAgentPromptGeneration({
    aiModel,
    setIsGeneratingPrompt,
    publicFiles,
    localFiles,
    artistPublicFiles: artistManager.artistPublicFiles,
    artistLocalFiles: artistManager.artistLocalFiles,
    ocPublicFiles: ocManager.ocPublicFiles,
    ocLocalFiles: ocManager.ocLocalFiles,
    roleTagMap,
    positivePrompt,
    negativePrompt,
    characterPrompts,
    selectedVibes,
    setPositivePrompt,
    setNegativePrompt,
    setSelectedVibes,
    setActiveVibes,
    setLoadingVibeIds,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
    clearPreciseReference: () => crManager.setActiveCR(null),
  });

  const {
    restorePromptSnapshot,
  } = useAgentSnapshotActions({
    publicFiles,
    localFiles,
    setPositivePrompt,
    setNegativePrompt,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
    setSelectedVibes,
    setActiveVibes,
    handleAIGenerateWithRequest,
  });

  const positiveEditorRef = useRef<PromptEditorRef>(null);
  const negativeEditorRef = useRef<PromptEditorRef>(null);
  const {
    handleSelectPrompt: handleSelectInspirationPrompt,
    handleAddCollapsibleTag: handleAddInspirationTag,
    handleAddToCharacter: handleAddInspirationToCharacter,
  } = useInspirationActions({
    chipMode,
    positiveEditorRef,
    characterPrompts,
    setPositivePrompt,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
  });
  const {
    handleConfirmArtistSelection,
    handleTagManagerConfirm,
    handleConfirmOCSelection,
  } = usePromptLibraryActions({
    chipMode,
    positiveEditorRef,
    artistPublicFiles: artistManager.artistPublicFiles,
    artistLocalFiles: artistManager.artistLocalFiles,
    selectedArtistIds: artistManager.selectedArtistIds,
    updateArtistUsageOrder: artistManager.updateArtistUsageOrder,
    ocPublicFiles: ocManager.ocPublicFiles,
    ocLocalFiles: ocManager.ocLocalFiles,
    selectedOCs: ocManager.selectedOCs,
    setSelectedOCs: ocManager.setSelectedOCs,
    setPositivePrompt,
    setNegativePrompt,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
    setIsArtistModalOpen,
    setIsOCModalOpen,
  });

  const {
    showTranslation,
    setShowTranslation,
    translationCache,
    handleTagClick,
  } = usePromptTranslation({
    positivePrompt,
    negativePrompt,
    setPositivePrompt,
    setNegativePrompt,
    positiveEditorRef,
    negativeEditorRef,
  });

  const { handleGenerate, handleInpaintGenerate } = useGenerationRunner({
    isGenerating,
    isPreparing,
    setIsPreparing,
    isAuthenticated,
    requireAuth,
    generate,
    addInpaintedImage,
    positivePrompt,
    negativePrompt,
    activePreset,
    activePresetId,
    selectedModel,
    steps,
    scale,
    seed,
    sampler,
    scaleRescale,
    noiseSchedule,
    varietyPlus,
    transparentBackground,
    normalizeVibeStrength,
    characterPrompts,
    activePreciseRefs: crManager.activePreciseRefs,
    activeVibes,
    setActiveVibes,
    customWidth,
    customHeight,
    setCustomWidth,
    setCustomHeight,
    setCustomWidthInput,
    setCustomHeightInput,
    setResolution,
    setIsCustomRes,
    resolutionSourceRef,
    reportResolutionNormalization,
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    savedInpaintRef,
    cropInfoRef,
    vibeEncodingCache,
  });

  // 固定指令「生成图片」带新提示词时：先落状态，提交后的渲染帧再触发生成，
  // 避免 handleGenerate 读到旧的 positivePrompt 闭包值。
  const pendingCommandGenerateRef = useRef(false);
  useEffect(() => {
    if (!pendingCommandGenerateRef.current) return;
    pendingCommandGenerateRef.current = false;
    handleGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positivePrompt]);

  // 把提示词写回入口注册给右侧停靠面板（提示词状态所有权留在左栏）。
  useEffect(() => {
    registerHandlers({
      generate: (request, imageBase64) => { void handleAIGenerate(request, imageBase64); },
      regenerate: (request, preState, imageBase64) => {
        void handleAIGenerateWithRequest(request, preState, imageBase64);
      },
      restoreSnapshot: (snapshot) => restorePromptSnapshot(snapshot, { openCharacterSection: true }),
      triggerGenerate: (positive) => {
        if (positive && positive.trim() && positive.trim() !== positivePrompt.trim()) {
          pendingCommandGenerateRef.current = true;
          setPositivePrompt(positive.trim());
        } else {
          handleGenerate();
        }
      },
    });
  }, [registerHandlers, handleAIGenerate, handleAIGenerateWithRequest, restorePromptSnapshot, handleGenerate, positivePrompt]);


  useGenerationCompletionEffects({
    isGenerating,
    currentSeed,
    fetchAnlas,
    loopGeneratingRef,
    handleGenerate,
  });

  // 全局回车快捷键拦截
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const settings = getAppSettings();
        if (settings.enterBehavior === 'generate') {
          // 如果没有按 Shift 键，则拦截回车并生成
          if (!e.shiftKey) {
            // 排除明确不需要拦截的组件
            const target = e.target as HTMLElement;
            if (target && target.closest('[data-no-enter-intercept="true"]')) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            handleGenerate();
          }
        }
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleGlobalKeyDown, true);
    };
  }, [handleGenerate]);

  // 监听局部重绘事件
  useEffect(() => {
    const handler = (e: Event) => handleInpaintGenerate(e as CustomEvent);
    window.addEventListener('inpaint-generate', handler);
    return () => window.removeEventListener('inpaint-generate', handler);
  }, [handleInpaintGenerate]);

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

  // Register drag-drop handlers with context
  useEffect(() => {
    setHandleImg2ImgDrop(handleImg2ImgDropCallback);
    setHandleVibeDrop(handleVibeDropCallback);
    setHandleCRDrop(handleCRDropCallback);
    setHandleMetadataImport(handleMetadataImportCallback);

    return () => {
      setHandleImg2ImgDrop(null);
      setHandleVibeDrop(null);
      setHandleCRDrop(null);
      setHandleMetadataImport(null);
    };
  }, [handleImg2ImgDropCallback, handleVibeDropCallback, handleCRDropCallback, handleMetadataImportCallback]);

  useHistoryMetadataApply({
    onRegisterApplyMetadata,
    resolutionSourceRef,
    reportResolutionNormalization,
    setPositivePrompt,
    setNegativePrompt,
    setSelectedModel,
    setSteps,
    setScale,
    setSampler,
    setScaleRescale,
    setNoiseSchedule,
    setVarietyPlus,
    setSeed,
    setResolution,
    setCustomWidth,
    setCustomHeight,
    setCustomWidthInput,
    setCustomHeightInput,
    setIsCustomRes,
    setCharacterPrompts,
    setIsCharacterSectionOpen,
  });

  return (
    <div 
      className="bg-nai-panel flex flex-col border-r border-gray-800 shrink-0 overflow-hidden relative group/sidebar transition-[width] duration-0"
      style={{ width: `${sidebarWidth}px`, minWidth: '400px', maxWidth: '680px' }}
    >
      {/* Toast 提示 */}
      {toastMessage && (
        <ToastBanner message={toastMessage} type={toastType} />
      )}

      {/* Prompt Settings Modal */}
      {isPresetModalOpen && (
        <PromptPresetModal
          promptPresets={promptPresets}
          activePresetId={activePresetId}
          editingPresetId={editingPresetId}
          onClose={() => setIsPresetModalOpen(false)}
          onActivePresetChange={setActivePresetId}
          onEditingPresetChange={setEditingPresetId}
          onUpdatePreset={handleUpdatePreset}
          onAddPreset={handleAddPreset}
          onDeletePreset={handleDeletePreset}
        />
      )}

      {/* Scrollable Content Area */}
      <div
        ref={sidebarScrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide flex flex-col min-w-0"
      >
        <SidebarHeader
          selectedModel={selectedModel}
          onSelectedModelChange={setSelectedModel}
          anlasInfo={anlasInfo}
          isLoadingAnlas={isLoadingAnlas}
          onRefreshAnlas={fetchAnlas}
          onlineCount={onlineCount}
          isBotAuthorized={isBotAuthorized}
          onLogout={onLogout}
          openLoginModal={openLoginModal}
          onOpenProfile={() => setIsProfileModalOpen(true)}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
          onOpenTools={() => setIsToolsModalOpen(true)}
        />

        {/* Prompt Area */}
        <div className="p-3 space-y-3 shrink-0">

          <PromptComposerSection
            promptAreaRef={promptAreaRef}
            promptBoxHeight={promptBoxHeight}
            isDraggingPromptBox={isDraggingPromptBox}
            onPromptBoxMouseDown={handlePromptBoxMouseDown}
            activeTab={activeTab}
            onActiveTabChange={setActiveTab}
            chipMode={chipMode}
            onChipModeChange={setChipMode}
            positivePrompt={positivePrompt}
            negativePrompt={negativePrompt}
            onPositivePromptChange={setPositivePrompt}
            onNegativePromptChange={setNegativePrompt}
            positiveEditorRef={positiveEditorRef}
            negativeEditorRef={negativeEditorRef}
            onPositiveTagsChange={artistManager.handleTagsChange}
            onPromptContentHeightChange={handlePromptContentHeightChange}
            showTranslation={showTranslation}
            translationCache={translationCache}
            onCloseTranslation={() => setShowTranslation(false)}
            onTranslationTagClick={handleTagClick}
            totalTokenCount={totalTokenCount}
            onOpenInspiration={() => setIsInspirationModalOpen(true)}
            onOpenTagManager={() => setIsTagManagerOpen(true)}
            onOpenPresetModal={() => setIsPresetModalOpen(true)}
          />

          <CharacterPromptsSection
            characterPrompts={characterPrompts}
            isCharacterSectionOpen={isCharacterSectionOpen}
            setIsCharacterSectionOpen={setIsCharacterSectionOpen}
            isClearConfirming={isClearConfirming}
            clearAllCharacterPrompts={clearAllCharacterPrompts}
            addCharacterPrompt={addCharacterPrompt}
            removeCharacterPrompt={removeCharacterPrompt}
            updateCharacterPrompt={updateCharacterPrompt}
            moveCharacterPrompt={moveCharacterPrompt}
            setEditingPositionId={setEditingPositionId}
            chipMode={chipMode}
            charHeights={charHeights}
            isDraggingChar={isDraggingChar}
            handleCharMouseDown={handleCharMouseDown}
            handleCharContentHeightChange={handleCharContentHeightChange}
          />

          <Image2ImageSection
            sectionRef={img2imgSectionRef}
            inputRef={img2imgInputRef}
            dropZoneHandlers={createDropZoneHandlers(
              setImg2imgDropActive,
              (_file, dataUrl) => setImg2imgWithAutoRes(dataUrl),
              false,
              img2imgDragCounterRef
            )}
            img2imgFlash={img2imgFlash}
            img2imgDropActive={img2imgDropActive}
            img2imgImage={img2imgImage}
            hasInpaintParams={hasInpaintParams}
            isInpaintPanelOpen={isInpaintPanelOpen}
            strength={hasInpaintParams ? inpaintStrength : img2imgStrength}
            noise={img2imgNoise}
            onUpload={handleImg2ImgUpload}
            onOpenInpaint={openImg2ImgInpaint}
            onClear={clearImg2Img}
            onStrengthChange={handleImg2ImgStrengthChange}
            onNoiseChange={setImg2imgNoise}
          />

          <VibeTransferSection
            inputRef={quickVibeInputRef}
            dropZoneHandlers={createDropZoneHandlers(
              setVibeDropActive,
              (file, dataUrl) => handleVibeDropCallback(file, dataUrl),
              true,
              vibeDragCounterRef
            )}
            vibeDropActive={vibeDropActive}
            activeVibes={activeVibes}
            loadingVibeIds={loadingVibeIds}
            exportingVibeId={exportingVibeId}
            normalizeVibeStrength={normalizeVibeStrength}
            onUpload={handleQuickVibeUpload}
            onOpenManager={() => setIsVibeModalOpen(true)}
            onToggleNormalize={() => setNormalizeVibeStrength(!normalizeVibeStrength)}
            onUpdateActiveVibe={updateActiveVibe}
            onRemoveActiveVibe={removeActiveVibe}
            onExportVibe={handleExportVibe}
            isActiveVibeCompatible={isActiveVibeCompatible}
          />

          <PreciseReferenceSection
            disabled={selectedModel.id === 'v4-full' || selectedModel.id === 'v4-curated-preview'}
            inputRef={crManager.quickCRInputRef}
            dropZoneHandlers={createDropZoneHandlers(
              setCrDropActive,
              (_file, dataUrl) => handleCRDropCallback(dataUrl),
              false,
              crDragCounterRef
            )}
            crDropActive={crDropActive}
            activePreciseRefs={crManager.activePreciseRefs}
            onUpload={handleQuickCRUpload}
            onOpenManager={() => setIsCRModalOpen(true)}
            onUpdatePreciseRef={crManager.updatePreciseRefParam}
            onRemovePreciseRef={crManager.removePreciseRef}
          />

          <AISettingsPanel
            panelRef={aiSettingsRef}
            isOpen={isAISettingsOpen}
            onOpenChange={setIsAISettingsOpen}
            onReset={resetAISettings}
            highlightSetting={highlightAISettings}
            steps={steps}
            onStepsChange={setSteps}
            scale={scale}
            onScaleChange={setScale}
            seed={seed}
            onSeedChange={setSeed}
            sampler={sampler}
            onSamplerChange={setSampler}
            scaleRescale={scaleRescale}
            onScaleRescaleChange={setScaleRescale}
            noiseSchedule={noiseSchedule}
            onNoiseScheduleChange={setNoiseSchedule}
            varietyPlus={varietyPlus}
            onVarietyPlusChange={setVarietyPlus}
            transparentBackground={transparentBackground}
            onTransparentBackgroundChange={setTransparentBackground}
            model={selectedModel.id}
          />
        </div>
      </div>

      <GenerationFooterControls
        steps={steps}
        setSteps={setSteps}
        scale={scale}
        setScale={setScale}
        seed={seed}
        setSeed={setSeed}
        scrollToAISettings={scrollToAISettings}
        isResSelectorOpen={isResSelectorOpen}
        setIsResSelectorOpen={setIsResSelectorOpen}
        resolutionTab={resolutionTab}
        setResolutionTab={setResolutionTab}
        resHighlight={resHighlight}
        resolution={resolution}
        isCustomRes={isCustomRes}
        setIsCustomRes={setIsCustomRes}
        customWidth={customWidth}
        customHeight={customHeight}
        customWidthInput={customWidthInput}
        customHeightInput={customHeightInput}
        setCustomWidth={setCustomWidth}
        setCustomHeight={setCustomHeight}
        setCustomWidthInput={setCustomWidthInput}
        setCustomHeightInput={setCustomHeightInput}
        setResolution={setResolution}
        handleResolutionChange={handleResolutionChange}
        resolutionSourceRef={resolutionSourceRef}
        reportResolutionNormalization={reportResolutionNormalization}
        showToast={showToast}
        isGenerating={isGenerating}
        isPreparing={isPreparing}
        isLoopGenerating={isLoopGenerating}
        setIsLoopGenerating={setIsLoopGenerating}
        loopGeneratingRef={loopGeneratingRef}
        handleGenerate={handleGenerate}
        aprilFoolsEffect={aprilFoolsEffect}
        aprilSpinActive={aprilSpinActive}
        setAprilSpinActive={setAprilSpinActive}
        setAprilCostActive={setAprilCostActive}
        resetAprilFoolsCost={resetAprilFoolsCost}
        aprilFoolsCost={aprilFoolsCost}
        selectedModelId={selectedModel.id}
        sampler={sampler}
        isOpus={anlasInfo?.isOpus ?? false}
        img2imgStrengthForCost={img2imgImage ? img2imgStrength : undefined}
        preciseRefCount={crManager.activePreciseRefs.filter(pr => pr.enabled).length}
        vibeRefCount={activeVibes.filter(v => v.enabled).length}
        onPendingImageImport={(file, dataUrl, isVibeFile) => setPendingFile({ file, dataUrl, isVibeFile })}
      />

      {/* Vibe Transfer Modal */}
      <VibeManagerModal
        isOpen={isVibeModalOpen}
        onClose={() => setIsVibeModalOpen(false)}
        selectedModelId={selectedModel.id}
        activeVibeIds={activeVibes.map(v => v.id)}
        onConfirmSelection={handleVibeConfirmSelection}
        showToast={showToast}
      />
      {/* Precise Reference Manager Modal */}
      <CRManagerModal
        isOpen={isCRModalOpen}
        onClose={() => setIsCRModalOpen(false)}
        manager={crManager}
        onConfirmSelection={handleConfirmCR}
      />

      {/* OC Manager Modal */}
      <OCManagerModal
        isOpen={isOCModalOpen}
        onClose={() => setIsOCModalOpen(false)}
        manager={ocManager}
        onConfirmSelection={handleConfirmOCSelection}
        characterPromptsCount={characterPrompts.length}
        maxCharacters={maxCharactersForModel(selectedModel.id)}
        onOpenInspiration={() => setIsInspirationModalOpen(true)}
      />

      {/* Character Position Modal */}
      {editingPositionId && (
        <CharacterPositionModal
          editingPositionId={editingPositionId}
          characterPrompts={characterPrompts}
          onClose={() => setEditingPositionId(null)}
          onUpdatePosition={(id, position) => {
            updateCharacterPrompt(id, 'position', position);
            setEditingPositionId(null);
          }}
        />
      )}

      {/* Artist Manager Modal */}
      <ArtistManagerModal
        isOpen={isArtistModalOpen}
        onClose={() => setIsArtistModalOpen(false)}
        manager={artistManager}
        onConfirmSelection={handleConfirmArtistSelection}
        showToast={showToast}
      />

      {/* 统一 Tag 管理器 (Step 3 v2 · 三轨试运行) */}
      <TagManagerModal
        isOpen={isTagManagerOpen}
        onClose={() => setIsTagManagerOpen(false)}
        ocManager={ocManager}
        artistManager={artistManager}
        characterPromptsCount={characterPrompts.length}
        maxCharacters={maxCharactersForModel(selectedModel.id)}
        showToast={showToast}
        onConfirm={handleTagManagerConfirm}
        onOpenInspiration={() => setIsInspirationModalOpen(true)}
        currentMainPrompt={positivePrompt}
        currentMainNegative={negativePrompt}
        currentCharacterPrompts={characterPrompts}
        imageHistory={generationHistory}
      />

      {/* Inspiration Modal */}
      <InspirationModal
        isOpen={isInspirationModalOpen}
        onClose={() => setIsInspirationModalOpen(false)}
        onSelectPrompt={handleSelectInspirationPrompt}
        onAddCollapsibleTag={handleAddInspirationTag}
        onAddToCharacter={handleAddInspirationToCharacter}
        externalCodexFilter={codexFilterSettings}
        onCodexFilterChange={updateCodexFilterSettings}
        onImportImage={(file, dataUrl) => {
          // 触发DropZoneModal
          setPendingFile({ file, dataUrl, isVibeFile: false });
        }}
      />

      {/* Tools Modal */}
      <ToolsModal
        isOpen={isToolsModalOpen}
        onClose={() => setIsToolsModalOpen(false)}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsModalOpen}
        onClose={() => setIsSettingsModalOpen(false)}
      />

      {/* Profile Modal */}
      <ProfileModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
      />


      {/* CR 编辑弹窗 */}
      <CREditModal manager={crManager} />

      {/* 侧边栏左右伸缩把手 */}
      <div 
        className="absolute top-0 right-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/10 transition-colors"
        onMouseDown={handleSidebarMouseDown}
        title="拖动调整面板宽度"
      />
    </div>
  );
};
