import React from 'react';
import { useGeneration } from '../../contexts/GenerationContext';
import { useAuth } from '../../contexts/AuthContext';
import { getPublicLibraryOwnerId } from '../../services/publicLibrary';
import { MobileAIAssistantSheet } from './MobileAIAssistantSheet';
import { MobileAdvancedSettingsSheet } from './MobileAdvancedSettingsSheet';
import { MobileArtistModal } from './MobileArtistModal';
import { MobileGenerateCards } from './MobileGenerateCards';
import { MobileCharacterPromptEditor } from './MobileCharacterPromptEditor';
import { MobileCharacterPositionSheet } from './MobileCharacterPositionSheet';
import { MobileImageImportModal } from './MobileImageImportModal';
import { MobileInspirationSheet } from './MobileInspirationSheet';
import { MobileGenerateHeader } from './MobileGenerateHeader';
import { MobileGenerateToolbar } from './MobileGenerateToolbar';
import { MobileOCEditorSheet } from './MobileOCEditorSheet';
import { MobileOCSheet } from './MobileOCSheet';
import { MobilePreciseReferenceSheet } from './MobilePreciseReferenceSheet';
import { MobileResolutionSheet } from './MobileResolutionSheet';
import { MobileVibeManagerSheet } from './MobileVibeManagerSheet';
import { FullscreenEditor } from './FullscreenEditor';
import {
  useMobileBackHandlers,
  useMobileEditorStateBridge,
  useMobileLibraryBootstrap,
  useMobileMetadataImportHandler,
  useMobileOCSheetLifecycle,
} from './generate/useMobileGeneratePageEffects';
import { useMobileAnlas } from './generate/useMobileAnlas';
import { useMobileAgentAssistant } from './generate/useMobileAgentAssistant';
import { useMobileArtistSelection } from './generate/useMobileArtistSelection';
import { useMobileArtistLibrary } from './generate/useMobileArtistLibrary';
import { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';
import { useMobileGenerateRunner } from './generate/useMobileGenerateRunner';
import { useMobileGenerateSheetState } from './generate/useMobileGenerateSheetState';
import { useMobileImg2Img } from './generate/useMobileImg2Img';
import { useMobileImageImport } from './generate/useMobileImageImport';
import { useMobileImportedImageActions } from './generate/useMobileImportedImageActions';
import { useMobileInspirationApply } from './generate/useMobileInspirationApply';
import { useMobileMetadataImportActions } from './generate/useMobileMetadataImportActions';
import { useMobileOCManager } from './generate/useMobileOCManager';
import { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';
import { useMobileInpaintGenerate } from './generate/useMobileInpaintGenerate';
import { useMobilePromptPresets } from './generate/useMobilePromptPresets';
import { useMobilePromptTokenCounts } from './generate/useMobilePromptTokenCounts';
import { useMobilePromptTranslation } from './generate/useMobilePromptTranslation';
import { useMobileResolutionPicker } from './generate/useMobileResolutionPicker';
import { useMobileRoleTags } from './generate/useMobileRoleTags';
import { useMobileTaggerImportAction } from './generate/useMobileTaggerImportAction';
import { useMobileGenerationParams } from './generate/useMobileGenerationParams';
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
  } = useMobileGenerateSheetState();

  const { anlasInfo, isLoadingAnlas, fetchAnlas } = useMobileAnlas(isGenerating);

  const {
    resolutionTab,
    setResolutionTab,
    currentResLabel,
    currentOptions: currentResolutionOptions,
  } = useMobileResolutionPicker(localWidth, localHeight);

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

  const roleTagMap = useMobileRoleTags();

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
  const { importTaggerPrompt } = useMobileTaggerImportAction({
    taggerResult,
    includeCharacter,
    importOptions,
    setPositivePrompt,
    closeImageImportModal: () => setShowImageImportModal(false),
  });

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
  const { handleArtistSelection } = useMobileArtistSelection({
    setPositivePrompt,
    closeArtistModal: () => setShowArtistModal(false),
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
  useMobileLibraryBootstrap({
    fetchAnlas,
    loadVibes,
    loadCRs,
    loadArtists,
    loadOCs,
  });
  useMobileOCSheetLifecycle({
    showOCModal,
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
  });

  const { isPreparing, handleGenerate } = useMobileGenerateRunner({
    isGenerating,
    isQueuing,
    isAuthenticated,
    requireAuth,
    positivePrompt,
    negativePrompt,
    promptPresets,
    activePresetId,
    activeVibes,
    activePreciseRefs,
    characterPrompts,
    savedInpaintRef,
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    localWidth,
    localHeight,
    model,
    seed,
    steps,
    scale,
    sampler,
    cfgRescale,
    noiseSchedule,
    varietyPlus,
    generate,
  });

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

  const { handleInspirationSelect } = useMobileInspirationApply({
    characterPrompts,
    setCharacterPrompts,
    setPositivePrompt,
    closeInspirationSheet: () => setIsInspirationModalOpen(false),
  });

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
        <MobileGenerateCards
          positivePrompt={positivePrompt}
          setPositivePrompt={setPositivePrompt}
          negativePrompt={negativePrompt}
          setNegativePrompt={setNegativePrompt}
          positiveTokens={positiveTokens}
          negativeTokens={negativeTokens}
          openPromptEditor={() => setEditorOpen('prompt')}
          openNegativeEditor={() => setEditorOpen('undesired')}
          openAIAssistant={() => setShowAIAssistant(true)}
          openArtistModal={() => setShowArtistModal(true)}
          openInspirationModal={() => setIsInspirationModalOpen(true)}
          openOCModal={() => setShowOCModal(true)}
          hasChinesePrompt={hasChinesePrompt}
          isTranslating={isTranslating}
          onTranslate={handleTranslate}
          characterPromptManager={characterPromptManager}
          vibeLibrary={vibeLibrary}
          preciseReferenceLibrary={preciseReferenceLibrary}
          model={model}
          openVibeManager={() => setShowVibeModal(true)}
          openCRManager={() => setShowCRModal(true)}
          img2imgState={img2imgState}
          width={localWidth}
          height={localHeight}
        />
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
        presetTokens={positivePresetTokens}
        totalTokens={positiveTokens}
      />
      <FullscreenEditor
        isOpen={editorOpen === 'undesired'}
        onClose={() => setEditorOpen(null)}
        type="undesired"
        value={negativePrompt}
        onChange={setNegativePrompt}
        presetTokens={negativePresetTokens}
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
        onConfirmSelection={handleArtistSelection}
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


