import { useEffect, useState } from 'react';

export function useFullscreenViewportHeight(isOpen: boolean) {
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const viewport = window.visualViewport;
    if (!viewport) return;
    const handleResize = () => setViewportHeight(viewport.height);
    handleResize();
    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleResize);
    return () => {
      viewport.removeEventListener('resize', handleResize);
      viewport.removeEventListener('scroll', handleResize);
    };
  }, [isOpen]);

  return viewportHeight;
}
