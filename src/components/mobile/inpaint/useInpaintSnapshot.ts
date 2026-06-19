import { useCallback, useRef, useState } from 'react';
import type { InpaintSnapshot } from './MobileInpaintCompareOverlay';

interface CaptureInpaintSnapshotParams {
  canvas: HTMLCanvasElement | null;
  imageWidth: number;
  imageHeight: number;
  padLeft: number;
  padTop: number;
}

export function useInpaintSnapshot() {
  const [showOriginal, setShowOriginal] = useState(false);
  const snapshotRef = useRef<InpaintSnapshot | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);

  const captureSnapshot = useCallback(({
    canvas,
    imageWidth,
    imageHeight,
    padLeft,
    padTop,
  }: CaptureInpaintSnapshotParams) => {
    if (!canvas) return;

    snapshotRef.current = {
      url: canvas.toDataURL('image/png'),
      width: imageWidth,
      height: imageHeight,
      padLeft,
      padTop,
    };
    setHasSnapshot(true);
  }, []);

  return {
    showOriginal,
    setShowOriginal,
    snapshotRef,
    hasSnapshot,
    captureSnapshot,
  };
}
