import { useEffect, useState } from 'react';
import { useSharedCharacterPrompts } from '../../hooks/useSharedCharacterPrompts';
import { assignSpawnCenters, hasManualPosition, placedCenter } from '../../services/characterPosition';
import type { CharacterPrompt } from './types';

const STORAGE_KEY = 'desktop_character_prompts';
/** 全局「按坐标出图」开关(官方 AI's Choice / Custom)。没存过时按老口径推:有人摆过就算开。 */
const USE_COORDS_KEY = 'desktop_character_use_coords';

function loadCharacterPrompts(): CharacterPrompt[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return parsed.map((c: Partial<CharacterPrompt>) => ({
      id: c.id || Date.now().toString(),
      positive: c.positive || '',
      negative: c.negative || '',
      activeTab: c.activeTab || 'prompt',
      enabled: c.enabled !== false,
      position: c.position,
      center: c.center ?? null,
      name: c.name,
    }));
  } catch {
    return [];
  }
}

function loadUseCoords(characterPrompts: CharacterPrompt[]): boolean {
  try {
    const saved = localStorage.getItem(USE_COORDS_KEY);
    if (saved === '1') return true;
    if (saved === '0') return false;
  } catch {
    // fall through
  }
  return characterPrompts.some(hasManualPosition);
}

function saveCharacterPrompts(characterPrompts: CharacterPrompt[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(characterPrompts.map(c => ({
      id: c.id,
      positive: c.positive,
      negative: c.negative,
      activeTab: c.activeTab,
      enabled: c.enabled,
      position: c.position,
      center: c.center ?? null,
      name: c.name,
    }))));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

// 薄壳:编辑操作在 src/hooks/useSharedCharacterPrompts.ts;
// 这里保留桌面专属的持久化(desktop_character_prompts 键不动)、
// 区块展开状态与清空二次确认(UI 决策,移动端不引入),行为与原实现一致。
//
// 定位照官方模型(见 services/characterPosition 末尾):每个角色一建出来就有坐标
// (出生位置从官方候选序挑),「按不按坐标出图」是全局 useCoords。任何路径(添加、
// OC 导入、元数据导入、助手工具)进来的角色只要没位置,下面那个 effect 会补上。
export function useCharacterPrompts(maxCharacters?: number, freeform = true) {
  const [characterPrompts, setCharacterPrompts] = useState<CharacterPrompt[]>(loadCharacterPrompts);
  const [useCoords, setUseCoords] = useState<boolean>(() => loadUseCoords(loadCharacterPrompts()));
  const [isCharacterSectionOpen, setIsCharacterSectionOpen] = useState(true);
  const [isClearConfirming, setIsClearConfirming] = useState(false);

  useEffect(() => {
    saveCharacterPrompts(characterPrompts);
  }, [characterPrompts]);

  useEffect(() => {
    try { localStorage.setItem(USE_COORDS_KEY, useCoords ? '1' : '0'); } catch { /* ignore */ }
  }, [useCoords]);

  // 出生位置:没位置的补,A1–E5 / 自由坐标串统一收成 center。补过就不再动。
  useEffect(() => {
    if (characterPrompts.every((c) => c.center && !c.position)) return;
    setCharacterPrompts((prev) => {
      if (prev.every((c) => c.center && !c.position)) return prev;
      const centers = assignSpawnCenters(prev, freeform);
      return prev.map((c, i) => (c.center && !c.position ? c : { ...c, center: placedCenter(c) ?? centers[i], position: '' }));
    });
  }, [characterPrompts, freeform]);

  const {
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts: clearAll,
  } = useSharedCharacterPrompts({ characterPrompts, setCharacterPrompts, maxCharacters });

  const clearAllCharacterPrompts = () => {
    if (isClearConfirming) {
      clearAll();
      setIsClearConfirming(false);
    } else {
      setIsClearConfirming(true);
      setTimeout(() => setIsClearConfirming(false), 3000);
    }
  };

  return {
    characterPrompts,
    setCharacterPrompts,
    useCoords,
    setUseCoords,
    isCharacterSectionOpen,
    setIsCharacterSectionOpen,
    isClearConfirming,
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    clearAllCharacterPrompts,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
  };
}
