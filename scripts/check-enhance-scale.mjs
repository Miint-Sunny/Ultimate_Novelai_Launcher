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
} = await import('../src/services/naiEnhanceScale.ts');

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

console.log(`\n${checks} 项放大重绘尺寸校验全部通过。`);
