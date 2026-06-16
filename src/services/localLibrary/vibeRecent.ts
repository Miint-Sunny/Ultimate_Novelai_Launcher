const VIBE_USAGE_ORDER_KEY = 'vibe_usage_order';
const RECENT_VIBE_MAX = 30;

export interface RecentVibeEntry {
  id: string;
  name: string;
  preview: string;
  lastUsed: number;
}

export const getRecentVibeEntries = (): RecentVibeEntry[] => {
  try {
    const raw = localStorage.getItem(VIBE_USAGE_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    if (parsed.length > 0 && typeof parsed[0] === 'string') {
      return (parsed as string[]).map(id => ({ id, name: id, preview: '', lastUsed: 0 }));
    }

    const valid: RecentVibeEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id : null;
      if (!id) continue;
      valid.push({
        id,
        name: typeof item.name === 'string' ? item.name : id,
        preview: typeof item.preview === 'string' ? item.preview : '',
        lastUsed: typeof item.lastUsed === 'number' ? item.lastUsed : 0,
      });
    }
    if (valid.length !== parsed.length) {
      try {
        localStorage.setItem(VIBE_USAGE_ORDER_KEY, JSON.stringify(valid));
      } catch { }
    }
    return valid;
  } catch {
    return [];
  }
};

const saveRecentVibeEntries = (entries: RecentVibeEntry[]): void => {
  try {
    const trimmed = entries.slice(0, RECENT_VIBE_MAX);
    localStorage.setItem(VIBE_USAGE_ORDER_KEY, JSON.stringify(trimmed));
  } catch { }
};

export const recordVibeUsage = (vibe: { id: string; name?: string; preview?: string }): void => {
  if (!vibe?.id) return;
  const entries = getRecentVibeEntries();
  const next: RecentVibeEntry = {
    id: vibe.id,
    name: vibe.name || vibe.id,
    preview: vibe.preview || '',
    lastUsed: Date.now(),
  };
  const filtered = entries.filter(e => e.id !== vibe.id);
  saveRecentVibeEntries([next, ...filtered]);
};

export const recordVibeUsageBatch = (vibes: Array<{ id: string; name?: string; preview?: string }>): void => {
  if (!vibes.length) return;
  const entries = getRecentVibeEntries();
  const ids = new Set(vibes.map(v => v.id));
  const filtered = entries.filter(e => !ids.has(e.id));
  const newEntries: RecentVibeEntry[] = vibes.map(v => ({
    id: v.id,
    name: v.name || v.id,
    preview: v.preview || '',
    lastUsed: Date.now(),
  }));
  saveRecentVibeEntries([...newEntries, ...filtered]);
};

export const removeRecentVibeEntry = (id: string): void => {
  const entries = getRecentVibeEntries();
  saveRecentVibeEntries(entries.filter(e => e.id !== id));
};

export const clearRecentVibeEntries = (): void => {
  saveRecentVibeEntries([]);
};
