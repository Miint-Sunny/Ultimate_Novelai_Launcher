#!/usr/bin/env node
// 提示词预设档位的对等校验:内置档 → 官方两个档位的翻译,以及档位按模型系列的分组。
//
// 运行: node --experimental-strip-types scripts/check-preset-tiers.mjs
//
// 为什么单独一份:官方那边「正面质量档」和「负面档」是两个互相独立的下拉,
// 我们这套 UI 是一行一档,中间那层翻译全是「不报错但报错档」的类型——
//   1. 曾经写死 `qualityToggle = (id === 'heavy')`:light 明明拼了质量词却上报没拼,
//      自定义档还会拿自己的时间戳 id 去查数字表(查不到落回 heavy=0),替用户谎报;
//   2. V5 的五个负面档我们只放出三个、三个质量尾只放出两个,官方文本明明就在
//      naiV5Presets 里躺着;
//   3. 两个系列的官方文本完全不同,混在一个列表里选会串味。
// 这些都不会在本地抛异常,服务端照收,只是元数据从此对不上、导入时剥不掉预设文本。

import assert from 'node:assert/strict';

// 目录 import 与模块级 localStorage:同 check-v5-parity,先装钩子再 import 前端模块。
await import('./lib/load-frontend-module.mjs');

const { buildRequestPayload } = await import('../src/services/novelai.ts');
const { DEFAULT_PROMPT_PRESETS } = await import('../src/services/localLibrary/promptPresets.ts');
const { V5_QUALITY_SUFFIX, V5_UC_PREFIX, officialPresetHint } = await import('../src/services/naiV5Presets.ts');
const {
  presetOfficialSource,
  promptPresetsForModel,
  remapPromptPresetId,
} = await import('../src/services/promptPresetCatalog.ts');
const { buildPromptPair } = await import('../src/components/generation/generationPrompts.ts');
const { buildBaseGenerationParams } = await import('../src/components/generation/generationPayload.ts');

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

const byId = (id) => DEFAULT_PROMPT_PRESETS.find((preset) => preset.id === id);
const CUSTOM = { id: '1718000000000', name: '自定义', positive: 'mine', negative: 'mine-uc' };
const withCustom = [...DEFAULT_PROMPT_PRESETS, CUSTOM];

// ---- 1. 档位覆盖 ----

check('覆盖: V5 的五个官方负面档都放出来了', () => {
  const v5 = promptPresetsForModel(DEFAULT_PROMPT_PRESETS, true);
  const uc = new Set(v5.map((preset) => presetOfficialSource(preset.id).uc ?? 'none'));
  for (const tier of ['heavy', 'light', 'humanFocus', 'furryFocus', 'none']) {
    assert.ok(uc.has(tier), `V5 下选不到负面档 ${tier}`);
  }
});

check('覆盖: V5 的三个官方质量尾都放出来了', () => {
  const v5 = promptPresetsForModel(DEFAULT_PROMPT_PRESETS, true);
  const quality = new Set(v5.map((preset) => presetOfficialSource(preset.id).quality ?? 'none'));
  for (const tier of ['standard', 'light', 'none']) {
    assert.ok(quality.has(tier), `V5 下选不到质量尾 ${tier}`);
  }
});

check('覆盖: V5 档的文本一律引用官方表,不在预设里再抄一份', () => {
  assert.equal(byId('v5-standard').positive, V5_QUALITY_SUFFIX.standard);
  assert.equal(byId('v5-standard').negative, V5_UC_PREFIX.heavy);
  assert.equal(byId('v5-light').positive, V5_QUALITY_SUFFIX.light);
  assert.equal(byId('v5-light').negative, V5_UC_PREFIX.light);
  assert.equal(byId('v5-human-focus').negative, V5_UC_PREFIX.humanFocus);
  assert.equal(byId('v5-furry-focus').negative, V5_UC_PREFIX.furryFocus);
});

// ---- 2. 按模型系列分组 ----

check('分组: legacy 下看不到 V5 档,V5 下看不到 legacy 档', () => {
  const legacyIds = promptPresetsForModel(DEFAULT_PROMPT_PRESETS, false).map((p) => p.id);
  const v5Ids = promptPresetsForModel(DEFAULT_PROMPT_PRESETS, true).map((p) => p.id);
  assert.deepEqual(legacyIds, ['heavy', 'light', 'none']);
  assert.deepEqual(v5Ids, ['v5-standard', 'v5-light', 'v5-human-focus', 'v5-furry-focus', 'none']);
});

check('分组: 自定义档没有 scope,两个系列下都在', () => {
  assert.ok(promptPresetsForModel(withCustom, false).some((p) => p.id === CUSTOM.id));
  assert.ok(promptPresetsForModel(withCustom, true).some((p) => p.id === CUSTOM.id));
});

// ---- 3. 切模型时的档位映射 ----

check('映射: 同强度档在两个系列之间对得上', () => {
  assert.equal(remapPromptPresetId('heavy', DEFAULT_PROMPT_PRESETS, true), 'v5-standard');
  assert.equal(remapPromptPresetId('light', DEFAULT_PROMPT_PRESETS, true), 'v5-light');
  assert.equal(remapPromptPresetId('v5-standard', DEFAULT_PROMPT_PRESETS, false), 'heavy');
  assert.equal(remapPromptPresetId('v5-light', DEFAULT_PROMPT_PRESETS, false), 'light');
});

check('映射: 已经可选就原样保留;自定义档与 none 两边都不动', () => {
  assert.equal(remapPromptPresetId('v5-light', DEFAULT_PROMPT_PRESETS, true), 'v5-light');
  assert.equal(remapPromptPresetId('none', DEFAULT_PROMPT_PRESETS, true), 'none');
  assert.equal(remapPromptPresetId('none', DEFAULT_PROMPT_PRESETS, false), 'none');
  assert.equal(remapPromptPresetId(CUSTOM.id, withCustom, true), CUSTOM.id);
  assert.equal(remapPromptPresetId(CUSTOM.id, withCustom, false), CUSTOM.id);
});

check('映射: V5 独有的侧重档在 legacy 侧没有对应,落到首项而不是消失', () => {
  const fallback = remapPromptPresetId('v5-furry-focus', DEFAULT_PROMPT_PRESETS, false);
  assert.equal(fallback, 'heavy');
  assert.ok(promptPresetsForModel(DEFAULT_PROMPT_PRESETS, false).some((p) => p.id === fallback));
});

check('映射: 是推导不是改写 —— 来回切模型能拿回原来那一档', () => {
  // 存的始终是用户点过的 id,映射只发生在读的时候。
  const stored = 'v5-light';
  assert.equal(remapPromptPresetId(stored, DEFAULT_PROMPT_PRESETS, false), 'light');
  assert.equal(remapPromptPresetId(stored, DEFAULT_PROMPT_PRESETS, true), stored);
});

// ---- 4. 官方来源与档位提示 ----

check('来源: heavy 拼了质量词,但它的正面对不上任何单一官方档', () => {
  // heavy 的正面是 V3 与 V4.5 两段官方文本拼出来的(还带着重复的 very aesthetic),
  // 硬报一个 standard 会让导入时按错的档去剥文本。
  assert.equal(presetOfficialSource('heavy').quality, null);
  assert.equal(presetOfficialSource('heavy').uc, 'heavy');
  assert.ok(byId('heavy').positive.length > 0);
});

check('来源: 自定义档与未知 id 一律没有官方来源', () => {
  assert.deepEqual(presetOfficialSource(CUSTOM.id), { quality: null, uc: null });
  assert.deepEqual(presetOfficialSource('nope'), { quality: null, uc: null });
});

check('提示: V5 各档的官方枚举编号(与线上数字 ucPreset 不是一张表)', () => {
  assert.equal(officialPresetHint(presetOfficialSource('v5-standard').uc), 2);
  assert.equal(officialPresetHint(presetOfficialSource('v5-light').uc), 3);
  assert.equal(officialPresetHint(presetOfficialSource('v5-human-focus').uc), 4);
  assert.equal(officialPresetHint(presetOfficialSource('v5-furry-focus').uc), 5);
  assert.equal(officialPresetHint(presetOfficialSource('v5-standard').quality), 1);
  assert.equal(officialPresetHint(presetOfficialSource('v5-light').quality), 3);
});

// ---- 5. 拼接位置 ----

check('拼接: V5 档的质量词在末尾,legacy 档保持在开头', () => {
  const v5 = buildPromptPair({ positivePrompt: '1girl', negativePrompt: 'x', activePreset: byId('v5-standard') });
  assert.equal(v5.positive, `1girl, ${V5_QUALITY_SUFFIX.standard}`);
  const legacy = buildPromptPair({ positivePrompt: '1girl', negativePrompt: 'x', activePreset: byId('heavy') });
  assert.equal(legacy.positive, `${byId('heavy').positive}, 1girl`);
});

check('拼接: 负面一律前缀(两个系列同规则)', () => {
  const v5 = buildPromptPair({ positivePrompt: 'a', negativePrompt: 'mine', activePreset: byId('v5-light') });
  assert.equal(v5.negative, `${V5_UC_PREFIX.light}, mine`);
});

check('拼接: 提示词为空时后缀档不留尾随逗号', () => {
  const empty = buildPromptPair({ positivePrompt: '', negativePrompt: '', activePreset: byId('v5-standard') });
  assert.equal(empty.positive, V5_QUALITY_SUFFIX.standard);
});

// ---- 6. 一路发到载荷 ----

const baseInput = (overrides = {}) => ({
  positivePrompt: '1girl',
  negativePrompt: 'lowres',
  activePreset: undefined,
  model: 'v5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  seed: '',
  sampler: 'k_euler_ancestral',
  cfgRescale: 0,
  noiseSchedule: 'karras',
  activePresetId: 'v5-standard',
  varietyPlus: false,
  normalizeVibeStrength: true,
  resolutionSource: 'x',
  characterPrompts: [],
  activePreciseRefs: [],
  activeVibes: [],
  vibeEncodingCache: new Map(),
  preparePreciseReferences: async () => undefined,
  prepareVibeReferences: async () => undefined,
  ...overrides,
});

const payloadFor = async (presetId) => {
  const preset = byId(presetId);
  const params = await buildBaseGenerationParams(baseInput({ activePresetId: presetId, activePreset: preset }));
  return buildRequestPayload(params).parameters;
};

// 逐档发一遍真实载荷:档位表改错时这里会立刻炸,而不是等到线上元数据对不上。
for (const [presetId, uc, quality, ucHint, qtHint] of [
  ['v5-standard', 'heavy', 'standard', 2, 1],
  ['v5-light', 'light', 'light', 3, 3],
  ['v5-human-focus', 'humanFocus', 'standard', 4, 1],
  ['v5-furry-focus', 'furryFocus', 'standard', 5, 1],
  ['none', 'none', 'none', 0, 0],
]) {
  const params = await payloadFor(presetId);
  check(`载荷: ${presetId} → ucPresetId=${uc} / qualityPresetId=${quality}`, () => {
    assert.equal(params.ucPresetId, uc);
    assert.equal(params.qualityPresetId, quality);
    assert.equal(params.tag_hint_uc_preset, ucHint);
    assert.equal(params.tag_hint_qt, qtHint);
    assert.ok(!('ucPreset' in params), 'V5 载荷不能带数字 ucPreset');
  });
}

{
  const params = await buildBaseGenerationParams(baseInput({
    activePresetId: CUSTOM.id,
    activePreset: CUSTOM,
  }));
  const wire = buildRequestPayload(params).parameters;
  check('载荷: 自定义档报 none 而不是落回 heavy,但仍如实上报拼了质量词', () => {
    assert.equal(wire.ucPresetId, 'none');
    assert.equal(wire.qualityPresetId, 'none');
    assert.equal(params.qualityToggle, true, '自定义档有正面文本,拼了就得报拼了');
  });
}

{
  const params = await buildBaseGenerationParams(baseInput({
    model: 'v4.5-full',
    activePresetId: 'light',
    activePreset: byId('light'),
  }));
  const wire = buildRequestPayload(params).parameters;
  check('载荷: legacy light 在 V4.5 上发数字 ucPreset=1,且如实上报拼了质量词', () => {
    assert.equal(wire.ucPreset, 1);
    assert.equal(wire.qualityToggle, true);
    assert.ok(!('ucPresetId' in wire), 'V4 系载荷不能带字符串 ucPresetId');
  });
}

console.log(`\n${checks} 项预设档位校验全部通过。`);
