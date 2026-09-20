#!/usr/bin/env node
// NAI Diffusion V5 支持的对等校验:断言注册表、家族判定、计费、预设文本,
// 以及**真实请求载荷**对 V5 的处理与官方口径一致。
//
// 运行: node --experimental-strip-types scripts/check-v5-parity.mjs
//
// 为什么值得单独一份:V5 的差异几乎全是「不报错但结果错」的类型——
//   1. 计费漏乘 1.5,界面显示的价永远比真实扣费少三分之一;
//   2. 模型落错家族(V5 会掉进 LEGACY)会切到另一条指数计价公式;
//   3. 载荷层:params_version 传 3 照样出图,只把角色坐标静默丢掉;两套预设口径
//      两套并存(服务端今天两种都收,我们只发官方形状,不赌宽容);
//      发 sm:true 或缺 v4_prompt 直接 HTTP 500。
// 这些都不会在本地抛异常,只会安静地算错或者到线上才 500,所以用实测锚点钉住。
//
// 第 5 段(载荷契约)跑的是 src/services/novelai.ts 里那个真正的 buildRequestPayload,
// 靠 scripts/lib/load-frontend-module.mjs 补上 vite 的目录解析与两个模块级浏览器 API。
// 断言的是线上那份实现本身,不是它的复述。
//
// 锚点来源:2026-08-28 用真实账号在 novelai.net 生成 832×1216 / 28 步 / V5 Full,
// 余额从 31659 掉到 31629,即 30 Anlas。同规格 V4.5 是 20,恰好 20×1.5=30。

import assert from 'node:assert/strict';

// 先装解析钩子与浏览器垫片,再 import 前端模块 —— 少了这一步,真正拼载荷的
// src/services/novelai.ts 在 node 里 import 不起来(目录 import + 模块级 localStorage)。
await import('./lib/load-frontend-module.mjs');

const { buildRequestPayload } = await import('../src/services/novelai.ts');
const { calculateAnlasCost, calculateCostFromUI } = await import('../src/services/costCalculator.ts');
const { MODEL_MATCH_MAP } = await import('../src/components/left-sidebar/metadataImportActions.ts');
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
const { V5_QUALITY_SUFFIX, V5_UC_PREFIX, toV5UcPresetId, toV5QualityPresetId } =
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
  // 文字渲染是 V5 独有:引号 → teXt: 块。编辑器提示与补全让路都问这一位。
  assert.equal(v5.textRendering, true);
  // 这两项是「暂缺」不是「不支持」——官方上线后改成 true,这两行断言应随之更新
  assert.equal(v5.vibeTransfer, false);
  assert.equal(v5.preciseReference, false);

  const legacy = modelCapabilities('v4.5-full');
  assert.equal(legacy.noiseSchedule, true);
  assert.equal(legacy.opusUsageLimit, false);
  assert.equal(legacy.textRendering, false);
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

// 现役预设表里一个 nsfw 都不该有:官方今天的口径不带它,带 nsfw 的那几段是历史变体
// (Aaalice 把它们单独放在 legacyPresetVariants,注明只用于读旧 PNG 元数据)。
check('预设: 发包用的预设文本里没有 nsfw', () => {
  for (const [tier, text] of Object.entries(V5_UC_PREFIX)) {
    assert.ok(!/\bnsfw\b/i.test(text), `V5 负面档 ${tier} 里不该有 nsfw`);
  }
  for (const [tier, text] of Object.entries(V5_QUALITY_SUFFIX)) {
    assert.ok(!/\bnsfw\b/i.test(text), `V5 质量尾 ${tier} 里不该有 nsfw`);
  }
});

// ---- 5. 载荷契约(跑真实的 buildRequestPayload,不是复述文档) ----
//
// 这一段针对的是 PARAMETER_MAPPING.md 里那张「按模型族分叉」的表。它值得单独校验,
// 是因为这一层的错法特别阴:params_version 传错**不报错**,只把角色坐标静默丢掉;
// 预设口径走岔(服务端今天两种都收,所以错了不会报,只会悄悄换掉一档预设);
// 发 sm:true 或缺 v4_prompt 直接 HTTP 500。
// 也就是说,这些错在本地一律看不出来,只有线上出图不对或者 500 才知道。

const baseParams = (overrides = {}) => ({
  positivePrompt: '1girl',
  negativePrompt: 'lowres',
  model: 'v5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5.5,
  sampler: 'k_euler_ancestral',
  cfgRescale: 0,
  // 故意用 exponential:它既不是 V5 的强制值也不是归一化目标,
  // 才能同时验出「V5 覆写」与「V4 系透传」。
  noiseSchedule: 'exponential',
  ucPreset: 'heavy',
  qualityToggle: true,
  varietyPlus: false,
  characterPrompts: [],
  seed: 1,
  ...overrides,
});
const paramsOf = (overrides) => buildRequestPayload(baseParams(overrides)).parameters;

check('载荷: params_version 按族分叉(V5 传 3 会静默丢掉角色坐标)', () => {
  assert.equal(paramsOf({ model: 'v5-full' }).params_version, 4);
  assert.equal(paramsOf({ model: 'v5-curated' }).params_version, 4);
  assert.equal(paramsOf({ model: 'v4.5-full' }).params_version, 3);
});

// 锁的是「我们发的形状」而不是「服务端的约束」——服务端今天数字口径也收
// (同作者的 web 端与 Plana-App v1.0.7 在 V5 上发的就是数字 ucPreset,生产在跑)。
// 我们不赌它一直收。
check('载荷: 只发官方形状的预设口径,两套不并存', () => {
  const v5 = paramsOf({ model: 'v5-full' });
  assert.equal(v5.ucPresetId, 'heavy');
  assert.equal(v5.qualityPresetId, 'standard');
  assert.ok(!('ucPreset' in v5), 'V5 载荷不能带数字 ucPreset');
  assert.ok(!('qualityToggle' in v5), 'V5 载荷不能带布尔 qualityToggle');

  const v4 = paramsOf({ model: 'v4.5-full' });
  assert.equal(typeof v4.ucPreset, 'number');
  assert.equal(v4.qualityToggle, true);
  assert.ok(!('ucPresetId' in v4), 'V4 系载荷不能带字符串 ucPresetId');
  assert.ok(!('qualityPresetId' in v4), 'V4 系载荷不能带 qualityPresetId');
});

check('载荷: V5 强制 karras 并忽略用户选择;V4 系原样透传', () => {
  assert.equal(paramsOf({ model: 'v5-full', noiseSchedule: 'exponential' }).noise_schedule, 'karras');
  assert.equal(paramsOf({ model: 'v4.5-full', noiseSchedule: 'exponential' }).noise_schedule, 'exponential');
});

check('载荷: V5 没有 Variety+,skip_cfg_above_sigma 恒 null', () => {
  assert.equal(paramsOf({ model: 'v5-full', varietyPlus: true }).skip_cfg_above_sigma, null);
  assert.equal(paramsOf({ model: 'v4.5-full', varietyPlus: true }).skip_cfg_above_sigma, 58);
  assert.equal(paramsOf({ model: 'v4.5-full', varietyPlus: false }).skip_cfg_above_sigma, null);
});

check('载荷: straight_alpha 只在 V5 出现(32 通道 VAE 吐 alpha 靠它)', () => {
  assert.equal(paramsOf({ model: 'v5-full' }).straight_alpha, true);
  assert.ok(!('straight_alpha' in paramsOf({ model: 'v4.5-full' })));
});

check('载荷: 透明背景 hint 只在 V5 且用户勾选时出现', () => {
  assert.equal(
    paramsOf({ model: 'v5-full', transparentBackground: true }).tag_hint_transparent_background,
    true,
  );
  assert.ok(!('tag_hint_transparent_background' in paramsOf({ model: 'v5-full' })));
  assert.ok(
    !('tag_hint_transparent_background' in paramsOf({ model: 'v4.5-full', transparentBackground: true })),
  );
});

check('载荷: 任何模型都不发 sm / sm_dyn(V5 发 sm:true 直接 HTTP 500)', () => {
  for (const model of ['v5-full', 'v5-curated', 'v4.5-full']) {
    const parameters = paramsOf({ model });
    assert.ok(!('sm' in parameters), `${model} 的载荷不能带 sm`);
    assert.ok(!('sm_dyn' in parameters), `${model} 的载荷不能带 sm_dyn`);
  }
});

check('载荷: 0 角色也必须发 v4_prompt / v4_negative_prompt(缺了 HTTP 500)', () => {
  const parameters = paramsOf({ model: 'v5-full', characterPrompts: [] });
  assert.equal(typeof parameters.v4_prompt?.caption?.base_caption, 'string');
  assert.deepEqual(parameters.v4_prompt.caption.char_captions, []);
  assert.equal(typeof parameters.v4_negative_prompt?.caption?.base_caption, 'string');
  assert.deepEqual(parameters.v4_negative_prompt.caption.char_captions, []);
});

// 这一条现在也顺带钉住「走的是能力位而不是散写的 isV5」——载荷层曾经硬编码
// !isV5,于是 vibeTransfer 这一位是死的:界面无人读它,V5 下 Vibe 入口照开,
// 用户能上传、能花 Anlas 编码,载荷却整段丢掉,全程无提示。
check('载荷: V5 不带 vibe / 精确参考字段(能力位关着,发了会出错)', () => {
  const parameters = paramsOf({
    model: 'v5-full',
    vibeReferences: [{ id: 'x', encoding: 'zzz', strength: 0.6, informationExtracted: 1 }],
    preciseReferences: [{ imageBase64: 'aaa', mode: 'character' }],
  });
  const leaked = Object.keys(parameters).filter(
    (key) => key.startsWith('reference_') || key.startsWith('director_reference_'),
  );
  assert.deepEqual(leaked, [], `V5 载荷混进了参考图字段: ${leaked.join(', ')}`);
});

check('载荷: V5 Curated 重绘是 4.5 顶替(NAI 上线真模型后要摘掉这条)', () => {
  const inpaint = { imageBase64: 'a', maskBase64: 'b' };
  const curated = buildRequestPayload(baseParams({ model: 'v5-curated', inpaint }));
  assert.equal(curated.model, 'nai-diffusion-4-5-curated-inpainting');
  assert.equal(curated.action, 'infill');
  // Full 没有顶替,走正常的后缀推导 —— 顶替只此一处,别扩散。
  const full = buildRequestPayload(baseParams({ model: 'v5-full', inpaint }));
  assert.equal(full.model, 'nai-diffusion-5-full-inpainting');
});

// 2026-09-20 真链路实测(V5 Full,同图同蒙版同 seed):服务端不看平铺的 strength,也不看单独的
// inpaintImg2ImgStrength;只有嵌套的 parameters.img2img.strength 才让结果随强度变。
check('载荷: 重绘强度走嵌套 img2img(强度 < 1 才发,等于 1 不发),inpaintImg2ImgStrength 跟滑杆', () => {
  const at = (strength) => buildRequestPayload(baseParams({ model: 'v5-full', inpaint: { imageBase64: 'a', maskBase64: 'b', strength } })).parameters;
  const soft = at(0.7);
  assert.deepEqual(soft.img2img, { strength: 0.7, color_correct: true });
  assert.equal(soft.inpaintImg2ImgStrength, 0.7);
  assert.equal(soft.add_original_image, true);
  const hard = at(1);
  assert.equal('img2img' in hard, false, '强度 1 = 整区重画,官方客户端不发嵌套对象');
  assert.equal(hard.inpaintImg2ImgStrength, 1);
  const bad = at(Number.NaN);
  assert.equal('img2img' in bad, false); assert.equal(bad.inpaintImg2ImgStrength, 1);
  assert.equal(at(5).inpaintImg2ImgStrength, 1, '越界夹回');
  assert.equal(at(0).img2img.strength, 0.01, '0 夹到最小正值,别发 0');
  const plain = buildRequestPayload(baseParams({ model: 'v5-full' })).parameters;
  assert.equal(plain.inpaintImg2ImgStrength, 1); assert.equal('img2img' in plain, false, '非重绘不带');
});

// 导入 V5 图片能不能选中 V5 模型。这条钉的是**两张表的接缝**:
// metadataImportActions 的关键词表匹配的是 imageMetadata 归一化之后的显示名,
// 不是 PNG 里的原始 Source 串。曾经 V5 在显示名表里没有条目,被正则压成
// `NovelAI V5`,而关键词表里写的是哈希 `v5 0adf9ab7` —— 一条都不中,
// 导入 V5 图片不切模型、也不报错。
check('导入: V5 的 Source 串归一化后仍能选中 V5 模型', () => {
  // 复刻 imageMetadata 里那条正则兜底(显示名表未命中时走的路径)。
  const normalize = (raw) => {
    const m = raw.match(/V(\d+(?:\.\d+)?)/i);
    if (!m) return raw;
    return `NovelAI V${m[1]}${/curated/i.test(raw) ? ' Curated' : ''}`;
  };
  const pick = (displayName) => {
    const lower = displayName.toLowerCase();
    return MODEL_MATCH_MAP.find((e) => e.keywords.some((k) => lower.includes(k)))?.modelName ?? null;
  };

  // 显示名表命中时(已知哈希)
  assert.equal(pick('NovelAI V5 Full'), 'NovelAI V5 Full');
  assert.equal(pick('NovelAI V5 Curated'), 'NovelAI V5 Curated');
  // 未知哈希被压扁后,仍要落到 V5 而不是一条都不中
  assert.equal(normalize('NovelAI Diffusion V5 DEADBEEF'), 'NovelAI V5');
  assert.equal(pick('NovelAI V5'), 'NovelAI V5 Full');
  // 别把 V4 系顺手吞掉
  assert.equal(pick('NovelAI V4.5 Full'), 'NovelAI V4.5 Full');
  assert.equal(pick('NovelAI V4.5 Curated'), 'NovelAI V4.5 Curated');
  assert.equal(pick('NovelAI V4 Full'), 'NovelAI V4 Full');
});

// 官方每个 V5 请求都带这两个数字档位提示(导入图片时靠它决定先拿哪个档去剥预设
// 文本)。我们的 PARAMETER_MAPPING.md 一直写着「所以我们照着发」,但代码里从来
// 没发过 —— 文档和实现对不上,而服务端照收,所以本地毫无反馈。
// 这张提示表和线上那个数字 ucPreset **不是**一张表,两张都有 heavy/light。
check('载荷: V5 带官方的数字档位提示,且不与数字 ucPreset 混淆', () => {
  const v5 = paramsOf({ model: 'v5-full', ucPreset: 'heavy', qualityToggle: true });
  assert.equal(v5.ucPresetId, 'heavy');
  assert.equal(v5.qualityPresetId, 'standard');
  assert.equal(v5.tag_hint_uc_preset, 2, 'heavy 在官方枚举里是 2');
  assert.equal(v5.tag_hint_qt, 1, 'standard 在官方枚举里是 1');
  // 别看串:线上数字 ucPreset 是可见档位数组的下标,heavy 在那张表里是 3。
  assert.notEqual(v5.tag_hint_uc_preset, 3);

  const off = paramsOf({ model: 'v5-full', ucPreset: 'none', qualityToggle: false });
  assert.equal(off.tag_hint_uc_preset, 0);
  assert.equal(off.tag_hint_qt, 0);

  const light = paramsOf({ model: 'v5-full', ucPreset: 'light', qualityToggle: false });
  assert.equal(light.tag_hint_uc_preset, 3);

  // V4 系不带 —— 这两个是 V5 的新增字段。
  const v4 = paramsOf({ model: 'v4.5-full', ucPreset: 'heavy', qualityToggle: true });
  assert.ok(!('tag_hint_qt' in v4), 'V4 系不该带 tag_hint_qt');
  assert.ok(!('tag_hint_uc_preset' in v4), 'V4 系不该带 tag_hint_uc_preset');
});

// Max✨ Enhance。这一条盯的是「省掉」而不是「发 false」:官方把 false 当成
// 普通 img2img,于是用户点了 Max 却拿到普通重绘的图,本地完全看不出来——
// 已上线的两个客户端(Aaalice_NAI_Launcher / Plana-App)各自都有一条测试钉着它。
check('载荷: upscaled_enhance 只在 V5 的 Max 档出现,其余整键省掉', () => {
  const img2img = { imageBase64: 'AAAA', strength: 0.5, noise: 0 };

  const max = paramsOf({ model: 'v5-full', img2img: { ...img2img, upscaledEnhance: true } });
  assert.equal(max.upscaled_enhance, true);

  // 非 Max:不是发 false,是整个键不存在。
  const plain = paramsOf({ model: 'v5-full', img2img: { ...img2img, upscaledEnhance: false } });
  assert.ok(!('upscaled_enhance' in plain), '非 Max 档不能带 upscaled_enhance');
  const unset = paramsOf({ model: 'v5-full', img2img });
  assert.ok(!('upscaled_enhance' in unset), '没选档位时不能带 upscaled_enhance');

  // 能力位关着的模型,即使上游把档位传进来了也不发。
  const v45 = paramsOf({ model: 'v4.5-full', img2img: { ...img2img, upscaledEnhance: true } });
  assert.ok(!('upscaled_enhance' in v45), 'V4 系不支持 Max 档,不能发 upscaled_enhance');

  // 不是 img2img 就无从谈起。
  const txt2img = paramsOf({ model: 'v5-full' });
  assert.ok(!('upscaled_enhance' in txt2img), '文生图不能带 upscaled_enhance');
});

// ---- 6. 提示词分词计数(V5=Qwen 3.5 byte-level BPE,V4 系=T5) ----
//
// V5 的 1471/703 软阈是按 Qwen 口径实测的,喂 T5 读数就是错的口径。这里断言:
//   a) 分词器种类由能力表决定(V5→qwen35,V4 系→t5),调用点不许散写家族判断;
//   b) Qwen 引擎在真实资产上的读数与官网实测锚点一致(Aaalice_NAI_Launcher 抓的
//      官网数据:blending=2、4::blending::=5、hello world=2);
//   c) 权重语法字符在 Qwen 口径下真实计数(不剥),空串/纯空白为 0;
//   d) 同一段文本在两套分词器下读数确实不同(否则「按模型族选用」无意义)。
// 引擎是纯模块(services/qwenBpe.ts),node 可直接加载;tokenizer.ts 因静态 JSON
// import 进不了 node,其分发逻辑(空文本跳过/近似回落)由消费方测试与门禁覆盖。

const { promptTokenizerForModel } = await import(
  '../src/components/generation/modelResolutionOptions.ts'
);
const { parseQwenBpeAsset, countQwenTokens } = await import('../src/services/qwenBpe.ts');
const { gunzipSync } = await import('node:zlib');
const { readFileSync } = await import('node:fs');

const qwenAssetText = gunzipSync(
  readFileSync(new URL('../src/assets/tokenizer/qwen35_bpe.txt.gz', import.meta.url)),
).toString('utf8');
const qwenAsset = parseQwenBpeAsset(qwenAssetText);

// T5 对照侧:真实包 + 仓库词表,构造方式与 src/services/tokenizer.ts 同源。
// tokenizer.ts 本体因静态 JSON import 进不了 node,这里只借它的依赖做对照。
const { Tokenizer } = await import('@huggingface/tokenizers');
const t5Tokenizer = new Tokenizer(
  JSON.parse(readFileSync(new URL('../src/assets/tokenizer/t5_tokenizer.json', import.meta.url), 'utf8')),
  {},
);

check('分词: 分词器口径由能力表决定,V5 走 Qwen、V4 系走 T5', () => {
  assert.equal(promptTokenizerForModel('v5-full'), 'qwen35');
  assert.equal(promptTokenizerForModel('v5-curated'), 'qwen35');
  // 后端名与 -inpainting 变体同口径(能力表按家族判定)
  assert.equal(promptTokenizerForModel('nai-diffusion-5-full-inpainting'), 'qwen35');
  assert.equal(promptTokenizerForModel('v4.5-full'), 't5');
  assert.equal(promptTokenizerForModel('v4-full'), 't5');
  assert.equal(promptTokenizerForModel('nai-diffusion-4-5-curated'), 't5');
});

check('分词: Qwen 计数与官网实测锚点一致(真实资产端到端)', () => {
  // 锚点来自 Aaalice_NAI_Launcher 在官网的实测注释:Qwen 口径下无 EOS 偏移。
  assert.equal(countQwenTokens(qwenAsset, 'hello world'), 2);
  assert.equal(countQwenTokens(qwenAsset, 'blending'), 2);
  assert.equal(countQwenTokens(qwenAsset, '4::blending::'), 5);
});

check('分词: 权重语法在 Qwen 口径下真实计数,不做 T5 式剥离', () => {
  // "4::blending::" 计 5 而 "blending" 计 2:差值 3 就是语法字符本身的 token ——
  // 若谁把 normalizePromptForNaiT5 的剥除误用到 Qwen 分支,这条立刻红。
  assert.ok(countQwenTokens(qwenAsset, '4::blending::') > countQwenTokens(qwenAsset, 'blending'));
  // 花括号同理:剥掉会偏小
  assert.ok(
    countQwenTokens(qwenAsset, '{blue eyes}') > countQwenTokens(qwenAsset, 'blue eyes'),
  );
});

check('分词: 纯英文 tag 串 / 含中文 / 空串与纯空白', () => {
  const english = countQwenTokens(qwenAsset, '1girl, smile, blue eyes');
  assert.equal(english, 7); // 由已提交资产推出的确定值,钉住防退化
  // 中文按 NFC 归一化后走同一条 BPE 管线(CJK 是词字符,splitRegex 原样切出)
  assert.equal(countQwenTokens(qwenAsset, '白发红瞳少女'), 4);
  assert.equal(countQwenTokens(qwenAsset, ''), 0);
  // 引擎层面对纯空白计 1(首空白会编码成 token);「纯空白文本跳过」是分发层
  // (tokenizer.ts)的口径,与参考仓 service 层一致,这里只锚定引擎不误报 0。
  assert.equal(countQwenTokens(qwenAsset, '   '), 1);
});

check('分词: 同一段文本在 V5 与 V4 口径下读数不同', () => {
  // T5 侧用真实的 @huggingface/tokenizers + 仓库 T5 词表(与 tokenizer.ts 同源)。
  // 这里对照的是**原始编码**(不复述 tokenizer.ts 的剥除归一化,避免双份逻辑漂移):
  // 只要读数不同,就证明两套分词器真实不同、「按模型族选用」不是摆设。
  const t5Count = t5Tokenizer.encode('4::blending::').ids.length;
  const qwenCount = countQwenTokens(qwenAsset, '4::blending::');
  assert.notEqual(
    t5Count,
    qwenCount,
    `T5(${t5Count}) 与 Qwen(${qwenCount}) 读数相同,按模型族选用失去意义`,
  );
  // 生产口径下 T5 还会先剥权重记号再编码(读数更小),Qwen 原样计数 ——
  // 两层差异叠加,V5 读数显著高于旧 T5 显示,偏差数据见任务回执。
  const t5Stripped = t5Tokenizer.encode('blending').ids.length;
  assert.ok(qwenCount > t5Stripped);
});


// ---- agent 契约:发给 planner 的图像模型代际(黑板 #10) ----
const { agentImageModelFor } = await import('../src/services/agentImageModel.ts');
check('agent 契约: UI id 与官方 id 都映到 nai_v5_* / nai_v45_*,V4/V3 报未知', () => {
  assert.equal(agentImageModelFor('nai-diffusion-5-full'), 'nai_v5_full');
  assert.equal(agentImageModelFor('nai-diffusion-5-curated'), 'nai_v5_curated');
  assert.equal(agentImageModelFor('v4.5-full'), 'nai_v45_full');
  assert.equal(agentImageModelFor('v4.5-curated'), 'nai_v45_curated');
  assert.equal(agentImageModelFor('v4-full'), '');
  assert.equal(agentImageModelFor('v3'), '');
  assert.equal(agentImageModelFor(''), '');
});

// ---- 2026-09-21 真链路暴露的两条:能力位散写、开关只发 hint 不发词 ----
// 后端 lane 在真 key 上做的对照实验:
//   1. V5 挂精确参考出图 —— 载荷里五个 director_reference_* 全缺席、Anlas 一点没扣,
//      但界面放行、按钮上还多写了 5 💎;
//   2. V5 只开透明背景开关 —— 全透明像素 0 个、四角 alpha 254;同参数手写
//      transparent background 才有 58085 个(5.7%)、四角 alpha 0。
// 两条都是「不报错、只是静默不对」,所以钉在这里。

check('能力位: 精确参考只在 4.5 / V3 上为真(V5 暂缺,V4 基座从来没有)', () => {
  // V4 Curated 两种官方写法都要认:元数据 / Vibe 导入用的是不带 -preview 的那个。
  for (const model of ['v5-full', 'v5-curated', 'nai-diffusion-5-full', 'v4-full', 'v4-curated-preview', 'nai-diffusion-4-full', 'nai-diffusion-4-curated']) {
    assert.equal(modelCapabilities(model).preciseReference, false, model);
  }
  for (const model of ['v4.5-full', 'v4.5-curated', 'nai-diffusion-4-5-full', 'v3']) {
    assert.equal(modelCapabilities(model).preciseReference, true, model);
  }
  // 重绘变体与基座同一套能力,别因为后缀掉进另一条分支。
  assert.equal(modelCapabilities('nai-diffusion-4-full-inpainting').preciseReference, false);
  assert.equal(modelCapabilities('nai-diffusion-4-5-full-inpainting').preciseReference, true);
});

check('载荷: 精确参考只发给能力位为真的模型(V4 基座与 V5 都不发,4.5 照发)', () => {
  const withRef = (model) => paramsOf({ model, preciseReferences: [{ imageBase64: 'aaa', mode: 'character' }] });
  for (const model of ['v5-full', 'v4-full', 'v4-curated-preview']) {
    const leaked = Object.keys(withRef(model)).filter((key) => key.startsWith('director_reference_'));
    assert.deepEqual(leaked, [], `${model} 不该发精确参考: ${leaked.join(', ')}`);
  }
  assert.deepEqual(withRef('v4.5-full').director_reference_images, ['aaa']);
});

check('计价: 模型不支持的参考图不收钱(V5 上的精确参考虚收过 5/张)', () => {
  const cost = (overrides) => calculateAnlasCost({
    width: 832, height: 1216, steps: 28, sampler: 'k_euler_ancestral', ...overrides,
  });
  const v5Plain = cost({ model: 'nai-diffusion-5-full' }).total;
  assert.equal(cost({ model: 'nai-diffusion-5-full', preciseRefCount: 2 }).total, v5Plain, 'V5 不该为精确参考收钱');
  // 同一张表在 4.5 上照收:这一刀只砍能力位关着的模型,别把功能一起砍了。
  const legacyPlain = cost({ model: 'nai-diffusion-4-5-full' }).total;
  assert.equal(cost({ model: 'nai-diffusion-4-5-full', preciseRefCount: 2 }).total, legacyPlain + 10);
  // Vibe 是同一个洞:第 5 张起每张 +2,V5 上一样不该收。
  assert.equal(cost({ model: 'nai-diffusion-5-full', vibeRefCount: 6 }).total, v5Plain);
  assert.equal(cost({ model: 'nai-diffusion-4-5-full', vibeRefCount: 6 }).total, legacyPlain + 4);
  // UI 口径走的是同一条路。
  assert.equal(
    calculateCostFromUI({ width: 832, height: 1216, steps: 28, modelId: 'v5-full', sampler: 'k_euler_ancestral', preciseRefCount: 3 }).total,
    calculateCostFromUI({ width: 832, height: 1216, steps: 28, modelId: 'v5-full', sampler: 'k_euler_ancestral' }).total,
  );
});

check('载荷: 透明背景开关把词写进提示词(只发 hint 等于没开)', () => {
  const on = paramsOf({ model: 'v5-full', positivePrompt: '1girl', transparentBackground: true });
  assert.ok(on.tag_hint_transparent_background, 'hint 仍然要发');
  assert.equal(buildRequestPayload(baseParams({ positivePrompt: '1girl', transparentBackground: true })).input, '1girl, transparent background');
  // 没开就不加;4.5 没有这个能力,开了也不加。
  assert.equal(buildRequestPayload(baseParams({ positivePrompt: '1girl' })).input, '1girl');
  assert.equal(
    buildRequestPayload(baseParams({ model: 'v4.5-full', positivePrompt: '1girl', transparentBackground: true })).input,
    '1girl',
  );
});

check('载荷: 透明背景词不重复、不落进手写 text: 块', () => {
  const inputOf = (positivePrompt) => buildRequestPayload(baseParams({ positivePrompt, transparentBackground: true })).input;
  // 用户自己写过就不再追加 —— 含权重与花括号写法(界面的 💡 提示就教了 2.1:: 那种)。
  assert.equal(inputOf('1girl, transparent background'), '1girl, transparent background');
  assert.equal(inputOf('1girl, 2.1::transparent background::'), '1girl, 2.1::transparent background::');
  assert.equal(inputOf('1girl, {Transparent Background}'), '1girl, {Transparent Background}');
  // 落进 text: 块里模型会把这两个词画到图上,必须拼在块之前(与质量尾同一个坑)。
  assert.equal(inputOf('1girl, text: Hello'), '1girl, transparent background, text: Hello');
});

check('载荷: 角色负向与正向等长,没写负向的发空串(不等长服务端 400)', () => {
  // NAI 的原话:「V4 positive and negative character prompts must have the same length.」
  // 老写法只收负向非空的那几个 —— 三个角色里有一个没写负向就整单 400,
  // 而且活下来的那条负向会按下标错配到别的角色头上。
  // 来源:Plana-App 上游 894393b(2026-09-20)因同一条 400 改成等长发送。
  const parameters = paramsOf({
    characterPrompts: [
      { positive: 'girl a', negative: '', enabled: true, center: { x: 0.25, y: 0.5 } },
      { positive: 'girl b', negative: 'bad hands', enabled: true, center: { x: 0.75, y: 0.5 } },
    ],
  });
  const pos = parameters.v4_prompt.caption.char_captions;
  const neg = parameters.v4_negative_prompt.caption.char_captions;
  assert.equal(neg.length, pos.length, '两份 char_captions 必须等长');
  assert.equal(neg[0].char_caption, '', '没写负向的发空串,不是跳过');
  assert.equal(neg[1].char_caption, 'bad hands', '写了的那条要落在它自己的位置上');
  assert.deepEqual(neg[1].centers, pos[1].centers, '负向的坐标跟着同一个角色');
  // 一个负向都没写时也得等长,别退回空数组。
  const none = paramsOf({
    characterPrompts: [
      { positive: 'solo', negative: '', enabled: true, center: { x: 0.5, y: 0.5 } },
    ],
  });
  assert.equal(none.v4_negative_prompt.caption.char_captions.length, 1);
});

const { parseNAIMetadata } = await import('../src/utils/imageMetadata.ts');

check('导入: 角色负向从 v4_negative_prompt 读回来(等长才按下标配)', () => {
  // parseNAIMetadata 收的是整块 PNG 文本,Comment 才是那段 JSON。
  const comment = (negatives) => ({ Comment: JSON.stringify({
    prompt: '1girl', uc: 'lowres', steps: 28, scale: 5, sampler: 'k_euler',
    width: 832, height: 1216, seed: 1,
    v4_prompt: { caption: { base_caption: '1girl', char_captions: [
      { char_caption: 'girl a', centers: [{ x: 0.25, y: 0.5 }] },
      { char_caption: 'girl b', centers: [{ x: 0.75, y: 0.5 }] },
    ] } },
    v4_negative_prompt: { caption: { base_caption: 'lowres', char_captions: negatives } },
  }) });
  // 等长(我们自己出的图):每个人的负向各归各位。老写法只读 char_uc,会把它们全丢光。
  const paired = parseNAIMetadata(comment([
    { char_caption: '', centers: [{ x: 0.25, y: 0.5 }] },
    { char_caption: 'bad hands', centers: [{ x: 0.75, y: 0.5 }] },
  ]));
  assert.deepEqual(paired.characterPrompts.map((c) => c.uc), ['', 'bad hands']);
  // 不等长(老图 / 老客户端只写了非空的那几条):按下标配会安到别人头上,宁可留空。
  const skewed = parseNAIMetadata(comment([{ char_caption: 'bad hands', centers: [{ x: 0.75, y: 0.5 }] }]));
  assert.deepEqual(skewed.characterPrompts.map((c) => c.uc), ['', '']);
  // 正向与坐标两种情况都照常。
  assert.deepEqual(paired.characterPrompts.map((c) => c.prompt), ['girl a', 'girl b']);
  assert.deepEqual(skewed.characterPrompts.map((c) => c.center), [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }]);
});

console.log(`\n${checks} 项 V5 支持对等校验全部通过。`);
