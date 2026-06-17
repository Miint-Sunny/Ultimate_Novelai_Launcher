import type { ComponentProps } from 'react';
import { MobileImageImportModal } from './MobileImageImportModal';

type MobileImageImportModalProps = ComponentProps<typeof MobileImageImportModal>;

interface MobileGenerateImageImportSheetProps extends MobileImageImportModalProps {
  isOpen: boolean;
}

export function MobileGenerateImageImportSheet({
  isOpen,
  ...modalProps
}: MobileGenerateImageImportSheetProps) {
  if (!isOpen) return null;
  return <MobileImageImportModal {...modalProps} />;
}
