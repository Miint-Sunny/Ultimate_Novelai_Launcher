import {
  getVibes,
  saveVibe,
  type VibeData,
} from './localLibrary';
import {
  getOCs,
  saveOC,
  getArtists,
  saveArtist,
  getCRs,
  saveCR,
  type OCData,
  type ArtistData,
  type CRData,
} from './localLibrary';

// 需要备份的 localStorage key
const BACKUP_LOCALSTORAGE_KEYS = [
  'novelai_app_settings',
  'novelai_ai_settings',
  'novelai_prompt_presets',
  'novelai_active_preset',
] as const;

// 备份文件的格式标识,导入时逐字比对:沿用旧项目名是故意的,改了以前导出的备份就导不进来了。
const BACKUP_IDENTIFIER = 'novelai-web-ui-backup';
const BACKUP_VERSION = 1;

export interface BackupData {
  meta: {
    identifier: string;
    version: number;
    createdAt: string;
    createdAtTimestamp: number;
  };
  localStorage: Record<string, string>;
  indexedDB: {
    vibes: VibeData[];
    oc_files: OCData[];
    artist_files: ArtistData[];
    cr_files: CRData[];
  };
}

export interface BackupSummary {
  createdAt: string;
  vibeCount: number;
  ocCount: number;
  artistCount: number;
  crCount: number;
  localStorageKeyCount: number;
}

export interface RestoreResult {
  success: boolean;
  errors: string[];
  restored: {
    localStorageKeys: number;
    vibes: number;
    ocs: number;
    artists: number;
    crs: number;
  };
}

export interface ExportOptions {
  settings: boolean;
  presets: boolean;
  vibes: boolean;
  ocs: boolean;
  artists: boolean;
  crs: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  settings: true,
  presets: true,
  vibes: true,
  ocs: true,
  artists: true,
  crs: true,
};

// 获取各项数据的数量（用于导出前预览）
export const getDataCounts = async (): Promise<{
  vibes: number;
  ocs: number;
  artists: number;
  crs: number;
  presets: number;
}> => {
  const [vibes, ocs, artists, crs] = await Promise.all([
    getVibes(),
    getOCs(),
    getArtists(),
    getCRs(),
  ]);
  const presetsRaw = localStorage.getItem('novelai_prompt_presets');
  let presetCount = 0;
  if (presetsRaw) {
    try {
      const parsed = JSON.parse(presetsRaw);
      presetCount = Array.isArray(parsed) ? parsed.filter((p: { isDefault?: boolean }) => !p.isDefault).length : 0;
    } catch { /* ignore */ }
  }
  return {
    vibes: vibes.length,
    ocs: ocs.length,
    artists: artists.length,
    crs: crs.length,
    presets: presetCount,
  };
};

export const exportBackup = async (options: ExportOptions = DEFAULT_EXPORT_OPTIONS): Promise<void> => {
  // 收集 localStorage 数据
  const localStorageData: Record<string, string> = {};
  if (options.settings) {
    for (const key of ['novelai_app_settings', 'novelai_ai_settings'] as const) {
      const value = localStorage.getItem(key);
      if (value !== null) localStorageData[key] = value;
    }
  }
  if (options.presets) {
    for (const key of ['novelai_prompt_presets', 'novelai_active_preset'] as const) {
      const value = localStorage.getItem(key);
      if (value !== null) localStorageData[key] = value;
    }
  }

  // 收集 IndexedDB 数据
  const [vibes, ocs, artists, crs] = await Promise.all([
    options.vibes ? getVibes() : Promise.resolve([]),
    options.ocs ? getOCs() : Promise.resolve([]),
    options.artists ? getArtists() : Promise.resolve([]),
    options.crs ? getCRs() : Promise.resolve([]),
  ]);

  const now = new Date();
  const backup: BackupData = {
    meta: {
      identifier: BACKUP_IDENTIFIER,
      version: BACKUP_VERSION,
      createdAt: now.toISOString(),
      createdAtTimestamp: now.getTime(),
    },
    localStorage: localStorageData,
    indexedDB: {
      vibes,
      oc_files: ocs,
      artist_files: artists,
      cr_files: crs,
    },
  };

  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const pad = (n: number) => n.toString().padStart(2, '0');
  const filename = `novelai_backup_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const parseAndPreviewBackup = (file: File): Promise<{ summary: BackupSummary; data: BackupData }> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as BackupData;

        if (data.meta?.identifier !== BACKUP_IDENTIFIER) {
          reject(new Error('无效的备份文件：文件标识不匹配'));
          return;
        }
        if (data.meta?.version !== BACKUP_VERSION) {
          reject(new Error(`不支持的备份版本：${data.meta?.version}`));
          return;
        }
        if (!data.localStorage || !data.indexedDB) {
          reject(new Error('无效的备份文件：数据结构不完整'));
          return;
        }

        const summary: BackupSummary = {
          createdAt: data.meta.createdAt,
          vibeCount: data.indexedDB.vibes?.length ?? 0,
          ocCount: data.indexedDB.oc_files?.length ?? 0,
          artistCount: data.indexedDB.artist_files?.length ?? 0,
          crCount: data.indexedDB.cr_files?.length ?? 0,
          localStorageKeyCount: Object.keys(data.localStorage).length,
        };

        resolve({ summary, data });
      } catch {
        reject(new Error('无法解析备份文件：JSON 格式错误'));
      }
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
};

export const restoreBackup = async (data: BackupData): Promise<RestoreResult> => {
  const errors: string[] = [];
  const restored = { localStorageKeys: 0, vibes: 0, ocs: 0, artists: 0, crs: 0 };

  // 恢复 localStorage
  for (const [key, value] of Object.entries(data.localStorage)) {
    try {
      localStorage.setItem(key, value);
      restored.localStorageKeys++;
    } catch (e) {
      errors.push(`localStorage "${key}" 写入失败: ${e}`);
    }
  }

  // 恢复 IndexedDB - vibes
  for (const vibe of data.indexedDB.vibes ?? []) {
    try {
      await saveVibe(vibe);
      restored.vibes++;
    } catch (e) {
      errors.push(`Vibe "${vibe.name}" 写入失败: ${e}`);
    }
  }

  // 恢复 IndexedDB - OCs
  for (const oc of data.indexedDB.oc_files ?? []) {
    try {
      await saveOC(oc);
      restored.ocs++;
    } catch (e) {
      errors.push(`OC "${oc.name}" 写入失败: ${e}`);
    }
  }

  // 恢复 IndexedDB - Artists
  for (const artist of data.indexedDB.artist_files ?? []) {
    try {
      await saveArtist(artist);
      restored.artists++;
    } catch (e) {
      errors.push(`画师 "${artist.name}" 写入失败: ${e}`);
    }
  }

  // 恢复 IndexedDB - CRs
  for (const cr of data.indexedDB.cr_files ?? []) {
    try {
      await saveCR(cr);
      restored.crs++;
    } catch (e) {
      errors.push(`精准参考 "${cr.name}" 写入失败: ${e}`);
    }
  }

  return {
    success: errors.length === 0,
    errors,
    restored,
  };
};
