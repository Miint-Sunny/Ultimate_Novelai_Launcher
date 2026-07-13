import {
  createVibeFromImage,
  exportVibesToBundle,
  exportVibeToFile,
  getVibes,
  importVibeBundleFromFile,
  importVibeFromFile,
  saveVibe,
  setVibeTags as setVibeTagsStorage,
  type VibeData,
} from '../../../services/localLibrary';
import { getPublicVibeFile, getPublicVibes } from '../../../services/publicLibrary';
import type { ActiveVibe, VibeFile } from '../types';

export const toMobileVibeFile = (vibe: VibeData): VibeFile => ({
  id: vibe.id,
  name: vibe.name,
  preview: vibe.preview,
  image: vibe.image,
  encodings: vibe.encodings,
  defaultStrength: vibe.defaultStrength,
  defaultInfoExtracted: vibe.defaultInfoExtracted,
  supportedModels: vibe.supportedModels,
  tags: vibe.tags,
  cloudFilename: vibe.cloudFilename,
} as VibeFile);

export async function loadMobileVibeLists() {
  const localVibes = await getVibes();
  const publicVibes = await getPublicVibes(true);
  return {
    local: localVibes.map(toMobileVibeFile),
    public: publicVibes.map((vibe): VibeFile => ({
      id: vibe.id || vibe.filename || `vibe-${Date.now()}`,
      name: vibe.name,
      preview: vibe.thumbnail || '',
      supportedModels: vibe.supportedModels,
      defaultStrength: vibe.defaultStrength,
      defaultInfoExtracted: vibe.defaultInfoExtracted,
      fileName: vibe.filename,
    })),
  };
}

export async function collectPublicVibeFile(vibe: VibeFile) {
  if (!vibe.fileName) throw new Error('该公共 Vibe 缺少文件信息');
  const fullData = await getPublicVibeFile(vibe.fileName);
  if (!fullData) throw new Error('获取公共 Vibe 失败');

  const importInfo = typeof fullData.importInfo === 'object' && fullData.importInfo
    ? fullData.importInfo as Record<string, unknown>
    : null;

  const saved = await saveVibe({
    id: String(fullData.id || vibe.id),
    name: String(fullData.name || vibe.name),
    size: String(fullData.size || '0.00 MB'),
    preview: String(fullData.thumbnail || vibe.preview || ''),
    image: typeof fullData.image === 'string' ? fullData.image : '',
    encodings: (fullData.encodings as VibeData['encodings']) || {},
    createdAt: typeof fullData.createdAt === 'number' ? fullData.createdAt : Date.now(),
    defaultStrength: typeof fullData.defaultStrength === 'number'
      ? fullData.defaultStrength
      : (typeof importInfo?.strength === 'number' ? importInfo.strength : vibe.defaultStrength),
    defaultInfoExtracted: typeof fullData.defaultInfoExtracted === 'number'
      ? fullData.defaultInfoExtracted
      : (typeof importInfo?.information_extracted === 'number' ? importInfo.information_extracted : vibe.defaultInfoExtracted),
    supportedModels: Array.isArray(fullData.supportedModels)
      ? fullData.supportedModels as string[]
      : (fullData.encodings ? Object.keys(fullData.encodings as Record<string, unknown>) : vibe.supportedModels),
  });

  return toMobileVibeFile(saved);
}

export async function importMobileVibeFile(file: File) {
  const isImage = file.type.startsWith('image/');
  const isVibeBundle = file.name.endsWith('.naiv4vibebundle');
  const isVibeFile = file.name.endsWith('.naiv4vibe');

  if (isImage) return [toMobileVibeFile(await createVibeFromImage(file))];
  if (isVibeBundle) return (await importVibeBundleFromFile(file)).map(toMobileVibeFile);
  if (isVibeFile) return [toMobileVibeFile(await importVibeFromFile(file))];

  throw new Error('仅支持图片、.naiv4vibe 或 .naiv4vibebundle 文件');
}

export async function exportMobileActiveVibes(activeVibes: ActiveVibe[]) {
  const allVibes = await getVibes();
  const selected = allVibes.filter((vibe) => activeVibes.some((active) => active.id === vibe.id));
  if (selected.length === 0) return;

  const blob = selected.length === 1
    ? await exportVibeToFile(selected[0], selected[0].defaultStrength, selected[0].defaultInfoExtracted, undefined, true)
    : await exportVibesToBundle(selected.map((vibe) => vibe.id));
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = selected.length === 1 ? `${selected[0].name}.naiv4vibe` : `vibes_${selected.length}.naiv4vibebundle`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function applyTagsToMobileActiveVibes(activeVibes: ActiveVibe[], tagsToAdd: string[]) {
  const allVibes = await getVibes();
  for (const vibe of activeVibes) {
    const local = allVibes.find((item) => item.id === vibe.id);
    if (!local) continue;
    const merged = Array.from(new Set([...(local.tags || []), ...tagsToAdd]));
    await setVibeTagsStorage(vibe.id, merged);
  }
}
