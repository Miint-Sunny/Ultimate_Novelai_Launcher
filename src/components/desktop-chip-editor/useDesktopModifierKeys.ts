import { useEffect, useState } from 'react';

export function useDesktopModifierKeys() {
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Control') setCtrlHeld(true);
      if (event.key === 'Shift') setShiftHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Control') setCtrlHeld(false);
      if (event.key === 'Shift') setShiftHeld(false);
    };
    const blur = () => {
      setCtrlHeld(false);
      setShiftHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return { ctrlHeld, shiftHeld };
}
