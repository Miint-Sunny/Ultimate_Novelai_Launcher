// 聚合 hook - 把现有 useOCManager / useArtistManager 通过 adapter 暴露成统一接口
// Step 3 阶段: 只接入 character + artist-style 两个内置 subtype
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { UseOCManagerReturn } from '../oc/types';
import type { UseArtistManagerReturn } from '../artist/types';
import type { TagFile } from './types';
import { fromArtist, fromOC } from './adapters';
import { getAllSubtypes } from './registry';
import { useCustomRegistry } from './useCustomRegistry';
import { useCustomTagStore } from './useCustomTagStore';
import { migrateLegacyKeys } from './migration';

export interface UseTagManagerInput {
  oc: UseOCManagerReturn;
  artist: UseArtistManagerReturn;
}

export interface SelectionConfirm {
  subtypeId: string;
  tagIds: string[];
  /** character subtype 独占: 'character' = 加入 characterPrompts[], 'main' = 拼到主提示词 */
  mode?: 'character' | 'main';
  /** 自定义 tag(scene/other/custom)的完整数据,由 TagManagerModal 附上,便于 LeftSidebar 不需访问 customStore */
  customTagFiles?: Array<{
    id: string;
    name: string;
    positive: string;
    negative?: string;
  }>;
}

export function useTagManager({ oc, artist }: UseTagManagerInput) {
  useEffect(() => {
    migrateLegacyKeys();
  }, []);

  const customRegistry = useCustomRegistry();
  const customStore = useCustomTagStore();

  const subtypes = useMemo(
    () => getAllSubtypes(customRegistry.custom),
    [customRegistry.custom]
  );

  const [activeSubtypeId, setActiveSubtypeId] = useState<string>('character');
  const [selectionMap, setSelectionMap] = useState<Record<string, Set<string>>>({});

  const toggleSelection = useCallback((subtypeId: string, id: string, max: number) => {
    setSelectionMap(prev => {
      const cur = new Set(prev[subtypeId] || []);
      if (cur.has(id)) {
        cur.delete(id);
      } else {
        if (cur.size >= max) return prev;
        cur.add(id);
      }
      return { ...prev, [subtypeId]: cur };
    });
  }, []);

  const clearSelection = useCallback((subtypeId?: string) => {
    if (!subtypeId) {
      setSelectionMap({});
    } else {
      setSelectionMap(prev => ({ ...prev, [subtypeId]: new Set() }));
    }
  }, []);

  // 数据源变化时,自动剔除 selectionMap 里不存在的 id (删除某条目时同步取消选中)
  useEffect(() => {
    setSelectionMap(prev => {
      const next: Record<string, Set<string>> = {};
      let changed = false;
      for (const [subtypeId, ids] of Object.entries(prev)) {
        if (!ids || ids.size === 0) {
          next[subtypeId] = ids;
          continue;
        }
        const validIds = new Set<string>();
        if (subtypeId === 'character') {
          oc.ocLocalFiles.forEach(f => validIds.add(f.id));
          oc.ocPublicFiles.forEach(f => validIds.add(f.id));
        } else if (subtypeId === 'artist-style') {
          artist.artistLocalFiles.forEach(f => validIds.add(f.id));
          artist.artistPublicFiles.forEach(f => validIds.add(f.id));
        } else {
          for (const t of customStore.tags) {
            if (t.subtypeId === subtypeId) validIds.add(t.id);
          }
        }
        const filtered = new Set<string>();
        for (const id of ids) if (validIds.has(id)) filtered.add(id);
        if (filtered.size !== ids.size) changed = true;
        next[subtypeId] = filtered;
      }
      return changed ? next : prev;
    });
  }, [oc.ocLocalFiles, oc.ocPublicFiles, artist.artistLocalFiles, artist.artistPublicFiles, customStore.tags]);

  const getFiles = useCallback(
    (subtypeId: string, currentTab: 'public' | 'local'): TagFile[] => {
      if (subtypeId === 'character') {
        const src = currentTab === 'public' ? oc.ocPublicFiles : oc.ocLocalFiles;
        return src.map(f => fromOC(f, currentTab === 'local'));
      }
      if (subtypeId === 'artist-style') {
        const src = currentTab === 'public' ? artist.artistPublicFiles : artist.artistLocalFiles;
        return src.map(f => fromArtist(f, currentTab === 'local'));
      }
      // 自定义 / 其余内置 (pose-composition / lighting-mood / scene-background)
      // 暂时只走本地 customStore
      return customStore.getBySubtype(subtypeId).map(t => ({
        id: t.id,
        subtypeId: t.subtypeId,
        name: t.name,
        preview: t.preview,
        positive: t.positive,
        negative: t.negative,
        tags: t.tags,
        usageCount: t.usageCount,
        createdAt: t.createdAt,
        _isLocal: true,
      }));
    },
    [oc.ocPublicFiles, oc.ocLocalFiles, artist.artistPublicFiles, artist.artistLocalFiles, customStore]
  );

  return {
    subtypes,
    activeSubtypeId,
    setActiveSubtypeId,
    selectionMap,
    toggleSelection,
    clearSelection,
    getFiles,
    customRegistry,
    customStore,
  };
}

export type UseTagManagerReturn = ReturnType<typeof useTagManager>;
