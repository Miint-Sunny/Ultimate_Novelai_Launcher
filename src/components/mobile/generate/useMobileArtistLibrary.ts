import { useCallback, useState } from 'react';
import { getArtists } from '../../../services/localLibrary';
import { getPublicArtists } from '../../../services/publicLibrary';
import type { ArtistFile } from '../types';

export function useMobileArtistLibrary() {
  const [artistPublicFiles, setArtistPublicFiles] = useState<ArtistFile[]>([]);
  const [artistLocalFiles, setArtistLocalFiles] = useState<ArtistFile[]>([]);
  const [isLoadingArtists, setIsLoadingArtists] = useState(false);

  const loadArtists = useCallback(async () => {
    setIsLoadingArtists(true);
    try {
      const localArtists = await getArtists();
      const localArtistList: ArtistFile[] = localArtists
        .filter((artist) => artist.isLocal)
        .map((artist) => ({
          id: artist.id,
          name: artist.name,
          previews: artist.previews || [],
          prompt: artist.prompt,
        }));
      setArtistLocalFiles(localArtistList);

      const artists = await getPublicArtists();
      const artistFiles: ArtistFile[] = artists.map((artist) => ({
        id: artist.id,
        name: artist.name,
        previews: artist.preview_url ? [artist.preview_url] : [],
        prompt: artist.artist_string,
      }));
      setArtistPublicFiles(artistFiles);
    } catch (error) {
      console.error('Failed to load artists:', error);
    } finally {
      setIsLoadingArtists(false);
    }
  }, []);

  return {
    artistPublicFiles,
    artistLocalFiles,
    isLoadingArtists,
    loadArtists,
  };
}
