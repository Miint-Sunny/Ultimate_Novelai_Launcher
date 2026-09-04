import { useCallback, useEffect, useState } from 'react';
import {
  deletePromptChunk,
  getPromptChunks,
  savePromptChunk,
  type PromptChunkData,
} from '../../services/localLibrary/promptChunks';

/** 片段库的读写壳:列表缓存 + 增删改后重读。同名查重在这里做,存储层不管。 */
export function usePromptChunks(enabled: boolean) {
  const [chunks, setChunks] = useState<PromptChunkData[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      setChunks(await getPromptChunks());
    } catch {
      setChunks([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const save = useCallback(async (
    chunk: Omit<PromptChunkData, 'createdAt' | 'updatedAt'> & { createdAt?: number },
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const label = chunk.label.trim();
    // 引用按名字找,同名的两条会互相遮住——存进去也没法用,直接拒绝。
    const clash = chunks.find((existing) => existing.label === label && existing.id !== chunk.id);
    if (clash) return { ok: false, reason: `已经有一条叫「${label}」的片段` };
    await savePromptChunk({ ...chunk, label });
    await reload();
    return { ok: true };
  }, [chunks, reload]);

  const remove = useCallback(async (id: string) => {
    await deletePromptChunk(id);
    await reload();
  }, [reload]);

  return { chunks, loaded, reload, save, remove };
}
