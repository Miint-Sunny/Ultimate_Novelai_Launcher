import {
  MODEL_TO_ENCODING_KEY,
  getEncodingKeysForModel,
  type VibeData,
  type VibeEncodings,
} from './vibeTypes';
import {
  computeEncodingHash,
  computeVibeEncodingHash,
  computeVibeIdFromImage,
} from './vibeHash';
import { getVibes, saveVibe } from './vibeRepository';

export const createVibeFromEncoding = async (
  encoding: string,
  informationExtracted: number,
  strength: number,
  model: string,
  name?: string
): Promise<VibeData> => {
  const id = `vibe_enc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const encodingHash = await computeVibeEncodingHash(informationExtracted);
  const modelKey = MODEL_TO_ENCODING_KEY[model] || model;
  const encodings: VibeEncodings = {
    [modelKey]: {
      [encodingHash]: {
        encoding,
        params: { information_extracted: informationExtracted },
      },
    },
  };

  return saveVibe({
    id,
    name: name || `Vibe ${new Date().toLocaleTimeString()}`,
    size: '',
    preview: '',
    image: '',
    encodings,
    createdAt: Date.now(),
    defaultStrength: strength,
    defaultInfoExtracted: informationExtracted,
    supportedModels: [modelKey],
  });
};

export const findCachedEncoding = (
  vibeData: VibeData,
  model: string,
  informationExtracted: number
): string | null => {
  if (!vibeData.encodings) return null;

  const keysToTry = getEncodingKeysForModel(model);
  const modelEncodings =
    keysToTry.map((k) => vibeData.encodings?.[k]).find(Boolean) || null;
  if (!modelEncodings) return null;

  const entries = Object.entries(modelEncodings);
  for (const [hash, entry] of entries) {
    if (!entry) continue;
    if (entry.params) {
      if (Math.abs(entry.params.information_extracted - informationExtracted) < 0.001) {
        return entry.encoding;
      }
    } else if (entries.length === 1 || hash === 'unknown') {
      return entry.encoding;
    }
  }
  return null;
};

export const saveVibeEncoding = async (
  vibeId: string,
  model: string,
  informationExtracted: number,
  encoding: string
): Promise<void> => {
  const vibes = await getVibes();
  const vibe = vibes.find(v => v.id === vibeId);
  if (!vibe) return;

  const encodingKey = MODEL_TO_ENCODING_KEY[model] || model;

  if (!vibe.encodings) vibe.encodings = {};
  if (!vibe.encodings[encodingKey]) vibe.encodings[encodingKey] = {};

  const hash = await computeVibeEncodingHash(informationExtracted);
  vibe.encodings[encodingKey][hash] = {
    encoding,
    params: { information_extracted: informationExtracted },
  };

  await saveVibe(vibe);
};

export const findVibeByEncodingHash = async (encodingHash: string): Promise<VibeData | null> => {
  const vibes = await getVibes();

  for (const vibe of vibes) {
    if (!vibe.encodings) continue;
    for (const modelKey in vibe.encodings) {
      const modelEncodings = vibe.encodings[modelKey];
      if (modelEncodings[encodingHash]) return vibe;
    }
  }

  return null;
};

export const findVibeByEncoding = async (encodingBase64: string): Promise<{
  vibe: VibeData;
  informationExtracted: number;
} | null> => {
  const hash = await computeEncodingHash(encodingBase64);
  const vibes = await getVibes();

  for (const vibe of vibes) {
    if (!vibe.encodings) continue;
    for (const modelKey in vibe.encodings) {
      const modelEncodings = vibe.encodings[modelKey];
      const entry = modelEncodings[hash];
      if (entry) {
        return {
          vibe,
          informationExtracted: entry.params?.information_extracted ?? 1,
        };
      }
    }
  }

  return null;
};

export const findVibeByImage = async (imageBase64: string): Promise<VibeData | null> => {
  const vibeId = await computeVibeIdFromImage(imageBase64);
  const vibes = await getVibes();
  return vibes.find(vibe => vibe.id === vibeId) || null;
};

export const findVibesByParams = async (informationExtracted: number): Promise<VibeData[]> => {
  const vibes = await getVibes();
  const matches: VibeData[] = [];

  for (const vibe of vibes) {
    if (!vibe.encodings) continue;
    for (const modelKey in vibe.encodings) {
      const modelEncodings = vibe.encodings[modelKey];
      for (const hash in modelEncodings) {
        const entry = modelEncodings[hash];
        if (entry.params && Math.abs(entry.params.information_extracted - informationExtracted) < 0.001) {
          matches.push(vibe);
          break;
        }
      }
      if (matches.includes(vibe)) break;
    }
  }

  return matches;
};
