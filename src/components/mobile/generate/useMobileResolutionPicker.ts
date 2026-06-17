import { useMemo, useState } from 'react';
import {
  MOBILE_LARGE_RESOLUTIONS as LARGE_RESOLUTIONS,
  MOBILE_WALLPAPER_RESOLUTIONS as WALLPAPER_RESOLUTIONS,
  RESOLUTIONS,
} from '../../generation/modelResolutionOptions';

export type MobileResolutionTab = 'small' | 'large' | 'wallpaper';

export function useMobileResolutionPicker(width: number, height: number) {
  const [resolutionTab, setResolutionTab] = useState<MobileResolutionTab>('small');

  const currentResLabel = useMemo(() => {
    return [...RESOLUTIONS, ...LARGE_RESOLUTIONS, ...WALLPAPER_RESOLUTIONS].find(
      (resolution) => resolution.width === width && resolution.height === height
    )?.label || '自定义';
  }, [height, width]);

  const currentOptions = resolutionTab === 'small'
    ? RESOLUTIONS
    : resolutionTab === 'large'
      ? LARGE_RESOLUTIONS
      : WALLPAPER_RESOLUTIONS;

  return {
    resolutionTab,
    setResolutionTab,
    currentResLabel,
    currentOptions,
  };
}
