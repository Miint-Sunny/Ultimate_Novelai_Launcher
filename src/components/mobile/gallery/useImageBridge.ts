import { useCallback, useRef, useState } from 'react';

// 桥接层(对齐 Plana 顶图层):当前展示 URL 因非拖动原因切换(生成完成
// preview→成图、点胶片条/网格跳选、老图从盘上读出)时,保留上一张**已成功
// 加载的真图**盖在画布上,直到新 <img> onLoad 才撤。不垫 cover 裁切的缩略图
// (拉到全画布会变形);拖动翻页/跟随生成预览期间挂起不盖 —— 邻页/预览自己的
// img 直接显示,盖上去反而把跟手的半页画面糊死。
const LOADED_URL_CAP = 120; // 已解码 URL 登记上限(只存字符串,防无限增长)

export function useImageBridge(displayUrl: string | null, suspended: boolean) {
  const loadedRef = useRef<Set<string>>(new Set());
  const lastLoadedRef = useRef<string | null>(null);
  const [, bump] = useState(0);

  // 各页 <img> onLoad 回报:登记已解码 URL 并触发重渲染以撤下桥接层
  const notifyLoaded = useCallback((url: string) => {
    const loaded = loadedRef.current;
    if (!loaded.has(url)) {
      loaded.add(url);
      if (loaded.size > LOADED_URL_CAP) {
        const oldest = loaded.values().next().value;
        if (oldest !== undefined) loaded.delete(oldest);
      }
    }
    lastLoadedRef.current = url;
    bump((n) => n + 1);
  }, []);

  const bridgeUrl =
    !suspended && displayUrl && !loadedRef.current.has(displayUrl)
      ? lastLoadedRef.current
      : null;

  return { bridgeUrl, notifyLoaded };
}
