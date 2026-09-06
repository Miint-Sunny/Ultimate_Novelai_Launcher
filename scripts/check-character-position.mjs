#!/usr/bin/env node
// 角色定位的校验。
//
// 运行: node --experimental-strip-types scripts/check-character-position.mjs
//
// 为什么单独钉:这一层的错法全是「照样出图,但出的不是用户摆的那张」——
//   1. 「自动」偷偷发坐标 → 界面说交给模型,实际钉死在兜底点位上(这次修的就是它);
//   2. 旧 A1–E5 换算漂一点点 → 老图重新生成构图就变了,而且没有任何报错;
//   3. 画布画的点和发出去的 centers 各算各的 → 看到的和发出的分叉;
//   4. 默认布局撞进「贴太近」的告警区 → 一加角色就亮黄条,像是坏了。

import assert from 'node:assert/strict';

const M = await import('../src/services/characterPosition.ts');
const {
  NEUTRAL_CENTER, CROWDING_DISTANCE,
  clampCenter, legacyCellToCenter, centerToLegacyCell, snapCenterToGrid,
  defaultCentersForCount, hasManualPosition, shouldUseCoords,
  resolveCharacterCenters, crowdedCharacterIndices,
} = M;

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

// ---- 1. 旧网格换算:必须跟 2026-08 之前发出去的逐位一致 ----

check('旧 A1–E5: 取格子中心,与历史 payload 逐位一致', () => {
  // 历史实现: x = (colIdx + 0.5) / 5, y = (row - 0.5) / 5
  const columns = ['A', 'B', 'C', 'D', 'E'];
  for (let colIdx = 0; colIdx < 5; colIdx += 1) {
    for (let row = 1; row <= 5; row += 1) {
      const cell = `${columns[colIdx]}${row}`;
      assert.deepEqual(legacyCellToCenter(cell), {
        x: (colIdx + 0.5) / 5,
        y: (row - 0.5) / 5,
      }, cell);
    }
  }
});

check('旧 A1–E5: 大小写与空白容错,非法值一律 null(不是 0,0)', () => {
  assert.deepEqual(legacyCellToCenter(' c3 '), legacyCellToCenter('C3'));
  for (const bad of ['', undefined, null, 'F1', 'A6', 'A0', 'AA', '3C', 'C', '1'])
    assert.equal(legacyCellToCenter(bad), null, String(bad));
});

check('网格往返: cell → center → cell 恒等,且 snap 幂等', () => {
  for (const col of ['A', 'B', 'C', 'D', 'E']) {
    for (const row of [1, 2, 3, 4, 5]) {
      const cell = `${col}${row}`;
      assert.equal(centerToLegacyCell(legacyCellToCenter(cell)), cell);
    }
  }
  const once = snapCenterToGrid({ x: 0.37, y: 0.62 });
  assert.deepEqual(snapCenterToGrid(once), once);
  assert.deepEqual(once, legacyCellToCenter(centerToLegacyCell({ x: 0.37, y: 0.62 })));
});

check('网格反查: 四角不越界(拖到边上不该算出 F 或第 6 行)', () => {
  assert.equal(centerToLegacyCell({ x: 0, y: 0 }), 'A1');
  assert.equal(centerToLegacyCell({ x: 1, y: 1 }), 'E5');
  assert.equal(centerToLegacyCell({ x: -5, y: 5 }), 'A5');
});

// ---- 2. 「自动」必须真的是自动 ----

check('自动: 没摆过的角色 hasManualPosition 为假(空串不是「摆在 0,0」)', () => {
  for (const character of [{}, { position: '' }, { position: undefined }, { center: null }])
    assert.equal(hasManualPosition(character), false, JSON.stringify(character));
});

check('自动: 全员自动 → use_coords 关掉,构图交回模型', () => {
  assert.equal(shouldUseCoords([{}, { position: '' }, { center: null }]), false);
  assert.equal(shouldUseCoords([]), false);
});

check('坐标模式: 只要有一个人摆过,整张图就开(use_coords 是全局开关)', () => {
  assert.equal(shouldUseCoords([{}, { center: { x: 0.2, y: 0.8 } }]), true);
  assert.equal(shouldUseCoords([{ position: 'B4' }, {}]), true);
});

// ---- 3. 中心点解析 ----

check('解析优先级: center > 旧 position > 按人数的默认布局', () => {
  const centers = resolveCharacterCenters([
    { center: { x: 0.11, y: 0.22 }, position: 'E5' },
    { position: 'A1' },
    {},
  ]);
  assert.deepEqual(centers[0], { x: 0.11, y: 0.22 });
  assert.deepEqual(centers[1], legacyCellToCenter('A1'));
  assert.deepEqual(centers[2], defaultCentersForCount(3)[2]);
});

check('解析: 越界坐标被夹住,非有限值退回中性点(拖出画布不该发出 x:-3)', () => {
  assert.deepEqual(resolveCharacterCenters([{ center: { x: -3, y: 9 } }])[0], { x: 0, y: 1 });
  // 有限的越界值夹到边上;NaN/Infinity 是「不知道」,退回中性点而不是贴边。
  assert.deepEqual(clampCenter({ x: NaN, y: Infinity }), { x: 0.5, y: 0.5 });
  assert.deepEqual(clampCenter({ x: 1.4, y: -0.2 }), { x: 1, y: 0 });
  assert.deepEqual(clampCenter(NEUTRAL_CENTER), { x: 0.5, y: 0.5 });
});

check('解析: 每个角色都拿得到中心点,数量与输入一致', () => {
  for (const count of [0, 1, 2, 3, 4, 5, 6, 12, 32]) {
    const centers = resolveCharacterCenters(Array.from({ length: count }, () => ({})));
    assert.equal(centers.length, count);
    for (const c of centers) {
      assert.ok(c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1, `${count}: ${JSON.stringify(c)}`);
    }
  }
});

// ---- 4. 默认布局 ----

check('默认布局: 按人数给,不是固定数组取模', () => {
  assert.deepEqual(defaultCentersForCount(1), [{ x: 0.5, y: 0.5 }]);
  assert.deepEqual(defaultCentersForCount(2), [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }]);
  assert.deepEqual(defaultCentersForCount(3), [
    { x: 0.2, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 },
  ]);
  assert.deepEqual(defaultCentersForCount(0), []);
  assert.deepEqual(defaultCentersForCount(-1), []);
  // 两个人的默认位置必须不同——原来的固定数组在别的人数下会给出重复点
  const two = defaultCentersForCount(2);
  assert.notDeepEqual(two[0], two[1]);
});

check('默认布局: 任何人数都不该自己踩进「贴太近」告警(一加角色就亮黄条像是坏了)', () => {
  for (let count = 1; count <= 32; count += 1) {
    assert.deepEqual(
      crowdedCharacterIndices(defaultCentersForCount(count)), [],
      `count=${count} 的默认布局互相太近`,
    );
  }
});

// ---- 5. 拥挤检测 ----

check('拥挤: 挨得太近的两个都报出来', () => {
  const crowded = crowdedCharacterIndices([
    { x: 0.5, y: 0.5 },
    { x: 0.5 + CROWDING_DISTANCE / 2, y: 0.5 },
    { x: 0.05, y: 0.95 },
  ]);
  assert.deepEqual(crowded, [0, 1]);
});

check('拥挤: 完全重合不报 —— 定到同一点是 cosplay 的正规用法', () => {
  assert.deepEqual(crowdedCharacterIndices([{ x: 0.4, y: 0.6 }, { x: 0.4, y: 0.6 }]), []);
});

check('拥挤: 刚好等于阈值不报(边界是开区间,免得默认布局擦边就告警)', () => {
  assert.deepEqual(
    crowdedCharacterIndices([{ x: 0, y: 0 }, { x: CROWDING_DISTANCE, y: 0 }]), [],
  );
});

check('官方出生序: 先中排由内向外,再按到中心距离;C4 因浮点比较排在 C2 前(照官方,不「修」)', () => {
  assert.deepEqual(M.SPAWN_CENTERS.slice(0, 5), [{ x: 0.5, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }, { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }]);
  assert.deepEqual(M.SPAWN_CENTERS[5], { x: 0.5, y: 0.7 });
  assert.deepEqual(M.SPAWN_CENTERS[6], { x: 0.5, y: 0.3 });
  assert.equal(M.SPAWN_CENTERS.length, 25);
  assert.equal(new Set(M.SPAWN_CENTERS.map((c) => `${c.x},${c.y}`)).size, 25, '25 格各出现一次');
});

check('出生位置: 跳过已占(V5 按距离 <0.1;网格模型量化同格);全占回正中;摆过的原样保留、逐个补', () => {
  assert.deepEqual(M.nextSpawnCenter([], true), { x: 0.5, y: 0.5 }, '第一个落 C3,不是 B3');
  assert.deepEqual(M.nextSpawnCenter([{ x: 0.52, y: 0.48 }], true), { x: 0.3, y: 0.5 });
  assert.deepEqual(M.nextSpawnCenter([{ x: 0.45, y: 0.55 }], false), { x: 0.3, y: 0.5 }, '网格模型:量化后同格即占');
  assert.deepEqual(M.nextSpawnCenter([{ x: 0.45, y: 0.55 }], true), { x: 0.3, y: 0.5 }, '自由定位:0.07 在 0.1 内,算占');
  assert.deepEqual(M.nextSpawnCenter([{ x: 0.38, y: 0.5 }], true), { x: 0.5, y: 0.5 }, '自由定位:离 C3 0.12,不算占');
  assert.deepEqual(M.nextSpawnCenter(M.SPAWN_CENTERS, true), { x: 0.5, y: 0.5 });
  const centers = M.assignSpawnCenters([{ center: { x: 0.9, y: 0.1 } }, { center: null }, { position: 'B3' }, { position: '0.2,0.2' }, {}], true);
  assert.deepEqual(centers, [{ x: 0.9, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 0.3, y: 0.5 }, { x: 0.2, y: 0.2 }, { x: 0.7, y: 0.5 }]);
});

check('量化: floor 分桶到格心;自由坐标串照实解析并算「摆过」', () => {
  assert.deepEqual(M.quantizeCenterToGrid({ x: 0.2, y: 0.19 }), { x: 0.3, y: 0.1 });
  assert.deepEqual(M.quantizeCenterToGrid({ x: 1, y: 0 }), { x: 0.9, y: 0.1 });
  assert.deepEqual(M.parseFreeformPosition('0.42, 0.67'), { x: 0.42, y: 0.67 });
  assert.equal(M.parseFreeformPosition('B3'), null);
  assert.equal(M.hasManualPosition({ position: '0.1,0.2' }), true);
  assert.deepEqual(M.placedCenter({ position: 'A1' }), { x: 0.1, y: 0.1 });
});

console.log(`\n${checks} 项角色定位校验全部通过。`);
