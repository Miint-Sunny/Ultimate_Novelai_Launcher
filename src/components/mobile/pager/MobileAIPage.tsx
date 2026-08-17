import React, { useEffect, useState } from 'react';
import { Bot, PlusCircle } from 'lucide-react';
import { appBackendApi } from '../../../api/appBackendApi';
import {
  agentService,
  AI_MODEL_CHOICES,
  DEFAULT_AI_MODEL,
  type AgentState,
} from '../../../services/agentService';
import { useAgentModelPresentation } from '../../../hooks/useAgentModelPresentation';
import { AssistantInputBar } from '../ai-assistant/AssistantInputBar';
import { AssistantLogList } from '../ai-assistant/AssistantLogList';
import { useMobileAssistantSheetState } from '../ai-assistant/useMobileAssistantSheetState';

type PromptSnapshot = {
  positive: string;
  negative: string;
  characters: { positive: string; negative?: string; name?: string }[];
};

interface MobileAIPageProps {
  onOpenMine: () => void;
}

// AI 页(页 0,负一屏):复用 ai-assistant/ 的 LogList/InputBar/EmptySuggestions/MessageParts
// 与 useMobileAssistantSheetState 的键盘适配思路(visualViewport 高度驱动,autoFocus 关闭)。
// 提示词状态所有权留在生图页:发送/重新生成/恢复快照经 pager-ai-* 事件桥转发到
// MobileGeneratePage 的助手工作流(见 generate/useMobilePagerAIBridge)。
// 会话 = 现状单会话(agentService 单例);头部「新会话」= 现有清空对话能力。
export const MobileAIPage: React.FC<MobileAIPageProps> = ({ onOpenMine }) => {
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [agentState, setAgentState] = useState<AgentState>({ status: 'idle', logs: [] });
  const agentAvailability = appBackendApi.desktopAgentAvailability();
  const agentModel = useAgentModelPresentation();

  useEffect(() => agentService.addEventListener(setAgentState), []);

  const isGeneratingPrompt = agentState.status === 'thinking';
  const {
    aiInput,
    setAiInput,
    viewportHeight,
    aiLogRef,
    inputRef,
    randomSuggestions,
    thinkingText,
  } = useMobileAssistantSheetState({
    isOpen: true,
    isGeneratingPrompt,
    logs: agentState.logs,
    autoFocus: false,
  });

  const handleAISend = () => {
    if (aiInput.trim() && !isGeneratingPrompt) {
      window.dispatchEvent(new CustomEvent('pager-ai-generate', { detail: aiInput.trim() }));
      setAiInput('');
    }
  };

  // 建议词条/错误重试等直接携带 request 的入口(对应 sheet 里传给 LogList 的 onAIGenerate)
  const handleAIGenerateRequest = (request: string) => {
    if (request.trim() && !isGeneratingPrompt) {
      window.dispatchEvent(new CustomEvent('pager-ai-generate', { detail: request.trim() }));
    }
  };

  const handleAIRegenerate = (request: string, preState: PromptSnapshot) => {
    window.dispatchEvent(new CustomEvent('pager-ai-regenerate', { detail: { request, preState } }));
  };

  const handleRestoreSnapshot = (snapshot: PromptSnapshot & { vibes: string[] }) => {
    window.dispatchEvent(new CustomEvent('pager-ai-restore', { detail: snapshot }));
  };

  return (
    <div
      className="flex flex-col h-full bg-nai-bg"
      style={viewportHeight ? { height: viewportHeight } : undefined}
    >
      {/* 页头:沿用 AssistantHeader 的模式状态/模型选择形态,关闭钮换成「新会话」 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-nai-panel flex-shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-nai-accent" />
          <span className="text-base font-bold text-white">AI 助手</span>
        </div>
        <div className="flex items-center gap-2">
          {agentModel.isLocal ? (
            <div
              role="status"
              title={`本地 sidecar 主模型:${agentModel.primaryModel || '未配置'}`}
              className="h-8 max-w-[160px] px-2.5 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg bg-nai-input border border-gray-700 text-white"
            >
              <span className="shrink-0">本地主模型</span>
              <span className="text-gray-400 truncate">· {agentModel.primaryModel || '未配置'}</span>
            </div>
          ) : (
            <select
              value={aiModel}
              onChange={(e) => {
                setAiModel(e.target.value);
                window.dispatchEvent(new CustomEvent('pager-ai-model-change', { detail: e.target.value }));
              }}
              className="h-8 px-2 text-sm font-bold rounded-lg bg-nai-input border border-gray-700 text-white max-w-[140px]"
            >
              {AI_MODEL_CHOICES.map((choice) => (
                <option key={choice.key} value={choice.key}>{choice.label}</option>
              ))}
            </select>
          )}
          <button
            onClick={() => agentService.clearLogs()}
            title="新会话(清空当前对话)"
            className="p-2 hover:bg-white/5 rounded-lg text-gray-400 hover:text-white transition-colors"
          >
            <PlusCircle className="w-5 h-5" />
          </button>
        </div>
      </div>

      {agentAvailability.available ? (
        <>
          <AssistantLogList
            logRef={aiLogRef}
            agentState={agentState}
            suggestions={randomSuggestions}
            isGeneratingPrompt={isGeneratingPrompt}
            thinkingText={thinkingText}
            onAIGenerate={handleAIGenerateRequest}
            onAIRegenerate={handleAIRegenerate}
            onRestoreSnapshot={handleRestoreSnapshot}
          />
          {/* 底部留白避让悬浮页栏 */}
          <div style={{ paddingBottom: 84 }}>
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
      ) : (
        // 能力不可用:页内说明卡,不白屏不自动跳走
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-xs w-full bg-nai-panel border border-gray-700 rounded-xl p-5 flex flex-col items-center gap-3 text-center">
            <Bot className="w-10 h-10 text-gray-600" />
            <p className="text-sm text-gray-300 font-medium">当前后端模式不支持 AI 助手</p>
            <p className="text-xs text-gray-500 leading-relaxed">
              {agentAvailability.reason || 'AI 助手需要支持完整桌面 Agent 的后端,请检查后端连接与模式设置。'}
            </p>
            <button
              onClick={onOpenMine}
              className="mt-1 px-4 py-2 rounded-lg bg-nai-accent/20 border border-nai-accent/50 text-nai-accent text-sm font-medium active:bg-nai-accent/30 transition-colors"
            >
              去「我的」检查后端
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
