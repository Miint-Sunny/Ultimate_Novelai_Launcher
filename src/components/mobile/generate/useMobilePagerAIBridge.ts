import { useEffect } from 'react';

type CharacterSnapshot = { positive: string; negative?: string; name?: string };

interface UseMobilePagerAIBridgeOptions {
  enabled: boolean;
  handleAIGenerate: (request: string) => Promise<void>;
  handleAIRegenerate: (
    request: string,
    preState: { positive: string; negative: string; characters: CharacterSnapshot[] },
    imageBase64?: string,
  ) => Promise<void>;
  handleRestoreSnapshot: (snapshot: {
    positive: string;
    negative: string;
    characters: CharacterSnapshot[];
    vibes: string[];
  }) => void;
  setAiModel: (model: string) => void;
}

// P3 pager 桥:AI 页(页 0)与生图页助手工作流之间的事件桥。
// 提示词/角色/vibe 等状态所有权留在 MobileGeneratePage 的 hook 树,
// AI 页的pager-ai-* 事件在这里映射为现有工作流调用:
//   pager-ai-generate      → handleAIGenerate(request)
//   pager-ai-regenerate    → handleAIRegenerate(request, preState, imageBase64)
//   pager-ai-restore       → handleRestoreSnapshot(snapshot) 然后跳回生图页(页 1)
//   pager-ai-model-change  → setAiModel(model)(AI 页的模型选择写回工作流)
export function useMobilePagerAIBridge({
  enabled,
  handleAIGenerate,
  handleAIRegenerate,
  handleRestoreSnapshot,
  setAiModel,
}: UseMobilePagerAIBridgeOptions) {
  useEffect(() => {
    if (!enabled) return;

    const onGenerate = (event: Event) => {
      void handleAIGenerate((event as CustomEvent).detail as string);
    };
    const onRegenerate = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      void handleAIRegenerate(detail.request, detail.preState, detail.imageBase64);
    };
    const onRestore = (event: Event) => {
      handleRestoreSnapshot((event as CustomEvent).detail);
      window.dispatchEvent(new CustomEvent('pager-navigate', { detail: { page: 1 } }));
    };
    const onModelChange = (event: Event) => {
      setAiModel((event as CustomEvent).detail as string);
    };

    window.addEventListener('pager-ai-generate', onGenerate);
    window.addEventListener('pager-ai-regenerate', onRegenerate);
    window.addEventListener('pager-ai-restore', onRestore);
    window.addEventListener('pager-ai-model-change', onModelChange);
    return () => {
      window.removeEventListener('pager-ai-generate', onGenerate);
      window.removeEventListener('pager-ai-regenerate', onRegenerate);
      window.removeEventListener('pager-ai-restore', onRestore);
      window.removeEventListener('pager-ai-model-change', onModelChange);
    };
  }, [enabled, handleAIGenerate, handleAIRegenerate, handleRestoreSnapshot, setAiModel]);
}
