#!/usr/bin/env node
// NAI Diffusion V5 支持的对等校验:直接加载纯模块(无 React/Tauri/服务门面),
// 断言注册表、家族判定与计费三处对 V5 的处理与官方口径一致。
//
// 运行: node --experimental-strip-types scripts/check-v5-parity.mjs
//
// 为什么值得单独一份:V5 的两条差异都是「不报错但结果错」的类型——
//   1. 计费漏乘 1.5,界面显示的价永远比真实扣费少三分之一;
//   2. 模型落错家族(V5 会掉进 LEGACY)会切到另一条指数计价公式。
// 两者都不会抛异常,只会安静地把数字算错,所以用实测锚点钉住。
//
// 锚点来源:2026-08-28 用真实账号在 novelai.net 生成 832×1216 / 28 步 / V5 Full,
// 余额从 31659 掉到 31629,即 30 Anlas。同规格 V4.5 是 20,恰好 20×1.5=30。

import assert from 'node:assert/strict';

const { calculateAnlasCost, calculateCostFromUI } = await import('../src/services/costCalculator.ts');
const {
  MODEL_MAP,
  NAI_MODELS,
  DEFAULT_MODEL_ID,
  defaultModelOption,
  isV5Model,
  modelCapabilities,
  maxCharactersForModel,
  maxPromptTokensForModel,
} = await import(
  '../src/components/generation/modelResolutionOptions.ts'
);
const { V5_QUALITY_SUFFIX, V5_UC_PREFIX, toV5UcPresetId, toV5QualityPresetId, shouldPrefixNsfw } =
  await import('../src/services/naiV5Presets.ts');

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

// ---- 1. 注册表 ----

check('注册表: V5 两个型号可选,且映射到官方后端名', () => {
  assert.equal(MODEL_MAP['v5-full'], 'nai-diffusion-5-full');
  assert.equal(MODEL_MAP['v5-curated'], 'nai-diffusion-5-curated');
  const ids = NAI_MODELS.map((m) => m.id);
  assert.ok(ids.includes('v5-full'));
  assert.ok(ids.includes('v5-curated'));
});

check('注册表: 列表按 NEW → LEGACY 排,V5 在最前', () => {
  assert.equal(NAI_MODELS[0].group, 'new');
  assert.equal(NAI_MODELS[1].group, 'new');
  assert.ok(NAI_MODELS.slice(2).every((m) => m.group === 'legacy'));
});

check('注册表: 默认模型是显式常量,不是数组第一项', () => {
  // 默认为 V5 Full 是一次明确的产品决定。这条断言的重点不在「值是 v5-full」,
  // 而在默认值走的是 DEFAULT_MODEL_ID 而非 NAI_MODELS[0]——两者当下恰好同值,
  // 所以要额外证明 defaultModelOption 真的在查表,否则将来重排列表会静默改掉
  // 默认模型(这个 bug 本次已经犯过一次:桌面壳曾用 MODELS[0] 播种状态)。
  assert.equal(DEFAULT_MODEL_ID, 'v5-full');
  assert.equal(defaultModelOption().id, 'v5-full');
  assert.equal(defaultModelOption(), NAI_MODELS.find((m) => m.id === DEFAULT_MODEL_ID));
});

check('注册表: 角色上限按模型分档(V4 系 6,V5 为 32)', () => {
  assert.equal(maxCharactersForModel('v4.5-full'), 6);
  assert.equal(maxCharactersForModel('v5-full'), 32);
  assert.equal(maxCharactersForModel('nai-diffusion-5-curated'), 32);
  // 能力表的其余几位一并钉住:V5 没有噪声调度选择与 Variety+,有透明与体力条
  const v5 = modelCapabilities('v5-full');
  assert.equal(v5.noiseSchedule, false);
  assert.equal(v5.varietyPlus, false);
  assert.equal(v5.transparency, true);
  assert.equal(v5.opusUsageLimit, true);
  assert.equal(v5.freeformCharacterPosition, true);
  // 这两项是「暂缺」不是「不支持」——官方上线后改成 true,这两行断言应随之更新
  assert.equal(v5.vibeTransfer, false);
  assert.equal(v5.preciseReference, false);

  const legacy = modelCapabilities('v4.5-full');
  assert.equal(legacy.noiseSchedule, true);
  assert.equal(legacy.opusUsageLimit, false);
});

check('注册表: token 软阈值按型号分档(Full 与 Curated 不同)', () => {
  // 这一项是 V5 家族内部唯一有分歧的能力位:V5 Full 1471、V5 Curated 703,
  // 所以 modelCapabilities 不能只按家族返回同一个对象。
  assert.equal(maxPromptTokensForModel('v4.5-full'), 512);
  assert.equal(maxPromptTokensForModel('v5-full'), 1471);
  assert.equal(maxPromptTokensForModel('v5-curated'), 703);
  assert.equal(maxPromptTokensForModel('nai-diffusion-5-curated-inpainting'), 703);
  // 除 token 上限外,Curated 与 Full 的其余能力位应当一致
  const full = modelCapabilities('v5-full');
  const curated = modelCapabilities('v5-curated');
  for (const key of Object.keys(full)) {
    if (key === 'maxPromptTokens') continue;
    assert.equal(curated[key], full[key], key);
  }
});

check('isV5Model: UI id / 后端名 / inpainting 变体 / custom 别名', () => {
  for (const m of [
    'v5-full',
    'v5-curated',
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-5-full-inpainting',
    'custom',
  ]) {
    assert.equal(isV5Model(m), true, m);
  }
  for (const m of ['v4.5-full', 'nai-diffusion-4-5-full', 'nai-diffusion-3', 'sd-xl']) {
    assert.equal(isV5Model(m), false, m);
  }
});

// ---- 2. 计费 ----

const NORMAL = { width: 832, height: 1216, steps: 28, sampler: 'k_euler' };

check('计费: V5 Full 832×1216/28步 = 30 Anlas(2026-08-28 实测锚点)', () => {
  const v5 = calculateAnlasCost({ ...NORMAL, model: 'nai-diffusion-5-full' });
  assert.equal(v5.perImage, 30);
});

check('计费: 同规格 V4.5 = 20,V5 恰为其 1.5 倍', () => {
  const v45 = calculateAnlasCost({ ...NORMAL, model: 'nai-diffusion-4-5-full' });
  const v5 = calculateAnlasCost({ ...NORMAL, model: 'nai-diffusion-5-full' });
  assert.equal(v45.perImage, 20);
  assert.equal(v5.perImage, Math.ceil(v45.perImage * 1.5));
});

check('计费: UI id 与后端名走同一条路', () => {
  assert.equal(
    calculateCostFromUI({ ...NORMAL, modelId: 'v5-full' }).perImage,
    calculateAnlasCost({ ...NORMAL, model: 'nai-diffusion-5-full' }).perImage,
  );
});

check('计费: V5 不会掉进 LEGACY 的指数公式', () => {
  // LEGACY 对「小图 + 简单采样器」走的是另一条 exp 公式。若 getModelGroup 漏了
  // V5,这里两者会相等——那正是要防的回归。
  const v5 = calculateAnlasCost({ ...NORMAL, model: 'nai-diffusion-5-full' });
  const legacy = calculateAnlasCost({ ...NORMAL, model: 'some-unknown-model' });
  assert.notEqual(v5.perImage, legacy.perImage);
});

check('计费: 单张封顶 140', () => {
  const huge = calculateAnlasCost({
    width: 1920,
    height: 1088,
    steps: 50,
    sampler: 'k_euler',
    model: 'nai-diffusion-5-full',
  });
  assert.ok(huge.perImage <= 140, `${huge.perImage} 应 ≤ 140`);
});

check('计费: 保底 2', () => {
  const tiny = calculateAnlasCost({
    width: 512,
    height: 512,
    steps: 1,
    sampler: 'k_euler',
    model: 'nai-diffusion-5-full',
  });
  assert.ok(tiny.perImage >= 2);
});

// ---- 3. Opus 体力条 ----

check('体力条: Opus 免费规格,条未空 → 免费', () => {
  const r = calculateAnlasCost({
    width: 1024,
    height: 1024,
    steps: 28,
    sampler: 'k_euler',
    model: 'nai-diffusion-5-full',
    isOpus: true,
  });
  assert.equal(r.opusFreeCount, 1);
  assert.equal(r.total, 0);
  assert.equal(r.isFree, true);
});

check('体力条: 条空后同一张图开始收费(V5 独有的第四道闸)', () => {
  // NAI 在这种情况下不报错也不返回 402,它就是照生成、照扣 Anlas。界面若仍显示
  // 「免费」,用户是在毫不知情的状态下花钱——所以这条断言守的是钱,不是数字。
  const r = calculateAnlasCost({
    width: 1024,
    height: 1024,
    steps: 28,
    sampler: 'k_euler',
    model: 'nai-diffusion-5-full',
    isOpus: true,
    opusUsageExhausted: true,
  });
  assert.equal(r.opusFreeCount, 0);
  assert.ok(r.total > 0);
  assert.equal(r.isFree, false);
});

check('体力条: 不影响 4.5 及以下(它们对 Opus 仍是无限)', () => {
  const r = calculateAnlasCost({
    width: 1024,
    height: 1024,
    steps: 28,
    sampler: 'k_euler',
    model: 'nai-diffusion-4-5-full',
    isOpus: true,
    opusUsageExhausted: true,
  });
  assert.equal(r.opusFreeCount, 1);
  assert.equal(r.total, 0);
});

// ---- 4. 预设文本 ----

check('预设: V5 质量尾去掉了 4.5 的 location 前缀', () => {
  assert.equal(V5_QUALITY_SUFFIX.standard, 'very aesthetic, masterpiece, no text');
  assert.equal(V5_QUALITY_SUFFIX.light, 'very aesthetic, amazing quality, no text');
  assert.equal(V5_QUALITY_SUFFIX.none, '');
  assert.ok(!V5_QUALITY_SUFFIX.standard.includes('location'));
});

check('预设: V5 的 light UC 是全新写法,含数字权重语法', () => {
  assert.ok(V5_UC_PREFIX.light.includes('0::ai-generated::'));
  assert.ok(V5_UC_PREFIX.light.includes('bad hands'));
  assert.notEqual(V5_UC_PREFIX.light, V5_UC_PREFIX.heavy);
});

check('预设: humanFocus = heavy 加四项', () => {
  assert.ok(V5_UC_PREFIX.humanFocus.startsWith(V5_UC_PREFIX.heavy));
  assert.ok(V5_UC_PREFIX.humanFocus.endsWith('@_@, mismatched pupils, glowing eyes, bad anatomy'));
});

check('预设: id 归一化 —— 未知档退到 heavy,布尔质量尾映到 standard/none', () => {
  assert.equal(toV5UcPresetId('heavy'), 'heavy');
  assert.equal(toV5UcPresetId('furryFocus'), 'furryFocus');
  assert.equal(toV5UcPresetId('nonsense'), 'heavy');
  assert.equal(toV5QualityPresetId(true), 'standard');
  assert.equal(toV5QualityPresetId(false), 'none');
});

check('预设: nsfw 前缀只加给 -full,且用户已写过就不重复加', () => {
  assert.equal(shouldPrefixNsfw('nai-diffusion-5-full', 'heavy', 'lowres'), true);
  assert.equal(shouldPrefixNsfw('nai-diffusion-5-curated', 'heavy', 'lowres'), false);
  assert.equal(shouldPrefixNsfw('nai-diffusion-5-full', 'none', 'lowres'), false);
  assert.equal(shouldPrefixNsfw('nai-diffusion-5-full', 'heavy', 'nsfw, lowres'), false);
});

console.log(`\n${checks} 项 V5 支持对等校验全部通过。`);
