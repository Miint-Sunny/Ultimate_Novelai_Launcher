import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, Dispatch, MutableRefObject, SetStateAction } from 'react';
import { clampToMaxPixels, type ClampedSize, type ResolutionPreset } from '../generation/modelResolutionOptions';

type SavedInpaintRef = {
  imageBase64: string;
  maskBase64: string;
  strength: number;
  width: number;
  height: number;
};

interface UseImg2ImgImportParams {
  savedInpaintRef: MutableRefObject<SavedInpaintRef | null>;
  setHasInpaintParams: Dispatch<SetStateAction<boolean>>;
  resolutionSourceRef: MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  setResolution: Dispatch<SetStateAction<ResolutionPreset>>;
  setCustomWidth: Dispatch<SetStateAction<number>>;
  setCustomHeight: Dispatch<SetStateAction<number>>;
  setCustomWidthInput: Dispatch<SetStateAction<string>>;
  setCustomHeightInput: Dispatch<SetStateAction<string>>;
  setIsCustomRes: Dispatch<SetStateAction<boolean>>;
  setImage: (imageUrl: string, width: number, height: number, seed?: number) => void;
  setIsResSelectorOpen: Dispatch<SetStateAction<boolean>>;
  setResHighlight: Dispatch<SetStateAction<boolean>>;
}

export function useImg2ImgImport(params: UseImg2ImgImportParams) {
  const [img2imgImage, setImg2imgImage] = useState<string | null>(null);
  const [img2imgStrength, setImg2imgStrength] = useState(0.7);
  const [img2imgNoise, setImg2imgNoise] = useState(0);
  const [img2imgFlash, setImg2imgFlash] = useState(false);
  const img2imgInputRef = useRef<HTMLInputElement>(null);
  const img2imgSectionRef = useRef<HTMLDivElement>(null);

  const setImg2imgWithAutoRes = useCallback((dataUrl: string) => {
    setImg2imgImage(dataUrl);
    params.savedInpaintRef.current = null;
    params.setHasInpaintParams(false);

    const img = new Image();
    img.onload = () => {
      let width = Math.round(img.naturalWidth / 64) * 64;
      let height = Math.round(img.naturalHeight / 64) * 64;
      width = Math.max(64, width);
      height = Math.max(64, height);
      const clamped = clampToMaxPixels(width, height);

      params.resolutionSourceRef.current = `图生图导入原图 ${img.naturalWidth}×${img.naturalHeight}`;
      params.reportResolutionNormalization('图生图导入', clamped);
      params.setCustomWidth(clamped.width);
      params.setCustomHeight(clamped.height);
      params.setCustomWidthInput(String(clamped.width));
      params.setCustomHeightInput(String(clamped.height));
      params.setIsCustomRes(true);
      params.setResolution({ label: '自定义', width: clamped.width, height: clamped.height });
      params.setImage(dataUrl, clamped.width, clamped.height);
      params.setIsResSelectorOpen(true);
      params.setResHighlight(true);
      setTimeout(() => params.setResHighlight(false), 2000);
    };
    img.src = dataUrl;
  }, [params]);

  const handleImg2ImgUpload = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImg2imgWithAutoRes(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  }, [setImg2imgWithAutoRes]);

  const handleImg2ImgDropCallback = useCallback((dataUrl: string) => {
    setImg2imgWithAutoRes(dataUrl);
  }, [setImg2imgWithAutoRes]);

  const clearImg2Img = useCallback(() => {
    setImg2imgImage(null);
    params.savedInpaintRef.current = null;
    params.setHasInpaintParams(false);
  }, [params]);

  return {
    img2imgImage,
    setImg2imgImage,
    img2imgStrength,
    setImg2imgStrength,
    img2imgNoise,
    setImg2imgNoise,
    img2imgInputRef,
    img2imgSectionRef,
    img2imgFlash,
    setImg2imgFlash,
    setImg2imgWithAutoRes,
    handleImg2ImgUpload,
    handleImg2ImgDropCallback,
    clearImg2Img,
  };
}
