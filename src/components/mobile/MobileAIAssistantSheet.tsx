import React from 'react';
import { appBackendApi } from '../../api/appBackendApi';
import { agentService, type AgentState } from '../../services/agentService';
import { useAgentModelPresentation } from '../../hooks/useAgentModelPresentation';
import { AssistantHeader } from './ai-assistant/AssistantHeader';
import { AssistantInputBar } from './ai-assistant/AssistantInputBar';
import { AssistantLogList } from './ai-assistant/AssistantLogList';
import { useMobileAssistantSheetState } from './ai-assistant/useMobileAssistantSheetState';

interface MobileAIAssistantSheetProps {
  isOpen: boolean;
  onClose: () => void;
  aiModel: string;
  onAiModelChange: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  onAIGenerate: (request: string) => void;
  onAIRegenerate?: (
    request: string,
    preState: { positive: string; negative: string; characters: { positive: string; negative?: string; name?: string }[] }
  ) => void;
  onRestoreSnapshot?: (snapshot: {
    positive: string;
    negative: string;
    characters: { positive: string; negative?: string; name?: string }[];
    vibes: string[];
  }) => void;
}

export const MobileAIAssistantSheet: React.FC<MobileAIAssistantSheetProps> = ({
  isOpen,
  onClose,
  aiModel,
  onAiModelChange,
  agentState,
  isGeneratingPrompt,
  onAIGenerate,
  onAIRegenerate,
  onRestoreSnapshot,
}) => {
  const agentAvailability = appBackendApi.desktopAgentAvailability();
  const agentModel = useAgentModelPresentation();
  const {
    aiInput,
    setAiInput,
    viewportHeight,
    aiLogRef,
    inputRef,
    randomSuggestions,
    thinkingText,
  } = useMobileAssistantSheetState({
    isOpen,
    isGeneratingPrompt,
    logs: agentState.logs,
  });

  React.useEffect(() => {
    if (isOpen && !agentAvailability.available) onClose();
  }, [agentAvailability.available, isOpen, onClose]);

  const handleAISend = () => {
    if (aiInput.trim() && onAIGenerate && !isGeneratingPrompt) {
      onAIGenerate(aiInput.trim());
      setAiInput('');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-fade-in"
        onClick={onClose}
      />

      {/* 半弹窗面板 */}
      <div
        className="fixed left-0 right-0 bottom-0 z-50 bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom flex flex-col transition-all duration-300"
        style={{ maxHeight: viewportHeight ? `${viewportHeight * 0.85}px` : '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <AssistantHeader
          aiModel={aiModel}
          localPrimaryModel={agentModel.isLocal ? (agentModel.primaryModel ?? '') : null}
          onAiModelChange={onAiModelChange}
          onClose={onClose}
        />

        <AssistantLogList
          logRef={aiLogRef}
          agentState={agentState}
          suggestions={randomSuggestions}
          isGeneratingPrompt={isGeneratingPrompt}
          thinkingText={thinkingText}
          onAIGenerate={onAIGenerate}
          onAIRegenerate={onAIRegenerate}
          onRestoreSnapshot={onRestoreSnapshot}
        />

        <AssistantInputBar
          inputRef={inputRef}
          aiInput={aiInput}
          onInputChange={setAiInput}
          isGeneratingPrompt={isGeneratingPrompt}
          hasLogs={agentState.logs.length > 0}
          onSend={handleAISend}
          onClearLogs={() => agentService.clearLogs()}
        />
      </div>
    </>
  );
};
