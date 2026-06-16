import { Fragment, type CSSProperties, type Dispatch, type MutableRefObject, type PointerEvent, type SetStateAction } from 'react';
import type { CropRect } from '../../utils/maskCrop';

interface CropSelectionOverlayProps {
  cropPreview: CropRect;
  displayWidth: number;
  displayHeight: number;
  imageWidth: number;
  imageHeight: number;
  scale: number;
  isDraggingCropRef: MutableRefObject<boolean>;
  cropManuallyAdjustedRef: MutableRefObject<boolean>;
  setCropPreview: Dispatch<SetStateAction<CropRect | null>>;
}

type ResizeMode = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const ACCENT = '#fceda4';
const CORNER_LEN = 28;
const CORNER_W = 5;
const EDGE_LEN = 44;
const EDGE_W = 6;
const EDGE_R = 3;
const MIN_CROP_SIZE = 256;

export function CropSelectionOverlay({
  cropPreview,
  displayWidth,
  displayHeight,
  imageWidth,
  imageHeight,
  scale,
  isDraggingCropRef,
  cropManuallyAdjustedRef,
  setCropPreview,
}: CropSelectionOverlayProps) {
  const startDrag = (
    event: PointerEvent<HTMLDivElement>,
    mode: ResizeMode,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    isDraggingCropRef.current = true;
    cropManuallyAdjustedRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);

    const startRect = { ...cropPreview };
    const startClientX = event.clientX;
    const startClientY = event.clientY;
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const dx = (moveEvent.clientX - startClientX) / scale;
      const dy = (moveEvent.clientY - startClientY) / scale;
      let nx = startRect.x;
      let ny = startRect.y;
      let nw = startRect.width;
      let nh = startRect.height;

      if (mode.includes('w')) {
        nx = startRect.x + dx;
        nw = startRect.width - dx;
      }
      if (mode.includes('e')) {
        nw = startRect.width + dx;
      }
      if (mode.includes('n')) {
        ny = startRect.y + dy;
        nh = startRect.height - dy;
      }
      if (mode.includes('s')) {
        nh = startRect.height + dy;
      }

      nx = Math.round(nx);
      ny = Math.round(ny);
      nw = Math.round(nw);
      nh = Math.round(nh);

      if (nw < MIN_CROP_SIZE) {
        if (mode.includes('w')) nx = startRect.x + startRect.width - MIN_CROP_SIZE;
        nw = MIN_CROP_SIZE;
      }
      if (nh < MIN_CROP_SIZE) {
        if (mode.includes('n')) ny = startRect.y + startRect.height - MIN_CROP_SIZE;
        nh = MIN_CROP_SIZE;
      }

      if (nx < 0) {
        nw += nx;
        nx = 0;
      }
      if (ny < 0) {
        nh += ny;
        ny = 0;
      }
      if (nx + nw > imageWidth) nw = imageWidth - nx;
      if (ny + nh > imageHeight) nh = imageHeight - ny;
      nw = Math.max(MIN_CROP_SIZE, nw);
      nh = Math.max(MIN_CROP_SIZE, nh);
      setCropPreview({ x: nx, y: ny, width: nw, height: nh });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setTimeout(() => {
        isDraggingCropRef.current = false;
      }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const rx = cropPreview.x * scale;
  const ry = cropPreview.y * scale;
  const rw = cropPreview.width * scale;
  const rh = cropPreview.height * scale;
  const cxMid = rx + rw / 2;
  const cyMid = ry + rh / 2;

  const cornerHandle = (
    pos: 'nw' | 'ne' | 'sw' | 'se',
    cursor: string,
    cx: number,
    cy: number,
  ) => {
    const isN = pos.includes('n');
    const isW = pos.includes('w');
    const horiz: CSSProperties = {
      position: 'absolute',
      width: `${CORNER_LEN}px`,
      height: `${CORNER_W}px`,
      background: ACCENT,
      borderRadius: '1px',
      top: `${cy - CORNER_W / 2}px`,
      left: isW ? `${cx - CORNER_W / 2}px` : `${cx - CORNER_LEN + CORNER_W / 2}px`,
    };
    const vert: CSSProperties = {
      position: 'absolute',
      width: `${CORNER_W}px`,
      height: `${CORNER_LEN}px`,
      background: ACCENT,
      borderRadius: '1px',
      top: isN ? `${cy - CORNER_W / 2}px` : `${cy - CORNER_LEN + CORNER_W / 2}px`,
      left: `${cx - CORNER_W / 2}px`,
    };
    const hit: CSSProperties = {
      position: 'absolute',
      width: '32px',
      height: '32px',
      top: `${cy - 16}px`,
      left: `${cx - 16}px`,
      cursor,
      pointerEvents: 'auto',
    };
    return (
      <Fragment key={pos}>
        <div style={horiz} />
        <div style={vert} />
        <div onPointerDown={(event) => startDrag(event, pos)} style={hit} />
      </Fragment>
    );
  };

  const edgeHandle = (
    pos: 'n' | 's' | 'e' | 'w',
    cursor: string,
    cx: number,
    cy: number,
  ) => {
    const horizontal = pos === 'n' || pos === 's';
    const visual: CSSProperties = {
      position: 'absolute',
      width: horizontal ? `${EDGE_LEN}px` : `${EDGE_W}px`,
      height: horizontal ? `${EDGE_W}px` : `${EDGE_LEN}px`,
      background: ACCENT,
      borderRadius: `${EDGE_R}px`,
      top: horizontal ? `${cy - EDGE_W / 2}px` : `${cy - EDGE_LEN / 2}px`,
      left: horizontal ? `${cx - EDGE_LEN / 2}px` : `${cx - EDGE_W / 2}px`,
    };
    const hit: CSSProperties = {
      position: 'absolute',
      width: horizontal ? '60px' : '20px',
      height: horizontal ? '20px' : '60px',
      top: horizontal ? `${cy - 10}px` : `${cy - 30}px`,
      left: horizontal ? `${cx - 30}px` : `${cx - 10}px`,
      cursor,
      pointerEvents: 'auto',
    };
    return (
      <Fragment key={pos}>
        <div style={visual} />
        <div onPointerDown={(event) => startDrag(event, pos)} style={hit} />
      </Fragment>
    );
  };

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
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${ry}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${ry + rh}px`, left: 0, width: '100%', bottom: 0, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${ry}px`, left: 0, width: `${rx}px`, height: `${rh}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw}px`, right: 0, height: `${rh}px`, background: 'rgba(0,0,0,0.4)' }} />
      <div
        style={{
          position: 'absolute',
          top: `${ry}px`,
          left: `${rx}px`,
          width: `${rw}px`,
          height: `${rh}px`,
          boxShadow: [
            '0 0 0 1.5px rgba(0,0,0,0.6)',
            `inset 0 0 0 2px ${ACCENT}`,
          ].join(', '),
          pointerEvents: 'none',
        }}
      />
      <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw / 3}px`, width: '1px', height: `${rh}px`, background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw * 2 / 3}px`, width: '1px', height: `${rh}px`, background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: `${ry + rh / 3}px`, left: `${rx}px`, width: `${rw}px`, height: '1px', background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', top: `${ry + rh * 2 / 3}px`, left: `${rx}px`, width: `${rw}px`, height: '1px', background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
      {cornerHandle('nw', 'nwse-resize', rx, ry)}
      {cornerHandle('ne', 'nesw-resize', rx + rw, ry)}
      {cornerHandle('sw', 'nesw-resize', rx, ry + rh)}
      {cornerHandle('se', 'nwse-resize', rx + rw, ry + rh)}
      {edgeHandle('n', 'ns-resize', cxMid, ry)}
      {edgeHandle('s', 'ns-resize', cxMid, ry + rh)}
      {edgeHandle('w', 'ew-resize', rx, cyMid)}
      {edgeHandle('e', 'ew-resize', rx + rw, cyMid)}
      <div
        style={{
          position: 'absolute',
          top: `${ry - 24}px`,
          left: `${rx}px`,
          background: 'rgba(252, 237, 164, 0.95)',
          color: 'black',
          fontSize: '11px',
          fontWeight: 600,
          padding: '2px 6px',
          borderRadius: '4px',
          pointerEvents: 'none',
        }}
      >
        {cropPreview.width}x{cropPreview.height}
      </div>
    </div>
  );
}
