import {
  createVibeFromEncoding,
  createVibeFromImageBase64,
  findVibeByEncoding,
  findVibeByImage,
  getVibes,
  type VibeData,
} from '../../services/localLibrary';
import type { ActiveVibe, VibeFile } from '../vibe';

export interface MetadataVibeInput {
  image?: string;
  encoding?: string;
  strength: number;
  informationExtracted?: number;
  needsLocalMatch?: boolean;
}

export interface ImportMetadataVibesParams {
  vibes: MetadataVibeInput[];
  seed?: string | number;
  source?: string;
  fileName?: string;
}

export interface ImportMetadataVibesResult {
  activeVibes: ActiveVibe[];
  localFilesToPrepend: VibeFile[];
}

export async function importVibesFromMetadata({
  vibes,
  seed,
  source,
  fileName,
}: ImportMetadataVibesParams): Promise<ImportMetadataVibesResult> {
  console.log(`[Vibe导入] 检测到 ${vibes.length} 个 vibe 数据`);

  const activeVibes: ActiveVibe[] = [];
  const localFilesToPrepend: VibeFile[] = [];

  for (let index = 0; index < vibes.length; index++) {
    const vibe = vibes[index];
    console.log(`[Vibe导入] Vibe ${index + 1}:`, {
      hasImage: !!vibe.image,
      imageLength: vibe.image?.length,
      hasEncoding: !!vibe.encoding,
      encodingLength: vibe.encoding?.length,
      strength: vibe.strength,
      informationExtracted: vibe.informationExtracted,
    });

    if (vibe.image) {
      const imported = await importImageVibe(vibe, index, fileName);
      activeVibes.push(imported.activeVibe);
      if (imported.localFile) localFilesToPrepend.unshift(imported.localFile);
      continue;
    }

    if (vibe.encoding) {
      const imported = await importEncodingVibe(vibe, index, source, fileName);
      activeVibes.push(imported.activeVibe);
      if (imported.localFile) localFilesToPrepend.unshift(imported.localFile);
      continue;
    }

    if (vibe.needsLocalMatch) {
      const matched = await matchLocalVibe(vibe, index, seed);
      if (matched) activeVibes.push(matched);
    }
  }

  return { activeVibes, localFilesToPrepend };
}

async function importImageVibe(vibe: MetadataVibeInput, index: number, fileName?: string) {
  const image = vibe.image!;
  const found = await findVibeByImage(image);
  console.log(`[Vibe导入] 通过图片匹配结果:`, found ? found.name : '未找到');

  if (found) {
    console.log(`Vibe "${found.name}" 从本地存储匹配成功（通过图片 hash）`);
    return {
      activeVibe: toActiveVibe(found, vibe.strength, getDefaultInfoExtracted(found)),
      localFile: null,
    };
  }

  console.log(`[Vibe导入] Vibe ${index + 1} 未在本地找到，从图片数据创建新 vibe...`);
  const importedVibe = await createVibeFromImageBase64(
    image,
    vibe.strength,
    vibe.informationExtracted ?? 1,
    generateVibeName(index, fileName)
  );

  console.log(`[Vibe导入] Vibe ${index + 1} 已从图片数据创建并保存`);
  return {
    activeVibe: toActiveVibe(importedVibe, vibe.strength, vibe.informationExtracted ?? 1),
    localFile: toVibeFile(importedVibe),
  };
}

async function importEncodingVibe(vibe: MetadataVibeInput, index: number, source?: string, fileName?: string) {
  const encoding = vibe.encoding!;
  console.log(`[Vibe导入] 尝试通过编码匹配...`);
  const found = await findVibeByEncoding(encoding);
  console.log(`[Vibe导入] 通过编码匹配结果:`, found ? found.vibe.name : '未找到');

  if (found) {
    console.log(`Vibe "${found.vibe.name}" 从本地存储匹配成功（通过编码）`);
    return {
      activeVibe: toActiveVibe(found.vibe, vibe.strength, found.informationExtracted),
      localFile: null,
    };
  }

  const importedVibe = await createVibeFromEncoding(
    encoding,
    vibe.informationExtracted ?? 1,
    vibe.strength,
    inferApiModel(source),
    generateVibeName(index, fileName)
  );

  console.log(`Vibe ${index + 1} 未在本地找到，已创建新的 vibe 并保存`);
  return {
    activeVibe: toActiveVibe(importedVibe, vibe.strength, vibe.informationExtracted ?? 1),
    localFile: toVibeFile(importedVibe),
  };
}

async function matchLocalVibe(vibe: MetadataVibeInput, index: number, seed?: string | number) {
  const seedMatch = await matchBySeed(index, seed);
  if (seedMatch) return seedMatch;

  console.log(`[Vibe导入] seed 匹配失败，尝试通过 strength 匹配...`);
  const paramMatch = await matchByParams(vibe);
  if (paramMatch) return paramMatch;

  console.log(`[Vibe导入] Vibe ${index + 1} 未找到匹配，跳过`);
  return null;
}

async function matchBySeed(index: number, seed?: string | number) {
  if (!seed) return null;
  const historyStr = localStorage.getItem('novelai_vibe_history');
  if (!historyStr) return null;

  try {
    const history = JSON.parse(historyStr) as Record<string, {
      vibes: Array<{ id: string; strength: number; informationExtracted: number }>;
      timestamp: number;
    }>;
    const seedKey = String(seed);
    const historyVibe = history[seedKey]?.vibes[index];
    if (!historyVibe) return null;

    const allVibes = await getVibes();
    const found = allVibes.find(vibe => vibe.id === historyVibe.id);
    if (!found) return null;

    console.log(`[Vibe导入] Vibe "${found.name}" 通过 seed=${seedKey} 匹配成功`);
    return toActiveVibe(found, historyVibe.strength, historyVibe.informationExtracted);
  } catch (e) {
    console.warn('[Vibe导入] 解析 vibe 历史失败:', e);
    return null;
  }
}

async function matchByParams(vibe: MetadataVibeInput) {
  const allVibes = await getVibes();

  for (const localVibe of allVibes) {
    if (!localVibe.encodings) continue;

    for (const modelKey in localVibe.encodings) {
      const modelEncodings = localVibe.encodings[modelKey];
      for (const hash in modelEncodings) {
        const entry = modelEncodings[hash];
        if (entry.params && Math.abs(entry.params.information_extracted - (vibe.informationExtracted ?? 1)) < 0.01) {
          console.log(`[Vibe导入] Vibe "${localVibe.name}" 通过参数匹配成功（可能不准确）`);
          return toActiveVibe(localVibe, vibe.strength, entry.params.information_extracted);
        }
      }
    }
  }

  return null;
}

function toActiveVibe(vibe: VibeData, strength: number, informationExtracted: number): ActiveVibe {
  return {
    id: vibe.id,
    name: vibe.name,
    preview: vibe.preview,
    image: vibe.image,
    encodings: vibe.encodings,
    referenceStrength: strength,
    informationExtracted,
    supportedModels: vibe.supportedModels,
    enabled: true,
  };
}

function toVibeFile(vibe: VibeData): VibeFile {
  return {
    id: vibe.id,
    name: vibe.name,
    size: vibe.size,
    preview: vibe.preview,
    image: vibe.image,
    encodings: vibe.encodings,
    defaultStrength: vibe.defaultStrength,
    defaultInfoExtracted: vibe.defaultInfoExtracted,
    supportedModels: vibe.supportedModels,
  };
}

function getDefaultInfoExtracted(vibe: VibeData): number {
  if (!vibe.encodings) return vibe.defaultInfoExtracted ?? 1;
  const firstModelKey = Object.keys(vibe.encodings)[0];
  if (!firstModelKey) return vibe.defaultInfoExtracted ?? 1;
  const firstEncoding = Object.values(vibe.encodings[firstModelKey])[0];
  return firstEncoding?.params?.information_extracted ?? vibe.defaultInfoExtracted ?? 1;
}

function generateVibeName(vibeIndex: number, fileName?: string) {
  if (!fileName) return `导入的 Vibe ${vibeIndex + 1}`;
  const baseName = fileName.replace(/\.[^/.]+$/, '').slice(0, 8);
  return `${baseName}_v${vibeIndex + 1}`;
}

function inferApiModel(source?: string): string {
  if (!source) return 'nai-diffusion-4-5-full';
  const normalizedSource = source.toLowerCase();
  if (normalizedSource.includes('v4.5 curated')) return 'nai-diffusion-4-5-curated';
  if (normalizedSource.includes('v4.5')) return 'nai-diffusion-4-5-full';
  if (normalizedSource.includes('v4 curated')) return 'nai-diffusion-4-curated';
  if (normalizedSource.includes('v4')) return 'nai-diffusion-4-full';
  if (normalizedSource.includes('v3')) return 'nai-diffusion-3';
  return 'nai-diffusion-4-5-full';
}
