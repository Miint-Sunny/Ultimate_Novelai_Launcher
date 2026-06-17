import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { makeArtistMarker } from '../../../utils/promptTags';

type SelectedArtist = { name: string; prompt: string } | null;

interface UseMobileArtistSelectionOptions {
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  closeArtistModal: () => void;
}

export function useMobileArtistSelection({
  setPositivePrompt,
  closeArtistModal,
}: UseMobileArtistSelectionOptions) {
  const handleArtistSelection = useCallback((artist: SelectedArtist) => {
    if (artist) {
      const marker = makeArtistMarker(artist.name, artist.prompt);
      setPositivePrompt((prev) => (prev ? `${prev}, ${marker}` : marker));
    }
    closeArtistModal();
  }, [closeArtistModal, setPositivePrompt]);

  return {
    handleArtistSelection,
  };
}
