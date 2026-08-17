#!/usr/bin/env node
// 生图页模块注册表对等校验(P4):直接加载纯注册表 genModules.ts(无 React/Tauri/
// 服务门面),断言可见性矩阵、载荷剥离与排序归一化的纯逻辑。
//
// 运行: node --experimental-strip-types scripts/check-modules-parity.mjs
// (node >= 23.6 默认启用 type stripping,显式 flag 亦兼容)
//
// 校验内容:
//   1. 可见性矩阵:各模型(UI id 与后端名)× 后端模式 × 登录态 → 期望卡片集
//      (能力矩阵为前端静态表,待后端评审 #1 确认权威矩阵;serverMode/登录态暂不影响)
//   2. 剥离正确性:不可见模块数据从快照剥掉、输入快照(工作区)不被修改、
//      剥离幂等(重生成复跑入库快照 = 跳过二次剥离)
//   3. 排序归一化:未知 key 过滤、重复去重、新增模块补尾;可见序列调序时
//      隐藏模块槽位不动

import assert from 'node:assert/strict';

const {
  GEN_MODULE_DEFS,
  GEN_MODULE_SORTABLE_DEFAULT_ORDER,
  modelFamilyOf,
  isGenModuleVisible,
  orderedVisibleGenModuleKeys,
  normalizeGenModuleOrder,
  moveVisibleGenModule,
  stripInvisibleModuleData,
} = await import('../src/components/generation/genModules.ts');
const { stepsRangeForModel, STEPS_RANGE } = await import('../src/components/generation/modelResolutionOptions.ts');

let checks = 0;
const check = (name, fn) => {
  checks += 1;
  try {
    fn();
    console.log(`ok ${checks} - ${name}`);
  } catch (error) {
    console.error(`not ok ${checks} - ${name}`);
    throw error;
  }
};

const ctx = (model, serverMode = 'public', isAuthenticated = true) => ({
  model,
  serverMode,
  isAuthenticated,
});

const ALL_KEYS = GEN_MODULE_DEFS.map((def) => def.key);
const visibleSet = (c) => ALL_KEYS.filter((key) => isGenModuleVisible(key, c));

// ---- 1. 可见性矩阵 ----
const MATRIX = [
  // [模型, 期望可见集(含居顶 prompt-summary)]
  ['v4.5-full', ['prompt-summary', 'character', 'vibe', 'precise-reference', 'img2img']],
  ['v4.5-curated', ['prompt-summary', 'character', 'vibe', 'precise-reference', 'img2img']],
  ['v4-full', ['prompt-summary', 'character', 'vibe', 'img2img']],
  ['v4-curated-preview', ['prompt-summary', 'character', 'vibe', 'img2img']],
  ['v3', ['prompt-summary', 'vibe', 'img2img']],
  ['nai-diffusion-3', ['prompt-summary', 'vibe', 'img2img']], // 后端名直传也可判定
  ['nai-diffusion-4-5-full-inpainting', ['prompt-summary', 'character', 'vibe', 'precise-reference', 'img2img']],
  ['sd-xl', ['prompt-summary']],
  ['nai-diffusion-2', ['prompt-summary', 'img2img']], // legacy:前端无可编码 vibe key
  ['totally-unknown-model', ['prompt-summary']],
];

for (const [model, expected] of MATRIX) {
  check(`可见性矩阵: ${model} → [${expected.join(', ')}]`, () => {
    assert.deepEqual(visibleSet(ctx(model)), expected);
  });
}

check('可见性矩阵: serverMode(public/custom)与登录态暂不影响任何模块(待后端评审 #1)', () => {
  const base = visibleSet(ctx('v4.5-full'));
  assert.deepEqual(visibleSet(ctx('v4.5-full', 'custom')), base);
  assert.deepEqual(visibleSet(ctx('v4.5-full', 'public', false)), base);
  assert.deepEqual(visibleSet(ctx('v4.5-full', 'custom', false)), base);
});

check('modelFamilyOf: UI id / 后端名 / inpainting 变体归一到同一家族', () => {
  assert.equal(modelFamilyOf('v4.5-full'), 'nai-4.5');
  assert.equal(modelFamilyOf('nai-diffusion-4-5-curated'), 'nai-4.5');
  assert.equal(modelFamilyOf('v4-full'), 'nai-4');
  assert.equal(modelFamilyOf('nai-diffusion-4-full-inpainting'), 'nai-4');
  assert.equal(modelFamilyOf('v3'), 'nai-3');
  // furry-3 等派生型号前端无编码键记录,保守归入 legacy(vibe 不可见)
  assert.equal(modelFamilyOf('nai-diffusion-furry-3'), 'nai-legacy');
  assert.equal(modelFamilyOf('nai-diffusion-2'), 'nai-legacy');
  assert.equal(modelFamilyOf('stable-diffusion-xl'), 'other');
});

// ---- 2. 载荷剥离 ----
const snapshot = () => ({
  characterPrompts: [{ id: 'c1', positive: 'p', negative: 'n', enabled: true }],
  activePreciseRefs: [{ id: 'r1', enabled: true }],
  activeVibes: [{ id: 'v1', enabled: true }],
  img2imgImage: 'data:image/png;base64,x',
});

check('剥离: v4.5-full 全可见 → 逐字段原样保留(引用相等)', () => {
  const input = snapshot();
  const out = stripInvisibleModuleData(input, ctx('v4.5-full'));
  assert.equal(out.characterPrompts, input.characterPrompts);
  assert.equal(out.activePreciseRefs, input.activePreciseRefs);
  assert.equal(out.activeVibes, input.activeVibes);
  assert.equal(out.img2imgImage, input.img2imgImage);
});

check('剥离: v4-full 剥掉精确参考,其余保留', () => {
  const out = stripInvisibleModuleData(snapshot(), ctx('v4-full'));
  assert.deepEqual(out.activePreciseRefs, []);
  assert.equal(out.characterPrompts.length, 1);
  assert.equal(out.activeVibes.length, 1);
  assert.equal(out.img2imgImage, 'data:image/png;base64,x');
});

check('剥离: v3 剥掉角色提示词与精确参考(移动端行为修复),vibe/img2img 保留', () => {
  const out = stripInvisibleModuleData(snapshot(), ctx('v3'));
  assert.deepEqual(out.characterPrompts, []);
  assert.deepEqual(out.activePreciseRefs, []);
  assert.equal(out.activeVibes.length, 1);
  assert.equal(out.img2imgImage, 'data:image/png;base64,x');
});

check('剥离: 非 NAI 型号(SD/未知)剥到只剩提示词本体', () => {
  const out = stripInvisibleModuleData(snapshot(), ctx('sd-xl'));
  assert.deepEqual(out.characterPrompts, []);
  assert.deepEqual(out.activePreciseRefs, []);
  assert.deepEqual(out.activeVibes, []);
  assert.equal(out.img2imgImage, null);
});

check('剥离: 不修改输入快照(工作区状态不动)', () => {
  const input = snapshot();
  const before = JSON.parse(JSON.stringify(input));
  stripInvisibleModuleData(input, ctx('v3'));
  assert.deepEqual(input, before);
});

check('剥离: 幂等 —— 对已剥离快照再剥结果不变(重生成跳二次剥离)', () => {
  const once = stripInvisibleModuleData(snapshot(), ctx('v4-full'));
  const twice = stripInvisibleModuleData(once, ctx('v4-full'));
  assert.deepEqual(twice, once);
});

// ---- 3. 排序归一化 ----
check('排序归一化: 非法输入(null/对象/非数组)回落默认序', () => {
  assert.deepEqual(normalizeGenModuleOrder(null), GEN_MODULE_SORTABLE_DEFAULT_ORDER);
  assert.deepEqual(normalizeGenModuleOrder({}), GEN_MODULE_SORTABLE_DEFAULT_ORDER);
  assert.deepEqual(normalizeGenModuleOrder('img2img'), GEN_MODULE_SORTABLE_DEFAULT_ORDER);
  assert.deepEqual(normalizeGenModuleOrder([]), GEN_MODULE_SORTABLE_DEFAULT_ORDER);
});

check('排序归一化: 未知 key 过滤、重复去重、缺项补尾', () => {
  assert.deepEqual(
    normalizeGenModuleOrder(['img2img', 'bogus-key', 'vibe', 'img2img', 42]),
    ['img2img', 'vibe', 'character', 'precise-reference'],
  );
  // 完整合法序原样保留
  assert.deepEqual(
    normalizeGenModuleOrder(['img2img', 'precise-reference', 'vibe', 'character']),
    ['img2img', 'precise-reference', 'vibe', 'character'],
  );
});

check('排序归一化: 持久化里含 prompt-summary(居顶固定卡)视为未知项剔除', () => {
  assert.deepEqual(
    normalizeGenModuleOrder(['prompt-summary', 'vibe']),
    ['vibe', 'character', 'precise-reference', 'img2img'],
  );
});

check('可见序列: 按持久化顺序过滤(v4 无精确参考)', () => {
  const order = normalizeGenModuleOrder(['precise-reference', 'img2img', 'vibe', 'character']);
  assert.deepEqual(orderedVisibleGenModuleKeys(ctx('v4-full'), order), ['img2img', 'vibe', 'character']);
  assert.deepEqual(orderedVisibleGenModuleKeys(ctx('v4.5-full'), order), ['precise-reference', 'img2img', 'vibe', 'character']);
});

check('拖拽调序: 可见序列移动映射回完整 order,隐藏模块槽位不动', () => {
  // 完整序 [character, vibe, precise-reference, img2img],v4 下 precise-reference 隐藏
  const order = normalizeGenModuleOrder(null);
  const visible = orderedVisibleGenModuleKeys(ctx('v4-full'), order); // [character, vibe, img2img]
  // 把 img2img(可见序 idx 2)拖到最前(idx 0):img2img 占据 character 的槽位,
  // character/vibe 顺移到 img2img 空出的槽位,隐藏的 precise-reference 原槽位(索引 2)不动
  const next = moveVisibleGenModule(order, visible, 2, 0);
  assert.deepEqual(next, ['img2img', 'character', 'precise-reference', 'vibe']);
  assert.equal(next[2], 'precise-reference');
});

check('拖拽调序: 越界/原位 → 原 order 不变(引用相等)', () => {
  const order = normalizeGenModuleOrder(['vibe', 'character', 'precise-reference', 'img2img']);
  const visible = orderedVisibleGenModuleKeys(ctx('v4.5-full'), order);
  assert.equal(moveVisibleGenModule(order, visible, 1, 1), order);
  assert.equal(moveVisibleGenModule(order, visible, -1, 2), order);
  assert.equal(moveVisibleGenModule(order, visible, 0, 4), order);
});

// ---- 4. steps 范围 ----
check('stepsRangeForModel: 各模型 1–50(与两端高级设置同源)', () => {
  for (const model of ['v4.5-full', 'v4-full', 'v3', 'sd-xl']) {
    assert.deepEqual(stepsRangeForModel(model), { min: STEPS_RANGE.min, max: STEPS_RANGE.max });
  }
});

console.log(`\n${checks} 项模块注册表对等校验全部通过。`);
