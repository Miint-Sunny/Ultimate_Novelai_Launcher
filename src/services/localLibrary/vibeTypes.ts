export interface VibeEncodingParams {
  information_extracted: number;
}

export interface VibeEncodingEntry {
  encoding: string;
  params?: VibeEncodingParams;
}

export interface VibeEncodings {
  [modelKey: string]: {
    [encodingHash: string]: VibeEncodingEntry;
  };
}

export interface VibeImportInfo {
  model: string;
  information_extracted: number;
  strength: number;
}

export interface Naiv4VibeFile {
  identifier: 'novelai-vibe-transfer';
  version: number;
  type: 'image';
  image: string;
  id: string;
  encodings: VibeEncodings;
  name: string;
  thumbnail: string;
  createdAt: number;
  importInfo?: VibeImportInfo;
  tags?: string[];
}

export interface VibeData {
  id: string;
  name: string;
  size: string;
  preview: string;
  image?: string;
  encodings?: VibeEncodings;
  createdAt: number;
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  supportedModels?: string[];
  tags?: string[];
  cloudSync?: 'none' | 'synced' | 'pending' | 'error';
  cloudFilename?: string;
  cloudUpdatedAt?: number;
  cloudOwnerId?: string;
  imageHash?: string;
  metaHash?: string;
}

export const MODEL_TO_ENCODING_KEY: Record<string, string> = {
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-curated': 'v4curated',
  'nai-diffusion-4-curated-preview': 'v4curated',
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
  'nai-diffusion-3': 'v3',
};

export const ENCODING_KEY_TO_MODEL: Record<string, string> = {
  'v4full': 'nai-diffusion-4-full',
  'v4curated': 'nai-diffusion-4-curated',
  'v4-5full': 'nai-diffusion-4-5-full',
  'v4-5curated': 'nai-diffusion-4-5-curated',
  'v3': 'nai-diffusion-3',
};

export const getEncodingKeysForModel = (model: string): string[] => {
  const primary = MODEL_TO_ENCODING_KEY[model] || model;

  if (model === 'nai-diffusion-4-5-full') return [primary, 'v4full'];
  if (model === 'nai-diffusion-4-5-curated') return [primary, 'v4curated'];

  return [primary];
};
