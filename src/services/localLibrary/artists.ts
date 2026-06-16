import { ARTIST_STORE } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';

export interface ArtistData {
  id: string;
  name: string;
  prompt: string;
  negative?: string;
  previews: string[];
  isLocal: boolean;
  createdAt: number;
  usageCount?: number;
  createdTime?: number;
  createdTimeStr?: string;
  addedBy?: string | null;
  origin?: 'local' | 'favorited' | 'created';
  publicId?: string;
  tags?: string[];
}

export const saveArtist = async (
  artist: Omit<ArtistData, 'createdAt'> & { createdAt?: number }
): Promise<ArtistData> => {
  const artistData: ArtistData = {
    ...artist,
    createdAt: artist.createdAt || Date.now(),
  };
  return putRecord(ARTIST_STORE, artistData);
};

export const getArtists = async (): Promise<ArtistData[]> => {
  return getAllRecords<ArtistData>(ARTIST_STORE);
};

export const deleteArtist = async (id: string): Promise<void> => {
  return deleteRecord(ARTIST_STORE, id);
};
