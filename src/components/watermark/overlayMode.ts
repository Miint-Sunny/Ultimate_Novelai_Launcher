/**
 * 水印画板定位模式的共享状态:设置页按「在画板上调整」进入,画板上的覆盖层退出。
 * 顺带记下画板当前显示的图,设置页的「在当前图上选一次」用它,不用把整个生成上下文
 * 塞进设置弹窗。
 */

import { useSyncExternalStore } from 'react';

interface WatermarkUiState {
  overlayOn: boolean;
  canvasImageUrl: string | null;
}

let state: WatermarkUiState = { overlayOn: false, canvasImageUrl: null };
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setWatermarkOverlayMode(on: boolean): void {
  if (state.overlayOn === on) return;
  state = { ...state, overlayOn: on };
  emit();
}

export function publishCanvasImage(url: string | null): void {
  if (state.canvasImageUrl === url) return;
  state = { ...state, canvasImageUrl: url };
  emit();
}

export function useWatermarkOverlayMode(): boolean {
  return useSyncExternalStore(subscribe, () => state.overlayOn, () => false);
}

export function useCanvasImageUrl(): string | null {
  return useSyncExternalStore(subscribe, () => state.canvasImageUrl, () => null);
}
