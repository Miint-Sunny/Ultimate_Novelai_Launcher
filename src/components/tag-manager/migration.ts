// 老 localStorage key 迁移到新的按 subtype 命名的 key
// 仅执行一次,通过 tag_manager_migration_v1_done 标记

const MIGRATION_KEY = 'tag_manager_migration_v1_done';
const MIGRATION_AT_KEY = 'tag_manager_migration_v1_at';

const MIGRATIONS: Array<[string, string]> = [
  ['artist_usage_order', 'usage_order:artist-style'],
  ['artist_tag_pool', 'tag_pool:artist-style'],
];

export function migrateLegacyKeys(): boolean {
  if (typeof window === 'undefined') return false;
  if (localStorage.getItem(MIGRATION_KEY) === '1') return false;

  let migratedAny = false;
  for (const [oldKey, newKey] of MIGRATIONS) {
    const oldVal = localStorage.getItem(oldKey);
    if (oldVal !== null && localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, oldVal);
      migratedAny = true;
    }
  }

  localStorage.setItem(MIGRATION_KEY, '1');
  localStorage.setItem(MIGRATION_AT_KEY, Date.now().toString());
  return migratedAny;
}
