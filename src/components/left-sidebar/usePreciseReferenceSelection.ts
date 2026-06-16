import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { processCRImage } from '../../services/novelai';
import type { ActivePreciseRef, CRFile } from '../cr';
import type { ActiveVibe } from '../vibe';

interface UsePreciseReferenceSelectionParams {
  selectedCRs: string[];
  crPublicFiles: CRFile[];
  crLocalFiles: CRFile[];
  activePreciseRefs: ActivePreciseRef[];
  setActivePreciseRefs: Dispatch<SetStateAction<ActivePreciseRef[]>>;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
  setIsCRModalOpen: Dispatch<SetStateAction<boolean>>;
}

function toActivePreciseRef(file: CRFile): ActivePreciseRef {
  return {
    id: file.id,
    name: file.name,
    preview: file.preview,
    mode: 'character&style',
    informationExtracted: 1,
    strength: 1,
    enabled: true,
  };
}

export function usePreciseReferenceSelection(params: UsePreciseReferenceSelectionParams) {
  return useCallback(async () => {
    if (params.selectedCRs.length > 0) {
      const allFiles = [...params.crPublicFiles, ...params.crLocalFiles];
      const newPreciseRefs: ActivePreciseRef[] = [];

      for (const crId of params.selectedCRs) {
        const file = allFiles.find((candidate) => candidate.id === crId);
        if (!file) continue;

        const existing = params.activePreciseRefs.find((reference) => reference.id === file.id);
        newPreciseRefs.push(existing || toActivePreciseRef(file));
        processCRImage(file.preview).catch((err) =>
          console.error('Failed to preprocess Precise Reference image:', err),
        );
      }

      params.setActivePreciseRefs(newPreciseRefs);
      params.setActiveVibes([]);
      params.setSelectedVibes([]);
    } else {
      params.setActivePreciseRefs([]);
    }

    params.setIsCRModalOpen(false);
  }, [params]);
}
