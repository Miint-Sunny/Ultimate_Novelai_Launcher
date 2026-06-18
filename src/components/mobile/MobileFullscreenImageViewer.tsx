import React, { useCallback, useRef, useState } from 'react';
import { X } from 'lucide-react';

interface MobileFullscreenImageViewerProps {
  imageUrl: string;
  onClose: () => void;
}

export const MobileFullscreenImageViewer: React.FC<MobileFullscreenImageViewerProps> = ({
  imageUrl,
  onClose,
}) => {
  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const touchStateRef = useRef({
    initialDistance: 0,
    initialScale: 1,
    initialTranslate: { x: 0, y: 0 },
    initialCenter: { x: 0, y: 0 },
    lastTouchEnd: 0,
    isPinching: false,
    isDragging: false,
    startTouch: { x: 0, y: 0 },
  });

  const getDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getCenter = (touches: React.TouchList) => {
    if (touches.length < 2) {
      return { x: touches[0].clientX, y: touches[0].clientY };
    }
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  };

  const clampTranslate = useCallback((tx: number, ty: number, currentScale: number) => {
    if (!containerRef.current || !imageRef.current) return { x: tx, y: ty };

    const container = containerRef.current.getBoundingClientRect();
    const img = imageRef.current;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const containerRatio = container.width / container.height;

    let displayWidth: number;
    let displayHeight: number;
    if (imgRatio > containerRatio) {
      displayWidth = container.width;
      displayHeight = container.width / imgRatio;
    } else {
      displayHeight = container.height;
      displayWidth = container.height * imgRatio;
    }

    const scaledWidth = displayWidth * currentScale;
    const scaledHeight = displayHeight * currentScale;

    if (scaledWidth <= container.width && scaledHeight <= container.height) {
      return { x: 0, y: 0 };
    }

    const maxX = Math.max(0, (scaledWidth - container.width) / 2);
    const maxY = Math.max(0, (scaledHeight - container.height) / 2);

    return {
      x: Math.max(-maxX, Math.min(maxX, tx)),
      y: Math.max(-maxY, Math.min(maxY, ty)),
    };
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touches = e.touches;
    const state = touchStateRef.current;

    if (touches.length === 2) {
      state.isPinching = true;
      state.isDragging = false;
      state.initialDistance = getDistance(touches);
      state.initialScale = scale;
      state.initialTranslate = { ...translate };
      state.initialCenter = getCenter(touches);
    } else if (touches.length === 1 && scale > 1) {
      state.isDragging = true;
      state.isPinching = false;
      state.startTouch = { x: touches[0].clientX, y: touches[0].clientY };
      state.initialTranslate = { ...translate };
    }
  }, [scale, translate]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const touches = e.touches;
    const state = touchStateRef.current;

    if (state.isPinching && touches.length === 2) {
      e.preventDefault();

      const currentDistance = getDistance(touches);
      const currentCenter = getCenter(touches);
      let newScale = state.initialScale * (currentDistance / state.initialDistance);
      newScale = Math.max(1, Math.min(5, newScale));

      const centerDeltaX = currentCenter.x - state.initialCenter.x;
      const centerDeltaY = currentCenter.y - state.initialCenter.y;
      const newTranslate = clampTranslate(
        state.initialTranslate.x + centerDeltaX,
        state.initialTranslate.y + centerDeltaY,
        newScale
      );

      setScale(newScale);
      setTranslate(newTranslate);
    } else if (state.isDragging && touches.length === 1 && scale > 1) {
      e.preventDefault();

      const deltaX = touches[0].clientX - state.startTouch.x;
      const deltaY = touches[0].clientY - state.startTouch.y;
      const newTranslate = clampTranslate(
        state.initialTranslate.x + deltaX,
        state.initialTranslate.y + deltaY,
        scale
      );

      setTranslate(newTranslate);
    }
  }, [scale, clampTranslate]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    const state = touchStateRef.current;
    const now = Date.now();

    if (e.touches.length === 0 && !state.isPinching) {
      if (now - state.lastTouchEnd < 300) {
        if (scale > 1) {
          setScale(1);
          setTranslate({ x: 0, y: 0 });
        } else {
          setScale(2);
        }
      }
      state.lastTouchEnd = now;
    }

    if (e.touches.length < 2) {
      state.isPinching = false;
    }
    if (e.touches.length === 0) {
      state.isDragging = false;
      if (scale <= 1) {
        setTranslate({ x: 0, y: 0 });
      }
    }
  }, [scale]);

  const handleClick = useCallback(() => {
    if (scale <= 1) {
      onClose();
    }
  }, [scale, onClose]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 bg-black flex items-center justify-center touch-none"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleClick}
    >
      <img
        ref={imageRef}
        src={imageUrl}
        alt="Generated"
        className="max-w-full max-h-full object-contain select-none"
        style={{
          transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
          transition:
            touchStateRef.current.isPinching || touchStateRef.current.isDragging
              ? 'none'
              : 'transform 0.2s ease-out',
        }}
        draggable={false}
      />
      <button
        className="absolute top-4 right-4 p-2 bg-white/10 rounded-full z-10"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="w-6 h-6 text-white" />
      </button>
      {scale > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/60 rounded-full text-white text-sm">
          {scale.toFixed(1)}x
        </div>
      )}
    </div>
  );
};
