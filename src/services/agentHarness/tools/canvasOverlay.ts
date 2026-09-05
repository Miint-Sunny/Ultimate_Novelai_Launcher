/**
 * view_canvas_image 的角色位置覆盖层:纯几何与配色,不碰 canvas。
 * 语义照他的 renderImageWithCharacterOverlay:只画启用角色;V5 自由定位落在连续坐标上
 * 并叠中心十字线;V4/V4.5 吸附 5x5 格心并叠网格;粉=女性、蓝=男性、紫=其他。
 */

import { resolveCharacterCenters, snapCenterToGrid } from '../../characterPosition';
import type { WorkbenchCharacter } from '../workbench';

export interface OverlayAnchor {
  /** 从 1 起的启用顺序编号。 */
  index: number;
  /** 归一化坐标(0–1),已按定位模式处理(网格模式为格心)。 */
  x: number;
  y: number;
  color: string;
  label: string;
}

export interface OverlaySpec {
  anchors: OverlayAnchor[];
  guide: 'crosshair' | 'grid5';
}

export const ANCHOR_COLORS = { female: '#EC4899', male: '#3B82F6', other: '#8B5CF6' } as const;

/** 只有 V5 系列支持连续坐标;其余按 5x5 网格。 */
export function freePositioningForModel(model: string | undefined): boolean {
  return !!model && /diffusion-5/.test(model);
}

/** 角色锚点的配色与标签:名字为空或是「角色 N」这种占位名时退回首个标签。 */
export function anchorDisplayFor(character: { name: string; prompt: string }): { color: string; label: string } {
  const tags = character.prompt.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const isFemale = tags.some((t) => t === 'female' || t === 'woman' || t.includes('girl'));
  const isMale = tags.some((t) => t === 'male' || t === 'man' || t.includes('boy'));
  const color = isFemale ? ANCHOR_COLORS.female : isMale ? ANCHOR_COLORS.male : ANCHOR_COLORS.other;
  let label = character.name.trim();
  if (!label || /^角色 \d+$/.test(label)) label = tags[0] ?? '';
  return { color, label };
}

/** 没有启用角色时返回 null(调用方退回原图并说明)。 */
export function buildOverlaySpec(characters: readonly WorkbenchCharacter[], freePositioning: boolean): OverlaySpec | null {
  const enabled = characters.filter((c) => c.enabled);
  if (enabled.length === 0) return null;
  const centers = resolveCharacterCenters(enabled.map((c) => ({ center: c.center })));
  const anchors = enabled.map((c, i) => {
    const center = freePositioning ? centers[i] : snapCenterToGrid(centers[i]);
    const display = anchorDisplayFor(c);
    return { index: i + 1, x: center.x, y: center.y, color: display.color, label: display.label };
  });
  return { anchors, guide: freePositioning ? 'crosshair' : 'grid5' };
}
