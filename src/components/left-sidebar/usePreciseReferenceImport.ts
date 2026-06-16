import { useCallback } from 'react';
import type { ChangeEvent, Dispatch, SetStateAction } from 'react';
import { saveCR } from '../../services/localLibrary';
import { processCRImage } from '../../services/novelai';
import type { ActivePreciseRef, CRFile } from '../cr';
import type { ActiveVibe } from '../vibe';

interface UsePreciseReferenceImportParams {
  setCrLocalFiles: Dispatch<SetStateAction<CRFile[]>>;
  setActivePreciseRefs: Dispatch<SetStateAction<ActivePreciseRef[]>>;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });
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

async function saveAndActivatePreciseReference(
  file: CRFile,
  params: UsePreciseReferenceImportParams,
  errorMessage: string,
) {
  try {
    await saveCR({ ...file, isLocal: true });
    params.setCrLocalFiles((prev) => [file, ...prev]);
    params.setActivePreciseRefs((prev) => [...prev, toActivePreciseRef(file)]);
    params.setActiveVibes([]);
    params.setSelectedVibes([]);
    processCRImage(file.preview).catch((err) =>
      console.error('Failed to preprocess Precise Reference image:', err),
    );
  } catch (error) {
    console.error(errorMessage, error);
  }
}

export function usePreciseReferenceImport(params: UsePreciseReferenceImportParams) {
  const handleQuickCRUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const preview = await fileToDataUrl(file);
      await saveAndActivatePreciseReference(
        {
          id: `crl${Date.now()}`,
          name: file.name,
          preview,
        },
        params,
        'Failed to save Precise Reference:',
      );
    }

    if (event.target) event.target.value = '';
  }, [params]);

  const handleCRDropCallback = useCallback(async (dataUrl: string) => {
    await saveAndActivatePreciseReference(
      {
        id: `crl${Date.now()}`,
        name: `PR_${Date.now()}`,
        preview: dataUrl,
      },
      params,
      'Failed to save Precise Reference via drag-drop:',
    );
  }, [params]);

  return { handleQuickCRUpload, handleCRDropCallback };
}
