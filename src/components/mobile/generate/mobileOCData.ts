import { getOCPreviewUrl, type PublicOCData } from '../../../services/publicLibrary';
import type { CharacterPrompt, OCFile } from '../types';

export function toMobileOCFile(oc: PublicOCData): OCFile {
  return {
    id: oc.id,
    name: oc.zh_name || oc.en_name,
    preview: oc.preview_url ? getOCPreviewUrl(oc.en_name) : '',
    positive: oc.tag_group || '',
    negative: '',
    user: 'Bot公共库',
    aliases: oc.zh_aliases || [],
    created_by: oc.created_by || '',
    created_at: oc.created_at || 0,
    isLocal: false,
  };
}

export function filterMobileOCs(
  source: OCFile[],
  searchQuery: string,
): OCFile[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return source;
  return source.filter((oc) =>
    oc.name.toLowerCase().includes(query) ||
    oc.positive.toLowerCase().includes(query) ||
    (oc.created_by || '').toLowerCase().includes(query)
  );
}

export function buildCharacterPromptsFromOCs(
  selectedOCs: OCFile[],
  availableSlots: number,
): CharacterPrompt[] {
  return selectedOCs
    .slice(0, availableSlots)
    .map((oc) => ({
      id: `char_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      positive: oc.positive || '',
      negative: oc.negative || '',
      activeTab: 'prompt',
      enabled: true,
      name: oc.name,
    }));
}
