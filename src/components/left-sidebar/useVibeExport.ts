import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  computeVibeEncodingHash,
  exportVibeToFile,
  findCachedEncoding,
  getVibes,
  saveVibeEncoding,
  type VibeData,
} from '../../services/localLibrary';
import { encodeVibeImage } from '../../services/novelai';
import { getPublicVibeFile } from '../../services/publicLibrary';
import { MODEL_MAP } from '../generation/modelResolutionOptions';
import type { ActiveVibe, VibeFile } from '../vibe';

interface UseVibeExportParams {
  exportingVibeId: string | null;
  setExportingVibeId: Dispatch<SetStateAction<string | null>>;
  activeVibes: ActiveVibe[];
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  publicFiles: VibeFile[];
  selectedModel: { id: string };
}

function downloadVibeBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.naiv4vibe`;
  a.click();
  URL.revokeObjectURL(url);
}

function buildVibeDataFromActive(vibe: ActiveVibe): VibeData | undefined {
  if (!vibe.image) return undefined;

  return {
    id: vibe.id,
    name: vibe.name,
    size: '',
    preview: vibe.preview || '',
    image: vibe.image,
    encodings: vibe.encodings,
    supportedModels: vibe.supportedModels,
    createdAt: Date.now(),
  };
}

function updateActiveVibeData(
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>,
  vibeId: string,
  data: { image?: string; encodings?: VibeData['encodings'] },
) {
  setActiveVibes((prev) => prev.map((vibe) => (
    vibe.id === vibeId
      ? {
        ...vibe,
        image: data.image ?? vibe.image,
        encodings: data.encodings ?? vibe.encodings,
      }
      : vibe
  )));
}

async function loadPublicVibeData(
  vibe: ActiveVibe,
  publicFiles: VibeFile[],
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>,
): Promise<VibeData | undefined> {
  const publicFile = publicFiles.find((file) => file.id === vibe.id);
  if (!publicFile?.fileName) return undefined;

  const fullData = await getPublicVibeFile(publicFile.fileName);
  if (!fullData) return undefined;

  const vibeData: VibeData = {
    id: vibe.id,
    name: vibe.name,
    size: '',
    preview: vibe.preview || '',
    image: (fullData.image as string) || '',
    encodings: fullData.encodings as VibeData['encodings'],
    supportedModels: vibe.supportedModels,
    createdAt: Date.now(),
  };

  updateActiveVibeData(setActiveVibes, vibe.id, {
    image: vibeData.image,
    encodings: vibeData.encodings,
  });

  return vibeData;
}

function cachePublicEncoding(
  vibeData: VibeData,
  modelForVibe: string,
  informationExtracted: number,
  encoded: string,
) {
  const updatedVibeData = { ...vibeData };
  if (!updatedVibeData.encodings) {
    updatedVibeData.encodings = {};
  }

  const modelKey = modelForVibe
    .replace('nai-diffusion-', 'v')
    .replace('-full', '-5full')
    .replace('-curated', '-5curated');

  if (!updatedVibeData.encodings[modelKey]) {
    updatedVibeData.encodings[modelKey] = {};
  }

  return computeVibeEncodingHash(informationExtracted).then((hashKey) => {
    updatedVibeData.encodings![modelKey][hashKey] = {
      encoding: encoded,
      params: { information_extracted: informationExtracted },
    };
    return updatedVibeData;
  });
}

export function useVibeExport(params: UseVibeExportParams) {
  return useCallback(async (vibe: ActiveVibe) => {
    if (params.exportingVibeId === vibe.id) return;

    let vibeData = buildVibeDataFromActive(
      params.activeVibes.find((active) => active.id === vibe.id) || vibe,
    );

    if (!vibeData?.image) {
      const publicFile = params.publicFiles.find((file) => file.id === vibe.id);
      if (publicFile?.fileName) {
        params.setExportingVibeId(vibe.id);
        try {
          vibeData = await loadPublicVibeData(vibe, params.publicFiles, params.setActiveVibes);
        } catch (err) {
          console.error('Failed to load public vibe:', err);
          alert('无法加载公共Vibe数据');
          params.setExportingVibeId(null);
          return;
        }
      }
    }

    if (!vibeData) {
      const vibes = await getVibes();
      vibeData = vibes.find((candidate) => candidate.id === vibe.id);
    }

    if (!vibeData || (!vibeData.image && !vibeData.encodings)) {
      alert('无法导出：缺少图片数据和编码数据');
      params.setExportingVibeId(null);
      return;
    }

    const modelForVibe = MODEL_MAP[params.selectedModel.id] || 'nai-diffusion-4-5-full';
    const cachedEncoding = findCachedEncoding(
      vibeData,
      modelForVibe,
      vibe.informationExtracted,
    );

    if (!vibeData.image && vibeData.encodings) {
      const blob = await exportVibeToFile(
        vibeData,
        vibe.referenceStrength,
        vibe.informationExtracted,
        modelForVibe,
        true,
      );
      downloadVibeBlob(blob, vibe.name);
      params.setExportingVibeId(null);
      return;
    }

    if (!cachedEncoding) {
      if (params.exportingVibeId !== vibe.id) {
        params.setExportingVibeId(vibe.id);
      }

      try {
        const encoded = await encodeVibeImage(
          vibeData.image!,
          vibe.informationExtracted,
          modelForVibe,
        );

        if (!encoded) {
          alert('编码失败，请检查网络连接或 API Token');
          return;
        }

        const isPublicVibe = params.publicFiles.some((file) => file.id === vibe.id);
        if (isPublicVibe) {
          const updatedVibeData = await cachePublicEncoding(
            vibeData,
            modelForVibe,
            vibe.informationExtracted,
            encoded,
          );
          updateActiveVibeData(params.setActiveVibes, vibe.id, {
            encodings: updatedVibeData.encodings,
          });
          const blob = await exportVibeToFile(
            updatedVibeData,
            vibe.referenceStrength,
            vibe.informationExtracted,
            modelForVibe,
          );
          downloadVibeBlob(blob, vibe.name);
        } else {
          await saveVibeEncoding(vibe.id, modelForVibe, vibe.informationExtracted, encoded);
          const updatedVibes = await getVibes();
          const updatedVibeData = updatedVibes.find((candidate) => candidate.id === vibe.id);

          if (updatedVibeData) {
            updateActiveVibeData(params.setActiveVibes, vibe.id, {
              encodings: updatedVibeData.encodings,
            });
            const blob = await exportVibeToFile(
              updatedVibeData,
              vibe.referenceStrength,
              vibe.informationExtracted,
              modelForVibe,
            );
            downloadVibeBlob(blob, vibe.name);
          }
        }
      } catch (error) {
        console.error('Export vibe error:', error);
        alert('导出失败: ' + (error as Error).message);
      } finally {
        params.setExportingVibeId(null);
      }
    } else {
      const blob = await exportVibeToFile(
        vibeData,
        vibe.referenceStrength,
        vibe.informationExtracted,
        modelForVibe,
      );
      downloadVibeBlob(blob, vibe.name);
      if (params.exportingVibeId === vibe.id) {
        params.setExportingVibeId(null);
      }
    }
  }, [params]);
}
