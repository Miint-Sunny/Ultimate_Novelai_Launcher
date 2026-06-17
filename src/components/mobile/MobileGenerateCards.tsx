import type { Dispatch, SetStateAction } from 'react';
import { MobileCharacterPromptsCard } from './MobileCharacterPromptsCard';
import { MobileImg2ImgCard } from './MobileImg2ImgCard';
import { MobilePreciseReferenceCard } from './MobilePreciseReferenceCard';
import { MobilePromptSummaryCard } from './MobilePromptSummaryCard';
import { MobileVibeReferencesCard } from './MobileVibeReferencesCard';
import type { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';
import type { useMobileImg2Img } from './generate/useMobileImg2Img';
import type { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import type { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';

interface MobileGenerateCardsProps {
  positivePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  positiveTokens: number;
  negativeTokens: number;
  openPromptEditor: () => void;
  openNegativeEditor: () => void;
  openAIAssistant: () => void;
  openArtistModal: () => void;
  openInspirationModal: () => void;
  openOCModal: () => void;
  hasChinesePrompt: boolean;
  isTranslating: boolean;
  onTranslate: () => void;
  characterPromptManager: ReturnType<typeof useMobileCharacterPrompts>;
  vibeLibrary: ReturnType<typeof useMobileVibeLibrary>;
  preciseReferenceLibrary: ReturnType<typeof useMobilePreciseReferences>;
  model: string;
  openVibeManager: () => void;
  openCRManager: () => void;
  img2imgState: ReturnType<typeof useMobileImg2Img>;
  width: number;
  height: number;
}

export function MobileGenerateCards({
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
  positiveTokens,
  negativeTokens,
  openPromptEditor,
  openNegativeEditor,
  openAIAssistant,
  openArtistModal,
  openInspirationModal,
  openOCModal,
  hasChinesePrompt,
  isTranslating,
  onTranslate,
  characterPromptManager,
  vibeLibrary,
  preciseReferenceLibrary,
  model,
  openVibeManager,
  openCRManager,
  img2imgState,
  width,
  height,
}: MobileGenerateCardsProps) {
  return (
    <div className="p-3 space-y-3">
      <MobilePromptSummaryCard
        positivePrompt={positivePrompt}
        setPositivePrompt={setPositivePrompt}
        negativePrompt={negativePrompt}
        setNegativePrompt={setNegativePrompt}
        positiveTokens={positiveTokens}
        negativeTokens={negativeTokens}
        openPromptEditor={openPromptEditor}
        openNegativeEditor={openNegativeEditor}
        openAIAssistant={openAIAssistant}
        openArtistModal={openArtistModal}
        openInspirationModal={openInspirationModal}
        openOCModal={openOCModal}
        hasChinesePrompt={hasChinesePrompt}
        isTranslating={isTranslating}
        onTranslate={onTranslate}
      />

      <MobileCharacterPromptsCard manager={characterPromptManager} />

      <MobileVibeReferencesCard
        library={vibeLibrary}
        onOpenManager={openVibeManager}
      />
      <MobilePreciseReferenceCard
        model={model}
        library={preciseReferenceLibrary}
        onOpenManager={openCRManager}
      />

      <MobileImg2ImgCard
        imageState={img2imgState}
        width={width}
        height={height}
      />
    </div>
  );
}
