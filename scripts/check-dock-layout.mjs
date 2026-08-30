#!/usr/bin/env node
// 右侧停靠区布局模型的校验。
//
// 运行: node --experimental-strip-types scripts/check-dock-layout.mjs
//
// 为什么单独钉:这层的错法全是「不报错但布局烂掉」,而且用户自己修不回来——
//   1. 顺序数组里混进重复 id → 同一块面板渲染两次,React key 撞车;
//   2. 权重被拖到 0 → 面板永远看不见,菜单里还打着勾,用户以为它开着;
//   3. collapsed 记住了已经关掉的面板 → 重新打开时是折叠的,像是没打开;
//   4. 存量用户升级后旧的两个单面板键没迁移 → 原本开着的助手栏变成空白右栏。

import assert from 'node:assert/strict';

const M = await import('../src/components/desktop/dock/dockLayout.ts');
const {
  DEFAULT_DOCK_LAYOUT, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH, DOCK_MIN_WEIGHT, DOCK_PANEL_ORDER,
  normalizeDockLayout, togglePanel, setPanelCollapsed, movePanel, resizeAdjacent,
  setDockWidth, panelWeight, migrateLegacyDockLayout,
} = M;

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try { fn(); console.log(`ok ${checks} - ${name}`); }
  catch (error) { console.error(`not ok ${checks} - ${name}`); throw error; }
};

// ---- 1. 归一化 ----

check('归一化: 坏输入一律退默认,不抛错(布局坏了不该白屏)', () => {
  for (const bad of [null, undefined, 42, 'x', [], { open: 'nope' }]) {
    const out = normalizeDockLayout(bad);
    assert.equal(typeof out.width, 'number');
    assert.ok(Array.isArray(out.open));
  }
  assert.deepEqual(normalizeDockLayout(null), DEFAULT_DOCK_LAYOUT);
});

check('归一化: 未知 id 丢掉、重复 id 去重,顺序按输入', () => {
  const out = normalizeDockLayout({ open: ['sessions', 'nope', 'assistant', 'sessions'] });
  assert.deepEqual(out.open, ['sessions', 'assistant']);
});

check('归一化: collapsed 只保留 open 里的 —— 关掉的面板不该记得自己折叠过', () => {
  const out = normalizeDockLayout({ open: ['assistant'], collapsed: ['assistant', 'sessions'] });
  assert.deepEqual(out.collapsed, ['assistant']);
});

check('归一化: 权重夹到区间,下限不是 0(拖成 0 的面板会永远看不见)', () => {
  const out = normalizeDockLayout({ open: ['assistant'], weights: { assistant: 0, sessions: 999 } });
  assert.equal(out.weights.assistant, DOCK_MIN_WEIGHT);
  assert.ok(out.weights.assistant > 0);
  assert.ok(out.weights.sessions <= M.DOCK_MAX_WEIGHT);
});

check('归一化: 宽度夹到区间,非法值退默认', () => {
  assert.equal(normalizeDockLayout({ width: 10 }).width, DOCK_MIN_WIDTH);
  assert.equal(normalizeDockLayout({ width: 5000 }).width, DOCK_MAX_WIDTH);
  assert.equal(normalizeDockLayout({ width: 'x' }).width, DEFAULT_DOCK_LAYOUT.width);
});

// ---- 2. 开关与顺序 ----

check('开关: 新开的面板按规范顺序插入,不是一律追加到最下面', () => {
  // 只开着 sessions 时打开 assistant,它该回到 sessions 上面(规范顺序里它在前)
  const only = normalizeDockLayout({ open: ['sessions'] });
  assert.deepEqual(togglePanel(only, 'assistant').open, ['assistant', 'sessions']);
});

check('开关: 关掉面板时同时清掉它的折叠态', () => {
  let layout = normalizeDockLayout({ open: ['assistant', 'sessions'] });
  layout = setPanelCollapsed(layout, 'sessions', true);
  assert.deepEqual(layout.collapsed, ['sessions']);
  layout = togglePanel(layout, 'sessions');
  assert.deepEqual(layout.collapsed, []);
  // 再打开时是展开的,不是折叠的
  assert.ok(!togglePanel(layout, 'sessions').collapsed.includes('sessions'));
});

check('开关: 关掉再打开能回到原位置,而不是跑到底部', () => {
  const start = normalizeDockLayout({ open: ['assistant', 'sessions'] });
  const roundTrip = togglePanel(togglePanel(start, 'assistant'), 'assistant');
  assert.deepEqual(roundTrip.open, start.open);
});

check('开关: 只对 open 里的面板设折叠态', () => {
  const layout = normalizeDockLayout({ open: ['assistant'] });
  assert.deepEqual(setPanelCollapsed(layout, 'sessions', true).collapsed, []);
});

// ---- 3. 换位 ----

check('换位: 上下互换;到头就原样返回', () => {
  const layout = normalizeDockLayout({ open: ['assistant', 'sessions'] });
  assert.deepEqual(movePanel(layout, 'sessions', -1).open, ['sessions', 'assistant']);
  assert.deepEqual(movePanel(layout, 'assistant', -1).open, layout.open);
  assert.deepEqual(movePanel(layout, 'sessions', 1).open, layout.open);
  assert.deepEqual(movePanel(layout, 'nope', -1).open, layout.open);
});

// ---- 4. 分高度 ----

check('分高度: 总权重不变 —— 拖一对分隔线不该改动别的面板', () => {
  const layout = normalizeDockLayout({ open: ['assistant', 'sessions'] });
  const before = panelWeight(layout, 'assistant') + panelWeight(layout, 'sessions');
  for (const ratio of [0.1, 0.5, 0.9]) {
    const out = resizeAdjacent(layout, 'assistant', 'sessions', ratio);
    const after = panelWeight(out, 'assistant') + panelWeight(out, 'sessions');
    assert.ok(Math.abs(after - before) < 1e-9, `总权重变了: ${before} → ${after}`);
  }
});

check('分高度: 拖到两端也留得下最小高度,面板不会消失', () => {
  const layout = normalizeDockLayout({ open: ['assistant', 'sessions'] });
  for (const ratio of [-5, 0, 1, 5]) {
    const out = resizeAdjacent(layout, 'assistant', 'sessions', ratio);
    assert.ok(panelWeight(out, 'assistant') >= DOCK_MIN_WEIGHT, `上面那块被拖没了 (ratio=${ratio})`);
    assert.ok(panelWeight(out, 'sessions') >= DOCK_MIN_WEIGHT, `下面那块被拖没了 (ratio=${ratio})`);
  }
});

check('分高度: 没开着的面板不参与', () => {
  const layout = normalizeDockLayout({ open: ['assistant'] });
  assert.deepEqual(resizeAdjacent(layout, 'assistant', 'sessions', 0.5), layout);
});

check('宽度: 设置时夹到区间并取整', () => {
  const layout = normalizeDockLayout({});
  assert.equal(setDockWidth(layout, 10).width, DOCK_MIN_WIDTH);
  assert.equal(setDockWidth(layout, 99999).width, DOCK_MAX_WIDTH);
  assert.equal(setDockWidth(layout, 456.7).width, 457);
});

// ---- 5. 存量用户迁移 ----

check('迁移: 两个旧键都没有 = 全新用户,返回 null 走默认布局', () => {
  assert.equal(migrateLegacyDockLayout(null, null), null);
});

check('迁移: 旧的「助手栏开着 + 宽度」原样带过来', () => {
  const out = migrateLegacyDockLayout('1', '520');
  assert.deepEqual(out.open, ['assistant']);
  assert.equal(out.width, 520);
});

check('迁移: 旧口径里只有显式 "0" 算收起,没存过也算开着', () => {
  assert.deepEqual(migrateLegacyDockLayout('0', '400').open, []);
  // 只存过宽度、没存过开关的用户,助手栏在旧版本里是开着的
  assert.deepEqual(migrateLegacyDockLayout(null, '400').open, ['assistant']);
});

check('迁移: 旧宽度超出新区间时夹取,不是丢掉', () => {
  assert.equal(migrateLegacyDockLayout('1', '99999').width, DOCK_MAX_WIDTH);
  assert.equal(migrateLegacyDockLayout('1', 'x').width, DEFAULT_DOCK_LAYOUT.width);
});

check('登记表: 规范顺序覆盖全部已知面板,无重复', () => {
  assert.equal(new Set(DOCK_PANEL_ORDER).size, DOCK_PANEL_ORDER.length);
  assert.ok(DOCK_PANEL_ORDER.includes('assistant'));
  assert.ok(DOCK_PANEL_ORDER.includes('sessions'));
});

console.log(`\n${checks} 项停靠布局校验全部通过。`);
