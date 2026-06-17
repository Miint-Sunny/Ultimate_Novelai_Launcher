import { useCallback, useEffect, useRef, useState } from 'react';

export interface SavedMobileInpaint {
  imageBase64: string;
  maskBase64: string;
  strength: number;
  width: number;
  height: number;
}

export interface MobileCropInfo {
  cropRect: { x: number; y: number; width: number; height: number };
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
  isExpand?: boolean;
}

interface UseMobileImg2ImgOptions {
  setLocalWidth: (width: number) => void;
  setLocalHeight: (height: number) => void;
  setImage: (image: string, width: number, height: number) => void;
}

const MAX_TOTAL_PIXELS = 1024 * 3072;

export function useMobileImg2Img({
  setLocalWidth,
  setLocalHeight,
  setImage,
}: UseMobileImg2ImgOptions) {
  const [img2imgImage, setImg2imgImage] = useState<string | null>(null);
  const [img2imgStrength, setImg2imgStrength] = useState(0.7);
  const [img2imgNoise, setImg2imgNoise] = useState(0);
  const [isImg2ImgExpanded, setIsImg2ImgExpanded] = useState(true);
  const [hasInpaintParams, setHasInpaintParams] = useState(false);
  const [inpaintStrength, setInpaintStrength] = useState(0.7);

  const savedInpaintRef = useRef<SavedMobileInpaint | null>(null);
  const cropInfoRef = useRef<MobileCropInfo | null>(null);

  const clearInpaintParams = useCallback(() => {
    savedInpaintRef.current = null;
    setHasInpaintParams(false);
  }, []);

  const clearImg2Img = useCallback(() => {
    setImg2imgImage(null);
    clearInpaintParams();
  }, [clearInpaintParams]);

  const setImg2imgWithAutoRes = useCallback((dataUrl: string) => {
    setImg2imgImage(dataUrl);
    clearInpaintParams();

    const img = new Image();
    img.onload = () => {
      let width = Math.round(img.naturalWidth / 64) * 64;
      let height = Math.round(img.naturalHeight / 64) * 64;
      width = Math.max(64, width);
      height = Math.max(64, height);

      const pixels = width * height;
      if (pixels > MAX_TOTAL_PIXELS) {
        const scale = Math.sqrt(MAX_TOTAL_PIXELS / pixels);
        width = Math.max(64, Math.floor((width * scale) / 64) * 64);
        height = Math.max(64, Math.floor((height * scale) / 64) * 64);
      }

      setLocalWidth(width);
      setLocalHeight(height);
      setImage(dataUrl, width, height);
    };
    img.src = dataUrl;
  }, [clearInpaintParams, setImage, setLocalHeight, setLocalWidth]);

  const updateInpaintStrength = useCallback((strength: number) => {
    setInpaintStrength(strength);
    if (savedInpaintRef.current) {
      savedInpaintRef.current.strength = strength;
    }
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const { strength } = (event as CustomEvent).detail;
      updateInpaintStrength(strength);
    };
    window.addEventListener('inpaint-panel-strength-change', handler);
    return () => window.removeEventListener('inpaint-panel-strength-change', handler);
  }, [updateInpaintStrength]);

  return {
    img2imgImage,
    img2imgStrength,
    setImg2imgStrength,
    img2imgNoise,
    setImg2imgNoise,
    isImg2ImgExpanded,
    setIsImg2ImgExpanded,
    savedInpaintRef,
    cropInfoRef,
    hasInpaintParams,
    setHasInpaintParams,
    inpaintStrength,
    updateInpaintStrength,
    clearInpaintParams,
    clearImg2Img,
    setImg2imgWithAutoRes,
  };
}
