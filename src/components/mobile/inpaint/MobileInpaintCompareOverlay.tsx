import React from 'react';

// 生成前画布快照（用于原图对比覆盖层）
export interface InpaintSnapshot {
  url: string;
  width: number;
  height: number;
  padLeft: number;
  padTop: number;
}

interface MobileInpaintCompareOverlayProps {
  showOriginal: boolean;
  snapshot: InpaintSnapshot | null;
  displayWidth: number;
  displayHeight: number;
  imageWidth: number;
}

// 原图对比覆盖层：按快照把生成前的原图盖在当前画布上，并用深色遮罩盖住扩图区域。
export const MobileInpaintCompareOverlay: React.FC<MobileInpaintCompareOverlayProps> = ({
  showOriginal,
  snapshot,
  displayWidth,
  displayHeight,
  imageWidth,
}) => {
  if (!showOriginal || !snapshot) return null;

  const s = displayWidth / imageWidth;
  const offL = snapshot.padLeft * s;
  const offT = snapshot.padTop * s;
  const origW = snapshot.width * s;
  const origH = snapshot.height * s;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, width: `${displayWidth}px`, height: `${displayHeight}px`, zIndex: 50, pointerEvents: 'none' }}>
      <img src={snapshot.url} alt="原图对比" style={{
        position: 'absolute', top: `${offT}px`, left: `${offL}px`,
        width: `${origW}px`, height: `${origH}px`, display: 'block',
      }} />
      {offT > 0 && <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${offT}px`, background: '#0a0a0f' }} />}
      {offT + origH < displayHeight && <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: `${displayHeight - offT - origH}px`, background: '#0a0a0f' }} />}
      {offL > 0 && <div style={{ position: 'absolute', top: `${offT}px`, left: 0, width: `${offL}px`, height: `${origH}px`, background: '#0a0a0f' }} />}
      {offL + origW < displayWidth && <div style={{ position: 'absolute', top: `${offT}px`, right: 0, width: `${displayWidth - offL - origW}px`, height: `${origH}px`, background: '#0a0a0f' }} />}
    </div>
  );
};
