import type { VibeData } from '../../services/localLibrary';
import type { PublicVibeData } from '../../services/publicLibrary';
import type { VibeFile } from './types';

export function mapLocalVibeToFile(vibe: VibeData): VibeFile {
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
    createdAt: vibe.createdAt,
    tags: vibe.tags,
    cloudSync: vibe.cloudSync,
    cloudFilename: vibe.cloudFilename,
  };
}

export function mapPublicVibeToFile(
  vibe: PublicVibeData,
  resolvePreview: (thumbnail?: string) => string,
): VibeFile {
  return {
    id: vibe.id || vibe.filename || `vibe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: vibe.name,
    size: '',
    preview: resolvePreview(vibe.thumbnail),
    supportedModels: vibe.supportedModels,
    defaultStrength: vibe.defaultStrength,
    defaultInfoExtracted: vibe.defaultInfoExtracted,
    fileName: vibe.filename,
    hasImage: vibe.hasImage,
    uploaderId: vibe.uploaderId,
  };
}

export function filterVibesBySearchAndModel(
  files: VibeFile[],
  query: string,
  modelFilter: string,
): VibeFile[] {
  let filtered = files;
  if (query.trim()) {
    const normalizedQuery = query.trim().toLowerCase();
    filtered = filtered.filter(file => file.name.toLowerCase().includes(normalizedQuery));
  }
  if (modelFilter !== 'all') {
    filtered = filtered.filter(file => file.supportedModels?.includes(modelFilter));
  }
  return filtered;
}

export function filterVibesByTags(files: VibeFile[], selectedTags: Set<string>): VibeFile[] {
  if (selectedTags.size === 0) return files;
  return files.filter(file => (file.tags || []).some(tag => selectedTags.has(tag)));
}

export function sortVibesByCreatedAtDesc(files: VibeFile[]): VibeFile[] {
  return [...files].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
