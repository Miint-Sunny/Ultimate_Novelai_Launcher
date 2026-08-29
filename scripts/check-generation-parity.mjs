#!/usr/bin/env node
// 生成编排对等校验(P1):直接加载纯装配层 TS(无 React/Tauri/服务门面),
// 用注入的 stub 代表 vibe/CR/img2img 图像处理,对代表性输入矩阵断言载荷逐字段一致。
//
// 运行: node --experimental-strip-types scripts/check-generation-parity.mjs
// (node >= 23.6 默认启用 type stripping,显式 flag 亦兼容)
//
// 校验内容 = 桌面端在 P1 重构前的既有行为(基线,切换调用方前后必须一致),
// 同时也是移动端切换后必须对齐的目标:
//   1. 预设档位翻译:当前档 → 官方的质量档 + 负面档(见 promptPresetCatalog)
//   2. seed 为空字符串 → undefined(后端摇种子);非空 → parseInt(_, 10)
//   3. 生成前 clampToMaxPixels 兜底 + resolutionSource 追加「；生成前兜底 W×H」
//   4. savedInpaint 存在时覆盖 width/height 并写 inpaint、img2img 置 undefined
//   5. inpaint 事件载荷:resolutionSource = `局部重绘 W×H`,带 skipHistory
//   6. 桌面提示词语义:逗号切分 filterHiddenTags、预设无条件前置合并、
//      角色提示词仅按 enabled 过滤(保留空 positive)

import assert from 'node:assert/strict';

const {
  buildBaseGenerationParams,
  assembleGenerateParams,
  assembleInpaintParams,
} = await import('../src/components/generation/generationPayload.ts');
const {
  buildPromptPair,
  buildCharacterPromptParams,
  filterHiddenTags,
} = await import('../src/components/generation/generationPrompts.ts');
const { clampToMaxPixels } = await import('../src/components/generation/modelResolutionOptions.ts');

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

// ---- stub 注入:代替 generationReferences 的图像处理(确定性输出) ----
const stubPreciseReferences = async (refs) => {
  const enabled = refs.filter((ref) => ref.enabled);
  if (enabled.length === 0) return undefined;
  return enabled.map((ref) => ({
    imageBase64: `cr:${ref.id}`,
    mode: ref.mode,
    informationExtracted: ref.informationExtracted,
    strength: ref.strength,
  }));
};

const stubVibeReferences = async ({ activeVibes }) => {
  const enabled = activeVibes.filter((vibe) => vibe.enabled);
  if (enabled.length === 0) return undefined;
  return enabled.map((vibe) => ({
    encodedVibe: `vibe:${vibe.id}`,
    originalImage: vibe.image,
    strength: vibe.referenceStrength,
    informationExtracted: vibe.informationExtracted,
  }));
};

const stubImg2Img = async ({ img2imgImage, strength, noise }) => (
  img2imgImage ? { imageBase64: `i2i:${img2imgImage}`, strength, noise } : undefined
);

const baseInput = (overrides = {}) => ({
  positivePrompt: 'masterpiece, 1girl',
  negativePrompt: 'lowres',
  activePreset: undefined,
  model: 'v4.5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  seed: '',
  sampler: 'k_euler_ancestral',
  cfgRescale: 0,
  noiseSchedule: 'karras',
  activePresetId: 'heavy',
  varietyPlus: false,
  normalizeVibeStrength: true,
  characterPrompts: [],
  activePreciseRefs: [],
  activeVibes: [],
  vibeEncodingCache: new Map(),
  preparePreciseReferences: stubPreciseReferences,
  prepareVibeReferences: stubVibeReferences,
  ...overrides,
});

const assembleInput = (overrides = {}) => {
  const {
    resolutionSource = '默认竖图',
    savedInpaint = null,
    img2imgImage = null,
    img2imgStrength = 0.7,
    img2imgNoise = 0,
    ...rest
  } = overrides;
  let source = resolutionSource;
  return {
    ...baseInput(rest),
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    prepareImg2ImgParams: stubImg2Img,
    readResolutionSource: () => source,
    applyClampedResolution: (size, next) => { source = next; },
    readSavedInpaint: () => savedInpaint,
  };
};

// ---- 1. 预设档位翻译(ucPreset / qualityToggle / qualityPresetId) ----
// 三个字段各报各的事,别合并:
//   ucPreset        负面文本取自哪个官方档(自定义档没有官方来源 → none)
//   qualityToggle   到底有没有拼质量词
//   qualityPresetId 正面文本取自哪个官方质量档,对不上就 none
// heavy 就是「拼了词但对不上任何单一档」的那个 —— 它的正面是 V3 与 V4.5 两段
// 官方文本拼出来的。曾经这里写死 `qualityToggle = (id === 'heavy')`,于是 light
// 明明拼了质量词却上报没拼,而自定义档会拿自己的时间戳 id 去查数字表(查不到落回
// heavy=0),等于替用户谎报了一个官方档。
const PRESET_TIER_CASES = [
  { id: 'heavy', positive: 'best quality', uc: 'heavy', quality: 'none', toggle: true },
  { id: 'light', positive: 'very aesthetic', uc: 'light', quality: 'standard', toggle: true },
  { id: 'none', positive: '', uc: 'none', quality: 'none', toggle: false },
  { id: '1718000000000', positive: 'my own tags', uc: 'none', quality: 'none', toggle: true },
  { id: '1718000000001', positive: '', uc: 'none', quality: 'none', toggle: false },
];
for (const item of PRESET_TIER_CASES) {
  const params = await buildBaseGenerationParams(baseInput({
    activePresetId: item.id,
    activePreset: { positive: item.positive, negative: 'x' },
    resolutionSource: '默认竖图',
  }));
  check(`预设档位翻译: activePresetId=${item.id}`, () => {
    assert.equal(params.ucPreset, item.uc);
    assert.equal(params.qualityToggle, item.toggle);
    assert.equal(params.qualityPresetId, item.quality);
  });
}

// ---- 2. seed 策略 ----
{
  const emptySeed = await buildBaseGenerationParams(baseInput({ seed: '', resolutionSource: 'x' }));
  const withSeed = await buildBaseGenerationParams(baseInput({ seed: '12345', resolutionSource: 'x' }));
  check('seed 空串 → undefined,非空 → parseInt(_, 10)', () => {
    assert.equal(emptySeed.seed, undefined);
    assert.equal(withSeed.seed, 12345);
  });
}

// ---- 3. 桌面提示词语义(基线,必须逐字节保持) ----
check('filterHiddenTags:逗号切分、~ 前缀剔除、空 tag 保留(桌面语义)', () => {
  assert.equal(filterHiddenTags('a, ~b，c'), 'a, c');
  assert.equal(filterHiddenTags('a,,b'), 'a, , b');
  assert.equal(filterHiddenTags('a\n~hidden'), 'a\n~hidden'.split(/[,，]/).map((t) => t.trim()).filter((t) => !t.startsWith('~')).join(', '));
});

check('buildPromptPair:预设正/负词无条件前置合并(空 prompt 也合并)', () => {
  assert.deepEqual(
    buildPromptPair({ positivePrompt: 'b', negativePrompt: 'n', activePreset: { positive: 'p', negative: 'q' } }),
    { positive: 'p, b', negative: 'q, n' },
  );
  assert.deepEqual(
    buildPromptPair({ positivePrompt: '', negativePrompt: '', activePreset: { positive: 'p', negative: 'q' } }),
    { positive: 'p, ', negative: 'q, ' },
  );
  assert.deepEqual(
    buildPromptPair({ positivePrompt: 'b', negativePrompt: 'n', activePreset: null }),
    { positive: 'b', negative: 'n' },
  );
});

check('buildCharacterPromptParams:仅按 enabled 过滤(保留空 positive)', () => {
  assert.deepEqual(
    buildCharacterPromptParams([
      { positive: '', negative: 'x', enabled: true, position: '0.5,0.5' },
      { positive: 'y', negative: '', enabled: false },
    ]),
    [{ positive: '', negative: 'x', enabled: true, position: '0.5,0.5' }],
  );
});

// ---- 4. clampToMaxPixels 兜底 ----
check('clampToMaxPixels:64 取整、超像素等比缩小、最小 64', () => {
  assert.deepEqual(clampToMaxPixels(832, 1216), {
    width: 832, height: 1216, changed: false, originalWidth: 832, originalHeight: 1216,
  });
  const rounded = clampToMaxPixels(1000, 1000);
  assert.deepEqual([rounded.width, rounded.height, rounded.changed], [1024, 1024, true]);
  const capped = clampToMaxPixels(4096, 4096);
  assert.ok(capped.width * capped.height <= 1024 * 3072);
  assert.equal(capped.width % 64, 0);
  assert.equal(capped.height % 64, 0);
  const tiny = clampToMaxPixels(10, 10);
  assert.deepEqual([tiny.width, tiny.height], [64, 64]);
});

// ---- 5. assembleGenerateParams:完整载荷基线(逐字段快照) ----
{
  let applied = null;
  const input = {
    ...assembleInput({
      activePresetId: 'heavy',
      characterPrompts: [{ positive: 'c1', negative: 'cn', enabled: true, position: '0.1,0.2' }],
      activePreciseRefs: [
        { id: 'r1', name: 'r1', preview: 'p', mode: 'style', informationExtracted: 0.8, strength: 0.6, enabled: true },
        { id: 'r2', name: 'r2', preview: 'p', mode: 'character', informationExtracted: 0.7, strength: 0.5, enabled: false },
      ],
      activeVibes: [
        { id: 'v1', name: 'v1', image: 'img', referenceStrength: 0.6, informationExtracted: 0.9, enabled: true },
      ],
      img2imgImage: 'base64img',
    }),
    applyClampedResolution: (size, next) => { applied = { size, next }; },
  };
  const { generateParams, generationSize, resolutionSource } = await assembleGenerateParams(input);
  check('标准生成载荷基线:未触发 clamp 时逐字段一致', () => {
    assert.equal(applied, null);
    assert.deepEqual(generationSize, {
      width: 832, height: 1216, changed: false, originalWidth: 832, originalHeight: 1216,
    });
    assert.equal(resolutionSource, '默认竖图');
    assert.deepEqual(generateParams, {
      positivePrompt: 'masterpiece, 1girl',
      negativePrompt: 'lowres',
      model: 'v4.5-full',
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      seed: undefined,
      sampler: 'k_euler_ancestral',
      cfgRescale: 0,
      noiseSchedule: 'karras',
      ucPreset: 'heavy',
      // 这条基线的输入没有 activePreset 对象(只有 id),也就是这一发**没拼**任何
      // 预设文本 —— 看 positivePrompt 就知道。qualityToggle 报的正是「拼没拼」,
      // 所以这里是 false;而 ucPreset/qualityPresetId 报的是「选的哪个官方档」,
      // 由 id 决定。旧基线在这里写 true,和它自己的 positivePrompt 是矛盾的。
      qualityToggle: false,
      qualityPresetId: 'none',
      varietyPlus: false,
      normalizeVibeStrength: true,
      resolutionSource: '默认竖图',
      characterPrompts: [{ positive: 'c1', negative: 'cn', enabled: true, position: '0.1,0.2' }],
      preciseReferences: [
        { imageBase64: 'cr:r1', mode: 'style', informationExtracted: 0.8, strength: 0.6 },
      ],
      vibeReferences: [
        { encodedVibe: 'vibe:v1', originalImage: 'img', strength: 0.6, informationExtracted: 0.9 },
      ],
      img2img: { imageBase64: 'i2i:base64img', strength: 0.7, noise: 0 },
    });
  });
}

{
  let applied = null;
  const input = {
    ...assembleInput({ width: 1000, height: 1000, resolutionSource: '用户选择预设 方形 1000×1000' }),
    applyClampedResolution: (size, next) => { applied = { size, next }; },
  };
  // assembleInput 的 apply 闭包被覆盖,需要同步维护 readResolutionSource 的返回值
  const { generateParams } = await assembleGenerateParams(input);
  check('clamp 触发:尺寸回写、resolutionSource 追加「；生成前兜底 W×H」(原始尺寸)', () => {
    assert.ok(applied);
    assert.deepEqual([applied.size.width, applied.size.height], [1024, 1024]);
    assert.equal(applied.next, '用户选择预设 方形 1000×1000；生成前兜底 1000×1000');
    assert.equal(generateParams.width, 1024);
    assert.equal(generateParams.height, 1024);
    // 载荷里的 resolutionSource 读自 readResolutionSource(未回写 holder 时保持原值),
    // 桌面/移动壳的 apply 回调会回写 holder,使载荷携带兜底后缀 —— 见下一用例。
  });
}

{
  let source = '默认竖图';
  const input = {
    ...assembleInput({ width: 4096, height: 4096 }),
    readResolutionSource: () => source,
    applyClampedResolution: (size, next) => { source = next; },
  };
  const { generateParams, generationSize, resolutionSource } = await assembleGenerateParams(input);
  check('clamp 触发(壳回写 holder):载荷 resolutionSource 携带兜底后缀', () => {
    assert.ok(generationSize.changed);
    assert.equal(generateParams.resolutionSource, '默认竖图；生成前兜底 4096×4096');
    assert.equal(resolutionSource, '默认竖图；生成前兜底 4096×4096');
    assert.equal(generateParams.width, generationSize.width);
    assert.equal(generateParams.height, generationSize.height);
  });
}

// ---- 6. savedInpaint 覆盖 ----
{
  const savedInpaint = { imageBase64: 'orig', maskBase64: 'mask', strength: 0.5, width: 640, height: 896 };
  const { generateParams } = await assembleGenerateParams(assembleInput({
    savedInpaint,
    img2imgImage: 'base64img',
  }));
  check('savedInpaint:覆盖 width/height、写 inpaint、img2img 置 undefined', () => {
    assert.equal(generateParams.width, 640);
    assert.equal(generateParams.height, 896);
    assert.deepEqual(generateParams.inpaint, { imageBase64: 'orig', maskBase64: 'mask', strength: 0.5 });
    assert.equal(generateParams.img2img, undefined);
  });
}

// ---- 7. inpaint 事件载荷 ----
{
  const params = await assembleInpaintParams(assembleInput({
    width: 512,
    height: 768,
    inpaint: { imageBase64: 'orig', maskBase64: 'mask', strength: 0.6 },
    skipHistory: true,
  }));
  check('inpaint 载荷:resolutionSource=局部重绘 W×H、skipHistory 透传', () => {
    assert.equal(params.resolutionSource, '局部重绘 512×768');
    assert.deepEqual(params.inpaint, { imageBase64: 'orig', maskBase64: 'mask', strength: 0.6 });
    assert.equal(params.skipHistory, true);
    assert.equal(params.width, 512);
    assert.equal(params.height, 768);
  });
}

// ---- 8. 平台注入槽:移动端 prompt/角色提示词组装经 prepare* 覆盖 ----
{
  const params = await buildBaseGenerationParams(baseInput({
    resolutionSource: '移动端 832×1216',
    preparePromptPair: async ({ positivePrompt, negativePrompt, activePreset }) => ({
      positive: `mobile:${positivePrompt}${activePreset ? '+preset' : ''}`,
      negative: `mobile:${negativePrompt}`,
    }),
    prepareCharacterPrompts: (list) => list.filter((c) => c.enabled && c.positive.trim()).map((c) => ({
      positive: c.positive,
      negative: c.negative,
      enabled: c.enabled,
      position: c.position,
    })),
    characterPrompts: [
      { positive: '', negative: 'x', enabled: true },
      { positive: 'kept', negative: '', enabled: true },
    ],
  }));
  check('注入槽:preparePromptPair/prepareCharacterPrompts 覆盖生效(移动端语义入口)', () => {
    assert.equal(params.positivePrompt, 'mobile:masterpiece, 1girl');
    assert.equal(params.negativePrompt, 'mobile:lowres');
    assert.deepEqual(params.characterPrompts, [
      { positive: 'kept', negative: '', enabled: true, position: undefined },
    ]);
  });
}

console.log(`\n${checks} 项对等校验全部通过。`);
