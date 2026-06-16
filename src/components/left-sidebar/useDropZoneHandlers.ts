import { useCallback, useRef, useState } from 'react';
import type { DragEvent, MutableRefObject } from 'react';

type DropHandler = (file: File, dataUrl: string) => void;

function createDropZoneHandlers(
  setActive: (active: boolean) => void,
  onDrop: DropHandler,
  acceptVibeFiles: boolean,
  dragCounterRef: MutableRefObject<number>,
) {
  return {
    onDragEnter: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current++;
      if (event.dataTransfer.types.includes('Files')) {
        setActive(true);
      }
    },
    onDragLeave: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setActive(false);
      }
    },
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragCounterRef.current = 0;
      setActive(false);

      const file = Array.from(event.dataTransfer.files)[0];
      if (!file) return;

      const isVibeFile = file.name.toLowerCase().endsWith('.naiv4vibe');
      const isImage = file.type.startsWith('image/');

      if (!acceptVibeFiles && isVibeFile) return;
      if (!isVibeFile && !isImage) return;

      const reader = new FileReader();
      reader.onloadend = () => {
        onDrop(file, reader.result as string);
      };
      reader.readAsDataURL(file);
    },
  };
}

export function useDropZoneHandlers() {
  const [img2imgDropActive, setImg2imgDropActive] = useState(false);
  const [vibeDropActive, setVibeDropActive] = useState(false);
  const [crDropActive, setCrDropActive] = useState(false);

  const img2imgDragCounterRef = useRef(0);
  const vibeDragCounterRef = useRef(0);
  const crDragCounterRef = useRef(0);

  const getDropZoneHandlers = useCallback((
    setActive: (active: boolean) => void,
    onDrop: DropHandler,
    acceptVibeFiles: boolean,
    dragCounterRef: MutableRefObject<number>,
  ) => createDropZoneHandlers(setActive, onDrop, acceptVibeFiles, dragCounterRef), []);

  return {
    img2imgDropActive,
    setImg2imgDropActive,
    vibeDropActive,
    setVibeDropActive,
    crDropActive,
    setCrDropActive,
    img2imgDragCounterRef,
    vibeDragCounterRef,
    crDragCounterRef,
    createDropZoneHandlers: getDropZoneHandlers,
  };
}
