import { CR_STORE } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';

export interface CRData {
  id: string;
  name: string;
  preview: string;
  isLocal: boolean;
  createdAt: number;
}

export const saveCR = async (
  cr: Omit<CRData, 'createdAt'> & { createdAt?: number }
): Promise<CRData> => {
  const crData: CRData = {
    ...cr,
    createdAt: cr.createdAt || Date.now(),
  };
  return putRecord(CR_STORE, crData);
};

export const getCRs = async (): Promise<CRData[]> => {
  return getAllRecords<CRData>(CR_STORE);
};

export const deleteCR = async (id: string): Promise<void> => {
  return deleteRecord(CR_STORE, id);
};
