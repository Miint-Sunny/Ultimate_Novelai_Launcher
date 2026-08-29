import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import {
  generateImageStream,
  type GenerateImageParams,
  type GenerateResult,
  type StreamProgress,
  type QueueProgress,
} from '../services/novelai';
import { botService } from '../services/botService';
import { saveImageHistory, loadImageHistory } from '../services/localLibrary';

export interface HistoryItemMetadata {
  positivePrompt: string;
  negativePrompt: string;
  model: string;
  steps: number;
  scale: number;
  sampler: string;
  cfgRescale: number;
  noiseSchedule: string;
  ucPreset: string;
  qualityToggle: boolean;
  varietyPlus: boolean;
  characterPrompts?: Array<{ positive: string; negative: string; enabled: boolean; position?: string }>;
}

export interface HistoryItem {
  id: string;
  imageUrl: string;
  seed: number;
  timestamp: number;
  width: number;
  height: number;
  metadata?: HistoryItemMetadata;
  isUpscaled?: boolean; // 是否为超分图片
  originalSeed?: number; // 原始种子（超分图片用）
  upscaleScale?: number; // 实际达成倍率：原生超分 2/4，图生图重绘 1/1.5/2（Max 档按结果尺寸折算）
  isInpainted?: boolean; // 是否为局部重绘图片
  isBananaRepaint?: boolean; // 是否为香蕉重绘图片
}

interface GenerationState {
  isGenerating: boolean;
  currentStep: number;
  totalSteps: number;
  previewUrl: string | null;
  result: GenerateResult | null;
  imageUrl: string | null;
  currentSeed: number | null;
  seedSetting: string;
  targetWidth: number;
  targetHeight: number;
  history: HistoryItem[];
  // 排队状态
  isQueuing: boolean;
  queuePosition: number;
  queueSize: number;
  // 生成中是否正在查看历史图片
  viewingHistory: boolean;
}

interface GenerationContextType extends GenerationState {
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
  cancelTask: () => Promise<boolean>;
  setSeedSetting: (seed: string) => void;
  reset: () => void;
  clearHistory: () => void;
  selectHistoryItem: (id: string) => void;
  deleteHistoryItem: (id: string) => void;
  deleteHistoryItems: (ids: string[]) => void;
  addUpscaledImage: (imageUrl: string, width: number, height: number, originalSeed: number, scale: number) => void;
  setImage: (imageUrl: string, width: number, height: number, seed?: number) => void;
  addInpaintedImage: (imageUrl: string, width: number, height: number, seed: number) => void;
  addBananaRepaintImage: (imageUrl: string, width: number, height: number, seed?: number) => string; // 返回 historyItem id
  setViewingHistory: (v: boolean) => void;
}

const GenerationContext = createContext<GenerationContextType | null>(null);

export function GenerationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GenerationState>({
    isGenerating: false,
    currentStep: 0,
    totalSteps: 0,
    previewUrl: null,
    result: null,
    imageUrl: null,
    currentSeed: null,
    seedSetting: '',
    targetWidth: 1216,
    targetHeight: 832,
    history: [],
    isQueuing: false,
    queuePosition: 0,
    queueSize: 0,
    viewingHistory: false,
  });

  const previewUrlRef = useRef<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 启动时从 IndexedDB 恢复最近的图片历史
  useEffect(() => {
    loadImageHistory().then((items) => {
      if (items.length > 0) {
        setState((prev) => ({
          ...prev,
          history: items,
          imageUrl: items[0].imageUrl,
          currentSeed: items[0].seed,
          targetWidth: items[0].width,
          targetHeight: items[0].height,
        }));
      }
    });
  }, []);

  // 历史记录变化时，防抖保存最近 5 张到 IndexedDB
  useEffect(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveImageHistory(state.history);
    }, 1000);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, [state.history]);

  const setSeedSetting = useCallback((seed: string) => {
    setState((prev) => ({ ...prev, seedSetting: seed }));
  }, []);

  const setViewingHistory = useCallback((v: boolean) => {
    setState((prev) => ({ ...prev, viewingHistory: v }));
  }, []);

  const generate = useCallback(async (params: GenerateImageParams): Promise<GenerateResult> => {
    // 清理之前的预览 URL
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }

    setState((prev) => ({
      ...prev,
      isGenerating: true,
      currentStep: 0,
      totalSteps: params.steps,
      // skipHistory（裁切/扩图）时保持原始尺寸，避免 overlay 变形
      targetWidth: params.skipHistory ? prev.targetWidth : params.width,
      targetHeight: params.skipHistory ? prev.targetHeight : params.height,
      previewUrl: null,
      result: null,
      isQueuing: false,
      queuePosition: 0,
      queueSize: 0,
      viewingHistory: false,
    }));

    const onProgress = (progress: StreamProgress) => {
      // 清理旧的预览 URL
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }

      let newPreviewUrl: string | null = null;
      if (progress.previewImage) {
        newPreviewUrl = URL.createObjectURL(progress.previewImage);
        previewUrlRef.current = newPreviewUrl;
      }

      setState((prev) => ({
        ...prev,
        currentStep: progress.step,
        totalSteps: progress.totalSteps,
        previewUrl: newPreviewUrl,
      }));
    };

    const onQueueProgress = (progress: QueueProgress) => {
      setState((prev) => ({
        ...prev,
        isQueuing: progress.isQueuing,
        queuePosition: progress.position,
        queueSize: progress.queueSize,
      }));
    };

    try {
      const res = await generateImageStream(params, onProgress, onQueueProgress);

      // 记住旧的预览 URL，等状态更新后再释放（避免渲染闪烁）
      const oldPreviewUrl = previewUrlRef.current;
      previewUrlRef.current = null;

      let newImageUrl: string | null = null;

      if (res.success && res.imageData) {
        newImageUrl = URL.createObjectURL(res.imageData);

        const historyItem: HistoryItem = {
          id: Date.now().toString(),
          imageUrl: newImageUrl,
          seed: res.seed || 0,
          timestamp: Date.now(),
          width: params.width,
          height: params.height,
          metadata: {
            positivePrompt: params.positivePrompt,
            negativePrompt: params.negativePrompt,
            model: params.model,
            steps: params.steps,
            scale: params.scale,
            sampler: params.sampler,
            cfgRescale: params.cfgRescale,
            noiseSchedule: params.noiseSchedule,
            ucPreset: params.ucPreset,
            qualityToggle: params.qualityToggle,
            varietyPlus: params.varietyPlus,
            characterPrompts: params.characterPrompts,
          },
          // 检测是否为局部重绘
          isInpainted: !!params.inpaint,
        };

        setState((prev) => ({
          ...prev,
          isGenerating: false,
          currentStep: prev.totalSteps,
          previewUrl: null,
          result: res,
          imageUrl: params.skipHistory ? prev.imageUrl : newImageUrl,
          currentSeed: res.seed || null,
          history: params.skipHistory ? prev.history : [historyItem, ...prev.history],
          isQueuing: false,
          queuePosition: 0,
          queueSize: 0,
          viewingHistory: false,
        }));

        // 状态已提交后再释放旧预览 URL
        if (oldPreviewUrl) {
          setTimeout(() => URL.revokeObjectURL(oldPreviewUrl), 100);
        }
      } else {
        setState((prev) => ({
          ...prev,
          isGenerating: false,
          previewUrl: null,
          result: res,
          // 兜底：生成完成后强制关闭排队状态
          isQueuing: false,
          queuePosition: 0,
          queueSize: 0,
          viewingHistory: false,
        }));
        if (oldPreviewUrl) {
          setTimeout(() => URL.revokeObjectURL(oldPreviewUrl), 100);
        }
      }

      return res;
    } catch (error) {
      const errorResult: GenerateResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      if (previewUrlRef.current) {
        const url = previewUrlRef.current;
        previewUrlRef.current = null;
        setTimeout(() => URL.revokeObjectURL(url), 100);
      }
      setState((prev) => ({
        ...prev,
        isGenerating: false,
        previewUrl: null,
        result: errorResult,
        // 兜底：出错时也强制关闭排队状态
        isQueuing: false,
        queuePosition: 0,
        queueSize: 0,
        viewingHistory: false,
      }));
      return errorResult;
    }
  }, []);

  const cancelTask = useCallback(async (): Promise<boolean> => {
    const success = await botService.cancelTask();
    if (success) {
      setState((prev) => ({
        ...prev,
        isGenerating: false,
        isQueuing: false,
        queuePosition: 0,
        queueSize: 0,
        viewingHistory: false,
        result: { success: false, error: '已取消' },
      }));
    }
    return success;
  }, []);

  const reset = useCallback(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setState((prev) => ({
      ...prev,
      isGenerating: false,
      currentStep: 0,
      previewUrl: null,
      result: null,
    }));
  }, []);

  const clearHistory = useCallback(() => {
    // 保留最近一张（第一张）
    if (state.history.length > 1) {
      state.history.slice(1).forEach((item) => URL.revokeObjectURL(item.imageUrl));
      setState((prev) => ({ ...prev, history: prev.history.slice(0, 1) }));
    }
  }, [state.history]);

  const selectHistoryItem = useCallback(
    async (id: string) => {
      const item = state.history.find((h) => h.id === id);
      if (item) {
        // 先用历史记录中的尺寸
        setState((prev) => ({
          ...prev,
          imageUrl: item.imageUrl,
          currentSeed: item.seed,
          targetWidth: item.width,
          targetHeight: item.height,
          // 生成中点击历史记录时标记为正在查看历史
          viewingHistory: prev.isGenerating || prev.isQueuing,
        }));

        // 异步获取图片实际尺寸
        try {
          const img = new Image();
          img.src = item.imageUrl;
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject();
          });

          // 如果实际尺寸与记录不同，更新显示和历史记录
          if (img.naturalWidth !== item.width || img.naturalHeight !== item.height) {
            setState((prev) => ({
              ...prev,
              targetWidth: img.naturalWidth,
              targetHeight: img.naturalHeight,
              // 同时更新历史记录中的尺寸
              history: prev.history.map((h) =>
                h.id === id
                  ? { ...h, width: img.naturalWidth, height: img.naturalHeight }
                  : h
              ),
            }));
          }
        } catch {
          // 获取失败时保持原有尺寸
        }
      }
    },
    [state.history]
  );

  const deleteHistoryItem = useCallback(
    (id: string) => {
      const item = state.history.find((h) => h.id === id);
      if (item) {
        URL.revokeObjectURL(item.imageUrl);
        setState((prev) => ({
          ...prev,
          history: prev.history.filter((h) => h.id !== id),
          ...(prev.imageUrl === item.imageUrl ? { imageUrl: null, currentSeed: null } : {}),
        }));
      }
    },
    [state.history]
  );

  const deleteHistoryItems = useCallback(
    (ids: string[]) => {
      const itemsToDelete = state.history.filter((h) => ids.includes(h.id));
      itemsToDelete.forEach((item) => URL.revokeObjectURL(item.imageUrl));
      const currentImageDeleted = itemsToDelete.some((item) => item.imageUrl === state.imageUrl);
      setState((prev) => ({
        ...prev,
        history: prev.history.filter((h) => !ids.includes(h.id)),
        ...(currentImageDeleted ? { imageUrl: null, currentSeed: null } : {}),
      }));
    },
    [state.history, state.imageUrl]
  );

  // 添加超分图片到历史记录
  const addUpscaledImage = useCallback(
    (newImageUrl: string, width: number, height: number, originalSeed: number, scale: number) => {
      const historyItem: HistoryItem = {
        id: `upscaled_${Date.now()}`,
        imageUrl: newImageUrl,
        seed: originalSeed,
        timestamp: Date.now(),
        width,
        height,
        isUpscaled: true,
        originalSeed,
        upscaleScale: scale,
      };

      setState((prev) => ({
        ...prev,
        imageUrl: newImageUrl,
        currentSeed: originalSeed,
        targetWidth: width,
        targetHeight: height,
        history: [historyItem, ...prev.history],
      }));
    },
    []
  );

  // 直接设置图片（用于香蕉重绘等外部生成的图片）
  const setImage = useCallback(
    (newImageUrl: string, width: number, height: number, seed?: number) => {
      const historyItem: HistoryItem = {
        id: `external_${Date.now()}`,
        imageUrl: newImageUrl,
        seed: seed || 0,
        timestamp: Date.now(),
        width,
        height,
      };

      setState((prev) => ({
        ...prev,
        imageUrl: newImageUrl,
        currentSeed: seed || prev.currentSeed,
        targetWidth: width,
        targetHeight: height,
        history: [historyItem, ...prev.history],
      }));
    },
    []
  );

  // 添加局部重绘图片到历史记录
  const addInpaintedImage = useCallback(
    (newImageUrl: string, width: number, height: number, seed: number) => {
      const historyItem: HistoryItem = {
        id: `inpainted_${Date.now()}`,
        imageUrl: newImageUrl,
        seed,
        timestamp: Date.now(),
        width,
        height,
        isInpainted: true,
      };

      setState((prev) => ({
        ...prev,
        imageUrl: newImageUrl,
        currentSeed: seed,
        targetWidth: width,
        targetHeight: height,
        history: [historyItem, ...prev.history],
      }));
    },
    []
  );

  // 添加香蕉重绘图片到历史记录（不切换当前显示，返回 id 用于后续跳转）
  const addBananaRepaintImage = useCallback(
    (newImageUrl: string, width: number, height: number, seed?: number): string => {
      const itemId = `banana_${Date.now()}`;

      // 异步获取图片实际尺寸并更新
      const img = new Image();
      img.src = newImageUrl;
      img.onload = () => {
        if (img.naturalWidth !== width || img.naturalHeight !== height) {
          setState((prev) => ({
            ...prev,
            history: prev.history.map((h) =>
              h.id === itemId
                ? { ...h, width: img.naturalWidth, height: img.naturalHeight }
                : h
            ),
          }));
        }
      };

      const historyItem: HistoryItem = {
        id: itemId,
        imageUrl: newImageUrl,
        seed: seed || 0,
        timestamp: Date.now(),
        width,
        height,
        isBananaRepaint: true,
      };

      setState((prev) => ({
        ...prev,
        history: [historyItem, ...prev.history],
      }));

      return itemId;
    },
    []
  );

  return (
    <GenerationContext.Provider value={{ ...state, generate, cancelTask, setSeedSetting, reset, clearHistory, selectHistoryItem, deleteHistoryItem, deleteHistoryItems, addUpscaledImage, setImage, addInpaintedImage, addBananaRepaintImage, setViewingHistory }}>
      {children}
    </GenerationContext.Provider>
  );
}

export function useGeneration() {
  const context = useContext(GenerationContext);
  if (!context) throw new Error('useGeneration must be used within a GenerationProvider');
  return context;
}
