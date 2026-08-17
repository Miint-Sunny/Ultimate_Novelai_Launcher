import { findCachedEncoding, getVibes, saveVibeEncoding, type VibeData } from '../../services/localLibrary';
import {
  encodeVibeImage,
  processCRImage,
  processImg2ImgImage,
  type Img2ImgParams,
  type PreciseReferenceItem,
  type VibeReference,
} from '../../services/novelai';
import type { ActivePreciseRef } from '../cr';
import { MODEL_MAP } from './modelResolutionOptions';
import type { ActiveVibe } from '../vibe';

export async function preparePreciseReferences(activePreciseRefs: ActivePreciseRef[]) {
  const enabledPreciseRefs = activePreciseRefs.filter(reference => reference.enabled);
  console.log('[生成] Precise Reference 数量:', activePreciseRefs.length, '启用:', enabledPreciseRefs.length);
  if (enabledPreciseRefs.length === 0) return undefined;

  const preciseReferences: PreciseReferenceItem[] = [];
  for (const reference of enabledPreciseRefs) {
    try {
      console.log('[生成] 处理 Precise Reference:', reference.name, 'mode:', reference.mode, 'ie:', reference.informationExtracted, 'str:', reference.strength);
      const processedBase64 = await processCRImage(reference.preview);
      console.log('[生成] Precise Reference 图片处理完成, base64 长度:', processedBase64.length);
      preciseReferences.push({
        imageBase64: processedBase64,
        mode: reference.mode,
        informationExtracted: reference.informationExtracted,
        strength: reference.strength,
      });
    } catch (error) {
      console.error('Failed to process Precise Reference image:', error);
    }
  }

  return preciseReferences.length > 0 ? preciseReferences : undefined;
}

export async function prepareVibeReferences({
  activeVibes,
  selectedModelId,
  vibeEncodingCache,
  fetchPublicVibeEncoding,
  refreshActiveVibeEncodings,
  savePendingVibes,
}: {
  activeVibes: ActiveVibe[];
  selectedModelId: string;
  vibeEncodingCache: Map<string, string>;
  fetchPublicVibeEncoding?: (fileName: string, model: string, informationExtracted: number) => Promise<string | null>;
  refreshActiveVibeEncodings?: (vibeId: string, encodings: VibeData['encodings']) => void;
  savePendingVibes?: boolean;
}) {
  const enabledVibes = activeVibes.filter(vibe => vibe.enabled);
  if (enabledVibes.length === 0) return undefined;

  const modelForVibe = MODEL_MAP[selectedModelId] || 'nai-diffusion-4-5-full';
  const vibeReferences: VibeReference[] = [];

  for (const vibe of enabledVibes) {
    try {
      const encodedVibe = await resolveEncodedVibe({
        vibe,
        modelForVibe,
        vibeEncodingCache,
        fetchPublicVibeEncoding,
        refreshActiveVibeEncodings,
      });

      if (encodedVibe) {
        vibeReferences.push({
          encodedVibe,
          originalImage: vibe.image,
          strength: vibe.referenceStrength,
          informationExtracted: vibe.informationExtracted,
        });
      }
    } catch (error) {
      console.error('Failed to encode vibe:', error);
    }
  }

  if (vibeReferences.length === 0) return undefined;

  if (savePendingVibes) {
    const pendingVibeInfo = activeVibes.map(vibe => ({
      id: vibe.id,
      strength: vibe.referenceStrength,
      informationExtracted: vibe.informationExtracted,
    }));
    sessionStorage.setItem('novelai_pending_vibes', JSON.stringify(pendingVibeInfo));
    console.log('[生成] 保存待关联的 vibe:', pendingVibeInfo);
  }

  return vibeReferences;
}

export async function prepareImg2ImgParams({
  img2imgImage,
  width,
  height,
  strength,
  noise,
}: {
  img2imgImage: string | null;
  width: number;
  height: number;
  strength: number;
  noise: number;
}): Promise<Img2ImgParams | undefined> {
  if (!img2imgImage) return undefined;
  try {
    const processedBase64 = await processImg2ImgImage(img2imgImage, width, height);
    return {
      imageBase64: processedBase64,
      strength,
      noise,
    };
  } catch (error) {
    console.error('Failed to process img2img image:', error);
    return undefined;
  }
}

async function resolveEncodedVibe({
  vibe,
  modelForVibe,
  vibeEncodingCache,
  fetchPublicVibeEncoding,
  refreshActiveVibeEncodings,
}: {
  vibe: ActiveVibe;
  modelForVibe: string;
  vibeEncodingCache: Map<string, string>;
  fetchPublicVibeEncoding?: (fileName: string, model: string, informationExtracted: number) => Promise<string | null>;
  refreshActiveVibeEncodings?: (vibeId: string, encodings: VibeData['encodings']) => void;
}) {
  let encodedVibe = findPreencodedVibe(vibe, modelForVibe);
  if (encodedVibe) {
    console.log(`使用预编码缓存: ${vibe.name} (model=${modelForVibe}, ie=${vibe.informationExtracted})`);
    return encodedVibe;
  }

  const cacheKey = getVibeEncodingCacheKey(vibe.id, vibe.informationExtracted, modelForVibe);
  encodedVibe = vibeEncodingCache.get(cacheKey) || null;
  if (encodedVibe) return encodedVibe;

  if (fetchPublicVibeEncoding && vibe.isPublic && vibe.fileName) {
    try {
      encodedVibe = await fetchPublicVibeEncoding(vibe.fileName, modelForVibe, vibe.informationExtracted);
      if (encodedVibe) {
        console.log(`使用远端公共编码缓存: ${vibe.name} (model=${modelForVibe}, ie=${vibe.informationExtracted})`);
        vibeEncodingCache.set(cacheKey, encodedVibe);
        return encodedVibe;
      }
    } catch (error) {
      console.warn('查询远端编码缓存失败:', error);
    }
  }

  const imageBase64 = await getVibeImageBase64(vibe);
  if (!imageBase64) return null;

  console.log(`调用 API 编码: ${vibe.name} (model=${modelForVibe}, ie=${vibe.informationExtracted})`);
  const encoded = await encodeVibeImage(imageBase64, vibe.informationExtracted, modelForVibe);
  if (!encoded) return null;

  vibeEncodingCache.set(cacheKey, encoded);
  try {
    await saveVibeEncoding(vibe.id, modelForVibe, vibe.informationExtracted, encoded);
    if (refreshActiveVibeEncodings) {
      const updatedVibes = await getVibes();
      const updatedVibe = updatedVibes.find(candidate => candidate.id === vibe.id);
      if (updatedVibe) refreshActiveVibeEncodings(vibe.id, updatedVibe.encodings);
    }
  } catch (error) {
    console.warn('保存编码缓存失败:', error);
  }

  return encoded;
}

function findPreencodedVibe(vibe: ActiveVibe, modelForVibe: string) {
  if (!vibe.encodings) return null;
  const vibeDataForCache: VibeData = {
    id: vibe.id,
    name: vibe.name,
    size: '',
    preview: vibe.preview || '',
    image: vibe.image,
    encodings: vibe.encodings,
    createdAt: 0,
  };
  return findCachedEncoding(vibeDataForCache, modelForVibe, vibe.informationExtracted);
}

async function getVibeImageBase64(vibe: ActiveVibe) {
  if (vibe.image) return vibe.image;
  if (!vibe.preview) return null;
  if (vibe.preview.startsWith('data:')) return vibe.preview.split(',')[1];

  const response = await fetch(vibe.preview);
  const blob = await response.blob();
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function getVibeEncodingCacheKey(vibeId: string, informationExtracted: number, modelForVibe: string) {
  return `vibe_${vibeId}_${informationExtracted}_${modelForVibe}`;
}
