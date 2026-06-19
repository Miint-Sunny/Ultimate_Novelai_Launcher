import { useEffect, useRef, useState } from 'react';

export interface InpaintContainerSize {
  width: number;
  height: number;
}

export function useInpaintContainerSize() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState<InpaintContainerSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    setContainerSize(prev => (prev.width === width && prev.height === height) ? prev : { width, height });
  });

  return { containerRef, containerSize };
}
