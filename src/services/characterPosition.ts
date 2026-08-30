/**
 * 角色定位:一套规则,界面和发包共用。
 *
 * 为什么单独抽出来:Aaalice 在 `character_prompt.dart:58` 写明过这条约束——
 * 「画布兜底、状态规范化和请求构造必须使用同一套规则,避免界面显示位置与实际
 * 发送给 NovelAI 的 centers 分叉」。我们原来的实现正好踩了这个:界面给的是
 * A1–E5 网格,发包时另有一张 6 个点的兜底数组,两边对不上。
 *
 * 两条 V5 事实(出处是用户自己的 nai5-prompting,`references/通用写法.md`):
 *
 * 1. **5×5 网格是 V4 的限制,V5 已经不适用**(§「不要沿用 V4 文档「最多六人」和
 *    5×5 网格旧限制」)。官方 V5 是 Character Prompts → Position → **Custom**,
 *    在画布上自由摆点;线上协议这一侧本来就收连续浮点(`centers: [{x, y}]`),
 *    是我们自己把它量化回了 25 个格子。
 * 2. **Y 坐标会被解释成深度**:下 = 近(占画幅最大,可以只露局部),上 = 远
 *    (明显缩小)。所以纵轴不是单纯的「上下」,画布上要说清楚,否则用户会
 *    以为它只是构图位置。
 *
 * 还有一条反直觉的:**两个角色定到同一点是合法用法**(cosplay 玩法靠它避免
 * 生成两个人),所以重叠只提示、绝不阻止。
 */

/** 归一化坐标,原点在左上,x 向右、y 向下(y 同时是景深:大 = 近)。 */
export interface CharacterCenter {
  x: number;
  y: number;
}

/** 没有任何角色被手动摆放时,发包用的中性中心点。 */
export const NEUTRAL_CENTER: Readonly<CharacterCenter> = { x: 0.5, y: 0.5 };

/** 旧存档里的 A1–E5。只用于读,不再产生新值。 */
const LEGACY_COLUMNS = ['A', 'B', 'C', 'D', 'E'];
const LEGACY_CELL_PATTERN = /^([A-E])([1-5])$/;

export function clampCenter(center: CharacterCenter): CharacterCenter {
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  return { x: clamp(center.x), y: clamp(center.y) };
}

/**
 * 旧的 A1–E5 → 连续坐标。取格子中心,与 2026-08 之前发出去的 payload 逐位一致
 * (`(colIdx + 0.5) / 5`、`(row - 0.5) / 5`),所以老图重新生成不会漂。
 */
export function legacyCellToCenter(cell: string | undefined | null): CharacterCenter | null {
  if (!cell) return null;
  const match = LEGACY_CELL_PATTERN.exec(cell.trim().toUpperCase());
  if (!match) return null;
  const colIdx = LEGACY_COLUMNS.indexOf(match[1]);
  const row = Number(match[2]);
  return { x: (colIdx + 0.5) / 5, y: (row - 0.5) / 5 };
}

/** 连续坐标 → 最近的 A1–E5。只给「吸附到网格」和旧格式导出用。 */
export function centerToLegacyCell(center: CharacterCenter): string {
  const { x, y } = clampCenter(center);
  const colIdx = Math.min(4, Math.max(0, Math.round(x * 5 - 0.5)));
  const row = Math.min(5, Math.max(1, Math.round(y * 5 + 0.5)));
  return `${LEGACY_COLUMNS[colIdx]}${row}`;
}

/** 吸附到 5×5 网格的中心。想要旧手感的用户按一下就回去了。 */
export function snapCenterToGrid(center: CharacterCenter): CharacterCenter {
  return legacyCellToCenter(centerToLegacyCell(center)) ?? { ...NEUTRAL_CENTER };
}

/**
 * 按角色数量给的默认布局,照抄 Aaalice `CharacterPositionLayout.positionsForCount`。
 *
 * 原实现是一张固定 6 元素的数组按下标取模,跟人数无关——两个人拿到 0.3/0.7 还算凑合,
 * 三个人就变成「左、右、上中」这种没人会想要的排布。按人数给才是对的。
 */
export function defaultCentersForCount(count: number): CharacterCenter[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0.5, y: 0.5 }];
  if (count === 2) return [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }];
  if (count === 3) return [{ x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }];
  if (count === 4) {
    return [
      { x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 },
      { x: 0.25, y: 0.75 }, { x: 0.75, y: 0.75 },
    ];
  }
  // 五个人往上:按行铺开,每行尽量放满,行列都取格子中心。
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => ({
    x: ((index % columns) + 0.5) / columns,
    y: (Math.floor(index / columns) + 0.5) / rows,
  }));
}

/** 一个角色的定位意图,`center` 优先于旧的 `position` 字符串。 */
export interface PositionedCharacter {
  center?: CharacterCenter | null;
  position?: string;
}

/** 这个角色是不是被**手动**摆过。空字符串是「自动」,不是「摆在 0,0」。 */
export function hasManualPosition(character: PositionedCharacter): boolean {
  if (character.center) return true;
  return legacyCellToCenter(character.position) !== null;
}

/**
 * 有任何一个角色被手动摆过,整张图就得走坐标模式。
 *
 * `use_coords` 是**整张图一个**的开关,不是每角色一个,所以只要有人摆了,
 * 没摆的那些也必须给一个坐标——那正是 `defaultCentersForCount` 的用处。
 */
export function shouldUseCoords(characters: readonly PositionedCharacter[]): boolean {
  return characters.some(hasManualPosition);
}

/**
 * 解析出每个角色最终发出去的中心点。
 *
 * 顺序:显式 center → 旧的 A1–E5 → 按人数的默认布局。
 * 传进来的数组必须是**实际会发包的那一批**(已经过滤掉停用和空提示词的),
 * 否则默认布局会按错误的人数铺开。
 */
export function resolveCharacterCenters(
  characters: readonly PositionedCharacter[],
): CharacterCenter[] {
  const fallback = defaultCentersForCount(characters.length);
  return characters.map((character, index) => {
    if (character.center) return clampCenter(character.center);
    const legacy = legacyCellToCenter(character.position);
    if (legacy) return legacy;
    return fallback[index] ?? { ...NEUTRAL_CENTER };
  });
}

/** 画布上认为「贴太近」的距离。 */
export const CROWDING_DISTANCE = 0.12;

/**
 * 找出挨得太近的角色下标。V5 教程口径:角色之间别靠太近,否则坏图
 * (继承 4.5「周围 8 格不放人」)。
 *
 * **完全重合不算**——两个角色定到同一点是 cosplay 的正规用法,报出来是噪音。
 */
export function crowdedCharacterIndices(centers: readonly CharacterCenter[]): number[] {
  const crowded = new Set<number>();
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = i + 1; j < centers.length; j += 1) {
      const dx = centers[i].x - centers[j].x;
      const dy = centers[i].y - centers[j].y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0 && distance < CROWDING_DISTANCE) {
        crowded.add(i);
        crowded.add(j);
      }
    }
  }
  return [...crowded].sort((a, b) => a - b);
}
