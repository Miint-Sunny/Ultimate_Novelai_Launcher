import { getVibes, saveVibe } from './vibeRepository';

const VIBE_TAG_POOL_KEY = 'vibe_tag_pool';
const FAVORITED_VIBE_IDS_KEY = 'favorited_vibe_ids';
const FAVORITED_MIGRATION_KEY = 'favorited_to_tag_migrated';
const FAVORITED_TAG_NAME = '收藏';

export const getVibeTagPool = async (): Promise<string[]> => {
  let pool: string[] = [];
  try {
    const saved = localStorage.getItem(VIBE_TAG_POOL_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        pool = parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
      }
    }
  } catch { pool = []; }

  const vibes = await getVibes();
  const used = new Set<string>(pool);
  for (const v of vibes) {
    if (v.tags) {
      for (const t of v.tags) {
        if (typeof t === 'string' && t.length > 0) used.add(t);
      }
    }
  }
  return Array.from(used).sort((a, b) => a.localeCompare(b, 'zh-CN'));
};

export const saveVibeTagPool = (tags: string[]): void => {
  try {
    const dedup = Array.from(new Set(tags));
    localStorage.setItem(VIBE_TAG_POOL_KEY, JSON.stringify(dedup));
  } catch { }
};

export const setVibeTags = async (vibeId: string, tags: string[]): Promise<void> => {
  const vibes = await getVibes();
  const vibe = vibes.find(v => v.id === vibeId);
  if (!vibe) return;
  vibe.tags = Array.from(new Set(tags));
  await saveVibe(vibe);

  const pool = await getVibeTagPool();
  saveVibeTagPool(Array.from(new Set([...pool, ...vibe.tags])));
};

export const renameVibeTag = async (oldName: string, newName: string): Promise<void> => {
  const vibes = await getVibes();
  for (const v of vibes) {
    if (v.tags && v.tags.includes(oldName)) {
      v.tags = v.tags.map(t => (t === oldName ? newName : t));
      await saveVibe(v);
    }
  }
  const pool = await getVibeTagPool();
  const updated = pool.filter(t => t !== oldName);
  if (!updated.includes(newName)) updated.push(newName);
  saveVibeTagPool(updated);
};

export const deleteVibeTag = async (name: string): Promise<void> => {
  const vibes = await getVibes();
  for (const v of vibes) {
    if (v.tags && v.tags.includes(name)) {
      v.tags = v.tags.filter(t => t !== name);
      await saveVibe(v);
    }
  }
  const pool = await getVibeTagPool();
  saveVibeTagPool(pool.filter(t => t !== name));
};

export const migrateFavoritedToTag = async (): Promise<void> => {
  try {
    if (localStorage.getItem(FAVORITED_MIGRATION_KEY) === '1') return;
    const raw = localStorage.getItem(FAVORITED_VIBE_IDS_KEY);
    if (!raw) {
      localStorage.setItem(FAVORITED_MIGRATION_KEY, '1');
      return;
    }
    let favIds: string[] = [];
    try { favIds = JSON.parse(raw); } catch { favIds = []; }
    if (favIds.length > 0) {
      const vibes = await getVibes();
      for (const v of vibes) {
        if (favIds.includes(v.id)) {
          v.tags = Array.from(new Set([...(v.tags || []), FAVORITED_TAG_NAME]));
          await saveVibe(v);
        }
      }
      const pool = await getVibeTagPool();
      if (!pool.includes(FAVORITED_TAG_NAME)) {
        saveVibeTagPool([...pool, FAVORITED_TAG_NAME]);
      }
    }
    localStorage.removeItem(FAVORITED_VIBE_IDS_KEY);
    localStorage.setItem(FAVORITED_MIGRATION_KEY, '1');
  } catch (e) {
    console.warn('迁移收藏到标签失败:', e);
  }
};
