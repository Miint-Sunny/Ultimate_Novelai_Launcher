import { IMAGE_HISTORY_STORE, openLocalLibraryDB } from './idb';

const MAX_PERSISTED_HISTORY = 5;

export interface PersistedHistoryItem {
  id: string;
  imageBase64: string;
  seed: number;
  timestamp: number;
  width: number;
  height: number;
  metadata?: {
    positivePrompt: string;
    negativePrompt: string;
    model: string;
    steps: number;
    scale: number;
    sampler: string;
    cfgRescale: number;
    noiseSchedule: string;
    ucPreset: string;
    qualityToggle: boolean;
    varietyPlus: boolean;
    characterPrompts?: Array<{ positive: string; negative: string; enabled: boolean; position?: string }>;
  };
  isUpscaled?: boolean;
  originalSeed?: number;
  upscaleScale?: number;
  isInpainted?: boolean;
  isBananaRepaint?: boolean;
}

export interface ImageHistoryItem {
  id: string;
  imageUrl: string;
  seed: number;
  timestamp: number;
  width: number;
  height: number;
  metadata?: PersistedHistoryItem['metadata'];
  isUpscaled?: boolean;
  originalSeed?: number;
  upscaleScale?: number;
  isInpainted?: boolean;
  isBananaRepaint?: boolean;
}

const blobUrlToBase64 = (blobUrl: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    fetch(blobUrl)
      .then((res) => res.blob())
      .then((blob) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      })
      .catch(reject);
  });
};

const base64ToBlobUrl = (base64: string): string => {
  const parts = base64.split(',');
  const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/png';
  const bstr = atob(parts[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) {
    u8arr[i] = bstr.charCodeAt(i);
  }
  const blob = new Blob([u8arr], { type: mime });
  return URL.createObjectURL(blob);
};

export const saveImageHistory = async (historyItems: ImageHistoryItem[]): Promise<void> => {
  try {
    const itemsToSave = historyItems.slice(0, MAX_PERSISTED_HISTORY);
    const persistedItems: PersistedHistoryItem[] = await Promise.all(
      itemsToSave.map(async (item) => ({
        id: item.id,
        imageBase64: await blobUrlToBase64(item.imageUrl),
        seed: item.seed,
        timestamp: item.timestamp,
        width: item.width,
        height: item.height,
        metadata: item.metadata,
        isUpscaled: item.isUpscaled,
        originalSeed: item.originalSeed,
        upscaleScale: item.upscaleScale,
        isInpainted: item.isInpainted,
        isBananaRepaint: item.isBananaRepaint,
      }))
    );

    const db = await openLocalLibraryDB();
    const tx = db.transaction(IMAGE_HISTORY_STORE, 'readwrite');
    const store = tx.objectStore(IMAGE_HISTORY_STORE);
    store.clear();
    for (const item of persistedItems) store.put(item);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn('Failed to save image history:', e);
  }
};

export const loadImageHistory = async (): Promise<ImageHistoryItem[]> => {
  try {
    const db = await openLocalLibraryDB();
    const tx = db.transaction(IMAGE_HISTORY_STORE, 'readonly');
    const store = tx.objectStore(IMAGE_HISTORY_STORE);

    const items: PersistedHistoryItem[] = await new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items.map((item) => ({
      id: item.id,
      imageUrl: base64ToBlobUrl(item.imageBase64),
      seed: item.seed,
      timestamp: item.timestamp,
      width: item.width,
      height: item.height,
      metadata: item.metadata,
      isUpscaled: item.isUpscaled,
      originalSeed: item.originalSeed,
      upscaleScale: item.upscaleScale,
      isInpainted: item.isInpainted,
      isBananaRepaint: item.isBananaRepaint,
    }));
  } catch (e) {
    console.warn('Failed to load image history:', e);
    return [];
  }
};
