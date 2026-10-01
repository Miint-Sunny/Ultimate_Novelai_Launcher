import { useCallback, useRef, useState } from 'react';
import type React from 'react';
import { useShellLayout } from '../desktop/ShellLayoutContext';
import { clampSidebarWidth } from '../desktop/shellLayout';

export function usePromptBoxResize() {
  const [promptBoxHeight, setPromptBoxHeight] = useState(250);
  const promptBaseHeight = useRef(250);
  const promptContentHeightsRef = useRef<Record<string, number>>({ prompt: 0, undesired: 0 });
  const activeTabRef = useRef<string>('prompt');
  const isDraggingPromptBox = useRef(false);
  const promptBoxStartY = useRef(0);
  const promptBoxStartHeight = useRef(0);

  const handlePromptBoxMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingPromptBox.current = true;
    promptBoxStartY.current = e.clientY;
    promptBoxStartHeight.current = promptBoxHeight;

    const handleMouseMove = (mouseEvent: MouseEvent) => {
      if (!isDraggingPromptBox.current) return;
      const dy = mouseEvent.clientY - promptBoxStartY.current;
      const newHeight = Math.max(250, promptBoxStartHeight.current + dy);
      promptBaseHeight.current = newHeight;
      setPromptBoxHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDraggingPromptBox.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  }, [promptBoxHeight]);

  return {
    promptBoxHeight,
    setPromptBoxHeight,
    promptBaseHeight,
    promptContentHeightsRef,
    activeTabRef,
    isDraggingPromptBox,
    handlePromptBoxMouseDown,
  };
}

/**
 * 左栏拖宽。宽度本身由 ShellLayoutContext 和右栏、视口一起分配(设计 px,渲染成 rem),
 * 这里只把鼠标位移换算回设计 px 再交上去,松手时落盘。
 */
export function useSidebarResize() {
  const { sidebar, scale, setSidebarWidth, commitSidebarWidth } = useShellLayout();
  const isDraggingSidebar = useRef(false);

  const handleSidebarMouseDown = useCallback((e: React.MouseEvent) => {
    isDraggingSidebar.current = true;
    const startX = e.clientX;
    // 从屏幕上实际的宽度起拖:空间不够时它可能比用户要的窄
    const startWidth = sidebar;
    let lastWidth = startWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (mouseEvent: MouseEvent) => {
      if (!isDraggingSidebar.current) return;
      lastWidth = clampSidebarWidth(startWidth + (mouseEvent.clientX - startX) / scale);
      setSidebarWidth(lastWidth);
    };

    const handleMouseUp = () => {
      isDraggingSidebar.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      commitSidebarWidth(lastWidth);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  }, [sidebar, scale, setSidebarWidth, commitSidebarWidth]);

  return {
    sidebarWidth: sidebar,
    handleSidebarMouseDown,
  };
}

export function useCharacterPromptResize() {
  const [charHeights, setCharHeights] = useState<Record<string, number>>({});
  const charBaseHeights = useRef<Record<string, number>>({});
  const charContentHeightsRef = useRef<Record<string, number>>({});
  const isDraggingChar = useRef<string | null>(null);
  const charStartY = useRef(0);
  const charStartHeight = useRef(0);

  const handleCharMouseDown = useCallback((e: React.MouseEvent, charId: string) => {
    isDraggingChar.current = charId;
    charStartY.current = e.clientY;
    charStartHeight.current = charHeights[charId] || 150;

    const handleMouseMove = (mouseEvent: MouseEvent) => {
      if (!isDraggingChar.current) return;
      const dy = mouseEvent.clientY - charStartY.current;
      const newHeight = Math.max(150, charStartHeight.current + dy);
      const cid = isDraggingChar.current;
      charBaseHeights.current[cid] = newHeight;
      setCharHeights(prev => ({ ...prev, [cid]: newHeight }));
    };

    const handleMouseUp = () => {
      isDraggingChar.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    e.preventDefault();
  }, [charHeights]);

  return {
    charHeights,
    setCharHeights,
    charBaseHeights,
    charContentHeightsRef,
    isDraggingChar,
    handleCharMouseDown,
  };
}
