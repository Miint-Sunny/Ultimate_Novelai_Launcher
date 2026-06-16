import { STORE_NAME } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';
import type { VibeData } from './vibeTypes';

export const saveVibe = async (
  vibeData: Omit<VibeData, 'createdAt'> & { createdAt?: number },
  options?: { skipSync?: boolean }
): Promise<VibeData> => {
  void options;
  const data: VibeData = {
    ...vibeData,
    createdAt: vibeData.createdAt || Date.now(),
  };
  return putRecord(STORE_NAME, data);
};

export const getVibes = async (): Promise<VibeData[]> => {
  return getAllRecords<VibeData>(STORE_NAME);
};

export const deleteVibe = async (id: string): Promise<void> => {
  return deleteRecord(STORE_NAME, id);
};
