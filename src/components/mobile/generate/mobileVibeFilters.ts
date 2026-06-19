import { MODEL_MAP, MODEL_TO_ENCODING_KEY } from '../../generation/modelResolutionOptions';
import type { VibeFile } from '../types';

export function resolveMobileVibeModelApi(model: string): string {
  return MODEL_MAP[model] || 'nai-diffusion-4-5-full';
}

export function isMobileVibeCompatibleWithModel(
  vibe: VibeFile & { hasImage?: boolean },
  currentModelApi: string,
): boolean {
  if (vibe.image || vibe.hasImage) return true;
  if (!vibe.supportedModels || vibe.supportedModels.length === 0) return true;
  const currentEncodingKey = MODEL_TO_ENCODING_KEY[currentModelApi];
  if (!currentEncodingKey) return true;
  return vibe.supportedModels.some((supportedModel) =>
    supportedModel === currentEncodingKey ||
    (currentModelApi === 'nai-diffusion-4-5-full' && supportedModel === 'v4full') ||
    (currentModelApi === 'nai-diffusion-4-5-curated' && supportedModel === 'v4curated')
  );
}

export function filterMobilePublicVibes(
  files: VibeFile[],
  searchQuery: string,
  modelFilter: string,
): VibeFile[] {
  let filtered = files;
  const query = searchQuery.trim().toLowerCase();
  if (query) {
    filtered = filtered.filter((file) => file.name.toLowerCase().includes(query));
  }
  if (modelFilter !== 'all') {
    filtered = filtered.filter((file) => file.supportedModels?.includes(modelFilter));
  }
  return filtered;
}

export function filterMobileLocalVibes(
  files: VibeFile[],
  searchQuery: string,
  selectedTagFilter: Set<string>,
): VibeFile[] {
  let filtered = files;
  const query = searchQuery.trim().toLowerCase();
  if (query) {
    filtered = filtered.filter((file) => file.name.toLowerCase().includes(query));
  }
  if (selectedTagFilter.size > 0) {
    filtered = filtered.filter((file) => {
      const tags = (file as VibeFile & { tags?: string[] }).tags || [];
      return tags.some((tag) => selectedTagFilter.has(tag));
    });
  }
  return filtered;
}

export function countMobileVibeTags(files: VibeFile[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const tags = (file as VibeFile & { tags?: string[] }).tags || [];
    for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return counts;
}
