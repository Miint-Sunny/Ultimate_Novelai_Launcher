import type { ComponentProps } from 'react';
import { MobileAdvancedSettingsSheet } from './MobileAdvancedSettingsSheet';
import { MobileGenerateToolbar } from './MobileGenerateToolbar';
import { MobileResolutionSheet } from './MobileResolutionSheet';

type ToolbarProps = ComponentProps<typeof MobileGenerateToolbar>;
type ResolutionSheetProps = ComponentProps<typeof MobileResolutionSheet>;
type AdvancedSettingsSheetProps = ComponentProps<typeof MobileAdvancedSettingsSheet>;

interface MobileGenerateControlsProps {
  toolbar: ToolbarProps;
  resolutionSheet: ResolutionSheetProps;
  advancedSettingsSheet: AdvancedSettingsSheetProps;
}

export function MobileGenerateControls({
  toolbar,
  resolutionSheet,
  advancedSettingsSheet,
}: MobileGenerateControlsProps) {
  return (
    <>
      <MobileGenerateToolbar {...toolbar} />
      <MobileResolutionSheet {...resolutionSheet} />
      <MobileAdvancedSettingsSheet {...advancedSettingsSheet} />
    </>
  );
}
