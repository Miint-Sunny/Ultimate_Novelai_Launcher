import { OC_STORE } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';

export interface OCData {
  id: string;
  name: string;
  preview: string;
  positive: string;
  negative: string;
  user: string;
  isLocal: boolean;
  createdAt: number;
  aliases?: string[];
  /** 收藏副本对应的公共 OC id - 与 ArtistData.publicId 同义 */
  publicId?: string;
  origin?: 'local' | 'favorited' | 'created';
}

export const saveOC = async (
  oc: Omit<OCData, 'createdAt'> & { createdAt?: number }
): Promise<OCData> => {
  const ocData: OCData = {
    ...oc,
    createdAt: oc.createdAt || Date.now(),
  };
  return putRecord(OC_STORE, ocData);
};

export const getOCs = async (): Promise<OCData[]> => {
  return getAllRecords<OCData>(OC_STORE);
};

export const deleteOC = async (id: string): Promise<void> => {
  return deleteRecord(OC_STORE, id);
};
