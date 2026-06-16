import { safeSha256 } from './vibeHash';
import { getVibes, saveVibe } from './vibeRepository';
import { getVibeTagPool, saveVibeTagPool } from './vibeTags';
import type { VibeData, VibeEncodings } from './vibeTypes';

const computeVibeHashes = async (vibe: VibeData): Promise<{ imageHash: string; metaHash: string }> => {
  const imagePayload = JSON.stringify({
    image: vibe.image || '',
    encodings: vibe.encodings || {},
  });
  const imageHash = await safeSha256(imagePayload);

  const metaPayload = JSON.stringify({
    id: vibe.id || '',
    image_hash: imageHash,
    importInfo: {
      strength: vibe.defaultStrength,
      information_extracted: vibe.defaultInfoExtracted,
    },
    name: vibe.name || '',
    tags: [...(vibe.tags || [])].sort(),
  });
  const metaHash = await safeSha256(metaPayload);

  return { imageHash, metaHash };
};

export const pushVibeToCloud = async (vibeId: string): Promise<{ success: boolean; message?: string }> => {
  const { uploadCloudVibe, updateCloudVibeMeta, getCurrentBotUserId } = await import('../botService');
  const botUserId = getCurrentBotUserId();
  if (!botUserId) return { success: false, message: '未Bot授权' };

  const vibes = await getVibes();
  const vibe = vibes.find(v => v.id === vibeId);
  if (!vibe) return { success: false, message: 'Vibe不存在' };

  const { imageHash: currentImageHash, metaHash: currentMetaHash } = await computeVibeHashes(vibe);
  const canDoMetaOnly = !!vibe.cloudFilename && vibe.imageHash === currentImageHash;

  if (canDoMetaOnly) {
    console.log(`[Sync] 推送 vibe ${vibe.id} (仅 meta，image 未变)`);
    const result = await updateCloudVibeMeta(vibe.cloudFilename!, {
      name: vibe.name,
      tags: vibe.tags || [],
      defaultStrength: vibe.defaultStrength,
      defaultInfoExtracted: vibe.defaultInfoExtracted,
    });
    if (result.success) {
      vibe.cloudSync = 'synced';
      vibe.cloudUpdatedAt = Date.now();
      vibe.cloudOwnerId = botUserId;
      vibe.imageHash = result.imageHash || currentImageHash;
      vibe.metaHash = result.metaHash || currentMetaHash;
      await saveVibe(vibe, { skipSync: true });
      return { success: true };
    }
    console.warn(`[Sync] meta 更新失败 (vibe ${vibe.id}): ${result.message}, 尝试完整 upload`);
  }

  console.log(`[Sync] 推送 vibe ${vibe.id} (完整 upload)`);
  const fullData: Record<string, unknown> = {
    identifier: 'novelai-vibe-transfer',
    version: 1,
    type: 'image',
    id: vibe.id,
    name: vibe.name,
    image: vibe.image,
    thumbnail: vibe.preview,
    encodings: vibe.encodings || {},
    createdAt: vibe.createdAt,
    importInfo: {
      strength: vibe.defaultStrength,
      information_extracted: vibe.defaultInfoExtracted,
    },
    tags: vibe.tags || [],
  };

  const result = await uploadCloudVibe(fullData, vibe.tags || [], vibe.cloudFilename);
  if (result.success) {
    vibe.cloudSync = 'synced';
    vibe.cloudFilename = result.filename;
    vibe.cloudUpdatedAt = Date.now();
    vibe.cloudOwnerId = botUserId;
    vibe.imageHash = result.imageHash || currentImageHash;
    vibe.metaHash = result.metaHash || currentMetaHash;
    await saveVibe(vibe, { skipSync: true });
    return { success: true };
  }

  vibe.cloudSync = 'error';
  await saveVibe(vibe, { skipSync: true });
  return { success: false, message: result.message };
};

export const pushAllToCloud = async (
  onProgress?: (current: number, total: number) => void
): Promise<{ pushed: number; skipped: number; failed: number }> => {
  const { getCurrentBotUserId } = await import('../botService');
  if (!getCurrentBotUserId()) return { pushed: 0, skipped: 0, failed: 0 };

  const vibes = await getVibes();
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < vibes.length; i++) {
    onProgress?.(i + 1, vibes.length);
    const r = await pushVibeToCloud(vibes[i].id);
    if (r.success) pushed++;
    else if (r.message === 'Vibe不存在') skipped++;
    else failed++;
  }
  return { pushed, skipped, failed };
};

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
  tagPoolSynced: boolean;
}

export class SyncProtocolMismatchError extends Error {
  serverVersion: number;
  requiredVersion: number;
  constructor(serverVersion: number, requiredVersion: number) {
    super(`服务器同步协议版本过低 (服务器=${serverVersion}, 需要≥${requiredVersion})`);
    this.name = 'SyncProtocolMismatchError';
    this.serverVersion = serverVersion;
    this.requiredVersion = requiredVersion;
  }
}

export const syncVibesFromCloud = async (
  onProgress?: (msg: string) => void
): Promise<SyncResult> => {
  const {
    getCloudVibesStrict,
    getCloudVibeFileStrict,
    getCloudTagPool,
    putCloudTagPool,
    getServerSyncVersion,
    REQUIRED_SYNC_PROTOCOL_VERSION,
    getCurrentBotUserId,
  } = await import('../botService');

  const botUserId = getCurrentBotUserId();
  if (!botUserId) throw new Error('未Bot授权');

  const serverVersion = await getServerSyncVersion();
  if (serverVersion < REQUIRED_SYNC_PROTOCOL_VERSION) {
    throw new SyncProtocolMismatchError(serverVersion, REQUIRED_SYNC_PROTOCOL_VERSION);
  }

  onProgress?.('获取云端数据...');
  const [cloudList, cloudTagPool] = await Promise.all([
    getCloudVibesStrict(),
    getCloudTagPool(),
  ]);

  console.log(`[Restore] 云端 vibes=${cloudList.length}, 标签池=${cloudTagPool.length}`);

  const localVibes = await getVibes();
  const localById = new Map(localVibes.map(v => [v.id, v]));

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < cloudList.length; i++) {
    const cloud = cloudList[i];
    onProgress?.(`下载中 ${i + 1}/${cloudList.length}...`);
    const local = localById.get(cloud.id);

    if (!local) {
      const full = await getCloudVibeFileStrict(cloud.filename);
      const supportedModels = full.encodings ? Object.keys(full.encodings as Record<string, unknown>) : [];
      await saveVibe({
        id: (full.id as string) || cloud.id,
        name: (full.name as string) || cloud.name,
        size: '',
        preview: (full.thumbnail as string) || '',
        image: (full.image as string) || '',
        encodings: (full.encodings as VibeEncodings) || {},
        createdAt: (full.createdAt as number) || cloud.createdAt || Date.now(),
        defaultStrength: ((full.importInfo as Record<string, unknown>) || {}).strength as number | undefined,
        defaultInfoExtracted: ((full.importInfo as Record<string, unknown>) || {}).information_extracted as number | undefined,
        supportedModels,
        tags: (full.tags as string[]) || cloud.tags || [],
        cloudSync: 'synced',
        cloudFilename: cloud.filename,
        cloudUpdatedAt: cloud.updatedAt,
        cloudOwnerId: botUserId,
        imageHash: cloud.imageHash,
        metaHash: cloud.metaHash,
      });
      added++;
      continue;
    }

    if (cloud.metaHash && local.metaHash === cloud.metaHash) {
      skipped++;
      continue;
    }

    const full = await getCloudVibeFileStrict(cloud.filename);
    const supportedModels = full.encodings ? Object.keys(full.encodings as Record<string, unknown>) : [];
    local.name = (full.name as string) || local.name;
    local.preview = (full.thumbnail as string) || local.preview;
    local.image = (full.image as string) || local.image;
    local.encodings = (full.encodings as VibeEncodings) || local.encodings;
    local.defaultStrength = ((full.importInfo as Record<string, unknown>) || {}).strength as number | undefined ?? local.defaultStrength;
    local.defaultInfoExtracted = ((full.importInfo as Record<string, unknown>) || {}).information_extracted as number | undefined ?? local.defaultInfoExtracted;
    local.supportedModels = supportedModels;
    local.tags = (full.tags as string[]) || cloud.tags || [];
    local.cloudSync = 'synced';
    local.cloudFilename = cloud.filename;
    local.cloudUpdatedAt = cloud.updatedAt;
    local.cloudOwnerId = botUserId;
    local.imageHash = cloud.imageHash;
    local.metaHash = cloud.metaHash;
    await saveVibe(local);
    updated++;
  }

  let tagPoolSynced = false;
  try {
    const localPool = await getVibeTagPool();
    const finalVibes = await getVibes();
    const usedInVibes = new Set<string>();
    for (const v of finalVibes) {
      if (v.tags) v.tags.forEach(t => { if (typeof t === 'string' && t) usedInVibes.add(t); });
    }
    const merged = Array.from(new Set([...cloudTagPool, ...localPool, ...usedInVibes]))
      .filter(t => typeof t === 'string' && t.length > 0)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    saveVibeTagPool(merged);
    const cloudSorted = [...cloudTagPool].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (merged.length !== cloudSorted.length || merged.some((t, i) => t !== cloudSorted[i])) {
      await putCloudTagPool(merged);
    }
    tagPoolSynced = true;
  } catch (e) {
    console.error('[Restore] 标签池合并失败:', e);
  }

  return { added, updated, skipped, tagPoolSynced };
};
