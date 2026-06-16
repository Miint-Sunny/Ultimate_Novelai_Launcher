import { type VibeData } from '../../services/localLibrary';
import { type FileSystemDirectoryHandle } from '../../utils/fileSystem';
import {
  MODEL_MAP,
  MODEL_TO_ENCODING_KEY,
} from '../generation/modelResolutionOptions';

export { MODEL_MAP, MODEL_TO_ENCODING_KEY };

export interface VibeFile {
  id: string;
  name: string;
  size: string;
  preview?: string;
  image?: string;           // 原始图片 base64（用于编码）
  encodings?: VibeData['encodings'];  // 预编码缓存
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  supportedModels?: string[];
  fileName?: string;        // 原始文件名（用于链接文件夹模式下的删除）
  hasImage?: boolean;       // 后端告知是否存在图片数据
  createdAt?: number;       // 创建/添加时间

  // 标签 + 云同步状态（仅本地 vibe 用）
  tags?: string[];
  cloudSync?: 'none' | 'synced' | 'pending' | 'error';
  cloudFilename?: string;

  // 公共 vibe 字段
  uploaderId?: string | null;  // 仅公共 vibe，标识上传者 bot_user_id
}

export interface ActiveVibe {
  id: string;
  name: string;
  preview?: string;
  image?: string;           // 原始图片 base64
  encodings?: VibeData['encodings'];  // 预编码缓存
  referenceStrength: number;
  informationExtracted: number;
  supportedModels?: string[];
  enabled: boolean;         // 是否启用
  fileName?: string;        // 公共 vibe 文件名（用于查询远端编码缓存）
  isPublic?: boolean;       // 是否来自公共 vibe 库
}

export interface LinkedFolder {
  handle: FileSystemDirectoryHandle;
  name: string;
}

// 检查 vibe 是否与指定模型兼容
export const isVibeCompatibleWithModelId = (
  vibe: { supportedModels?: string[]; image?: string; hasImage?: boolean },
  modelId: string
): boolean => {
  // 如果有原图数据，则可以在生成时重新为任何模型生成编码，因此始终兼容
  if (vibe.image || vibe.hasImage) {
    return true;
  }

  // 如果没有 supportedModels 信息，认为兼容（可能是新上传的图片）
  if (!vibe.supportedModels || vibe.supportedModels.length === 0) {
    return true;
  }

  const modelApi = MODEL_MAP[modelId] || 'nai-diffusion-4-5-full';
  const encodingKey = MODEL_TO_ENCODING_KEY[modelApi];

  // 检查是否直接支持当前模型
  if (vibe.supportedModels.includes(encodingKey)) {
    return true;
  }

  // v4.5 模型可以使用 v4 的编码
  if (modelApi === 'nai-diffusion-4-5-full' && vibe.supportedModels.includes('v4full')) {
    return true;
  }
  if (modelApi === 'nai-diffusion-4-5-curated' && vibe.supportedModels.includes('v4curated')) {
    return true;
  }

  return false;
};

// 格式化模型标签显示文本
export const formatModelLabel = (model: string): string => {
  return model
    .replace('v4-5', 'V4.5')
    .replace('v4', 'V4')
    .replace('full', ' Full')
    .replace('curated', ' Curated')
    .replace('v3', 'V3');
};
