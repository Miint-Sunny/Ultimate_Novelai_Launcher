import { getVibes } from '../../services/localLibrary';
import { encodeVibeImage } from '../../services/novelai';
import type { FileSystemDirectoryHandle } from '../../utils/fileSystem';
import type { VibeFile } from '../vibe';
import type { ToastType } from './types';

type ShowToast = (message: string, type: ToastType) => void;

export async function loadCompleteVibeData({
  vibeFile,
  localDirectoryHandle,
  vibeUploadStrength,
  vibeUploadInfoExtracted,
  showToast,
}: {
  vibeFile: VibeFile;
  localDirectoryHandle: FileSystemDirectoryHandle | null;
  vibeUploadStrength: number;
  vibeUploadInfoExtracted: number;
  showToast: ShowToast;
}): Promise<Record<string, unknown> | null> {
  if (localDirectoryHandle) {
    const fileName = vibeFile.fileName || `${vibeFile.name}.naiv4vibe`;
    try {
      const fileHandle = await localDirectoryHandle.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const content = await file.text();
      const fullVibeData = JSON.parse(content) as Record<string, unknown>;
      fullVibeData.importInfo = {
        ...((fullVibeData.importInfo as Record<string, unknown> | undefined) || {}),
        strength: vibeUploadStrength,
        information_extracted: vibeUploadInfoExtracted,
      };
      return fullVibeData;
    } catch (err) {
      console.error('读取vibe文件失败:', err);
      showToast('读取vibe文件失败', 'error');
      return null;
    }
  }

  const vibes = await getVibes();
  const vibe = vibes.find(candidate => candidate.id === vibeFile.id);
  if (!vibe) {
    showToast('无法获取vibe数据', 'error');
    return null;
  }

  return {
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    id: vibe.id,
    name: vibe.name,
    image: vibe.image,
    thumbnail: vibe.preview,
    encodings: vibe.encodings,
    createdAt: vibe.createdAt,
    importInfo: {
      strength: vibeUploadStrength,
      information_extracted: vibeUploadInfoExtracted,
    },
  };
}

export async function ensurePublicUploadEncodings(
  fullVibeData: Record<string, unknown>,
  targetIE: number,
  showToast: ShowToast
) {
  const imageData = fullVibeData.image as string | undefined;
  if (!imageData) return;

  const { computeVibeEncodingHash } = await import('../../services/localLibrary');
  const modelsToEncode = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'];
  const modelKeyMap: Record<string, string> = {
    'nai-diffusion-4-5-full': 'v4-5full',
    'nai-diffusion-4-5-curated': 'v4-5curated',
  };
  const encodings = (fullVibeData.encodings || {}) as Record<string, Record<string, any>>;

  for (const model of modelsToEncode) {
    const modelKey = modelKeyMap[model];
    const modelEncodings = encodings[modelKey] || {};
    const hasEncoding = Object.values(modelEncodings).some(entry =>
      entry?.params && Math.abs(entry.params.information_extracted - targetIE) < 0.001
    );

    if (hasEncoding) {
      console.log(`[上传预编码] ${modelKey} IE=${targetIE} 已有编码，跳过`);
      continue;
    }

    console.log(`[上传预编码] 缺少 ${modelKey} IE=${targetIE} 的编码，正在编码...`);
    showToast(`正在为 ${modelKey} 预编码 (IE=${targetIE})...`, 'success');
    try {
      const encoded = await encodeVibeImage(imageData, targetIE, model);
      if (encoded) {
        const hashKey = await computeVibeEncodingHash(targetIE);
        if (!encodings[modelKey]) {
          encodings[modelKey] = {};
        }
        encodings[modelKey][hashKey] = {
          encoding: encoded,
          params: { information_extracted: targetIE },
        };
        console.log(`[上传预编码] ${modelKey} IE=${targetIE} 编码完成`);
      }
    } catch (err) {
      console.warn(`[上传预编码] ${modelKey} 编码失败:`, err);
    }
  }

  fullVibeData.encodings = encodings;
}
