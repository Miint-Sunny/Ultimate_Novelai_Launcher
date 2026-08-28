import type { Dispatch, SetStateAction } from 'react';
import {
  orderedVisibleGenModuleKeys,
  type GenModuleContext,
  type SortableGenModuleKey,
} from '../generation/genModules';
import { useMobileCardDragSort, type MobileCardDragHandleProps } from './generate/useMobileCardDragSort';
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
  /** 当前模型的同框角色上限。 */
  maxCharacters: number;
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
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
  openVibeManager: () => void;
  openCRManager: () => void;
  img2imgState: ReturnType<typeof useMobileImg2Img>;
  width: number;
  height: number;
  /** 模块注册表:可见性上下文 + 持久化顺序(含当前不可见模块,隐藏保槽位) */
  moduleContext: GenModuleContext;
  moduleOrder: SortableGenModuleKey[];
  onModuleOrderChange: (next: SortableGenModuleKey[]) => void;
}

// 注册表驱动渲染(对齐 Plana generate_page):提示词摘要卡居顶固定,其余模块卡按
// orderedVisibleGenModuleKeys(持久化顺序 × 可见性谓词)渲染,不满足谓词的整卡不渲染
// (无置灰占位);卡头长按起拖调序,手势经 dragHandleProps 只挂卡头/标题区。
export function MobileGenerateCards({
  maxCharacters,
  maxTokens,
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
  openVibeManager,
  openCRManager,
  img2imgState,
  width,
  height,
  moduleContext,
  moduleOrder,
  onModuleOrderChange,
}: MobileGenerateCardsProps) {
  const visibleKeys = orderedVisibleGenModuleKeys(moduleContext, moduleOrder);
  const { draggingKey, getDragHandleProps, registerCard } = useMobileCardDragSort({
    order: moduleOrder,
    visibleKeys,
    onOrderChange: onModuleOrderChange,
  });

  const renderModuleCard = (key: SortableGenModuleKey) => {
    const dragHandleProps = getDragHandleProps(key);
    switch (key) {
      case 'character':
        return <MobileCharacterPromptsCard manager={characterPromptManager} maxCharacters={maxCharacters} dragHandleProps={dragHandleProps} />;
      case 'vibe':
        return <MobileVibeReferencesCard library={vibeLibrary} onOpenManager={openVibeManager} dragHandleProps={dragHandleProps} />;
      case 'precise-reference':
        return <MobilePreciseReferenceCard library={preciseReferenceLibrary} onOpenManager={openCRManager} dragHandleProps={dragHandleProps} />;
      case 'img2img':
        return <MobileImg2ImgCard imageState={img2imgState} width={width} height={height} dragHandleProps={dragHandleProps} />;
    }
  };

  return (
    <div className="p-3 space-y-3">
      <MobilePromptSummaryCard
        maxTokens={maxTokens}
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

      {visibleKeys.map((key) => (
        <div
          key={key}
          ref={registerCard(key)}
          className={draggingKey === key
            ? 'relative z-10 scale-[1.02] shadow-2xl rounded-xl transition-transform'
            : 'transition-transform'}
        >
          {renderModuleCard(key)}
        </div>
      ))}
    </div>
  );
}
