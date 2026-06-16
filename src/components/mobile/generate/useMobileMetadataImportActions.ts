import type { Dispatch, SetStateAction } from 'react';
import {
  createVibeFromEncoding,
  createVibeFromImageBase64,
  findVibeByEncoding,
  findVibeByImage,
  getVibes,
} from '../../../services/localLibrary';
import { getUnsupportedImportSettings, normalizeNoiseSchedule } from '../../../utils/generationOptions';
import type { ImageMetadata, VibeMetadata } from '../../../utils/imageMetadata';
import type { ActiveVibe, CharacterPrompt, VibeFile } from '../types';
import type { MobileImageImportOptions } from './useMobileImageImport';

interface UseMobileMetadataImportActionsOptions {
  importImageMetadata: ImageMetadata | null;
  importOptions: MobileImageImportOptions;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setSteps: Dispatch<SetStateAction<number>>;
  setScale: Dispatch<SetStateAction<number>>;
  setSampler: Dispatch<SetStateAction<string>>;
  setNoiseSchedule: Dispatch<SetStateAction<string>>;
  setLocalWidth: Dispatch<SetStateAction<number>>;
  setLocalHeight: Dispatch<SetStateAction<number>>;
  setSeed: (seed: string) => void;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setLocalVibeFiles: Dispatch<SetStateAction<VibeFile[]>>;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  closeImageImportModal: () => void;
}

const generateVibeName = (vibeIndex: number) => `导入的 Vibe ${vibeIndex + 1}`;

const inferApiModel = (source?: string): string => {
  if (!source) return 'nai-diffusion-4-5-full';
  const s = source.toLowerCase();
  if (s.includes('v4.5 curated')) return 'nai-diffusion-4-5-curated';
  if (s.includes('v4.5')) return 'nai-diffusion-4-5-full';
  if (s.includes('v4 curated')) return 'nai-diffusion-4-curated';
  if (s.includes('v4')) return 'nai-diffusion-4-full';
  if (s.includes('v3')) return 'nai-diffusion-3';
  return 'nai-diffusion-4-5-full';
};

export function useMobileMetadataImportActions({
  importImageMetadata,
  importOptions,
  setPositivePrompt,
  setNegativePrompt,
  setSteps,
  setScale,
  setSampler,
  setNoiseSchedule,
  setLocalWidth,
  setLocalHeight,
  setSeed,
  setCharacterPrompts,
  setLocalVibeFiles,
  setActiveVibes,
  closeImageImportModal,
}: UseMobileMetadataImportActionsOptions) {
  const addImportedVibeToLocalList = (importedVibe: Awaited<ReturnType<typeof createVibeFromImageBase64>>) => {
    setLocalVibeFiles((prev) => [{
      id: importedVibe.id,
      name: importedVibe.name,
      preview: importedVibe.preview,
      image: importedVibe.image,
      encodings: importedVibe.encodings,
      defaultStrength: importedVibe.defaultStrength,
      defaultInfoExtracted: importedVibe.defaultInfoExtracted,
      supportedModels: importedVibe.supportedModels,
    }, ...prev]);
  };

  const importVibeFromMetadata = async (vibe: VibeMetadata, index: number, meta: ImageMetadata) => {
    if (vibe.image) {
      const found = await findVibeByImage(vibe.image);
      console.log('[Vibe导入] 通过图片匹配结果:', found ? found.name : '未找到');

      if (found) {
        let defaultInfoExtracted = found.defaultInfoExtracted ?? 1;
        if (found.encodings) {
          const firstModelKey = Object.keys(found.encodings)[0];
          const firstEncoding = firstModelKey ? Object.values(found.encodings[firstModelKey])[0] : undefined;
          if (firstEncoding?.params) defaultInfoExtracted = firstEncoding.params.information_extracted;
        }
        return {
          id: found.id,
          name: found.name,
          preview: found.preview,
          image: found.image,
          encodings: found.encodings,
          referenceStrength: vibe.strength,
          informationExtracted: defaultInfoExtracted,
          supportedModels: found.supportedModels,
          enabled: true,
        };
      }

      const importedVibe = await createVibeFromImageBase64(
        vibe.image,
        vibe.strength,
        vibe.informationExtracted ?? 1,
        generateVibeName(index)
      );
      addImportedVibeToLocalList(importedVibe);
      return {
        id: importedVibe.id,
        name: importedVibe.name,
        preview: importedVibe.preview,
        image: importedVibe.image,
        encodings: importedVibe.encodings,
        referenceStrength: vibe.strength,
        informationExtracted: vibe.informationExtracted ?? 1,
        supportedModels: importedVibe.supportedModels,
        enabled: true,
      };
    }

    if (vibe.encoding) {
      const found = await findVibeByEncoding(vibe.encoding);
      console.log('[Vibe导入] 通过编码匹配结果:', found ? found.vibe.name : '未找到');
      if (found) {
        return {
          id: found.vibe.id,
          name: found.vibe.name,
          preview: found.vibe.preview,
          image: found.vibe.image,
          encodings: found.vibe.encodings,
          referenceStrength: vibe.strength,
          informationExtracted: found.informationExtracted,
          supportedModels: found.vibe.supportedModels,
          enabled: true,
        };
      }

      const importedVibe = await createVibeFromEncoding(
        vibe.encoding,
        vibe.informationExtracted ?? 1,
        vibe.strength,
        inferApiModel(meta.source),
        generateVibeName(index)
      );
      addImportedVibeToLocalList(importedVibe);
      return {
        id: importedVibe.id,
        name: importedVibe.name,
        preview: importedVibe.preview,
        image: importedVibe.image,
        encodings: importedVibe.encodings,
        referenceStrength: vibe.strength,
        informationExtracted: vibe.informationExtracted ?? 1,
        supportedModels: importedVibe.supportedModels,
        enabled: true,
      };
    }

    if (vibe.needsLocalMatch) {
      const allVibes = await getVibes();
      const historyStr = meta.seed ? localStorage.getItem('novelai_vibe_history') : null;
      if (historyStr && meta.seed) {
        try {
          const history = JSON.parse(historyStr) as Record<string, {
            vibes: Array<{ id: string; strength: number; informationExtracted: number }>;
          }>;
          const historyVibe = history[String(meta.seed)]?.vibes[index];
          const found = historyVibe ? allVibes.find((item) => item.id === historyVibe.id) : null;
          if (found && historyVibe) {
            return {
              id: found.id,
              name: found.name,
              preview: found.preview,
              image: found.image,
              encodings: found.encodings,
              referenceStrength: historyVibe.strength,
              informationExtracted: historyVibe.informationExtracted,
              supportedModels: found.supportedModels,
              enabled: true,
            };
          }
        } catch (error) {
          console.warn('[Vibe导入] 解析 vibe 历史失败:', error);
        }
      }

      for (const localVibe of allVibes) {
        if (!localVibe.encodings) continue;
        for (const modelKey in localVibe.encodings) {
          for (const hash in localVibe.encodings[modelKey]) {
            const entry = localVibe.encodings[modelKey][hash];
            if (entry.params && Math.abs(entry.params.information_extracted - (vibe.informationExtracted ?? 1)) < 0.01) {
              return {
                id: localVibe.id,
                name: localVibe.name,
                preview: localVibe.preview,
                image: localVibe.image,
                encodings: localVibe.encodings,
                referenceStrength: vibe.strength,
                informationExtracted: entry.params.information_extracted,
                supportedModels: localVibe.supportedModels,
                enabled: true,
              };
            }
          }
        }
      }
    }

    return null;
  };

  const importMetadata = async () => {
    const meta = importImageMetadata;
    if (!meta) return;

    if (importOptions.cleanImports) {
      if (importOptions.prompt && meta.prompt) setPositivePrompt(meta.prompt);
      if (importOptions.negativePrompt && meta.negativePrompt) setNegativePrompt(meta.negativePrompt);
    } else {
      if (importOptions.prompt && meta.prompt) setPositivePrompt((prev) => prev ? `${prev}, ${meta.prompt}` : meta.prompt);
      if (importOptions.negativePrompt && meta.negativePrompt) setNegativePrompt((prev) => prev ? `${prev}, ${meta.negativePrompt}` : meta.negativePrompt);
    }

    if (importOptions.settings && meta.sourceType === 'novelai' && getUnsupportedImportSettings(meta).length === 0) {
      if (meta.steps) setSteps(Number(meta.steps));
      if (meta.scale) setScale(Number(meta.scale));
      if (meta.sampler) setSampler(meta.sampler);
      if (meta.noiseSchedule) setNoiseSchedule(normalizeNoiseSchedule(meta.noiseSchedule));
      if (meta.width && meta.height) {
        setLocalWidth(meta.width);
        setLocalHeight(meta.height);
      }
    }
    if (importOptions.seed && meta.seed) setSeed(String(meta.seed));
    if (importOptions.characters && meta.characterPrompts) {
      const newChars = meta.characterPrompts.map((cp, idx) => ({
        id: `imported_${Date.now()}_${idx}`,
        positive: cp.prompt || '',
        negative: cp.uc || '',
        activeTab: 'prompt' as const,
        enabled: true,
      }));
      setCharacterPrompts((prev) => importOptions.cleanImports ? newChars : [...prev, ...newChars]);
    }

    if (importOptions.vibes && meta.vibes && meta.vibes.length > 0) {
      try {
        console.log(`[Vibe导入] 检测到 ${meta.vibes.length} 个 vibe 数据`);
        const newVibes: ActiveVibe[] = [];
        for (let index = 0; index < meta.vibes.length; index++) {
          const importedVibe = await importVibeFromMetadata(meta.vibes[index], index, meta);
          if (importedVibe) newVibes.push(importedVibe);
        }
        if (newVibes.length > 0) {
          setActiveVibes((prev) => importOptions.cleanImports ? newVibes : [...prev, ...newVibes]);
          console.log(`[Vibe导入] 成功导入 ${newVibes.length} 个 vibe`);
        }
      } catch (error) {
        console.error('[Vibe导入] 导入失败:', error);
      }
    }

    closeImageImportModal();
  };

  return {
    importMetadata,
  };
}
