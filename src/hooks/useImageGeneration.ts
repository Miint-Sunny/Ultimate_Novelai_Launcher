import { useState, useCallback } from 'react';
import { generateImage, type GenerateImageParams, type GenerateResult } from '../services/novelai';

export interface UseImageGenerationReturn {
  isGenerating: boolean;
  progress: number; // 0-100
  result: GenerateResult | null;
  imageUrl: string | null;
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
  reset: () => void;
}

export function useImageGeneration(): UseImageGenerationReturn {
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const generate = useCallback(async (params: GenerateImageParams): Promise<GenerateResult> => {
    // 清理之前的 URL
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
      setImageUrl(null);
    }

    setIsGenerating(true);
    setProgress(0);
    setResult(null);

    // 模拟进度 (因为 API 不提供实时进度)
    const progressInterval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 90) return prev;
        return prev + Math.random() * 10;
      });
    }, 500);

    try {
      const res = await generateImage(params);
      
      clearInterval(progressInterval);
      setProgress(100);
      setResult(res);

      if (res.success && res.imageData) {
        const url = URL.createObjectURL(res.imageData);
        setImageUrl(url);
      }

      return res;
    } catch (error) {
      clearInterval(progressInterval);
      const errorResult: GenerateResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      setResult(errorResult);
      return errorResult;
    } finally {
      setIsGenerating(false);
    }
  }, [imageUrl]);

  const reset = useCallback(() => {
    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }
    setIsGenerating(false);
    setProgress(0);
    setResult(null);
    setImageUrl(null);
  }, [imageUrl]);

  return {
    isGenerating,
    progress,
    result,
    imageUrl,
    generate,
    reset,
  };
}

// 辅助函数：将前端状态转换为 API 参数
export function buildParamsFromState(state: {
  positivePrompt: string;
  negativePrompt: string;
  selectedModel: { id: string };
  customWidth: number;
  customHeight: number;
  steps: number;
  scale: number;
  seed: string;
  sampler: string;
  scaleRescale: number;
  noiseSchedule: string;
  activePresetId: string;
  varietyPlus?: boolean;
  characterPrompts: Array<{
    positive: string;
    negative: string;
    enabled: boolean;
    position?: string;
  }>;
  activePreset?: {
    positive: string;
    negative: string;
  };
}): GenerateImageParams {
  // 合并预设提示词
  let finalPositive = state.positivePrompt;
  let finalNegative = state.negativePrompt;
  
  if (state.activePreset) {
    if (state.activePreset.positive) {
      finalPositive = `${state.activePreset.positive}, ${finalPositive}`;
    }
    if (state.activePreset.negative) {
      finalNegative = `${state.activePreset.negative}, ${finalNegative}`;
    }
  }

  return {
    positivePrompt: finalPositive,
    negativePrompt: finalNegative,
    model: state.selectedModel.id,
    width: state.customWidth,
    height: state.customHeight,
    steps: state.steps,
    scale: state.scale,
    seed: state.seed ? parseInt(state.seed, 10) : undefined,
    sampler: state.sampler,
    cfgRescale: state.scaleRescale,
    noiseSchedule: state.noiseSchedule,
    ucPreset: state.activePresetId,
    qualityToggle: state.activePresetId === 'heavy',
    varietyPlus: state.varietyPlus ?? false,
    characterPrompts: state.characterPrompts.map(cp => ({
      positive: cp.positive,
      negative: cp.negative,
      enabled: cp.enabled,
      position: cp.position,
    })),
  };
}
