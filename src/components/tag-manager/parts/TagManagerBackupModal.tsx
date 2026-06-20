// 统一 Tag 管理器 - 4 分类数据备份
// 画风(artist):云端 API 备份 + 本地 JSON 导出/导入
// 角色 / 场景 / 其他:本地 JSON 导出/导入(后端暂无 API)
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Cloud, Download, Loader2, Upload, X,
  User, Palette, Mountain, Tag as TagIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  getCustomTags, saveCustomTag,
  type CustomTagData,
} from '../../../services/localLibrary';
import {
  getArtists, saveArtist, getOCs, saveOC,
  type ArtistData, type OCData,
} from '../../../services/localLibrary';
import {
  getCurrentBotUserId, recordBackup,
  getTagBackupAll, uploadTagBackupAll,
} from '../../../services/botService';
import { useConfirm } from './useConfirm';

type CategoryId = 'character' | 'artist-style' | 'scene' | 'other';

interface CategoryConfig {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  hasCloud: boolean;
}

const CATEGORIES: CategoryConfig[] = [
  { id: 'character', label: '角色', icon: User, hasCloud: true },
  { id: 'artist-style', label: '画风', icon: Palette, hasCloud: true },
  { id: 'scene', label: '场景', icon: Mountain, hasCloud: true },
  { id: 'other', label: '其他', icon: TagIcon, hasCloud: true },
];

interface CategoryStats {
  localCount: number;
  cloudCount: number | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onDataChanged?: () => void;
}

const BACKUP_IDENTIFIER = 'tag-manager-backup';
const BACKUP_VERSION = 1;

interface BackupFile {
  identifier: string;
  version: number;
  category: CategoryId;
  exportedAt: string;
  count: number;
  items: Array<Record<string, unknown>>;
}

export const TagManagerBackupModal: React.FC<Props> = ({ isOpen, onClose, onDataChanged }) => {
  const [stats, setStats] = useState<Record<CategoryId, CategoryStats>>({
    'character': { localCount: 0, cloudCount: null },
    'artist-style': { localCount: 0, cloudCount: null },
    'scene': { localCount: 0, cloudCount: null },
    'other': { localCount: 0, cloudCount: null },
  });
  const [busyCategory, setBusyCategory] = useState<CategoryId | null>(null);
  const [busyAction, setBusyAction] = useState<'export' | 'import' | null>(null);
  // 云端备份/恢复是整包操作,不属于某一类,独立状态
  const [cloudBusy, setCloudBusy] = useState<'backup' | 'restore' | null>(null);
  // 云端整包备份的上次更新时间 (unix seconds); 0 表示无备份
  const [cloudUpdatedAt, setCloudUpdatedAt] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImportCategoryRef = useRef<CategoryId | null>(null);

  const isAuthed = !!getCurrentBotUserId();
  const { confirm, confirmDialog } = useConfirm();

  // 操作日志只输出到控制台,UI 不再展示
  const addLog = useCallback((type: 'ok' | 'error', msg: string) => {
    if (type === 'error') console.warn('[TagBackup]', msg);
    else console.log('[TagBackup]', msg);
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const [artists, ocs, customTags] = await Promise.all([
        getArtists(),
        getOCs(),
        getCustomTags(),
      ]);
      const artistLocal = artists.filter(a => a.isLocal).length;
      const ocLocal = ocs.filter(o => o.isLocal).length;
      const sceneLocal = customTags.filter(t => t.subtypeId === 'scene').length;
      const otherLocal = customTags.filter(t => t.subtypeId === 'other').length;

      let cloudCounts: Record<CategoryId, number | null> = {
        'character': null, 'artist-style': null, 'scene': null, 'other': null,
      };
      if (isAuthed) {
        try {
          const b = await getTagBackupAll();
          cloudCounts = {
            'character': b.counts['character'] ?? 0,
            'artist-style': b.counts['artist-style'] ?? 0,
            'scene': b.counts['scene'] ?? 0,
            'other': b.counts['other'] ?? 0,
          };
          setCloudUpdatedAt(b.updated_at || 0);
        } catch { /* ignore */ }
      } else {
        setCloudUpdatedAt(0);
      }
      setStats({
        'character': { localCount: ocLocal, cloudCount: cloudCounts['character'] },
        'artist-style': { localCount: artistLocal, cloudCount: cloudCounts['artist-style'] },
        'scene': { localCount: sceneLocal, cloudCount: cloudCounts['scene'] },
        'other': { localCount: otherLocal, cloudCount: cloudCounts['other'] },
      });
    } catch (err) {
      console.warn('[TagManagerBackup] loadStats failed', err);
    }
  }, [isAuthed]);

  useEffect(() => {
    if (!isOpen) return;
    loadStats();
  }, [isOpen, loadStats]);

  useEffect(() => {
    if (!isOpen) return;
    const fn = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busyCategory && !cloudBusy) onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [isOpen, onClose, busyCategory, cloudBusy]);

  // 收集 4 类本地数据 → 用于打包上传
  const collectAllLocals = async (): Promise<Record<CategoryId, Array<Record<string, unknown>>>> => {
    const [artists, ocs, customTags] = await Promise.all([getArtists(), getOCs(), getCustomTags()]);
    const artistItems = artists.filter(a => a.isLocal).map(a => ({
      id: a.id, name: a.name, prompt: a.prompt, previews: a.previews,
      origin: a.origin, publicId: a.publicId, tags: a.tags || [],
      usageCount: a.usageCount, createdTime: a.createdTime, addedBy: a.addedBy,
    }));
    const ocItems = ocs.filter(o => o.isLocal).map(o => ({
      id: o.id, name: o.name, positive: o.positive, negative: o.negative,
      preview: o.preview, user: o.user, aliases: o.aliases,
    }));
    const sceneItems = customTags.filter(t => t.subtypeId === 'scene').map(t => ({ ...t }));
    const otherItems = customTags.filter(t => t.subtypeId === 'other').map(t => ({ ...t }));
    return {
      'character': ocItems,
      'artist-style': artistItems,
      'scene': sceneItems,
      'other': otherItems,
    };
  };

  // 把 1 条 raw 数据写回本地存储 - 按 category 路由
  const restoreOne = async (cat: CategoryId, raw: Record<string, unknown>, idFallback: string) => {
    if (cat === 'character') {
      await saveOC({
        id: (raw.id as string) || idFallback,
        name: (raw.name as string) || '未命名',
        positive: (raw.positive as string) || '',
        negative: (raw.negative as string) || '',
        preview: (raw.preview as string) || '',
        user: (raw.user as string) || 'LocalUser',
        aliases: (raw.aliases as string[]) || undefined,
        isLocal: true,
      } as OCData);
    } else if (cat === 'artist-style') {
      await saveArtist({
        id: (raw.id as string) || idFallback,
        name: (raw.name as string) || '未命名',
        prompt: (raw.prompt as string) || '',
        previews: (raw.previews as string[]) || [],
        isLocal: true,
        createdAt: (raw.createdTime as number) || (raw.createdAt as number) || Date.now(),
        origin: (raw.origin as ArtistData['origin']) || 'local',
        publicId: raw.publicId as string | undefined,
        tags: (raw.tags as string[]) || [],
        usageCount: raw.usageCount as number | undefined,
        createdTime: raw.createdTime as number | undefined,
        addedBy: raw.addedBy as string | undefined,
      });
    } else {
      await saveCustomTag({
        id: (raw.id as string) || idFallback,
        subtypeId: cat,
        name: (raw.name as string) || '未命名',
        preview: raw.preview as string | undefined,
        positive: (raw.positive as string) || '',
        negative: raw.negative as string | undefined,
        tags: (raw.tags as string[]) || undefined,
        usageCount: raw.usageCount as number | undefined,
        createdAt: (raw.createdAt as number) || Date.now(),
      } as CustomTagData);
    }
  };

  // 云端备份 - 整包上传 4 类
  const handleCloudBackup = useCallback(async () => {
    if (cloudBusy || !isAuthed) return;
    setCloudBusy('backup');
    try {
      const categories = await collectAllLocals();
      const result = await uploadTagBackupAll(categories);
      const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
      const detail = (['character', 'artist-style', 'scene', 'other'] as CategoryId[])
        .map(c => `${labelOf(c)} ${result.counts[c] ?? 0}`).join(' · ');
      addLog('ok', `云端备份完成: ${detail}`);
      await recordBackup('backup', total, `tag-manager 备份 ${detail}`);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addLog('error', '云端备份失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      setCloudBusy(null);
    }
  }, [cloudBusy, isAuthed, addLog, loadStats, onDataChanged]);

  // 云端恢复 - 整包下载 4 类并写回本地
  const handleCloudRestore = useCallback(async () => {
    if (cloudBusy || !isAuthed) return;
    setCloudBusy('restore');
    try {
      const backup = await getTagBackupAll();
      const total = Object.values(backup.counts).reduce((a, b) => a + b, 0);
      if (total === 0) {
        addLog('ok', '云端无备份');
        return;
      }
      // 预检冲突 - 把 4 类的覆盖数合并算一个总数
      const [locArtists, locOcs, locCustom] = await Promise.all([getArtists(), getOCs(), getCustomTags()]);
      const localIdByCat: Record<CategoryId, Set<string>> = {
        'character': new Set(locOcs.filter(o => o.isLocal).map(o => o.id)),
        'artist-style': new Set(locArtists.filter(a => a.isLocal).map(a => a.id)),
        'scene': new Set(locCustom.filter(t => t.subtypeId === 'scene').map(t => t.id)),
        'other': new Set(locCustom.filter(t => t.subtypeId === 'other').map(t => t.id)),
      };
      let totalOverwrite = 0;
      let totalAdd = 0;
      for (const cat of ['character', 'artist-style', 'scene', 'other'] as CategoryId[]) {
        for (const it of backup.categories[cat] || []) {
          if (localIdByCat[cat].has(it.id as string)) totalOverwrite++;
          else totalAdd++;
        }
      }
      if (totalOverwrite > 0) {
        const ok = await confirm({
          title: '云端恢复将覆盖本地数据',
          message: `将覆盖本地 ${totalOverwrite} 个,新增 ${totalAdd} 个 (合计 4 类),确认?`,
          confirmLabel: '继续恢复',
          danger: true,
        });
        if (!ok) return;
      }
      const counts: Record<CategoryId, { added: number; updated: number }> = {
        'character': { added: 0, updated: 0 },
        'artist-style': { added: 0, updated: 0 },
        'scene': { added: 0, updated: 0 },
        'other': { added: 0, updated: 0 },
      };
      for (const cat of ['character', 'artist-style', 'scene', 'other'] as CategoryId[]) {
        const items = backup.categories[cat] || [];
        let i = 0;
        for (const raw of items) {
          const exists = localIdByCat[cat].has(raw.id as string);
          if (exists) counts[cat].updated++; else counts[cat].added++;
          await restoreOne(cat, raw, `restore_${cat}_${Date.now()}_${i++}`);
        }
      }
      const detail = (['character', 'artist-style', 'scene', 'other'] as CategoryId[])
        .filter(c => counts[c].added + counts[c].updated > 0)
        .map(c => `${labelOf(c)} +${counts[c].added}/✎${counts[c].updated}`)
        .join(' · ');
      addLog('ok', `云端恢复完成: ${detail || '无变化'}`);
      await recordBackup('restore', total, `tag-manager 恢复 ${detail}`);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addLog('error', '云端恢复失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      setCloudBusy(null);
    }
  }, [cloudBusy, isAuthed, addLog, loadStats, onDataChanged, confirm]);

  // 本地导出 JSON 文件
  const handleExport = useCallback(async (cat: CategoryId) => {
    if (busyCategory) return;
    setBusyCategory(cat);
    setBusyAction('export');
    try {
      let items: Array<Record<string, unknown>> = [];
      if (cat === 'character') {
        const all = await getOCs();
        items = all.filter(o => o.isLocal) as unknown as Array<Record<string, unknown>>;
      } else if (cat === 'artist-style') {
        const all = await getArtists();
        items = all.filter(a => a.isLocal) as unknown as Array<Record<string, unknown>>;
      } else {
        const all = await getCustomTags();
        items = all.filter(t => t.subtypeId === cat) as unknown as Array<Record<string, unknown>>;
      }
      const file: BackupFile = {
        identifier: BACKUP_IDENTIFIER,
        version: BACKUP_VERSION,
        category: cat,
        exportedAt: new Date().toISOString(),
        count: items.length,
        items,
      };
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const dateStr = new Date().toISOString().slice(0, 10);
      a.download = `tag-manager-${cat}-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addLog('ok', `${labelOf(cat)} 已导出 ${items.length} 个 JSON`);
    } catch (err) {
      addLog('error', `${labelOf(cat)} 导出失败: ` + (err instanceof Error ? err.message : ''));
    } finally {
      setBusyCategory(null);
      setBusyAction(null);
    }
  }, [busyCategory, addLog]);

  // 触发文件选择 (导入)
  const triggerImport = (cat: CategoryId) => {
    if (busyCategory) return;
    pendingImportCategoryRef.current = cat;
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  // 处理文件导入
  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const cat = pendingImportCategoryRef.current;
    pendingImportCategoryRef.current = null;
    if (!file || !cat) return;
    setBusyCategory(cat);
    setBusyAction('import');
    try {
      const text = await file.text();
      const parsed: BackupFile = JSON.parse(text);
      if (parsed.identifier !== BACKUP_IDENTIFIER) {
        addLog('error', '文件格式错误:非本备份文件');
        return;
      }
      if (parsed.category !== cat) {
        addLog('error', `分类不匹配:文件为「${labelOf(parsed.category)}」,但当前是「${labelOf(cat)}」`);
        return;
      }
      const items = parsed.items || [];
      if (items.length === 0) {
        addLog('ok', '文件为空');
        return;
      }

      // 预检冲突
      let existingIds = new Set<string>();
      if (cat === 'character') {
        existingIds = new Set((await getOCs()).filter(o => o.isLocal).map(o => o.id));
      } else if (cat === 'artist-style') {
        existingIds = new Set((await getArtists()).filter(a => a.isLocal).map(a => a.id));
      } else {
        existingIds = new Set((await getCustomTags()).filter(t => t.subtypeId === cat).map(t => t.id));
      }
      const overwrite = items.filter(it => existingIds.has(it.id as string));
      if (overwrite.length > 0) {
        const ok = await confirm({
          title: '导入将覆盖本地数据',
          message: `将覆盖本地 ${overwrite.length} 个,新增 ${items.length - overwrite.length} 个,确认?`,
          confirmLabel: '继续导入',
          danger: true,
        });
        if (!ok) return;
      }

      let added = 0, updated = 0;
      for (const raw of items) {
        const exists = existingIds.has(raw.id as string);
        if (exists) updated++; else added++;
        if (cat === 'character') {
          await saveOC({
            id: (raw.id as string) || `imp_oc_${Date.now()}_${added + updated}`,
            name: (raw.name as string) || '未命名',
            positive: (raw.positive as string) || '',
            negative: (raw.negative as string) || '',
            preview: (raw.preview as string) || '',
            user: (raw.user as string) || 'LocalUser',
            aliases: (raw.aliases as string[]) || undefined,
            isLocal: true,
          } as OCData);
        } else if (cat === 'artist-style') {
          await saveArtist({
            id: (raw.id as string) || `imp_art_${Date.now()}_${added + updated}`,
            name: (raw.name as string) || '未命名',
            prompt: (raw.prompt as string) || '',
            previews: (raw.previews as string[]) || [],
            isLocal: true,
            createdAt: (raw.createdTime as number) || (raw.createdAt as number) || Date.now(),
            origin: (raw.origin as ArtistData['origin']) || 'local',
            publicId: raw.publicId as string | undefined,
            tags: (raw.tags as string[]) || [],
            usageCount: raw.usageCount as number | undefined,
            createdTime: raw.createdTime as number | undefined,
            addedBy: raw.addedBy as string | undefined,
          });
        } else {
          await saveCustomTag({
            id: (raw.id as string) || `imp_${cat}_${Date.now()}_${added + updated}`,
            subtypeId: cat,
            name: (raw.name as string) || '未命名',
            preview: raw.preview as string | undefined,
            positive: (raw.positive as string) || '',
            negative: raw.negative as string | undefined,
            tags: (raw.tags as string[]) || undefined,
            usageCount: raw.usageCount as number | undefined,
            createdAt: (raw.createdAt as number) || Date.now(),
          } as CustomTagData);
        }
      }
      addLog('ok', `${labelOf(cat)} 已导入: 新增 ${added} / 覆盖 ${updated}`);
      await loadStats();
      onDataChanged?.();
    } catch (err) {
      addLog('error', '导入失败: ' + (err instanceof Error ? err.message : ''));
    } finally {
      setBusyCategory(null);
      setBusyAction(null);
    }
  }, [addLog, loadStats, onDataChanged]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[105] grid place-items-center bg-black/55 backdrop-blur-md animate-in fade-in duration-200"
      onClick={() => !busyCategory && !cloudBusy && onClose()}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[min(560px,92vw)] max-h-[88vh] grid grid-rows-[auto_1fr] overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06] bg-nai-dark/50">
          <span className="text-nai-accent inline-flex w-9 h-9 rounded-lg bg-nai-accent/10 items-center justify-center">
            <Cloud className="w-[22px] h-[22px]" strokeWidth={1.75} />
          </span>
          <div className="flex flex-col leading-tight flex-1 min-w-0">
            <span className="text-[16px] font-bold text-white whitespace-nowrap tracking-wide">数据备份</span>
          </div>
          <button
            onClick={onClose}
            disabled={!!busyCategory || !!cloudBusy}
            title="关闭"
            className="w-9 h-9 grid place-items-center rounded-lg text-nai-text-dim hover:bg-white/[0.06] hover:text-white transition-colors cursor-pointer shrink-0 disabled:opacity-30"
          >
            <X className="w-[18px] h-[18px]" />
          </button>
        </header>

        {/* Body */}
        <div className="overflow-y-auto custom-scrollbar px-5 py-4 flex flex-col gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleFileImport}
          />

          {/* 顶部:云端备份 - 整包备份 4 类本地数据 */}
          <div className="rounded-lg border border-nai-accent/30 bg-nai-accent/[0.06] p-3.5 flex flex-col gap-3">
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 grid place-items-center rounded-md bg-nai-accent/15 text-nai-accent shrink-0">
                <Cloud className="w-[20px] h-[20px]" strokeWidth={1.75} />
              </span>
              <div className="flex flex-col leading-tight flex-1 min-w-0">
                <span className="text-[14px] font-bold text-white">云端备份</span>
                <span className="text-[11px] text-nai-text-dim tabular-nums">
                  {isAuthed
                    ? (cloudUpdatedAt > 0 ? `上次备份: ${formatBackupTime(cloudUpdatedAt)}` : '尚未备份')
                    : '需要 Bot 授权'}
                </span>
              </div>
              {cloudBusy && (
                <Loader2 className="w-4 h-4 animate-spin text-nai-accent" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleCloudBackup}
                disabled={!isAuthed || !!cloudBusy || !!busyCategory}
                title={isAuthed ? '把本地 4 类数据整体备份到云端' : '需要 Bot 授权'}
                className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md bg-nai-accent text-[#1a1410] text-[13px] font-bold hover:bg-nai-accent-hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
              >
                <Upload className="w-4 h-4" />
                备份到云端
              </button>
              <button
                type="button"
                onClick={handleCloudRestore}
                disabled={!isAuthed || !!cloudBusy || !!busyCategory}
                title={isAuthed ? '从云端拉取备份恢复到本地 (4 类)' : '需要 Bot 授权'}
                className="flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-md bg-gray-700/70 border border-gray-600 text-white text-[13px] font-bold hover:bg-gray-600/85 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Download className="w-4 h-4" />
                从云端恢复
              </button>
            </div>
          </div>

          {/* 分类导出/导入 - 每类独立 JSON 文件 */}
          <div className="flex items-center gap-2 mt-1 mb-0.5">
            <span className="text-[12px] font-bold text-nai-text-dim">按分类导出 / 导入</span>
            <span className="flex-1 h-px bg-white/[0.04]" />
          </div>
          {CATEGORIES.map(cfg => {
            const s = stats[cfg.id];
            const Icon = cfg.icon;
            const isBusy = busyCategory === cfg.id && (busyAction === 'export' || busyAction === 'import');
            return (
              <div
                key={cfg.id}
                className="rounded-lg border border-gray-700 bg-nai-dark/40 p-3 flex items-center gap-2.5"
              >
                <span className="w-8 h-8 grid place-items-center rounded-md bg-nai-accent/10 text-nai-accent shrink-0">
                  <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
                </span>
                <div className="flex flex-col leading-tight min-w-0 flex-1">
                  <span className="text-[13.5px] font-bold text-white">{cfg.label}</span>
                  <span className="text-[11px] text-nai-text-dim tabular-nums">
                    本地 {s.localCount}
                    {s.cloudCount !== null && ` · 云端 ${s.cloudCount}`}
                  </span>
                </div>
                {isBusy && <Loader2 className="w-4 h-4 animate-spin text-nai-accent" />}
                <button
                  type="button"
                  onClick={() => handleExport(cfg.id)}
                  disabled={!!busyCategory || s.localCount === 0}
                  title="导出为 JSON 文件"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-gray-800/60 border border-gray-700 text-gray-200 text-[12px] font-bold hover:bg-gray-700 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出
                </button>
                <button
                  type="button"
                  onClick={() => triggerImport(cfg.id)}
                  disabled={!!busyCategory}
                  title="从 JSON 文件导入"
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-gray-800/60 border border-gray-700 text-gray-200 text-[12px] font-bold hover:bg-gray-700 hover:text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  导入
                </button>
              </div>
            );
          })}

        </div>
      </div>

      {confirmDialog}
    </div>,
    document.body
  );
};

function labelOf(cat: CategoryId): string {
  return CATEGORIES.find(c => c.id === cat)?.label || cat;
}

// 后端返回的 updated_at 是 unix 秒,格式化为 YYYY-MM-DD HH:MM
function formatBackupTime(unixSec: number): string {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}
