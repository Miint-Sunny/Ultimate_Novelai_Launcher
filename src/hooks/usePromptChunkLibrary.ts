import { useEffect, useSyncExternalStore } from 'react';
import {
  getCachedPromptChunks,
  refreshPromptChunkCache,
  subscribePromptChunkCache,
} from '../services/promptChunkCache';

/** 片段库的响应式快照:挂载时拉一次,之后跟着增删改重渲染。 */
export function usePromptChunkLibrary() {
  const chunks = useSyncExternalStore(subscribePromptChunkCache, getCachedPromptChunks, getCachedPromptChunks);
  useEffect(() => {
    void refreshPromptChunkCache();
  }, []);
  return chunks;
}
