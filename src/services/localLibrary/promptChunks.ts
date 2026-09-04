import { PROMPT_CHUNK_STORE } from './idb';
import { deleteRecord, getAllRecords, putRecord } from './records';

/**
 * 提示词片段(官方 Prompt Chunks)的本地库。
 *
 * 只存本地:官方把片段放在账号侧并用 keystore 加密,持久 token 解不开,
 * 见 services/promptChunkMacros 头注。文本契约(引用写法、展开规则)也在那边,
 * 这里只管记录的增删改查。
 */
export interface PromptChunkData {
  id: string;
  /** 引用用的名字,区分大小写;同名会互相遮住,保存时要查重。 */
  label: string;
  expansion: string;
  color?: string;
  /** 文件夹名;空 = 根。官方是树状 childOrder,我们一层够用。 */
  category?: string;
  createdAt: number;
  updatedAt: number;
}

export const savePromptChunk = async (
  chunk: Omit<PromptChunkData, 'createdAt' | 'updatedAt'> & { createdAt?: number },
): Promise<PromptChunkData> => {
  const now = Date.now();
  const data: PromptChunkData = {
    ...chunk,
    label: chunk.label.trim(),
    category: chunk.category?.trim() || undefined,
    createdAt: chunk.createdAt || now,
    updatedAt: now,
  };
  return putRecord(PROMPT_CHUNK_STORE, data);
};

/** 按文件夹再按创建时间排,列表和 `@` 菜单共用这个顺序。 */
export const getPromptChunks = async (): Promise<PromptChunkData[]> => {
  const all = await getAllRecords<PromptChunkData>(PROMPT_CHUNK_STORE);
  return all.sort((a, b) =>
    (a.category ?? '').localeCompare(b.category ?? '') || a.createdAt - b.createdAt,
  );
};

export const deletePromptChunk = async (id: string): Promise<void> => {
  return deleteRecord(PROMPT_CHUNK_STORE, id);
};
