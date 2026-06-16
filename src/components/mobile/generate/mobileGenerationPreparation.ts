import {
  findCachedEncoding,
  saveVibeEncoding,
  type PromptPresetData,
  type VibeData,
} from '../../../services/localLibrary';
import { fetchPublicVibeEncoding } from '../../../services/publicLibrary';
import {
  encodeVibeImage,
  processCRImage,
  processImg2ImgImage,
  type GenerateImageParams,
  type VibeReference,
} from '../../../services/novelai';
import {
  containsChinese,
  translateChineseInPrompt,
} from '../../../services/translate';
import { filterHiddenTags } from '../../../utils/promptTags';
import { MODEL_MAP } from '../../generation/modelResolutionOptions';
import { expandCollapsibleMarkers } from '../FullscreenEditor';
import type {
  ActivePreciseRef,
  ActiveVibe,
  CharacterPrompt,
} from '../types';

type PreparedCharacterPrompt = GenerateImageParams['characterPrompts'][number];
type PreparedPreciseReference = NonNullable<GenerateImageParams['preciseReferences']>[number];
type PreparedImg2Img = NonNullable<GenerateImageParams['img2img']>;

interface PreparePromptOptions {
  positivePrompt: string;
  negativePrompt: string;
  promptPresets: PromptPresetData[];
  activePresetId: string;
}

interface PrepareVibeReferencesOptions {
  activeVibes: ActiveVibe[];
  model: string;
  includePublicRemoteCache?: boolean;
}

interface PrepareImg2ImgOptions {
  img2imgImage: string | null;
  localWidth: number;
  localHeight: number;
  img2imgStrength: number;
  img2imgNoise: number;
}

export async function prepareMobilePrompts({
  positivePrompt,
  negativePrompt,
  promptPresets,
  activePresetId,
}: PreparePromptOptions) {
  let finalPrompt = expandCollapsibleMarkers(filterHiddenTags(positivePrompt));
  let finalNegative = filterHiddenTags(negativePrompt);

  const activePreset = promptPresets.find((preset) => preset.id === activePresetId);
  if (activePreset) {
    if (activePreset.positive) {
      finalPrompt = finalPrompt ? `${activePreset.positive}, ${finalPrompt}` : activePreset.positive;
    }
    if (activePreset.negative) {
      finalNegative = finalNegative ? `${activePreset.negative}, ${finalNegative}` : activePreset.negative;
    }
  }

  if (containsChinese(finalPrompt)) finalPrompt = await translateChineseInPrompt(finalPrompt);
  if (containsChinese(finalNegative)) finalNegative = await translateChineseInPrompt(finalNegative);

  return {
    finalPrompt,
    finalNegative,
  };
}

export function prepareMobileCharacterPrompts(
  characterPrompts: CharacterPrompt[]
): PreparedCharacterPrompt[] {
  return characterPrompts
    .filter((characterPrompt) => characterPrompt.enabled && characterPrompt.positive.trim())
    .map((characterPrompt) => ({
      positive: filterHiddenTags(characterPrompt.positive),
      negative: filterHiddenTags(characterPrompt.negative),
      enabled: characterPrompt.enabled,
      position: characterPrompt.position,
    }));
}

export async function prepareMobilePreciseReferences(
  activePreciseRefs: ActivePreciseRef[]
): Promise<PreparedPreciseReference[] | undefined> {
  const preciseReferences: PreparedPreciseReference[] = [];
  for (const preciseRef of activePreciseRefs.filter((ref) => ref.enabled)) {
    try {
      const processedBase64 = await processCRImage(preciseRef.preview);
      preciseReferences.push({
        imageBase64: processedBase64,
        mode: preciseRef.mode,
        informationExtracted: preciseRef.informationExtracted,
        strength: preciseRef.strength,
      });
    } catch (error) {
      console.error('Failed to process Precise Reference image:', error);
    }
  }
  return preciseReferences.length > 0 ? preciseReferences : undefined;
}

export async function prepareMobileVibeReferences({
  activeVibes,
  model,
  includePublicRemoteCache = false,
}: PrepareVibeReferencesOptions): Promise<VibeReference[] | undefined> {
  const vibeRefs: VibeReference[] = [];
  const currentModelApi = MODEL_MAP[model] || 'nai-diffusion-4-5-full';

  for (const vibe of activeVibes.filter((item) => item.enabled)) {
    let encoding: string | undefined;

    if (vibe.encodings) {
      const vibeDataForCache: VibeData = {
        id: vibe.id,
        name: vibe.name,
        size: '',
        preview: vibe.preview || '',
        image: vibe.image,
        encodings: vibe.encodings,
        createdAt: 0,
      };
      const cached = findCachedEncoding(vibeDataForCache, currentModelApi, vibe.informationExtracted);
      if (cached) encoding = cached;
    }

    if (!encoding && includePublicRemoteCache && vibe.isPublic && vibe.fileName) {
      try {
        const remoteEncoding = await fetchPublicVibeEncoding(
          vibe.fileName,
          currentModelApi,
          vibe.informationExtracted
        );
        if (remoteEncoding) {
          encoding = remoteEncoding;
          console.log(`使用远端公共编码缓存: ${vibe.name}`);
        }
      } catch (error) {
        console.warn('查询远端编码缓存失败:', error);
      }
    }

    if (!encoding && vibe.image) {
      try {
        const result = await encodeVibeImage(vibe.image, vibe.informationExtracted, currentModelApi);
        if (result) {
          encoding = result;
          try {
            await saveVibeEncoding(vibe.id, currentModelApi, vibe.informationExtracted, result);
          } catch (error) {
            console.warn('保存编码缓存失败:', error);
          }
        }
      } catch {
        continue;
      }
    }

    if (encoding) {
      vibeRefs.push({
        encodedVibe: encoding,
        originalImage: vibe.image,
        strength: vibe.referenceStrength,
        informationExtracted: vibe.informationExtracted,
      });
    }
  }

  return vibeRefs.length > 0 ? vibeRefs : undefined;
}

export async function prepareMobileImg2Img({
  img2imgImage,
  localWidth,
  localHeight,
  img2imgStrength,
  img2imgNoise,
}: PrepareImg2ImgOptions): Promise<PreparedImg2Img | undefined> {
  if (!img2imgImage) return undefined;
  try {
    const processedBase64 = await processImg2ImgImage(img2imgImage, localWidth, localHeight);
    return {
      imageBase64: processedBase64,
      strength: img2imgStrength,
      noise: img2imgNoise,
    };
  } catch (error) {
    console.error('Failed to process img2img image:', error);
    return undefined;
  }
}
