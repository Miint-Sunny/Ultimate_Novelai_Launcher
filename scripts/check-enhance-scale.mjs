#!/usr/bin/env node
// 放大重绘(Max ✨ 与数值倍率)的尺寸与档位校验。
//
// 运行: node --experimental-strip-types scripts/check-enhance-scale.mjs
//
// 为什么值得单独一份:Max ✨ 的输出尺寸是**服务端**定的,我们发的 params 里
// 留的是原图尺寸。算错了图照出、不报错,只有 Anlas 账不对——本地没有任何反馈。
// 官方那套 RO() 又不是「等比放到上限」,凭直觉写必错,所以把实测锚点钉在这里。

import assert from 'node:assert/strict';

// 这个模块经能力表判断 Max 档,而能力表是 vite 风格的无扩展名 import。
await import('./lib/load-frontend-module.mjs');

const {
  NAI_MAX_PIXELS,
  ENHANCE_MAX_SOURCE_LIMIT,
  enhanceMaxTargetSize,
  enhanceTargetSize,
  enhanceMaxAvailable,
  enhanceScaleOptions,
  resolveEnhanceScaleChoice,
  MAGNITUDE_PRESETS,
  ENHANCE_DEFAULT_STRENGTH,
  ENHANCE_DEFAULT_NOISE,
} = await import('../src/services/naiEnhanceScale.ts');
const { resolveEnhanceModel, buildRequestPayload } = await import('../src/services/novelai.ts');

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

const ids = (w, h, model) => enhanceScaleOptions(w, h, model).map((s) => s.id);

check('常量: 上限 3,145,728;Max 档源图阈值是它的 0.8', () => {
  assert.equal(NAI_MAX_PIXELS, 3_145_728);
  assert.equal(ENHANCE_MAX_SOURCE_LIMIT, 2_516_582.4);
  // 它就是上限的 0.8,只是照抄官方字面量避开浮点尾数,所以这里用容差核关系。
  assert.ok(Math.abs(ENHANCE_MAX_SOURCE_LIMIT - NAI_MAX_PIXELS * 0.8) < 1e-6);
});

// 这条是整份校验的锚:官方实测 512×512 → 1024×1024。
// 「等比放到上限」会得到 1774×1774,估价高出三倍——两个数都钉住,
// 免得将来有人"顺手改成放到上限"。
check('Max: 512×512 实测出 1024×1024,而不是放到上限的 1774', () => {
  assert.deepEqual(enhanceMaxTargetSize(512, 512), { width: 1024, height: 1024 });
  assert.notEqual(enhanceMaxTargetSize(512, 512).width, 1774);
});

check('Max: 先向下对齐 16 再 ×2 —— 非对齐边长会被吃掉余数', () => {
  // 500 → floor(500/16)*16 = 496 → ×2 = 992 → 32 对齐后仍是 992。
  assert.deepEqual(enhanceMaxTargetSize(500, 500), { width: 992, height: 992 });
  // 比 512 小,结果也必须比 1024 小:余数是被吃掉而不是被补齐。
  assert.ok(enhanceMaxTargetSize(500, 500).width < enhanceMaxTargetSize(512, 512).width);
});

check('Max: 超过上限时等比缩回,round 越界则整体改用 floor', () => {
  // 832×1216: ×2 后 1664×2432 = 4.05M 超上限,缩回后 round 得 1472×2144
  // = 3,155,968 仍越界,于是走 floor 分支。
  const t = enhanceMaxTargetSize(832, 1216);
  assert.deepEqual(t, { width: 1440, height: 2144 });
  assert.ok(t.width * t.height <= NAI_MAX_PIXELS, '缩回后仍越界');
  assert.equal(t.width % 32, 0);
  assert.equal(t.height % 32, 0);
});

check('Max: 任何输入都不越上限', () => {
  for (const [w, h] of [[512, 512], [832, 1216], [1216, 832], [1024, 1024], [1500, 1500], [64, 2048]]) {
    const t = enhanceMaxTargetSize(w, h);
    assert.ok(t.width * t.height <= NAI_MAX_PIXELS, `${w}×${h} 越界`);
  }
});

check('Max: 小到对齐后归零的图返回 0,不返回负数或 NaN', () => {
  assert.deepEqual(enhanceMaxTargetSize(15, 15), { width: 0, height: 0 });
  assert.deepEqual(enhanceMaxTargetSize(0, 0), { width: 0, height: 0 });
});

check('数值档: 结果本就 64 对齐时原样 floor,不再对齐', () => {
  assert.deepEqual(enhanceTargetSize(640, 640, 'x2'), { width: 1280, height: 1280 });
  assert.deepEqual(enhanceTargetSize(640, 640, 'x1'), { width: 640, height: 640 });
});

check('数值档: 832×1216 特判——1.5× 出 1248×1824,并非 64 对齐也照发', () => {
  assert.deepEqual(enhanceTargetSize(832, 1216, 'x1.5'), { width: 1248, height: 1824 });
  assert.equal(1248 % 64, 32, '前提变了:1248 若成了 64 的倍数,这条特判就没必要了');
});

check('数值档: 导入的任意尺寸补一次 64 对齐(官方没有这一步)', () => {
  // 700×700 ×1.5 = 1050 → 不是 64 的倍数 → 就近对齐到 1024。
  assert.deepEqual(enhanceTargetSize(700, 700, 'x1.5'), { width: 1024, height: 1024 });
  const t = enhanceTargetSize(333, 777, 'x2');
  assert.equal(t.width % 64, 0);
  assert.equal(t.height % 64, 0);
  assert.ok(t.width >= 64 && t.height >= 64, '不能对齐到 0');
});

check('档位: Max 只在 V5 出现,V4 系没有这一档', () => {
  assert.ok(ids(832, 1216, 'nai-diffusion-5-full').includes('max'));
  assert.ok(ids(832, 1216, 'nai-diffusion-5-curated').includes('max'));
  assert.ok(!ids(832, 1216, 'nai-diffusion-4-5-full').includes('max'));
  assert.ok(!ids(832, 1216, 'nai-diffusion-3').includes('max'));
});

check('档位: 源图 ≥ 上限的 0.8 就没有 Max 档', () => {
  assert.equal(enhanceMaxAvailable(1024, 1024, 'nai-diffusion-5-full'), true);
  // 1600×1600 = 2,560,000 ≥ 2,516,582.4
  assert.equal(enhanceMaxAvailable(1600, 1600, 'nai-diffusion-5-full'), false);
  assert.equal(enhanceMaxAvailable(0, 1216, 'nai-diffusion-5-full'), false);
  // 阈值带小数,整数像素面积**永远撞不到**它,所以 `>=` 与 `>` 在这里等价、
  // 不必也无法钉。真正要钉的是紧贴阈值两侧的判定别搞反。
  const side = Math.sqrt(ENHANCE_MAX_SOURCE_LIMIT);
  assert.equal(enhanceMaxAvailable(Math.ceil(side), Math.ceil(side), 'nai-diffusion-5-full'), false);
  assert.equal(enhanceMaxAvailable(Math.floor(side), Math.floor(side), 'nai-diffusion-5-full'), true);
});

check('档位: 832×1216 特判成 1.5× / 1×,没有 2×', () => {
  const got = ids(832, 1216, 'nai-diffusion-4-5-full');
  assert.deepEqual(got, ['x1.5', 'x1']);
  assert.deepEqual(ids(1216, 832, 'nai-diffusion-4-5-full'), ['x1.5', 'x1']);
});

check('档位: 通则只放出 64 对齐且不越上限的档', () => {
  // 640×640: ×2=1280 对齐且 1.64M 不越界;×1.5=960 对齐;×1 对齐。
  assert.deepEqual(ids(640, 640, 'nai-diffusion-4-5-full'), ['x2', 'x1.5', 'x1']);
  // 1280×1280: ×2 = 6.55M 越上限,该档必须消失。
  assert.ok(!ids(1280, 1280, 'nai-diffusion-4-5-full').includes('x2'));
});

check('档位: 任意尺寸被通则筛空时兜底,不返回空数组', () => {
  // 700×700 三档都不 64 对齐,通则会筛空 —— 兜底后仍要有档可选。
  const got = ids(700, 700, 'nai-diffusion-4-5-full');
  assert.ok(got.length > 0, '筛空后没有兜底');
  for (const [w, h] of [[333, 777], [901, 1103], [64, 64]]) {
    assert.ok(ids(w, h, 'nai-diffusion-4-5-full').length > 0, `${w}×${h} 一档不剩`);
  }
});

check('档位: 放出来的每一档都不越上限', () => {
  for (const [w, h] of [[512, 512], [640, 640], [832, 1216], [700, 700], [1280, 1280]]) {
    for (const s of enhanceScaleOptions(w, h, 'nai-diffusion-5-full')) {
      const t = enhanceTargetSize(w, h, s.id);
      assert.ok(t.width * t.height <= NAI_MAX_PIXELS, `${w}×${h} 的 ${s.id} 档越界`);
    }
  }
});

// 放大重绘走 img2img,**不顶替**:V5 Curated 缺的是 `-inpainting` 模型,而 img2img
// 不需要那种模型。官方的分法是 `inpaint != null ? inpaintModelId(model) : model`
// (Plana-App nai_request.dart:185)。所以 5f / 5c 都用它们自己。
check('模型: 5f 与 5c 都用自己,img2img 不套用 infill 的顶替', () => {
  assert.equal(resolveEnhanceModel('v5-full'), 'v5-full');
  assert.equal(resolveEnhanceModel('v5-curated'), 'v5-curated');
  // 非 V5 暂时仍退回历史默认档(单独一条待定项)。
  assert.equal(resolveEnhanceModel('v4.5-full'), 'v4.5-curated');
  assert.equal(resolveEnhanceModel('v3'), 'v4.5-curated');
});

// 这一条钉的是一个真实踩过的坑:这里曾经填 API id('nai-diffusion-4-5-curated'),
// 而 MODEL_MAP 是按 **UI id** 建的,查不到就静默落到默认的 4.5 Full ——
// 于是「4.5 Curated 重绘」实际一直在用 4.5 Full 出图,界面和估价都还写着 curated。
check('模型: 返回的是 UI id,喂给 buildRequestPayload 能解析成对应的 API 模型', () => {
  const apiModelOf = (uiId) => buildRequestPayload({
    positivePrompt: '1girl', negativePrompt: 'lowres', model: uiId,
    width: 832, height: 1216, steps: 28, scale: 5, sampler: 'k_euler_ancestral',
    cfgRescale: 0, noiseSchedule: 'native', ucPreset: 'heavy', qualityToggle: true,
    varietyPlus: false, characterPrompts: [], seed: 1,
  }).model;
  assert.equal(apiModelOf(resolveEnhanceModel('v5-curated')), 'nai-diffusion-5-curated');
  assert.equal(apiModelOf(resolveEnhanceModel('v5-full')), 'nai-diffusion-5-full');
  // 认不出的输入退回历史默认档,而不是悄悄落到 4.5 Full。
  assert.equal(resolveEnhanceModel('nai-diffusion-4-5-curated'), 'v4.5-curated');
  assert.equal(apiModelOf(resolveEnhanceModel('')), 'nai-diffusion-4-5-curated');
});

check('档位: 5f 与 5c 都有 Max ✨ —— 门槛看所选模型,不看顶替后的', () => {
  assert.ok(enhanceMaxAvailable(832, 1216, resolveEnhanceModel('v5-full')));
  assert.ok(enhanceMaxAvailable(832, 1216, resolveEnhanceModel('v5-curated')));
  assert.ok(!enhanceMaxAvailable(832, 1216, resolveEnhanceModel('v4.5-full')));
});

// 尺寸口径**全族一致**:曾经非 V5 走一份「一律就近对齐 64」的历史算法,
// 832×1216 会出 1280×1856。现在统一跟官方,出 1248×1824。
// 这条钉住「不再按模型分叉」——尺寸函数不该再多一个 model 参数。
check('尺寸: 1.5× 全族都跟官方特判,不再按模型分叉', () => {
  const expected = { width: 1248, height: 1824 };
  assert.deepEqual(enhanceTargetSize(832, 1216, 'x1.5'), expected);
  assert.deepEqual(enhanceTargetSize(1216, 832, 'x1.5'), { width: 1824, height: 1248 });
  // 历史算法在这个尺寸上给的是 1280×1856,不能再出现。
  assert.notDeepEqual(enhanceTargetSize(832, 1216, 'x1.5'), { width: 1280, height: 1856 });
  // 其余尺寸两套本就相同,这次统一只动了那两个特判尺寸。
  assert.deepEqual(enhanceTargetSize(640, 640, 'x1.5'), { width: 960, height: 960 });
  assert.deepEqual(enhanceTargetSize(700, 700, 'x1.5'), { width: 1024, height: 1024 });
});

check('档位: V5 的 640×640 给满四档 —— 界面最挤的情况', () => {
  assert.deepEqual(ids(640, 640, 'nai-diffusion-5-full'), ['max', 'x2', 'x1.5', 'x1']);
});

// 这条钉的是一个反直觉的事实:筛选**和它的兜底会一起落空**。源图大到连 1× 都
// 越过总像素上限时,fits() 全不过,而 enhanceMaxAvailable 也因为源图 ≥ 上限的
// 0.8 一起关掉。界面若假定「永远至少有一档」,就会渲染出一个空的倍率行,
// 而用户点下去会一路走到服务层抛出一条与档位无关的报错。
check('档位: 源图过大时会一档都不剩 —— 界面必须挡住空列表', () => {
  assert.deepEqual(ids(2000, 2000, 'nai-diffusion-5-full'), []);
  assert.deepEqual(ids(3000, 3000, 'nai-diffusion-5-full'), []);
  // 只剩一档也是真实情况,同样要能显示。
  assert.deepEqual(ids(1600, 1600, 'nai-diffusion-5-full'), ['x1']);
});

check('档位: 记住的档被尺寸筛掉时回退到首项,还在就保留', () => {
  const portrait = enhanceScaleOptions(832, 1216, 'nai-diffusion-5-full');
  // 832×1216 没有 2× 档(特判成 1.5×/1×),记住的 x2 要回退到首项 max。
  assert.equal(resolveEnhanceScaleChoice(portrait, 'x2'), 'max');
  assert.equal(resolveEnhanceScaleChoice(portrait, 'x1.5'), 'x1.5');
  // 空列表时原样返回记住的档:纯函数不替界面决定「没得选时显示什么」。
  assert.equal(resolveEnhanceScaleChoice([], 'x1.5'), 'x1.5');
});

check('档位: Magnitude 五档,档 3 与默认强度/噪声同源', () => {
  assert.equal(Object.keys(MAGNITUDE_PRESETS).length, 5);
  assert.deepEqual(MAGNITUDE_PRESETS[3], {
    strength: ENHANCE_DEFAULT_STRENGTH,
    noise: ENHANCE_DEFAULT_NOISE,
  });
  for (const tier of [1, 2, 3, 4, 5]) {
    const preset = MAGNITUDE_PRESETS[tier];
    assert.ok(preset.strength > 0 && preset.strength <= 1, `档 ${tier} 强度越界`);
    assert.ok(preset.noise >= 0 && preset.noise <= 1, `档 ${tier} 噪声越界`);
  }
});

// ---- V5 扩散超分(2026-09-04 真号实测:1024² → 2048²,扣 1 Anlas,体力条不动) ----
const { v5UpscaleTargetSize, v5UpscaleCost, v5UpscaleAvailable, V5_UPSCALE_MAX_SOURCE_PIXELS } =
  await import('../src/services/naiV5Upscale.ts');

check('V5 超分尺寸: 边长向下对齐 16 再 ×2,输出没有总像素上限', () => {
  assert.deepEqual(v5UpscaleTargetSize(1024, 1024), { width: 2048, height: 2048 });
  assert.deepEqual(v5UpscaleTargetSize(832, 1216), { width: 1664, height: 2432 });
  assert.deepEqual(v5UpscaleTargetSize(1400, 1200), { width: 2784, height: 2400 });
  assert.deepEqual(v5UpscaleTargetSize(1000, 1000), { width: 1984, height: 1984 });
});

check('V5 超分计价: 按源图像素查表,边界含等号,超上限为 null', () => {
  assert.equal(v5UpscaleCost(1024, 1024), 1);
  assert.equal(v5UpscaleCost(1024, 1025), 2);
  assert.equal(v5UpscaleCost(1216, 1437), 2);
  assert.equal(v5UpscaleCost(1216, 1438), 3);
  assert.equal(v5UpscaleCost(1024, 3072), 4);
  assert.equal(v5UpscaleCost(1024, 3073), null);
  assert.equal(V5_UPSCALE_MAX_SOURCE_PIXELS, 1024 * 3072);
});

check('V5 超分可用性: 上限之内可用,太小或超限不可用', () => {
  assert.equal(v5UpscaleAvailable(832, 1216), true);
  assert.equal(v5UpscaleAvailable(1024, 3072), true);
  assert.equal(v5UpscaleAvailable(1024, 3073), false);
  assert.equal(v5UpscaleAvailable(8, 8), false);
});

console.log(`\n${checks} 项放大重绘尺寸校验全部通过。`);
