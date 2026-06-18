import React from 'react';
import type { CropRect } from '../../../utils/maskCrop';

interface MobileInpaintCropPreviewProps {
  isCropMode: boolean;
  cropPreview: CropRect | null;
  isGenerating: boolean;
  displayWidth: number;
  displayHeight: number;
  baseScale: number;
  zoom: number;
}

export const MobileInpaintCropPreview: React.FC<MobileInpaintCropPreviewProps> = ({
  isCropMode,
  cropPreview,
  isGenerating,
  displayWidth,
  displayHeight,
  baseScale,
  zoom,
}) => {
  if (!isCropMode || !cropPreview || isGenerating) return null;

  const scale = baseScale * zoom;
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${displayWidth}px`,
        height: `${displayHeight}px`,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${cropPreview.y * scale}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${(cropPreview.y + cropPreview.height) * scale}px`, left: 0, width: '100%', bottom: 0, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${cropPreview.y * scale}px`, left: 0, width: `${cropPreview.x * scale}px`, height: `${cropPreview.height * scale}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${cropPreview.y * scale}px`, left: `${(cropPreview.x + cropPreview.width) * scale}px`, right: 0, height: `${cropPreview.height * scale}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{
        position: 'absolute',
        top: `${cropPreview.y * scale}px`,
        left: `${cropPreview.x * scale}px`,
        width: `${cropPreview.width * scale}px`,
        height: `${cropPreview.height * scale}px`,
        border: '2px dashed rgba(45, 212, 191, 0.8)',
      }} />
      <div style={{
        position: 'absolute',
        top: `${cropPreview.y * scale - 20}px`,
        left: `${cropPreview.x * scale}px`,
        background: 'rgba(45, 212, 191, 0.9)',
        color: 'black',
        fontSize: '10px',
        fontWeight: 600,
        padding: '1px 4px',
        borderRadius: '3px',
      }}>
        {cropPreview.width}x{cropPreview.height}
      </div>
    </div>
  );
};
