import React from 'react';
import { useGeneration } from '../../contexts/GenerationContext';
import { useAuth } from '../../contexts/AuthContext';
import { getPublicLibraryOwnerId } from '../../services/publicLibrary';
import { MobileGenerateCards } from './MobileGenerateCards';
import { MobileGenerateControls } from './MobileGenerateControls';
import { MobileGenerateEditors } from './MobileGenerateEditors';
import { MobileGenerateImageImportSheet } from './MobileGenerateImageImportSheet';
import { MobileGenerateReferenceSheets } from './MobileGenerateReferenceSheets';
import { MobileGenerateHeader } from './MobileGenerateHeader';
import { useMobileGeneratePageLifecycle } from './generate/useMobileGeneratePageEffects';
import { useMobileAnlas } from './generate/useMobileAnlas';
import { useMobileArtistLibrary } from './generate/useMobileArtistLibrary';
import { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';
import { useMobileGenerateSheetState } from './generate/useMobileGenerateSheetState';
import { useMobileGenerationWorkflow } from './generate/useMobileGenerationWorkflow';
import { useMobileImg2Img } from './generate/useMobileImg2Img';
import { useMobileImageImportWorkflow } from './generate/useMobileImageImportWorkflow';
import { useMobileInspirationApply } from './generate/useMobileInspirationApply';
import { useMobileOCManager } from './generate/useMobileOCManager';
import { useMobilePromptPresets } from './generate/useMobilePromptPresets';
import { useMobilePromptTokenCounts } from './generate/useMobilePromptTokenCounts';
import { useMobilePromptAssistWorkflow } from './generate/useMobilePromptAssistWorkflow';
import { useMobileReferenceLibraries } from './generate/useMobileReferenceLibraries';
import { useMobileResolutionPicker } from './generate/useMobileResolutionPicker';
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

      <MobileGenerateControls
        toolbar={{
          currentResLabel,
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

