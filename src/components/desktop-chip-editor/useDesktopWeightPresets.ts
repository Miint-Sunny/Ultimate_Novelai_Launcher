import { useEffect, useState } from 'react';
import { getAppSettings } from '../../services/localLibrary';

const DEFAULT_WEIGHT_PRESETS = [-1, 0.5, 0.8, 1.5, 2.0];

export function useDesktopWeightPresets() {
  const [weightPresets, setWeightPresets] = useState(() => getAppSettings().weightPresets || DEFAULT_WEIGHT_PRESETS);

  useEffect(() => {
    const sync = () => setWeightPresets(getAppSettings().weightPresets || DEFAULT_WEIGHT_PRESETS);
    window.addEventListener('storage', sync);
    window.addEventListener('app-settings-changed', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('app-settings-changed', sync);
    };
  }, []);

  return weightPresets;
}
