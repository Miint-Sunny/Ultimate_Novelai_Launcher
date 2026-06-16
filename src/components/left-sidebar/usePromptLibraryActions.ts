import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { usePublicArtist } from '../../services/publicLibrary';
import type { ArtistFile } from '../artist';
import type { OCFile } from '../oc';
import type { PromptEditorRef } from '../PromptEditor';
import type { SelectionConfirm } from '../tag-manager';
import type { CharacterPrompt } from './types';

interface UsePromptLibraryActionsParams {
  chipMode: boolean;
  positiveEditorRef: RefObject<PromptEditorRef | null>;
  artistPublicFiles: ArtistFile[];
  artistLocalFiles: ArtistFile[];
  selectedArtistIds: string[];
  updateArtistUsageOrder: (ids: string[]) => void;
  ocPublicFiles: OCFile[];
  ocLocalFiles: OCFile[];
  selectedOCs: string[];
  setSelectedOCs: Dispatch<SetStateAction<string[]>>;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setIsCharacterSectionOpen: Dispatch<SetStateAction<boolean>>;
  setIsArtistModalOpen: Dispatch<SetStateAction<boolean>>;
  setIsOCModalOpen: Dispatch<SetStateAction<boolean>>;
}

function appendArtistNegatives(
  setNegativePrompt: Dispatch<SetStateAction<string>>,
  files: Array<{ negative?: string }>,
) {
  const incoming = files
    .map((file) => file.negative?.trim())
    .filter((negative): negative is string => !!negative)
    .flatMap((negative) => negative.split(/,\s*/).map((tag) => tag.trim()).filter(Boolean));

  if (incoming.length === 0) return;

  setNegativePrompt((prev) => {
    const existing = new Set(prev.split(/,\s*/).map((tag) => tag.trim()).filter(Boolean));
    const additions = incoming.filter((tag) => !existing.has(tag));
    if (additions.length === 0) return prev;
    return prev.trim() ? `${prev}, ${additions.join(', ')}` : additions.join(', ');
  });
}

function appendOCNegatives(
  setNegativePrompt: Dispatch<SetStateAction<string>>,
  files: Array<{ negative?: string }>,
) {
  const newNegative = files.map((file) => file.negative).filter(Boolean).join(', ');
  if (newNegative) {
    setNegativePrompt((prev) => (prev ? `${prev}, ${newNegative}` : newNegative));
  }
}

function removeExistingMarkers(prompt: string, subtypeId: string) {
  const escaped = subtypeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const oldMarkerRe = new RegExp(`<<${escaped}:[^:]+:(?:.|\\n)*?>>`, 'g');
  return prompt.replace(oldMarkerRe, '').split(/,\s*/).filter((tag) => tag.trim() !== '').join(', ');
}

function replaceMarkers(
  setPositivePrompt: Dispatch<SetStateAction<string>>,
  subtypeId: string,
  files: Array<{ name: string; positive?: string; prompt?: string }>,
) {
  const markers = files
    .map((file) => {
      const content = file.positive ?? file.prompt;
      return content ? `<<${subtypeId}:${file.name}:${content}>>` : null;
    })
    .filter((marker): marker is string => !!marker)
    .join(', ');

  setPositivePrompt((prev) => {
    const withoutOld = removeExistingMarkers(prev, subtypeId);
    if (!markers) return withoutOld;
    return withoutOld ? `${withoutOld}, ${markers}` : markers;
  });
}

function addCollapsibleTags(
  editorRef: RefObject<PromptEditorRef | null>,
  subtypeId: string,
  files: Array<{ name: string; positive?: string; prompt?: string }>,
  replaceExisting: boolean,
) {
  if (!editorRef.current) return;

  if (replaceExisting) {
    editorRef.current.removeTagsByType(subtypeId);
  }

  for (const file of files) {
    const content = file.positive ?? file.prompt;
    if (!content || !editorRef.current) continue;

    editorRef.current.addCollapsibleTag({
      type: subtypeId,
      label: file.name,
      content,
      collapsed: true,
    });
  }
}

function buildCharacterPrompts(files: OCFile[], baseTs: number): CharacterPrompt[] {
  return files.map((file, index) => ({
    id: `${baseTs}-${index}-${file.id}`,
    positive: file.positive,
    negative: file.negative,
    activeTab: 'prompt',
    enabled: true,
    position: '',
    name: file.name,
  }));
}

function recordUsageOrder(subtypeId: string, tagIds: string[]) {
  if (subtypeId === 'artist-style' || tagIds.length === 0) return;

  try {
    const key = `usage_order:${subtypeId}`;
    const raw = localStorage.getItem(key);
    const existing: string[] = raw ? JSON.parse(raw) : [];
    const next = [...tagIds, ...existing.filter((id) => !tagIds.includes(id))].slice(0, 50);
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // ignore local usage persistence failures
  }
}

export function usePromptLibraryActions(params: UsePromptLibraryActionsParams) {
  const insertOCsToMainPrompt = useCallback((files: Array<{ name: string; positive: string; negative?: string }>) => {
    const withPositive = files.filter((file) => file.positive?.trim());

    if (params.chipMode) {
      const markers = withPositive
        .map((file) => `<<oc:${file.name}:${file.positive}>>`)
        .join(', ');
      if (markers) {
        params.setPositivePrompt((prev) => (prev.trim() ? `${prev}, ${markers}` : markers));
      }
    } else {
      addCollapsibleTags(params.positiveEditorRef, 'oc', withPositive, false);
    }

    appendOCNegatives(params.setNegativePrompt, files);
  }, [params]);

  const handleConfirmArtistSelection = useCallback(() => {
    const fileMap = new Map<string, ArtistFile>();
    for (const file of params.artistPublicFiles) fileMap.set(file.id, file);
    for (const file of params.artistLocalFiles) fileMap.set(file.id, file);

    const selectedFiles = params.selectedArtistIds
      .map((id) => fileMap.get(id))
      .filter((file): file is ArtistFile => !!file);

    if (params.chipMode) {
      replaceMarkers(params.setPositivePrompt, 'artist', selectedFiles);
    } else {
      addCollapsibleTags(params.positiveEditorRef, 'artist', selectedFiles, true);
    }

    appendArtistNegatives(params.setNegativePrompt, selectedFiles);

    for (const file of selectedFiles) {
      if (params.artistPublicFiles.some((publicFile) => publicFile.id === file.id)) {
        usePublicArtist(file.id).catch((err) => console.warn('记录画师串使用失败:', err));
      }
    }

    params.updateArtistUsageOrder(params.selectedArtistIds);
    params.setIsArtistModalOpen(false);
  }, [params]);

  const handleTagManagerConfirm = useCallback((selections: SelectionConfirm[]) => {
    let openCharacterSection = false;
    const baseTs = Date.now();

    for (const { subtypeId, tagIds, mode } of selections) {
      if (subtypeId === 'character') {
        const selected = [...params.ocPublicFiles, ...params.ocLocalFiles]
          .filter((file) => tagIds.includes(file.id));
        if (selected.length === 0) continue;

        if (mode === 'main') {
          insertOCsToMainPrompt(selected);
        } else {
          const newChars = buildCharacterPrompts(selected, baseTs);
          params.setCharacterPrompts((prev) => {
            const availableSlots = 6 - prev.length;
            if (availableSlots <= 0) return prev;
            return [...prev, ...newChars.slice(0, availableSlots)];
          });
          openCharacterSection = true;
        }
      } else if (subtypeId === 'artist-style') {
        const fileMap = new Map<string, ArtistFile>();
        for (const file of params.artistPublicFiles) fileMap.set(file.id, file);
        for (const file of params.artistLocalFiles) fileMap.set(file.id, file);
        const selected = tagIds
          .map((id) => fileMap.get(id))
          .filter((file): file is ArtistFile => !!file);
        if (selected.length === 0) continue;

        if (params.chipMode) {
          replaceMarkers(params.setPositivePrompt, 'artist', selected);
        } else {
          addCollapsibleTags(params.positiveEditorRef, 'artist', selected, true);
        }

        appendArtistNegatives(params.setNegativePrompt, selected);

        for (const file of selected) {
          if (params.artistPublicFiles.some((publicFile) => publicFile.id === file.id)) {
            usePublicArtist(file.id).catch((err) => console.warn('记录画师串使用失败:', err));
          }
        }
        params.updateArtistUsageOrder(tagIds);
      } else {
        const files = selections.find((selection) => selection.subtypeId === subtypeId)?.customTagFiles || [];
        const selected = files.filter((file) => tagIds.includes(file.id));
        if (selected.length > 0) {
          if (params.chipMode) {
            replaceMarkers(params.setPositivePrompt, subtypeId, selected);
          } else {
            addCollapsibleTags(params.positiveEditorRef, subtypeId, selected, true);
          }
        }
      }

      recordUsageOrder(subtypeId, tagIds);
    }

    if (openCharacterSection) {
      params.setIsCharacterSectionOpen(true);
    }
  }, [insertOCsToMainPrompt, params]);

  const handleConfirmOCSelection = useCallback((mode: 'character' | 'main') => {
    const selectedFiles = [...params.ocPublicFiles, ...params.ocLocalFiles]
      .filter((file) => params.selectedOCs.includes(file.id));

    if (mode === 'character') {
      const newChars = selectedFiles.map((file, index) => ({
        id: `${Date.now()}-${index}`,
        positive: file.positive,
        negative: file.negative,
        activeTab: 'prompt' as const,
        enabled: true,
        position: '',
        name: file.name,
      }));

      params.setCharacterPrompts((prev) => {
        const availableSlots = 6 - prev.length;
        if (availableSlots <= 0) return prev;
        return [...prev, ...newChars.slice(0, availableSlots)];
      });

      if (selectedFiles.length > 0) {
        params.setIsCharacterSectionOpen(true);
      }
    } else {
      insertOCsToMainPrompt(selectedFiles);
    }

    params.setIsOCModalOpen(false);
    params.setSelectedOCs([]);
  }, [insertOCsToMainPrompt, params]);

  return {
    handleConfirmArtistSelection,
    handleTagManagerConfirm,
    handleConfirmOCSelection,
  };
}
