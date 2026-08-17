import React from 'react';
import { useGeneration } from '../../contexts/GenerationContext';
import { useAuth } from '../../contexts/AuthContext';
import { getPublicLibraryOwnerId } from '../../services/publicLibrary';
import { isGenModuleVisible } from '../generation/genModules';
import { MobileGenerateCards } from './MobileGenerateCards';
import { MobileGenerateControls } from './MobileGenerateControls';
import { MobileGenerateEditors } from './MobileGenerateEditors';
import { MobileGenerateImageImportSheet } from './MobileGenerateImageImportSheet';
import { MobileGenerateReferenceSheets } from './MobileGenerateReferenceSheets';
import { MobileGenerateHeader } from './MobileGenerateHeader';
import { MobileStepsSliderOverlay } from './MobileStepsSliderOverlay';
import { useMobileGeneratePageLifecycle } from './generate/useMobileGeneratePageEffects';
import { useMobileAnlas } from './generate/useMobileAnlas';
import { useMobileArtistLibrary } from './generate/useMobileArtistLibrary';
import { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';
import { useMobileGenerateSheetState } from './generate/useMobileGenerateSheetState';
import { useMobileGenerationWorkflow } from './generate/useMobileGenerationWorkflow';
import { useMobileGenModuleContext } from './generate/useMobileGenModuleContext';
import { useMobileImg2Img } from './generate/useMobileImg2Img';
import { useMobileImageImportWorkflow } from './generate/useMobileImageImportWorkflow';
import { useMobileInspirationApply } from './generate/useMobileInspirationApply';
import { useMobileModuleOrder } from './generate/useMobileModuleOrder';
import { useMobileOCManager } from './generate/useMobileOCManager';
import { useMobilePromptPresets } from './generate/useMobilePromptPresets';
import { useMobilePromptTokenCounts } from './generate/useMobilePromptTokenCounts';
import { useMobilePromptAssistWorkflow } from './generate/useMobilePromptAssistWorkflow';
import { useMobileReferenceLibraries } from './generate/useMobileReferenceLibraries';
import { useMobileResolutionPicker } from './generate/useMobileResolutionPicker';
import { useMobileGenerationParams } from './generate/useMobileGenerationParams';
import { useMobilePagerAIBridge } from './generate/useMobilePagerAIBridge';
import { useScrollEdge } from './pager/useScrollEdge';
// ==================== 主组件 ====================
interface MobileGeneratePageProps {
  onEditorStateChange?: (isOpen: boolean) => void;
  /** P3 pager 壳:AI 助手以整页(页 0)呈现——提示词卡 AI 按钮改为导航到页 0,
   *  并注册 pager-ai-* 事件桥;tabs 壳下缺省(false),保持原 sheet 行为不变 */
  aiAssistantAsPage?: boolean;
}

export const MobileGeneratePage: React.FC<MobileGeneratePageProps> = ({ onEditorStateChange, aiAssistantAsPage = false }) => {
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

  const {
    editorOpen,
    setEditorOpen,
    showAIAssistant,
    setShowAIAssistant,
    showModelDropdown,
    setShowModelDropdown,
    showResolutionDropdown,
    setShowResolutionDropdown,
    showVibeModal,
    setShowVibeModal,
    showCRModal,
    setShowCRModal,
    isInspirationModalOpen,
    setIsInspirationModalOpen,
    showArtistModal,
    setShowArtistModal,
    showOCModal,
    setShowOCModal,
    showStepsSlider,
    setShowStepsSlider,
  } = useMobileGenerateSheetState();

  // P4 模块注册表:可见性上下文(模型 × 后端模式 × 登录态)与卡片顺序持久化
  const moduleContext = useMobileGenModuleContext(model, isAuthenticated);
  const { order: moduleOrder, setOrder: setModuleOrder } = useMobileModuleOrder();

  const { anlasInfo, isLoadingAnlas, fetchAnlas } = useMobileAnlas(isGenerating);

  const {
    resolutionTab,
    setResolutionTab,
    currentOptions: currentResolutionOptions,
  } = useMobileResolutionPicker(localWidth, localHeight);

  const {
    vibeLibrary,
    preciseReferenceLibrary,
  } = useMobileReferenceLibraries({
    model,
    showVibeModal,
    closeCRSheet: () => setShowCRModal(false),
  });
  const {
    activeVibes,
    setActiveVibes,
    localVibeFiles,
    setLocalVibeFiles,
    vibeFiles,
    loadVibes,
  } = vibeLibrary;

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

  const codexInspiration = useMobileCodexInspiration(isInspirationModalOpen);

  const {
    artistPublicFiles,
    artistLocalFiles,
    loadArtists,
  } = useMobileArtistLibrary();

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

  const imageImportWorkflow = useMobileImageImportWorkflow({
    setActiveVibes,
    setImg2imgWithAutoRes,
    setActiveCR,
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
  });
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
    useImportedImageAsVibe,
    useImportedImageAsImg2Img,
    useImportedImageAsCR,
    importMetadata,
    importTaggerPrompt,
  } = imageImportWorkflow;

  const {
    aiModel,
    setAiModel,
    isGeneratingPrompt,
    agentState,
    handleAIGenerate,
    handleAIRegenerate,
    handleRestoreSnapshot,
    hasChinesePrompt,
    isTranslating,
    handleTranslate,
    handleArtistSelection,
  } = useMobilePromptAssistWorkflow({
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
    setActiveCR,
    closeArtistModal: () => setShowArtistModal(false),
  });

  // P3 pager 壳:AI 整页(页 0)的事件桥(pager-ai-* → 上方工作流)
  useMobilePagerAIBridge({
    enabled: aiAssistantAsPage,
    handleAIGenerate,
    handleAIRegenerate,
    handleRestoreSnapshot,
    setAiModel,
  });

  useMobileGeneratePageLifecycle({
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
    onEditorStateChange,
    setPositivePrompt,
    setNegativePrompt,
    fetchAnlas,
    loadVibes,
    loadCRs,
    loadArtists,
    loadOCs,
    resetOCSelection,
  });

  const {
    promptPresets,
    activePreset,
    handleApplyPreset,
  } = useMobilePromptPresets({
    activePresetId,
    setActivePresetId,
  });

  const {
    positiveTokens,
    negativeTokens,
    positivePresetTokens,
    negativePresetTokens,
  } = useMobilePromptTokenCounts({
    positivePrompt,
    negativePrompt,
    activePreset,
    characterPrompts,
    // 与载荷剥离同口径:角色模块对当前型号不可见时不计入 token 读数
    characterPromptsVisible: isGenModuleVisible('character', moduleContext),
  });

  const { isPreparing, handleGenerate } = useMobileGenerationWorkflow({
    isGenerating,
    isQueuing,
    isAuthenticated,
    requireAuth,
    positivePrompt,
    negativePrompt,
    promptPresets,
    activePresetId,
    activeVibes,
    setActiveVibes,
    activePreciseRefs,
    characterPrompts,
    savedInpaintRef,
    cropInfoRef,
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    localWidth,
    localHeight,
    setLocalWidth,
    setLocalHeight,
    model,
    seed,
    steps,
    scale,
    sampler,
    cfgRescale,
    noiseSchedule,
    varietyPlus,
    generate,
    addInpaintedImage,
    clearInpaintParams,
  });

  const { handleInspirationSelect } = useMobileInspirationApply({
    characterPrompts,
    setCharacterPrompts,
    setPositivePrompt,
    closeInspirationSheet: () => setIsInspirationModalOpen(false),
  });

  // P7-1 scroll edge:卡片列滚离顶部 → 页头转均匀玻璃材质并收起大标题
  const { scrolled, scrollRef } = useScrollEdge();

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
        scrolled={scrolled}
      />

      {/* 可滚动内容区(相对定位容器:步数滑杆浮在其上、吸底栏之上,不占布局) */}
      <div className="flex-1 relative overflow-hidden">
        <div ref={scrollRef} className="h-full overflow-y-auto scrollbar-hide">
          <MobileGenerateCards
            positivePrompt={positivePrompt}
            setPositivePrompt={setPositivePrompt}
            negativePrompt={negativePrompt}
            setNegativePrompt={setNegativePrompt}
            positiveTokens={positiveTokens}
            negativeTokens={negativeTokens}
            openPromptEditor={() => setEditorOpen('prompt')}
            openNegativeEditor={() => setEditorOpen('undesired')}
            openAIAssistant={
              aiAssistantAsPage
                ? () => window.dispatchEvent(new CustomEvent('pager-navigate', { detail: { page: 0 } }))
                : () => setShowAIAssistant(true)
            }
            openArtistModal={() => setShowArtistModal(true)}
            openInspirationModal={() => setIsInspirationModalOpen(true)}
            openOCModal={() => setShowOCModal(true)}
            hasChinesePrompt={hasChinesePrompt}
            isTranslating={isTranslating}
            onTranslate={handleTranslate}
            characterPromptManager={characterPromptManager}
            vibeLibrary={vibeLibrary}
            preciseReferenceLibrary={preciseReferenceLibrary}
            openVibeManager={() => setShowVibeModal(true)}
            openCRManager={() => setShowCRModal(true)}
            img2imgState={img2imgState}
            width={localWidth}
            height={localHeight}
            moduleContext={moduleContext}
            moduleOrder={moduleOrder}
            onModuleOrderChange={setModuleOrder}
          />
        </div>

        <MobileStepsSliderOverlay
          open={showStepsSlider}
          steps={steps}
          model={model}
          onCommit={setSteps}
        />
      </div>

      <MobileGenerateControls
        toolbar={{
          openAdvancedSettings: () => setShowAdvancedSettings(true),
          openResolutionDropdown: () => setShowResolutionDropdown(true),
          openImageFile,
          onGenerate: handleGenerate,
          cancelTask,
          isGenerating,
          isQueuing,
          isPreparing,
          queuePosition,
          currentStep,
          totalSteps,
          width: localWidth,
          height: localHeight,
          steps,
          model,
          sampler,
          isOpus: anlasInfo?.isOpus ?? false,
          img2imgImage,
          img2imgStrength,
          activePreciseRefs,
          activeVibes,
          stepsSliderOpen: showStepsSlider,
          onToggleStepsSlider: () => setShowStepsSlider(!showStepsSlider),
        }}
        resolutionSheet={{
          isOpen: showResolutionDropdown,
          onClose: () => setShowResolutionDropdown(false),
          resolutionTab,
          setResolutionTab,
          options: currentResolutionOptions,
          width: localWidth,
          height: localHeight,
          setWidth: setLocalWidth,
          setHeight: setLocalHeight,
        }}
        advancedSettingsSheet={{
          isOpen: showAdvancedSettings,
          onClose: () => setShowAdvancedSettings(false),
          promptPresets,
          activePresetId,
          onApplyPreset: handleApplyPreset,
          isPresetExpanded,
          setIsPresetExpanded,
          steps,
          setSteps,
          scale,
          setScale,
          seed,
          setSeed,
          sampler,
          setSampler,
          cfgRescale,
          setCfgRescale,
          noiseSchedule,
          setNoiseSchedule,
          varietyPlus,
          setVarietyPlus,
        }}
      />

      <MobileGenerateEditors
        editorOpen={editorOpen}
        setEditorOpen={setEditorOpen}
        positivePrompt={positivePrompt}
        setPositivePrompt={setPositivePrompt}
        negativePrompt={negativePrompt}
        setNegativePrompt={setNegativePrompt}
        positivePresetTokens={positivePresetTokens}
        negativePresetTokens={negativePresetTokens}
        positiveTokens={positiveTokens}
        negativeTokens={negativeTokens}
        showAIAssistant={showAIAssistant}
        closeAIAssistant={() => setShowAIAssistant(false)}
        aiModel={aiModel}
        setAiModel={setAiModel}
        agentState={agentState}
        isGeneratingPrompt={isGeneratingPrompt}
        handleAIGenerate={handleAIGenerate}
        handleAIRegenerate={handleAIRegenerate}
        handleRestoreSnapshot={handleRestoreSnapshot}
        characterPromptManager={characterPromptManager}
      />

      <MobileGenerateReferenceSheets
        showVibeModal={showVibeModal}
        closeVibeModal={() => setShowVibeModal(false)}
        vibeLibrary={vibeLibrary}
        showCRModal={showCRModal}
        closeCRModal={() => setShowCRModal(false)}
        preciseReferenceLibrary={preciseReferenceLibrary}
        showArtistModal={showArtistModal}
        closeArtistModal={() => setShowArtistModal(false)}
        handleArtistSelection={handleArtistSelection}
        showOCModal={showOCModal}
        closeOCModal={() => setShowOCModal(false)}
        characterPromptCount={characterPrompts.length}
        ocManager={ocManager}
        isInspirationModalOpen={isInspirationModalOpen}
        closeInspirationModal={() => setIsInspirationModalOpen(false)}
        handleInspirationSelect={handleInspirationSelect}
        codexInspiration={codexInspiration}
      />

      <MobileGenerateImageImportSheet
        isOpen={showImageImportModal}
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
    </div>
  );
};

export default MobileGeneratePage;

