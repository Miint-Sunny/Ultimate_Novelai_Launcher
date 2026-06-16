import { computeNaiVibeId } from './vibeHash';
import { getVibes } from './vibeRepository';
import { generateThumbnailFromBase64 } from './vibeThumbnails';
import {
  ENCODING_KEY_TO_MODEL,
  MODEL_TO_ENCODING_KEY,
  getEncodingKeysForModel,
  type Naiv4VibeFile,
  type VibeData,
  type VibeEncodingEntry,
  type VibeEncodings,
} from './vibeTypes';

export const exportVibesToBundle = async (vibeIds: string[]): Promise<Blob> => {
  const allVibes = await getVibes();
  const vibes = vibeIds.map(id => allVibes.find(v => v.id === id)).filter(Boolean) as VibeData[];

  const bundleVibes = vibes.map(vibe => {
    let thumbnail = vibe.preview || '';
    if (thumbnail.startsWith('http://') || thumbnail.startsWith('https://')) {
      thumbnail = '';
    }

    const supportedModels = vibe.encodings ? Object.keys(vibe.encodings) : [];
    const defaultModel = supportedModels.length > 0
      ? (ENCODING_KEY_TO_MODEL[supportedModels[0]] || supportedModels[0])
      : 'nai-diffusion-4-full';

    return {
      identifier: 'novelai-vibe-transfer' as const,
      version: 1,
      type: vibe.image ? 'image' : 'encoding',
      image: vibe.image || undefined,
      id: vibe.id,
      encodings: vibe.encodings || {},
      name: vibe.name,
      thumbnail: thumbnail || undefined,
      createdAt: vibe.createdAt,
      importInfo: {
        model: defaultModel,
        information_extracted: vibe.defaultInfoExtracted ?? 1,
        strength: vibe.defaultStrength ?? 1,
      },
      tags: vibe.tags || [],
    };
  });

  return new Blob([JSON.stringify({
    identifier: 'novelai-vibe-transfer-bundle',
    version: 1,
    vibes: bundleVibes,
  })], { type: 'application/json' });
};

export const exportVibeToFile = async (
  vibeData: VibeData,
  currentStrength?: number,
  currentInfoExtracted?: number,
  currentModel?: string,
  preserveAllEncodings?: boolean
): Promise<Blob> => {
  const supportedModels = vibeData.encodings ? Object.keys(vibeData.encodings) : [];

  let defaultModel = currentModel || null;
  if (!defaultModel && supportedModels.length > 0) {
    defaultModel = ENCODING_KEY_TO_MODEL[supportedModels[0]] || supportedModels[0];
  }
  if (!defaultModel) defaultModel = 'nai-diffusion-4-full';

  let defaultInfoExtracted = currentInfoExtracted ?? vibeData.defaultInfoExtracted ?? 1;

  let imageBase64 = vibeData.image || '';
  if (!imageBase64 && vibeData.preview && vibeData.preview.startsWith('data:')) {
    imageBase64 = vibeData.preview.split(',')[1] || '';
  }

  let imageHash = vibeData.id;
  if (imageBase64) imageHash = await computeNaiVibeId(imageBase64);

  let encodings: VibeEncodings = {};

  if (preserveAllEncodings && vibeData.encodings) {
    encodings = vibeData.encodings;
    if (typeof currentInfoExtracted !== 'number' && supportedModels.length > 0) {
      const firstModelEncodings = vibeData.encodings[supportedModels[0]];
      if (firstModelEncodings) {
        const first = Object.values(firstModelEncodings)[0];
        if (first?.params) defaultInfoExtracted = first.params.information_extracted;
      }
    }
  } else if (vibeData.encodings && currentModel) {
    const keysToTry = getEncodingKeysForModel(currentModel);
    const modelKey = MODEL_TO_ENCODING_KEY[currentModel] || currentModel;
    const modelEncodings =
      keysToTry.map(k => vibeData.encodings?.[k]).find(Boolean) || null;

    if (modelEncodings) {
      const normalizedModelEncodings: Record<string, VibeEncodingEntry> = {};
      const entries = Object.entries(modelEncodings);

      let targetEntries = entries;
      if (typeof currentInfoExtracted === 'number') {
        const matched = entries.filter(
          ([, e]) => e.params && Math.abs(e.params.information_extracted - currentInfoExtracted) < 0.001
        );
        if (matched.length > 0) targetEntries = matched;
      }

      for (const [originalHash, entry] of targetEntries) {
        normalizedModelEncodings[originalHash] = entry;
      }

      if (Object.keys(normalizedModelEncodings).length > 0) {
        encodings = { [modelKey]: normalizedModelEncodings };
        if (typeof currentInfoExtracted !== 'number') {
          const first = Object.values(normalizedModelEncodings)[0];
          if (first?.params) defaultInfoExtracted = first.params.information_extracted;
        }
      }
    }
  } else if (vibeData.encodings && supportedModels.length > 0) {
    const modelKey = supportedModels[0];
    const modelEncodings = vibeData.encodings[modelKey];
    if (modelEncodings) {
      const normalizedModelEncodings: Record<string, VibeEncodingEntry> = {};
      for (const [originalHash, entry] of Object.entries(modelEncodings)) {
        normalizedModelEncodings[originalHash] = entry;
      }
      if (Object.keys(normalizedModelEncodings).length > 0) {
        encodings = { [modelKey]: normalizedModelEncodings };
        const first = Object.values(normalizedModelEncodings)[0];
        if (first?.params) defaultInfoExtracted = first.params.information_extracted;
      }
    }
  }

  let thumbnail = vibeData.preview;
  if (thumbnail && (thumbnail.startsWith('http://') || thumbnail.startsWith('https://'))) {
    thumbnail = imageBase64 ? await generateThumbnailFromBase64(imageBase64) : '';
  }

  const naiv4vibe: Naiv4VibeFile = {
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    image: imageBase64,
    id: imageHash,
    encodings,
    name: vibeData.name,
    thumbnail,
    createdAt: vibeData.createdAt,
    importInfo: {
      model: defaultModel,
      information_extracted: defaultInfoExtracted,
      strength: currentStrength ?? vibeData.defaultStrength ?? 1,
    },
    tags: vibeData.tags || [],
  };

  return new Blob([JSON.stringify(naiv4vibe, null, 2)], { type: 'application/json' });
};
