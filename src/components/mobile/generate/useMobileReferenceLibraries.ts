import { useRef } from 'react';
import { useMobilePreciseReferences } from './useMobilePreciseReferences';
import { useMobileVibeLibrary } from './useMobileVibeLibrary';

interface UseMobileReferenceLibrariesOptions {
  model: string;
  showVibeModal: boolean;
  closeCRSheet: () => void;
}

export function useMobileReferenceLibraries({
  model,
  showVibeModal,
  closeCRSheet,
}: UseMobileReferenceLibrariesOptions) {
  const preciseReferenceLibraryRef = useRef<ReturnType<typeof useMobilePreciseReferences> | null>(null);

  const vibeLibrary = useMobileVibeLibrary({
    model,
    showVibeModal,
    clearActiveCR: () => preciseReferenceLibraryRef.current?.setActiveCR(null),
  });

  const preciseReferenceLibrary = useMobilePreciseReferences({
    closeSheet: closeCRSheet,
    clearActiveVibes: () => vibeLibrary.setActiveVibes([]),
  });

  preciseReferenceLibraryRef.current = preciseReferenceLibrary;

  return {
    vibeLibrary,
    preciseReferenceLibrary,
  };
}
