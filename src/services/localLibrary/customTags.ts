import { CUSTOM_TAG_STORE } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';

export interface CustomTagData {
  id: string;
  subtypeId: string;
  name: string;
  preview?: string;
  positive: string;
  negative?: string;
  tags?: string[];
  usageCount?: number;
  createdAt: number;
}

export const saveCustomTag = async (
  tag: Omit<CustomTagData, 'createdAt'> & { createdAt?: number }
): Promise<CustomTagData> => {
  const data: CustomTagData = {
    ...tag,
    createdAt: tag.createdAt || Date.now(),
  };
  return putRecord(CUSTOM_TAG_STORE, data);
};

export const getCustomTags = async (): Promise<CustomTagData[]> => {
  return getAllRecords<CustomTagData>(CUSTOM_TAG_STORE);
};

export const deleteCustomTag = async (id: string): Promise<void> => {
  return deleteRecord(CUSTOM_TAG_STORE, id);
};
