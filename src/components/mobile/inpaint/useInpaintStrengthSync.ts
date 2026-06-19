import { useCallback, useEffect, useState } from 'react';

export function useInpaintStrengthSync(initialStrength = 0.7) {
  const [strength, setStrength] = useState(initialStrength);

  useEffect(() => {
    const handler = (event: Event) => {
      const { strength: newStrength } = (event as CustomEvent).detail;
      setStrength(newStrength);
    };

    window.addEventListener('inpaint-strength-sync', handler);
    return () => window.removeEventListener('inpaint-strength-sync', handler);
  }, []);

  const handleStrengthChange = useCallback((newStrength: number) => {
    setStrength(newStrength);
    window.dispatchEvent(new CustomEvent('inpaint-panel-strength-change', { detail: { strength: newStrength } }));
  }, []);

  return { strength, handleStrengthChange };
}
