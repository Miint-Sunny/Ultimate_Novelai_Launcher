import { useCallback } from 'react';

interface UseMobileUpscaleCompletionOptions {
  currentSeed: number | null;
  addUpscaledImage: (imageUrl: string, width: number, height: number, seed: number, scale: number) => void;
}

export function useMobileUpscaleCompletion({
  currentSeed,
  addUpscaledImage,
}: UseMobileUpscaleCompletionOptions) {
  return useCallback(async (resultBlob: Blob, scale: number) => {
    const url = URL.createObjectURL(resultBlob);

    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
    });

    const width = img.naturalWidth;
    const height = img.naturalHeight;
    addUpscaledImage(url, width, height, currentSeed || 0, scale);
  }, [addUpscaledImage, currentSeed]);
}
