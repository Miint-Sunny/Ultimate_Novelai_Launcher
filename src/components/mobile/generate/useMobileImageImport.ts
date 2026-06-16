import { useEffect, useState } from 'react';
import {
  extractImageMetadata,
  type ImageMetadata,
} from '../../../utils/imageMetadata';
import {
  analyzeImageWithWDTagger,
  extractBase64FromDataUrl,
  type WDTaggerResult,
} from '../../../services/wdTagger';

export interface MobileImageImportOptions {
  prompt: boolean;
  negativePrompt: boolean;
  characters: boolean;
  settings: boolean;
  seed: boolean;
  vibes: boolean;
  cleanImports: boolean;
}

const defaultImportOptions: MobileImageImportOptions = {
  prompt: true,
  negativePrompt: true,
  characters: true,
  settings: false,
  seed: false,
  vibes: true,
  cleanImports: true,
};

export function useMobileImageImport() {
  const [showImageImportModal, setShowImageImportModal] = useState(false);
  const [importImageDataUrl, setImportImageDataUrl] = useState<string | null>(null);
  const [importImageMetadata, setImportImageMetadata] = useState<ImageMetadata | null>(null);
  const [isParsingMetadata, setIsParsingMetadata] = useState(false);
  const [isAnalyzingTagger, setIsAnalyzingTagger] = useState(false);
  const [taggerResult, setTaggerResult] = useState<WDTaggerResult | null>(null);
  const [showTaggerResult, setShowTaggerResult] = useState(false);
  const [showFullMetadata, setShowFullMetadata] = useState(false);
  const [importOptions, setImportOptions] = useState<MobileImageImportOptions>(defaultImportOptions);
  const [includeCharacter, setIncludeCharacter] = useState(true);

  const openImageImport = (dataUrl: string, metadata?: ImageMetadata | null) => {
    setImportImageDataUrl(dataUrl);
    setImportImageMetadata(metadata || null);
    setIsParsingMetadata(false);
    setTaggerResult(null);
    setShowTaggerResult(false);
    setShowFullMetadata(false);
    setShowImageImportModal(true);
  };

  const openImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      openImageImport(dataUrl, null);

      if (!file.name.endsWith('.vibe')) {
        setIsParsingMetadata(true);
        extractImageMetadata(dataUrl)
          .then((metadata) => {
            setImportImageMetadata(metadata);
          })
          .catch((error) => {
            console.error('解析元数据失败:', error);
          })
          .finally(() => {
            setIsParsingMetadata(false);
          });
      }
    };
    reader.readAsDataURL(file);
  };

  const analyzeWithTagger = async () => {
    if (!importImageDataUrl || isAnalyzingTagger) return;
    setIsAnalyzingTagger(true);
    try {
      const base64 = extractBase64FromDataUrl(importImageDataUrl);
      const result = await analyzeImageWithWDTagger(base64);
      if (result) {
        setTaggerResult(result);
        setShowTaggerResult(true);
      } else {
        alert('反推失败，请稍后重试');
      }
    } catch (error) {
      console.error('WD Tagger 分析失败:', error);
      alert('反推失败，请稍后重试');
    } finally {
      setIsAnalyzingTagger(false);
    }
  };

  useEffect(() => {
    const handleOpenImageImport = (event: Event) => {
      const { dataUrl, metadata } = (event as CustomEvent).detail;
      openImageImport(dataUrl, metadata || null);
    };
    window.addEventListener('open-image-import', handleOpenImageImport);
    return () => window.removeEventListener('open-image-import', handleOpenImageImport);
  }, []);

  return {
    showImageImportModal,
    setShowImageImportModal,
    importImageDataUrl,
    importImageMetadata,
    isParsingMetadata,
    isAnalyzingTagger,
    taggerResult,
    showTaggerResult,
    setShowTaggerResult,
    showFullMetadata,
    setShowFullMetadata,
    importOptions,
    setImportOptions,
    includeCharacter,
    setIncludeCharacter,
    openImageFile,
    analyzeWithTagger,
  };
}
