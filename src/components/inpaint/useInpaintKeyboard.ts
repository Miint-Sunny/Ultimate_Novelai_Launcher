import { useEffect, type Dispatch, type SetStateAction } from 'react';

interface UseInpaintKeyboardParams {
  onClose: () => void;
  setSpacePressed: Dispatch<SetStateAction<boolean>>;
  setIsPanning: Dispatch<SetStateAction<boolean>>;
}

export function useInpaintKeyboard({
  onClose,
  setSpacePressed,
  setIsPanning,
}: UseInpaintKeyboardParams) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        event.preventDefault();
        setSpacePressed(true);
      }
      if (event.code === 'Escape') {
        onClose();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [onClose, setIsPanning, setSpacePressed]);
}
