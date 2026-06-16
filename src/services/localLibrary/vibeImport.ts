import { computeNaiVibeId } from './vibeHash';
import { saveVibe } from './vibeRepository';
import { generateThumbnail, generateThumbnailFromBase64 } from './vibeThumbnails';
import type { Naiv4VibeFile, VibeData, VibeEncodings } from './vibeTypes';

export const createVibeFromImage = async (file: File): Promise<VibeData> => {
  const size = (file.size / 1024 / 1024).toFixed(2) + ' MB';
  const arrayBuffer = await file.arrayBuffer();
  const imageBase64 = btoa(
    new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
  );
  const id = await computeNaiVibeId(imageBase64);
  const thumbnail = await generateThumbnail(file);

  return saveVibe({
    id,
    name: file.name.replace(/\.[^/.]+$/, ''),
    size,
    preview: thumbnail,
    image: imageBase64,
    encodings: {},
    createdAt: Date.now(),
  });
};

export const createVibeFromImageBase64 = async (
  imageBase64: string,
  strength: number,
  informationExtracted: number,
  name?: string
): Promise<VibeData> => {
  const id = await computeNaiVibeId(imageBase64);
  const thumbnail = await generateThumbnailFromBase64(imageBase64);
  const sizeBytes = Math.ceil((imageBase64.length * 3) / 4);
  const size = (sizeBytes / 1024 / 1024).toFixed(2) + ' MB';

  return saveVibe({
    id,
    name: name || `导入的 Vibe ${new Date().toLocaleTimeString()}`,
    size,
    preview: thumbnail,
    image: imageBase64,
    encodings: {},
    createdAt: Date.now(),
    defaultStrength: strength,
    defaultInfoExtracted: informationExtracted,
  });
};

export const importVibeFromFile = async (file: File): Promise<VibeData> => {
  const content = await file.text();
  const naiv4vibe: Naiv4VibeFile = JSON.parse(content);

  if (naiv4vibe.identifier !== 'novelai-vibe-transfer') {
    throw new Error('无效的 vibe 文件格式');
  }

  const supportedModels = naiv4vibe.encodings ? Object.keys(naiv4vibe.encodings) : [];
  let preview = naiv4vibe.thumbnail || '';
  if (!preview && naiv4vibe.image) {
    preview = `data:image/png;base64,${naiv4vibe.image.substring(0, 1000)}`;
  }

  return saveVibe({
    id: naiv4vibe.id || Date.now().toString(),
    name: naiv4vibe.name || file.name.replace('.naiv4vibe', ''),
    size: (content.length / 1024 / 1024).toFixed(2) + ' MB',
    preview,
    image: naiv4vibe.image || '',
    encodings: naiv4vibe.encodings || {},
    createdAt: naiv4vibe.createdAt || Date.now(),
    defaultStrength: naiv4vibe.importInfo?.strength,
    defaultInfoExtracted: naiv4vibe.importInfo?.information_extracted,
    supportedModels,
    tags: naiv4vibe.tags || [],
  });
};

interface Naiv4VibeBundleFile {
  identifier: 'novelai-vibe-transfer-bundle';
  version: number;
  vibes: Array<{
    identifier: 'novelai-vibe-transfer';
    version: number;
    type?: string;
    image?: string;
    thumbnail?: string;
    id?: string;
    name?: string;
    encodings?: VibeEncodings;
    createdAt?: number;
    importInfo?: {
      model?: string;
      information_extracted?: number;
      strength?: number;
    };
    tags?: string[];
  }>;
}

export const importVibeBundleFromFile = async (file: File): Promise<VibeData[]> => {
  const content = await file.text();
  const bundle: Naiv4VibeBundleFile = JSON.parse(content);

  if (bundle.identifier !== 'novelai-vibe-transfer-bundle') {
    throw new Error('无效的 vibe bundle 文件格式');
  }

  const results: VibeData[] = [];
  const baseName = file.name.replace('.naiv4vibebundle', '');

  for (let i = 0; i < bundle.vibes.length; i++) {
    const vibe = bundle.vibes[i];
    if (vibe.identifier !== 'novelai-vibe-transfer') {
      console.warn(`跳过无效的 vibe 条目 ${i}`);
      continue;
    }

    const supportedModels = vibe.encodings ? Object.keys(vibe.encodings) : [];
    let preview = vibe.thumbnail || '';
    if (!preview && vibe.image) {
      preview = `data:image/png;base64,${vibe.image.substring(0, 1000)}`;
    }

    const saved = await saveVibe({
      id: vibe.id || `${Date.now()}_${i}`,
      name: vibe.name || `${baseName}_${i + 1}`,
      size: '',
      preview,
      image: vibe.image || '',
      encodings: vibe.encodings || {},
      createdAt: vibe.createdAt || Date.now(),
      defaultStrength: vibe.importInfo?.strength,
      defaultInfoExtracted: vibe.importInfo?.information_extracted,
      supportedModels,
      tags: vibe.tags || [],
    });
    results.push(saved);
  }

  return results;
};
